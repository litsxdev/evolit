import fs from "node:fs/promises";
import path from "node:path";
import { compileModuleGraph } from "./compiler.js";
import {
  collectTransitiveAssetPreloads,
  collectTransitiveStyleUrls,
  createAssetResolver,
  createHydrationBootstrap,
  createStaticAssetPublicUrlMap,
  emitBundledClientAssetsWithState,
  getAssetByPublicUrl,
  getSharedOutputRoot,
  normalizeHydrationDataForClient,
  normalizeClientAssetManifest,
  resolveSharedVendorModuleUrl,
  resolveBrowserPackageAssetFilePath,
  rewriteHydrationDataScript,
} from "./client-assets.js";
import { loadNexelConfig } from "./config.js";
import { createRouteResolver } from "./render.js";
import {
  createCachedRouteResponse,
  createDefaultRouteCacheKey,
  isCachedRouteResponseFresh,
  resolveResponseCacheRuntime,
} from "./response-cache.js";
import { createSsrAdapter, renderRouteTreeWithAdapter } from "./ssr-adapter.js";
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
  [".map", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
]);

function getContentType(filePath) {
  return CONTENT_TYPE_BY_EXTENSION.get(path.extname(filePath)) ?? "application/octet-stream";
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

export function createPublicAssetOrigin({ projectRoot, mode, assetManifest, getAssetManifest }) {
  function resolveAssetManifest() {
    return normalizeClientAssetManifest(
      typeof getAssetManifest === "function" ? getAssetManifest() : assetManifest,
    );
  }

  return {
    async resolve(pathname) {
      if (pathname.startsWith("/_nexel/static/")) {
        const normalizedAssetManifest = resolveAssetManifest();
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

      if (pathname.startsWith("/_nexel/shared/")) {
        const sharedRoot = getSharedOutputRoot(projectRoot, mode);
        const relativePath = decodeURIComponent(pathname.slice("/_nexel/shared/".length));
        const filePath = path.join(sharedRoot, relativePath);
        return {
          filePath,
          contentType: getContentType(filePath),
        };
      }

      if (pathname.startsWith("/_nexel/pkg/")) {
        const filePath = await resolveBrowserPackageAssetFilePath(pathname);
        if (!filePath) {
          return null;
        }
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
          "x-nexel-cache": cacheState,
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
  let currentAssetManifest = normalizeClientAssetManifest(assetManifest);
  let currentAssetResolver = createAssetResolver(projectRoot, {
    assetManifest: currentAssetManifest,
  });
  let currentHydrationModuleUrl = await resolveSharedVendorModuleUrl(
    projectRoot,
    mode,
    "@litsx/ssr/hydration",
  );
  const devBundledEntries = new Set();
  let devRollupCache = null;
  const usesFrameworkRouteResolver = !routeResolver;
  async function createFrameworkRouteResolver() {
    return createRouteResolver(projectRoot, mode, {
      getStaticAssetPublicUrls() {
        return createStaticAssetPublicUrlMap(currentAssetManifest);
      },
    });
  }
  let effectiveRouteResolver = routeResolver ?? await createFrameworkRouteResolver();
  const ssrAdapter = createSsrAdapter({
    assetResolver(moduleId) {
      return currentAssetResolver(moduleId);
    },
    async resolveAdditionalHead({ result }) {
      const clientImports = Array.isArray(result.clientImports) ? result.clientImports : [];
      const urls = currentAssetManifest
        ? collectTransitiveAssetPreloads(clientImports, currentAssetManifest)
        : [];
      const styleUrls = currentAssetManifest
        ? collectTransitiveStyleUrls(clientImports, currentAssetManifest)
        : [];
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
        hydrationData: normalizeHydrationDataForClient(result.hydrationData, projectRoot),
        assetResolver(moduleId) {
          return currentAssetResolver(moduleId);
        },
        hydrationModuleUrl: currentHydrationModuleUrl,
      });
    },
    transformDocument({ result, document }) {
      return rewriteHydrationDataScript(
        document,
        normalizeHydrationDataForClient(result.hydrationData, projectRoot),
      );
    },
  });
  const responseCacheController = createResponseCacheController({
    responseCacheRuntime: responseCacheRuntime ?? {
      store: { get: async () => null, put: async () => {} },
      createKey: ({ request }) => createDefaultRouteCacheKey(request),
    },
  });

  return {
    get routeResolver() {
      return effectiveRouteResolver;
    },
    responseCacheController,
    async invalidateDevelopmentState() {
      if (mode !== "development") {
        return;
      }

      currentAssetManifest = null;
      currentAssetResolver = createAssetResolver(projectRoot, {
        assetManifest: currentAssetManifest,
      });
      devBundledEntries.clear();
      devRollupCache = null;

      if (usesFrameworkRouteResolver) {
        effectiveRouteResolver = await createFrameworkRouteResolver();
      }
    },
    async prepareRouteClientArtifacts(routeResult) {
      if (routeResult.type !== "route" && !routeResult.boundaryModule) {
        return;
      }

      const clientModules = [
        ...(routeResult.type === "route" ? [routeResult.route.page, ...routeResult.route.layouts] : []),
        ...(routeResult.boundaryModule ? [routeResult.boundaryModule] : []),
      ];

      for (const clientModule of new Set(clientModules)) {
        const clientBuild = await compileModuleGraph(clientModule, {
          projectRoot,
          mode,
          sourceMaps: mode === "development",
          target: "client",
        });
        devBundledEntries.add(
          path.relative(clientBuild.outputRoot, clientBuild.entrypoint).split(path.sep).join("/"),
        );
      }

      if (mode === "development") {
        const bundledClientAssets = await emitBundledClientAssetsWithState(projectRoot, {
          mode: "development",
          entryClientModules: devBundledEntries,
          rollupCache: devRollupCache,
        });
        currentAssetManifest = bundledClientAssets.manifest;
        currentAssetResolver = createAssetResolver(projectRoot, {
          assetManifest: currentAssetManifest,
        });
        currentHydrationModuleUrl = await resolveSharedVendorModuleUrl(
          projectRoot,
          mode,
          "@litsx/ssr/hydration",
          {
            assetManifest: currentAssetManifest,
            entryClientModules: [...devBundledEntries],
          },
        ) ?? currentHydrationModuleUrl;
        devRollupCache = bundledClientAssets.rollupCache;
      }
    },
    async resolveRoutePolicy(request) {
      return effectiveRouteResolver.resolveRoutePolicy(request);
    },
    async renderRoute(request, routePolicyResult = null) {
      const shouldPrepareBeforeResolve = mode === "development" && !currentAssetManifest;
      if (shouldPrepareBeforeResolve) {
        const resolvedRoutePolicyResult = routePolicyResult ?? await effectiveRouteResolver.resolveRoutePolicy(request);
        await this.prepareRouteClientArtifacts(resolvedRoutePolicyResult);
      }

      const routeResult = await effectiveRouteResolver.resolveRequest(request);
      if (!shouldPrepareBeforeResolve || routeResult.boundaryModule) {
        await this.prepareRouteClientArtifacts(routeResult);
      }
      const response = await renderRouteTreeWithAdapter(routeResult, ssrAdapter);
      return {
        routeResult,
        response,
      };
    },
    get assetManifest() {
      return currentAssetManifest;
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
      await loadNexelConfig(projectRoot),
    );
  const runtimeState = {
    assetManifest: normalizeClientAssetManifest(assetManifest),
  };
  const assets = createPublicAssetOrigin({
    projectRoot,
    mode,
    getAssetManifest() {
      return runtimeState.assetManifest;
    },
  });
  const renderer = await createRequestRenderer({
    projectRoot,
    mode,
    assetManifest: runtimeState.assetManifest,
    responseCacheRuntime: effectiveResponseCacheRuntime,
    routeResolver,
  });

  return {
    assets,
    cache: renderer.responseCacheController,
    renderer,
    async invalidateDevelopmentState() {
      if (mode !== "development") {
        return;
      }

      await renderer.invalidateDevelopmentState();
      if (typeof effectiveResponseCacheRuntime.store.clear === "function") {
        await effectiveResponseCacheRuntime.store.clear();
      }
      runtimeState.assetManifest = null;
    },
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
            const { routeResult, response } = await renderer.renderRoute(request, routePolicyResult);
            await renderer.responseCacheController.store(
              request,
              routeResult,
              response,
              cachedResponse.cacheKey,
            );
          })()
            .catch(() => {})
            .finally(() => {
              revalidationTasks.delete(cachedResponse.cacheKey);
            });
          revalidationTasks.set(cachedResponse.cacheKey, revalidationTask);
        }

        return cachedResponse.response;
      }

      const { routeResult, response } = await renderer.renderRoute(request, routePolicyResult);
      runtimeState.assetManifest = normalizeClientAssetManifest(renderer.assetManifest);
      return renderer.responseCacheController.write(request, routeResult, response);
    },
    async close() {
      const revalidationTasks = this.revalidationTasks;
      if (revalidationTasks) {
        await Promise.all(revalidationTasks.values());
      }
    },
  };
}
