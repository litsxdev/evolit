import http from "node:http";
import { watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { loadEvolitConfig } from "./config.js";
import { createDeploymentRuntime } from "./deployment-runtime.js";
import { APP_DIRECTORY, BUILD_DIRECTORY, INTERNAL_DIRECTORY, MANIFEST_FILENAME } from "./constants.js";
import { normalizeClientAssetManifest } from "./client-assets.js";
import { pathExists, readJson } from "./fs-utils.js";
import { createDefaultRouteCacheKey, resolveResponseCacheRuntime } from "./response-cache.js";
import { terminal } from "./terminal.js";

function getPort(explicitPort) {
  const port = explicitPort ?? process.env.PORT ?? "3000";
  return Number.parseInt(String(port), 10);
}

async function writeResponseBody(response, body) {
  if (!body || typeof body.getReader !== "function") {
    response.end(body);
    return;
  }

  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      response.write(value);
    }
  } finally {
    reader.releaseLock();
  }
  response.end();
}

const LIVE_RELOAD_PATHNAME = "/_evolit/live-reload";

function getResponseHeader(headers, name) {
  if (headers?.get) {
    return headers.get(name);
  }

  return headers?.[name] ?? headers?.[name.toLowerCase()] ?? null;
}

function injectLiveReloadSnippet(response) {
  if (
    typeof response.body !== "string"
    || !getResponseHeader(response.headers, "content-type")?.includes("text/html")
  ) {
    return response;
  }

  return {
    ...response,
    body: response.body.includes("</body>")
      ? response.body.replace("</body>", `${createLiveReloadSnippet()}</body>`)
      : `${response.body}${createLiveReloadSnippet()}`,
  };
}

function createLiveReloadSnippet() {
  return `<script data-evolit-live-reload>const evolitProtocol=window.location.protocol==="https:"?"wss:":"ws:";const evolitSocket=new WebSocket(evolitProtocol+"//"+window.location.host+${JSON.stringify(LIVE_RELOAD_PATHNAME)});evolitSocket.addEventListener("message",({data})=>{if(data==="reload")window.location.reload()});</script>`;
}

async function createRecursiveDirectoryWatcher(rootDirectory, onChange) {
  const watchers = new Map();
  let closed = false;

  async function watchDirectory(directory) {
    if (closed || watchers.has(directory)) {
      return;
    }

    let watcher;
    try {
      watcher = watch(directory, (eventType, fileName) => {
        onChange(fileName ? path.join(directory, String(fileName)) : null);

        if (eventType === "rename" && fileName) {
          void watchNewDirectory(path.join(directory, fileName));
        }
      });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      return;
    }

    // A deleted directory may emit an error after its watcher has been installed.
    watcher.on("error", () => {});
    watchers.set(directory, watcher);

    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return;
      }
      throw error;
    }

    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => watchDirectory(path.join(directory, entry.name))),
    );
  }

  async function watchNewDirectory(candidate) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        await watchDirectory(candidate);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  await watchDirectory(rootDirectory);

  return {
    close() {
      closed = true;
      for (const watcher of watchers.values()) {
        watcher.close();
      }
      watchers.clear();
    },
  };
}

