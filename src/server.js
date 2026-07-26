import http from "node:http";
import { watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { loadEvolitConfig } from "./config.js";
import { createDeploymentRuntime } from "./deployment-runtime.js";
import { APP_DIRECTORY, BUILD_DIRECTORY, INTERNAL_DIRECTORY, MANIFEST_FILENAME } from "./constants.js";
import { normalizeClientAssetManifest } from "./client-assets.js";
import { pathExists, readJson } from "./fs-utils.js";
import { createDefaultRouteCacheKey, resolveResponseCacheRuntime } from "./response-cache.js";

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
const LIVE_RELOAD_SNIPPET = `<script data-evolit-live-reload>if (typeof EventSource !== "undefined") { const source = new EventSource(${JSON.stringify(LIVE_RELOAD_PATHNAME)}); source.addEventListener("reload", () => window.location.reload()); }</script>`;

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
      ? response.body.replace("</body>", `${LIVE_RELOAD_SNIPPET}</body>`)
      : `${response.body}${LIVE_RELOAD_SNIPPET}`,
  };
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
        onChange();

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
  });
  const port = getPort(explicitPort);
  const liveReloadConnections = new Set();
  let invalidationTimer = null;
  let pendingInvalidation = null;
  let resolvePendingInvalidation = null;
  let invalidationPromise = Promise.resolve();

  function scheduleDevelopmentInvalidation() {
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
      pendingInvalidation = null;
      resolvePendingInvalidation = null;
      invalidationPromise = invalidationPromise
        .catch(() => {})
        .then(() => deploymentRuntime.invalidateDevelopmentState());
      invalidationPromise.then(
        () => {
          for (const connection of liveReloadConnections) {
            connection.write("event: reload\\ndata: update\\n\\n");
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
      if (mode === "development" && pathname === LIVE_RELOAD_PATHNAME) {
        res.writeHead(200, {
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "content-type": "text/event-stream",
        });
        res.write("retry: 1000\\n\\n");
        liveReloadConnections.add(res);
        res.on("close", () => {
          liveReloadConnections.delete(res);
        });
        return;
      }

      await pendingInvalidation;
      await invalidationPromise;
      const method = req.method ?? "GET";
      const request = new Request(new URL(req.url ?? "/", origin), {
        method,
        headers: req.headers,
        ...(method === "GET" || method === "HEAD" ? {} : { body: req, duplex: "half" }),
      });
      const response = await deploymentRuntime.handle(request);
      const servedResponse = mode === "development" ? injectLiveReloadSnippet(response) : response;

      res.writeHead(servedResponse.status, servedResponse.headers);
      await writeResponseBody(res, servedResponse.body);
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.stack ?? error.message : String(error));
    }
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
      for (const connection of liveReloadConnections) {
        connection.end();
      }
      liveReloadConnections.clear();
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
