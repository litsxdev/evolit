import http from "node:http";
import { watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { loadEvolitConfig, resolveManagedSourceRoots } from "./config.js";
import { createDeploymentRuntime } from "./deployment-runtime.js";
import { BUILD_DIRECTORY, INTERNAL_DIRECTORY, MANIFEST_FILENAME } from "./constants.js";
import { normalizeClientAssetManifest } from "./client-assets.js";
import { pathExists, readJson } from "./fs-utils.js";
import { createDefaultRouteCacheKey, resolveResponseCacheRuntime } from "./response-cache.js";
import { createDevelopmentEventReporter } from "./development-events.js";
import { createNavigationResponseFromDocument } from "./route-segments.js";

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
  return `<script data-evolit-live-reload>(()=>{const protocol=location.protocol==="https:"?"wss:":"ws:";let socket;let connected=false;const subscribe=()=>{if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:"subscribe",url:location.href}))};const connect=()=>{socket=new WebSocket(protocol+"//"+location.host+${JSON.stringify(LIVE_RELOAD_PATHNAME)});socket.addEventListener("open",()=>{if(connected){location.reload();return}connected=true;subscribe()});socket.addEventListener("message",({data})=>{let update;try{update=JSON.parse(data)}catch{location.reload();return}if(update?.type==="reload"){location.reload();return}if(update?.type!=="update"||update.url!==location.href){return}const detail={update,handled:false,result:null};dispatchEvent(new CustomEvent("evolit:development-refresh",{detail}));if(!detail.handled){location.reload();return}Promise.resolve(detail.result).then((applied)=>{if(!applied)location.reload()}).catch(()=>location.reload())});socket.addEventListener("close",()=>setTimeout(connect,250))};addEventListener("popstate",subscribe);addEventListener("evolit:navigation",subscribe);connect()})();</script>`;
}

