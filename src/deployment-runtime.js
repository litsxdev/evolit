import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { compileModuleGraph } from "./compiler.js";
import {
  collectDevStyleUrls,
  collectTransitiveAssetPreloads,
  collectTransitiveStyleUrls,
  createAssetResolver,
  createFrameworkImportMap,
  createHydrationBootstrap,
  getAssetByPublicUrl,
  getClientOutputRoot,
  normalizeClientAssetManifest,
} from "./client-assets.js";
import { loadNextsxConfig } from "./config.js";
import { createRouteResolver } from "./render.js";
import {
  createCachedRouteResponse,
  createDefaultRouteCacheKey,
  isCachedRouteResponseFresh,
  resolveResponseCacheRuntime,
} from "./response-cache.js";
import { createSsrAdapter, renderRouteTreeWithAdapter } from "./ssr-adapter.js";

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

function getClientAssetFilePath(projectRoot, mode, pathname) {
  const clientRoot = getClientOutputRoot(projectRoot, mode);
  const relativePath = decodeURIComponent(pathname.slice("/_nextsx/client/".length));
  return path.join(clientRoot, relativePath);
}

function applyRouteCacheHeaders(response, cachePolicy) {
  const headers = { ...(response.headers ?? {}) };

  if (cachePolicy?.mode === "static") {
    headers["cache-control"] = "public, max-age=31536000, immutable";
  } else if (cachePolicy?.mode === "revalidate") {
    headers["cache-control"] = `public, max-age=${cachePolicy.ttlSeconds}, stale-while-revalidate=${cachePolicy.ttlSeconds}`;
  } else {
    headers["cache-control"] = "no-store";
  }

  return {
    ...response,
    headers,
  };
}

export function createPublicAssetOrigin({ projectRoot, mode, assetManifest }) {
  const normalizedAssetManifest = normalizeClientAssetManifest(assetManifest);

  return {
    async resolve(pathname) {
      if (pathname.startsWith("/_nextsx/client/")) {
        const filePath = getClientAssetFilePath(projectRoot, mode, pathname);
        return {
          filePath,
          contentType: getContentType(filePath),
        };
      }

      if (pathname.startsWith("/_nextsx/static/")) {
        const decodedPathname = decodeURIComponent(pathname);
        const filePath = getAssetByPublicUrl(normalizedAssetManifest, decodedPathname)?.outputPath
          ?? getAssetByPublicUrl(normalizedAssetManifest, pathname)?.outputPath
          ?? null;
        if (!filePath) {
          return null;
        }

        return {
          filePath,
          contentType: getContentType(filePath),
        };
      }

      if (pathname.startsWith("/_nextsx/pkg/")) {
        const specifier = decodeURIComponent(pathname.slice("/_nextsx/pkg/".length));
        const filePath = requireFromHere.resolve(specifier);
        return {
          filePath,
          contentType: getContentType(filePath),
        };
      }

      return null;
    },
    async read(pathname) {
      const asset = await this.resolve(pathname);
      if (!asset) {
        return null;
      }

      return {
        status: 200,
        headers: { "content-type": asset.contentType },
        body: await fs.readFile(asset.filePath),
      };
    },
  };
}

export function createResponseCacheController({ responseCacheRuntime }) {
  return {
    async getCacheKey(request, routeResult) {
      return responseCacheRuntime.createKey({
        request,
        routeResult,
      });
    },
    createResponse(routeResult, response, cacheState) {
      const nextResponse = applyRouteCacheHeaders(response, routeResult.cachePolicy);
      if (!cacheState) {
        return nextResponse;
      }

      return {
        ...nextResponse,
        headers: {
          ...nextResponse.headers,
          "x-nextsx-cache": cacheState,
        },
      };
    },
    async read(request, routeResult) {
      if (routeResult.type !== "route" || routeResult.cachePolicy.mode === "dynamic") {
        return null;
      }

      const cacheKey = await this.getCacheKey(request, routeResult);
      const cachedResponse = await responseCacheRuntime.store.get(cacheKey);
      if (!cachedResponse) {
        return null;
      }

      const response = this.createResponse(routeResult, {
        status: cachedResponse.status,
        headers: { ...cachedResponse.headers },
        body: cachedResponse.body,
      }, isCachedRouteResponseFresh(cachedResponse) ? "HIT" : "STALE");

      return {
        cacheKey,
        entry: cachedResponse,
        fresh: isCachedRouteResponseFresh(cachedResponse),
        response,
      };
    },
    async store(request, routeResult, response, cacheKey) {
      if (routeResult.type !== "route") {
        return false;
      }

      const nextResponse = applyRouteCacheHeaders(response, routeResult.cachePolicy);
      if (routeResult.cachePolicy.mode !== "dynamic" && nextResponse.status === 200) {
        const effectiveCacheKey = cacheKey ?? await this.getCacheKey(request, routeResult);
        await responseCacheRuntime.store.put(
          effectiveCacheKey,
          createCachedRouteResponse(nextResponse, routeResult.cachePolicy),
        );
        return true;
      }

      return false;
    },
    async write(request, routeResult, response, options = {}) {
      const didStore = await this.store(
        request,
        routeResult,
        response,
        options.cacheKey,
      );

      return this.createResponse(
        routeResult,
        response,
        options.cacheState ?? (didStore ? "MISS" : "SKIP"),
      );
    },
  };
}