async function createServer(projectRoot, mode, explicitPort, options = {}) {
  const reportDevelopmentEvent = mode === "development"
    ? options.onDevelopmentEvent ?? ((event) => {
      switch (event.type) {
        case "initializing":
          console.log(`${terminal.cyan("[evolit]")} ${terminal.yellow("○")} Preparing development runtime…`);
          break;
        case "vendor-runtime-ready":
          console.log(`${terminal.cyan("[evolit]")} ${terminal.green("✓")} Vendor runtime ready.`);
          break;
        case "client-assets-building":
          console.log(`${terminal.cyan("[evolit]")} ${terminal.magenta("○")} Compiling client assets (${event.entryCount} entries)…`);
          break;
        case "client-assets-ready":
          console.log(`${terminal.cyan("[evolit]")} ${terminal.green("✓")} Client assets compiled in ${terminal.dim(`${event.durationMs}ms`)} (${event.entryCount} entries).`);
          break;
        case "client-assets-cache-hit":
          console.log(`${terminal.cyan("[evolit]")} ${terminal.blue("●")} Client assets served from cache.`);
          break;
        case "invalidated":
          console.log(
            `${terminal.cyan("[evolit]")} ${terminal.yellow("△")} Source change detected${event.changedPathCount == null ? "" : ` (${event.changedPathCount} files)`}; invalidated ${event.affectedClientEntryCount} client entries.`,
          );
          break;
        case "external-import":
          console.warn(
            `${terminal.yellow("[evolit]")} ${terminal.yellow("⚠")} Development import ${terminal.cyan(JSON.stringify(event.resolvedImportPath))} from ${terminal.cyan(JSON.stringify(event.sourcePath))} is outside the project root. It will be emitted under ${terminal.cyan("/_evolit/static/__external__/")}.`,
          );
          break;
        case "request": {
          const statusColor = event.status >= 500
            ? terminal.red
            : event.status >= 400
              ? terminal.yellow
              : event.status >= 300
                ? terminal.blue
                : terminal.green;
          console.log(
            `${terminal.cyan("[evolit]")} ${terminal.dim(event.method)} ${event.pathname} ${statusColor(event.status)} in ${terminal.dim(`${event.durationMs}ms`)}${event.cacheState ? ` ${terminal.blue(`(${event.cacheState})`)}` : ""}`,
          );
          break;
        }
        case "request-error":
          console.error(
            `${terminal.red("[evolit]")} ${terminal.red("✖")} ${event.method} ${event.pathname} failed`,
            event.error,
          );
          break;
        default:
          break;
      }
    })
    : null;
  const evolitConfig = options.evolitConfig ?? await loadEvolitConfig(projectRoot);
  const responseCacheRuntime = options.responseCacheStore
    ? {
      store: options.responseCacheStore,
      createKey: options.createResponseCacheKey ?? (({ request }) => createDefaultRouteCacheKey(request)),
    }
    : await resolveResponseCacheRuntime(projectRoot, mode, evolitConfig);
  const deploymentRuntime = await createDeploymentRuntime({
    projectRoot,
    mode,
    assetManifest: normalizeClientAssetManifest(options.assetManifest),
    responseCacheRuntime,
    onDevelopmentEvent: reportDevelopmentEvent,
  });
  const port = getPort(explicitPort);
  const liveReloadServer = mode === "development" ? new WebSocketServer({ noServer: true }) : null;
  const liveReloadSockets = new Set();
  liveReloadServer?.on("connection", (socket) => {
    liveReloadSockets.add(socket);
    socket.on("close", () => {
      liveReloadSockets.delete(socket);
    });
  });
  let invalidationTimer = null;
  let pendingInvalidation = null;
  let resolvePendingInvalidation = null;
  let invalidationPromise = Promise.resolve();
  const pendingChangedPaths = new Set();

  function scheduleDevelopmentInvalidation(changedPath = null) {
    if (changedPath) {
      pendingChangedPaths.add(path.resolve(changedPath));
    }
    if (invalidationTimer) {
      clearTimeout(invalidationTimer);
    }

    if (!pendingInvalidation) {
      pendingInvalidation = new Promise((resolve) => {
        resolvePendingInvalidation = resolve;
      });
    }

    invalidationTimer = setTimeout(() => {
      invalidationTimer = null;
      const resolve = resolvePendingInvalidation;
      const changedPaths = pendingChangedPaths.size > 0
        ? [...pendingChangedPaths]
        : null;
      pendingChangedPaths.clear();
      pendingInvalidation = null;
      resolvePendingInvalidation = null;
      invalidationPromise = invalidationPromise
        .catch(() => {})
        .then(() => deploymentRuntime.invalidateDevelopmentState(changedPaths));
      invalidationPromise.then(
        () => {
          for (const socket of liveReloadSockets) {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send("reload");
            }
          }
          resolve();
        },
        resolve,
      );
    }, 40);
  }

  const watcher = mode === "development"
    ? await createRecursiveDirectoryWatcher(
      path.join(projectRoot, APP_DIRECTORY),
      scheduleDevelopmentInvalidation,
    )
    : null;

  const server = http.createServer(async (req, res) => {
    try {
      const origin = `http://${req.headers.host ?? `localhost:${port}`}`;
      const pathname = new URL(req.url ?? "/", origin).pathname;
      await pendingInvalidation;
      await invalidationPromise;
      const method = req.method ?? "GET";
      const request = new Request(new URL(req.url ?? "/", origin), {
        method,
        headers: req.headers,
        ...(method === "GET" || method === "HEAD" ? {} : { body: req, duplex: "half" }),
      });
      const requestStartedAt = performance.now();
      const response = await deploymentRuntime.handle(request);
      const servedResponse = mode === "development"
        ? injectLiveReloadSnippet(response)
        : response;

      res.writeHead(servedResponse.status, servedResponse.headers);
      await writeResponseBody(res, servedResponse.body);
      if (mode === "development" && !pathname.startsWith("/_evolit/")) {
        const durationMs = Math.round(performance.now() - requestStartedAt);
        reportDevelopmentEvent({
          type: "request",
          method,
          pathname,
          status: servedResponse.status,
          durationMs,
          cacheState: servedResponse.headers?.["x-evolit-cache"] ?? null,
        });
      }
    } catch (error) {
      reportDevelopmentEvent?.({
        type: "request-error",
        method: req.method ?? "GET",
        pathname: req.url ?? "/",
        error,
      });
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.stack ?? error.message : String(error));
    }
  });

  server.on("upgrade", (request, socket, head) => {
    const origin = `http://${request.headers.host ?? `localhost:${port}`}`;
    const pathname = new URL(request.url ?? "/", origin).pathname;
    if (!liveReloadServer || pathname !== LIVE_RELOAD_PATHNAME) {
      socket.destroy();
      return;
    }

    liveReloadServer.handleUpgrade(request, socket, head, (webSocket) => {
      liveReloadServer.emit("connection", webSocket, request);
    });
  });

  return {
    port,
    deploymentRuntime,
    async listen() {
      await new Promise((resolve) => {
        server.listen(port, resolve);
      });
      return server;
    },
    async close() {
      if (invalidationTimer) {
        clearTimeout(invalidationTimer);
      }
      watcher?.close();
      for (const socket of liveReloadSockets) {
        socket.close();
      }
      if (liveReloadServer) {
        await new Promise((resolve) => {
          liveReloadServer.close(resolve);
        });
      }
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await deploymentRuntime.close?.();
    },
  };
}

export async function createDevServer(projectRoot, options = {}) {
  return createServer(projectRoot, "development", options.port, options);
}

export async function createStartServer(projectRoot, options = {}) {
  const manifestPath = path.join(
    projectRoot,
    INTERNAL_DIRECTORY,
    BUILD_DIRECTORY,
    MANIFEST_FILENAME,
  );

  if (!(await pathExists(manifestPath))) {
    throw new Error("Build output not found. Run `yarn build` before `yarn start`.");
  }

  const manifest = await readJson(manifestPath);
  return createServer(projectRoot, "production", options.port, {
    ...options,
    assetManifest: manifest.clientAssets ?? null,
  });
}