function createDevelopmentNavigationRequest(subscription, origin) {
  const headers = new Headers(subscription.headers);
  headers.set("accept", "application/vnd.evolit.navigation+json");
  for (const name of ["connection", "upgrade", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions"]) {
    headers.delete(name);
  }
  return new Request(new URL(subscription.url, origin), { headers });
}

function annotateDevelopmentSegmentRevisions(delta, revisions) {
  if (delta?.type !== "route" || !Array.isArray(delta.route?.segments)) return delta;
  return {
    ...delta,
    route: {
      ...delta.route,
      segments: delta.route.segments.map((segment) => {
        const revision = revisions.get(segment.modulePath);
        return revision == null ? segment : { ...segment, revision };
      }),
    },
  };
}

async function createRecursiveDirectoryWatcher(rootDirectory, onChange, options = {}) {
  const watchers = new Map();
  const shouldIgnorePath = options.shouldIgnorePath ?? (() => false);
  let closed = false;

  async function watchDirectory(directory) {
    if (closed || watchers.has(directory) || shouldIgnorePath(directory)) {
      return;
    }

    let watcher;
    try {
      watcher = watch(directory, (eventType, fileName) => {
        const changedPath = fileName ? path.join(directory, String(fileName)) : null;
        if (!changedPath || !shouldIgnorePath(changedPath)) {
          onChange(changedPath);
        }

        if (eventType === "rename" && changedPath && !shouldIgnorePath(changedPath)) {
          void watchNewDirectory(changedPath);
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
    if (shouldIgnorePath(candidate)) {
      return;
    }

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

function createSourceWatchIgnorePath(sourceRoot) {
  const ignoredDirectoryNames = new Set([
    "node_modules",
    INTERNAL_DIRECTORY,
    ".git",
  ]);

  return (candidate) => {
    const relativePath = path.relative(sourceRoot, candidate);
    if (
      relativePath === ".."
      || relativePath.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativePath)
    ) {
      return true;
    }

    return relativePath
      .split(path.sep)
      .some((segment) => ignoredDirectoryNames.has(segment));
  };
}

async function createServer(projectRoot, mode, explicitPort, options = {}) {
  const reportDevelopmentEvent = mode === "development"
    ? options.onDevelopmentEvent ?? createDevelopmentEventReporter()
    : null;
  reportDevelopmentEvent?.({ type: "server-starting" });
  const evolitConfig = options.evolitConfig ?? await loadEvolitConfig(projectRoot);
  const managedSourceRoots = resolveManagedSourceRoots(projectRoot, evolitConfig);
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
    managedSourceRoots,
  });
  const port = getPort(explicitPort);
  const liveReloadServer = mode === "development" ? new WebSocketServer({ noServer: true }) : null;
  const liveReloadSockets = new Map();
  liveReloadServer?.on("connection", (socket, request) => {
    const subscription = { url: null, headers: request.headers };
    liveReloadSockets.set(socket, subscription);
    socket.on("message", (message) => {
      try {
        const payload = JSON.parse(String(message));
        if (payload?.type !== "subscribe" || typeof payload.url !== "string") return;
        const origin = `http://${request.headers.host ?? `localhost:${port}`}`;
        const url = new URL(payload.url, origin);
        if (url.origin !== new URL(origin).origin) return;
        subscription.url = url.href;
      } catch {
        // Ignore malformed development protocol messages.
      }
    });
    socket.on("close", () => {
      liveReloadSockets.delete(socket);
    });
  });
  let invalidationTimer = null;
  let pendingInvalidation = null;
  let resolvePendingInvalidation = null;
  let invalidationPromise = Promise.resolve();
  const pendingChangedPaths = new Set();
  let developmentVersion = 0;
  const segmentRevisions = new Map();

  async function pushDevelopmentUpdates(changedPaths, invalidationResult) {
    developmentVersion += 1;
    for (const modulePath of invalidationResult?.affectedRouteEntryPaths ?? []) {
      segmentRevisions.set(modulePath, developmentVersion);
    }
    const strategy = (invalidationResult?.affectedClientEntryCount ?? 0) > 0 ? "hot" : "delta";
    const renders = new Map();
    await Promise.all([...liveReloadSockets].map(async ([socket, subscription]) => {
      if (socket.readyState !== WebSocket.OPEN || !subscription.url) return;
      const cacheKey = JSON.stringify([
        subscription.url,
        subscription.headers.cookie ?? "",
        subscription.headers.authorization ?? "",
        subscription.headers["accept-language"] ?? "",
      ]);
      let pending = renders.get(cacheKey);
      if (!pending) {
        pending = (async () => {
          const origin = `http://${subscription.headers.host ?? `localhost:${port}`}`;
          const response = await deploymentRuntime.handle(
            createDevelopmentNavigationRequest(subscription, origin),
          );
          const navigationResponse = createNavigationResponseFromDocument(response);
          if (!getResponseHeader(navigationResponse.headers, "content-type")
            ?.includes("application/vnd.evolit.navigation+json")) return null;
          const delta = JSON.parse(navigationResponse.body);
          return annotateDevelopmentSegmentRevisions(delta, segmentRevisions);
        })();
        renders.set(cacheKey, pending);
      }
      try {
        const delta = await pending;
        if (!delta) {
          socket.send(JSON.stringify({ type: "reload", version: developmentVersion }));
          return;
        }
        socket.send(JSON.stringify({
          type: "update",
          strategy,
          version: developmentVersion,
          url: subscription.url,
          delta,
        }));
      } catch {
        socket.send(JSON.stringify({ type: "reload", version: developmentVersion }));
      }
    }));
    reportDevelopmentEvent?.({
      type: "live-update",
      strategy,
      affectedClientEntryCount: invalidationResult?.affectedClientEntryCount ?? null,
      subscriberCount: liveReloadSockets.size,
    });
  }

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
        .then(async () => {
          const invalidationResult = await deploymentRuntime.invalidateDevelopmentState(changedPaths);
          await pushDevelopmentUpdates(changedPaths, invalidationResult);
          return invalidationResult;
        });
      invalidationPromise.then(resolve, resolve);
    }, 40);
  }

  const watchers = mode === "development"
    ? await Promise.all(managedSourceRoots.map((sourceRoot) => createRecursiveDirectoryWatcher(
      sourceRoot,
      scheduleDevelopmentInvalidation,
      { shouldIgnorePath: createSourceWatchIgnorePath(sourceRoot) },
    )))
    : [];

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
      const navigationResponse = String(req.headers.accept ?? "").includes("application/vnd.evolit.navigation+json")
        ? createNavigationResponseFromDocument(response)
        : response;
      const servedResponse = mode === "development"
        ? injectLiveReloadSnippet(navigationResponse)
        : navigationResponse;

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
      reportDevelopmentEvent?.({ type: "server-ready", port });
      return server;
    },
    async close() {
      if (invalidationTimer) {
        clearTimeout(invalidationTimer);
      }
      for (const watcher of watchers) watcher.close();
      for (const socket of liveReloadSockets.keys()) {
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
