import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createRouteResolver } from "./render.js";
import { createSsrAdapter, renderRouteTreeWithAdapter } from "./ssr-adapter.js";
import { compileModuleGraph } from "./compiler.js";
import { loadNextsxConfig } from "./config.js";
import {
  BUILD_DIRECTORY,
  INTERNAL_DIRECTORY,
  MANIFEST_FILENAME,
} from "./constants.js";
import {
  createAssetResolver,
  collectDevStyleUrls,
  collectTransitiveAssetPreloads,
  collectTransitiveStyleUrls,
  createHydrationBootstrap,
  createFrameworkImportMap,
  getAssetByPublicUrl,
  getClientOutputRoot,
  normalizeClientAssetManifest,
} from "./client-assets.js";
import { pathExists, readJson } from "./fs-utils.js";
import { createRequire } from "node:module";
import {
  createDefaultRouteCacheKey,
  createCachedRouteResponse,
  isCachedRouteResponseFresh,
  resolveResponseCacheRuntime,
} from "./response-cache.js";

const requireFromHere = createRequire(import.meta.url);

const CONTENT_TYPE_BY_EXTENSION = new Map([
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
]);

function getContentType(filePath) {
  return CONTENT_TYPE_BY_EXTENSION.get(path.extname(filePath)) ?? "application/octet-stream";
}

function getPort(explicitPort) {
  const port = explicitPort ?? process.env.PORT ?? "3000";
  return Number.parseInt(String(port), 10);
}

function getClientAssetFilePath(projectRoot, mode, pathname) {
  const clientRoot = getClientOutputRoot(projectRoot, mode);
  const relativePath = decodeURIComponent(pathname.slice("/_nextsx/client/".length));
  return path.join(clientRoot, relativePath);
}

async function sendFileResponse(res, filePath, contentType = getContentType(filePath)) {
  const body = await fs.readFile(filePath);
  res.writeHead(200, { "content-type": contentType });
  res.end(body);
}

function applyRouteCacheHeaders(response, cachePolicy) {
  const headers = { ...(response.headers ?? {}) };

  if (cachePolicy?.mode === "static") {
    headers["cache-control"] = "public, max-age=31536000, immutable";
  } else if (cachePolicy?.mode === "revalidate") {
    headers["cache-control"] = `public, max-age=${cachePolicy.ttlSeconds}`;
  } else {
    headers["cache-control"] = "no-store";
  }

  return {
    ...response,
    headers,
  };
}