export async function createRequestRenderer({ projectRoot, mode, assetManifest, routeResolver, responseCacheRuntime }) {
  const normalizedAssetManifest = normalizeClientAssetManifest(assetManifest);
  const effectiveRouteResolver = routeResolver ?? await createRouteResolver(projectRoot, mode);
  const assetResolver = createAssetResolver(projectRoot, {
    assetManifest: normalizedAssetManifest,
  });
  const frameworkImportMap = await createFrameworkImportMap();
  const importMapMarkup = `<script type="importmap">${JSON.stringify(frameworkImportMap)}</script>`;
  const ssrAdapter = createSsrAdapter({
    assetResolver,
    head: importMapMarkup,
    async resolveAdditionalHead({ result }) {
      const clientImports = Array.isArray(result.clientImports) ? result.clientImports : [];
      const urls = normalizedAssetManifest
        ? collectTransitiveAssetPreloads(clientImports, normalizedAssetManifest)
        : [];
      const styleUrls = normalizedAssetManifest
        ? collectTransitiveStyleUrls(clientImports, normalizedAssetManifest)
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
  const responseCacheController = createResponseCacheController({
    responseCacheRuntime: responseCacheRuntime ?? {
      store: { get: async () => null, put: async () => {} },
      createKey: ({ request }) => createDefaultRouteCacheKey(request),
    },
  });

  return {
    routeResolver: effectiveRouteResolver,
    responseCacheController,
    async prepareRouteClientArtifacts(routeResult) {
      if (routeResult.type !== "route") {
        return;
      }

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
    },
    async resolveRoutePolicy(request) {
      return effectiveRouteResolver.resolveRoutePolicy(request);
    },
    async renderRoute(request) {
      const routeResult = await effectiveRouteResolver.resolveRequest(request);
      await this.prepareRouteClientArtifacts(routeResult);
      const response = await renderRouteTreeWithAdapter(routeResult, ssrAdapter);
      return {
        routeResult,
        response,
      };
    },
  };
}

export async function createDeploymentRuntime({
  projectRoot,
  mode,
  assetManifest,
  responseCacheRuntime,
  routeResolver,
} = {}) {
  const effectiveResponseCacheRuntime = responseCacheRuntime
    ?? await resolveResponseCacheRuntime(
      projectRoot,
      mode,
      await loadNextsxConfig(projectRoot),
    );
  const assets = createPublicAssetOrigin({
    projectRoot,
    mode,
    assetManifest,
  });
  const renderer = await createRequestRenderer({
    projectRoot,
    mode,
    assetManifest,
    responseCacheRuntime: effectiveResponseCacheRuntime,
    routeResolver,
  });

  return {
    assets,
    cache: renderer.responseCacheController,
    renderer,
    async handle(request) {
      const revalidationTasks = this.revalidationTasks ??= new Map();
      const pathname = new URL(request.url).pathname;
      const assetResponse = await assets.read(pathname);
      if (assetResponse) {
        return assetResponse;
      }

      const routePolicyResult = await renderer.resolveRoutePolicy(request);
      const cachedResponse = await renderer.responseCacheController.read(request, routePolicyResult);
      if (cachedResponse) {
        if (cachedResponse.fresh) {
          return cachedResponse.response;
        }

        if (
          routePolicyResult.type === "route"
          && routePolicyResult.cachePolicy.mode === "revalidate"
          && !revalidationTasks.has(cachedResponse.cacheKey)
        ) {
          const revalidationTask = (async () => {
            try {
              const { routeResult, response } = await renderer.renderRoute(request);
              await renderer.responseCacheController.store(
                request,
                routeResult,
                response,
                cachedResponse.cacheKey,
              );
            } finally {
              revalidationTasks.delete(cachedResponse.cacheKey);
            }
          })();
          revalidationTasks.set(cachedResponse.cacheKey, revalidationTask);
        }

        return cachedResponse.response;
      }

      const { routeResult, response } = await renderer.renderRoute(request);
      return renderer.responseCacheController.write(request, routeResult, response);
    },
  };
}