async function createServer(projectRoot, mode, explicitPort, options = {}) {
  const nextsxConfig = options.nextsxConfig ?? await loadNextsxConfig(projectRoot);
  const assetManifest = normalizeClientAssetManifest(options.assetManifest);
  const routeResolver = await createRouteResolver(projectRoot, mode);
  const assetResolver = createAssetResolver(projectRoot, {
    assetManifest,
  });
  const responseCacheRuntime = options.responseCacheStore
    ? {
      store: options.responseCacheStore,
      createKey: options.createResponseCacheKey ?? (({ request }) => createDefaultRouteCacheKey(request)),
    }
    : await resolveResponseCacheRuntime(projectRoot, mode, nextsxConfig);
  const frameworkImportMap = await createFrameworkImportMap();
  const importMapMarkup = `<script type="importmap">${JSON.stringify(frameworkImportMap)}</script>`;
  const ssrAdapter = createSsrAdapter({
    assetResolver,
    head: importMapMarkup,
    async resolveAdditionalHead({ result }) {
      const clientImports = Array.isArray(result.clientImports) ? result.clientImports : [];
      const urls = assetManifest
        ? collectTransitiveAssetPreloads(clientImports, assetManifest)
        : [];
      const styleUrls = assetManifest
        ? collectTransitiveStyleUrls(clientImports, assetManifest)
        : await collectDevStyleUrls(projectRoot, clientImports, mode);
      if (urls.length === 0 && styleUrls.length === 0) {
        return "";
      }

      return [
        ...urls.map((href) => `<link rel="modulepreload" href="${href}">`),
        ...styleUrls.map((href) => `<link rel="stylesheet" href="${href}">`),
      ].join("\n");
    },
    resolveBootstrap({ result }) {
      return createHydrationBootstrap({
        hydrationData: result.hydrationData,
        assetResolver,
      });
    },
  });
  const port = getPort(explicitPort);

  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? "/", `http://localhost:${port}`).pathname;

      if (pathname.startsWith("/_nextsx/client/")) {
        const assetPath = getClientAssetFilePath(projectRoot, mode, pathname);
        await sendFileResponse(res, assetPath);
        return;
      }

      if (pathname.startsWith("/_nextsx/static/")) {
        const decodedPathname = decodeURIComponent(pathname);
        const assetPath = getAssetByPublicUrl(assetManifest, decodedPathname)
          ?.outputPath
          ?? getAssetByPublicUrl(assetManifest, pathname)?.outputPath
          ?? null;
        if (!assetPath) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("Asset not found.");
          return;
        }
        await sendFileResponse(res, assetPath);
        return;
      }

      if (pathname.startsWith("/_nextsx/pkg/")) {
        const specifier = decodeURIComponent(pathname.slice("/_nextsx/pkg/".length));
        const packageFile = requireFromHere.resolve(specifier);
        await sendFileResponse(res, packageFile);
        return;
      }

      const origin = `http://${req.headers.host ?? `localhost:${port}`}`;
      const request = new Request(new URL(req.url ?? "/", origin), {
        method: req.method,
        headers: req.headers,
      });
      const routePolicyResult = await routeResolver.resolveRoutePolicy(request);

      if (routePolicyResult.type === "route" && routePolicyResult.cachePolicy.mode !== "dynamic") {
        const cacheKey = await responseCacheRuntime.createKey({
          request,
          routeResult: routePolicyResult,
        });
        const cachedResponse = await responseCacheRuntime.store.get(cacheKey);
        if (isCachedRouteResponseFresh(cachedResponse)) {
          const response = applyRouteCacheHeaders({
            status: cachedResponse.status,
            headers: {
              ...cachedResponse.headers,
              "x-nextsx-cache": "HIT",
            },
            body: cachedResponse.body,
          }, routePolicyResult.cachePolicy);

          res.writeHead(response.status, response.headers);
          res.end(response.body);
          return;
        }
      }

      const routeResult = await routeResolver.resolveRequest(request);

      if (routeResult.type === "route") {
        await compileModuleGraph(routeResult.route.page, {
          projectRoot,
          mode,
          sourceMaps: mode === "development",
          target: "client",
        });

        for (const layoutPath of routeResult.route.layouts) {
          await compileModuleGraph(layoutPath, {
            projectRoot,
            mode,
            sourceMaps: mode === "development",
            target: "client",
          });
        }
      }

      let response = await renderRouteTreeWithAdapter(routeResult, ssrAdapter);

      if (routeResult.type === "route") {
        response = applyRouteCacheHeaders(response, routeResult.cachePolicy);
        if (routeResult.cachePolicy.mode !== "dynamic" && response.status === 200) {
          const cacheKey = await responseCacheRuntime.createKey({
            request,
            routeResult,
          });
          await responseCacheRuntime.store.put(
            cacheKey,
            createCachedRouteResponse(response, routeResult.cachePolicy),
          );
          response.headers = {
            ...response.headers,
            "x-nextsx-cache": "MISS",
          };
        } else {
          response.headers = {
            ...response.headers,
            "x-nextsx-cache": "SKIP",
          };
        }
      }

      res.writeHead(response.status, response.headers);
      res.end(response.body);
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.stack ?? error.message : String(error));
    }
  });

  return {
    port,
    async listen() {
      await new Promise((resolve) => {
        server.listen(port, resolve);
      });
      return server;
    },
    close() {
      server.close();
    },
  };
}

export async function createDevServer(projectRoot, options = {}) {
  return createServer(projectRoot, "development", options.port);
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
    assetManifest: manifest.clientAssets ?? null,
  });
}
