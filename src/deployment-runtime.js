import fs from "node:fs/promises";
import path from "node:path";
import {
  compileModuleGraph,
  invalidateDevelopmentCompilationCache,
} from "./compiler.js";
import {
  collectTransitiveAssetPreloads,
  collectTransitiveStyleUrls,
  createAssetResolver,
  createHydrationBootstrap,
  createStaticAssetPublicUrlMap,
  buildSharedVendorRuntime,
  emitBundledClientAssetsWithState,
  getAssetByPublicUrl,
  getSharedOutputRoot,
  normalizeHydrationDataForClient,
  normalizeClientAssetManifest,
  resetDevelopmentAssetCaches,
  resolveHydrationRootClientImports,
  resolveRouteClientImports,
  resolveSharedVendorModuleUrl,
  resolveBrowserPackageAssetFilePath,
  rewriteHydrationDataScript,
} from "./client-assets.js";
import { loadEvolitConfig } from "./config.js";
import { DEV_DIRECTORY, INTERNAL_DIRECTORY } from "./constants.js";
import { createRouteResolver } from "./render.js";
import {
  createCachedRouteResponse,
  createDefaultRouteCacheKey,
  isCachedRouteResponseFresh,
  resolveResponseCacheRuntime,
} from "./response-cache.js";
import { createSsrAdapter, renderRouteTreeWithAdapter } from "./ssr-adapter.js";
import { createNavigationResponseFromDocument } from "./route-segments.js";
import { appendSsrUrqlData, runWithOptionalSsrUrqlScope } from "./urql-ssr.js";
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
      if (pathname.startsWith("/_evolit/static/")) {
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

      if (pathname.startsWith("/_evolit/shared/")) {
        const sharedRoot = getSharedOutputRoot(projectRoot, mode);
        const relativePath = decodeURIComponent(pathname.slice("/_evolit/shared/".length));
        const filePath = path.join(sharedRoot, relativePath);
        return {
          filePath,
          contentType: getContentType(filePath),
        };
      }

      if (pathname.startsWith("/_evolit/pkg/")) {
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
          "x-evolit-cache": cacheState,
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

export async function createRequestRenderer({
  projectRoot,
  mode,
  assetManifest,
  routeResolver,
  responseCacheRuntime,
  onDevelopmentEvent,
}) {
  let currentAssetManifest = normalizeClientAssetManifest(assetManifest);
  let currentAssetResolver = createAssetResolver(projectRoot, {
    assetManifest: currentAssetManifest,
  });
  let currentHydrationModuleUrl = await resolveSharedVendorModuleUrl(
    projectRoot,
    mode,
    "@litsx/ssr/hydration",
  );
  let currentNavigationModuleUrl = await resolveSharedVendorModuleUrl(
    projectRoot,
    mode,
    "evolit/navigation",
  );
  const devBundledEntries = new Set();
  const devPreparedClientModules = new Set();
  const devClientModuleDependencies = new Map();
  let devPreviousAssetOutputPaths = new Set();
  let devRollupCache = null;
  let devClientAssetWork = Promise.resolve();
  const developmentMetrics = {
    clientArtifactBuilds: 0,
    clientArtifactCacheHits: 0,
    invalidations: 0,
    selectivelyInvalidatedClientEntries: 0,
  };
  const usesFrameworkRouteResolver = !routeResolver;
  let sharedSegmentRenderCache = null;

  function enqueueDevClientAssetWork(work) {
    const nextWork = devClientAssetWork.then(work, work);
    devClientAssetWork = nextWork.catch(() => {});
    return nextWork;
  }

  function reportDevelopmentEvent(event) {
    if (mode === "development" && typeof onDevelopmentEvent === "function") {
      onDevelopmentEvent(event);
    }
  }

  function getDevClientModuleKey(clientModule) {
    return path.resolve(projectRoot, clientModule);
  }
  async function createFrameworkRouteResolver() {
    const resolver = await createRouteResolver(projectRoot, mode, {
      onDevelopmentEvent,
      segmentRenderCache: sharedSegmentRenderCache,
      getStaticAssetPublicUrls() {
        return createStaticAssetPublicUrlMap(currentAssetManifest);
      },
      assetResolver(moduleId) {
        return currentAssetResolver(moduleId);
      },
    });
    sharedSegmentRenderCache ??= resolver.segmentRenderCache;
    return resolver;
  }
  let effectiveRouteResolver = routeResolver ?? await createFrameworkRouteResolver();
  const ssrAdapter = createSsrAdapter({
    assetResolver(moduleId) {
      return currentAssetResolver(moduleId);
    },
    async resolveAdditionalHead({ routeResult, result }) {
      const clientImports = [
        ...(Array.isArray(result.clientImports) ? result.clientImports : []),
        ...resolveRouteClientImports(routeResult, projectRoot, currentAssetManifest),
      ];
      const hydratedClientImports = Array.isArray(result.clientImports) ? result.clientImports : [];
      const urls = currentAssetManifest && hydratedClientImports.length > 0
        ? [...new Set([
          ...hydratedClientImports,
          ...collectTransitiveAssetPreloads(hydratedClientImports, currentAssetManifest),
        ])]
        : [];
      const styleUrls = currentAssetManifest
        ? collectTransitiveStyleUrls(clientImports, currentAssetManifest)
        : [];
      if (urls.length === 0 && styleUrls.length === 0) {
        return "";
      }

      return [
        ...urls.map((href) => `<link rel="modulepreload" href="${href}" data-evolit-route-asset="preload">`),
        ...styleUrls.map((href) => `<link rel="stylesheet" href="${href}" data-evolit-route-asset="style">`),
      ].join("\n");
    },
    resolveBootstrap({ routeResult, result }) {
      const routeClientImports = resolveRouteClientImports(
        routeResult,
        projectRoot,
        currentAssetManifest,
      );
      return createHydrationBootstrap({
        hydrationData: normalizeHydrationDataForClient(
          result.hydrationData,
          projectRoot,
          routeClientImports,
        ),
        assetResolver(moduleId) {
          return currentAssetResolver(moduleId);
        },
        hydrationModuleUrl: currentHydrationModuleUrl,
        navigationModuleUrl: currentNavigationModuleUrl,
      });
    },
    transformDocument({ routeResult, result, document }) {
      const routeClientImports = resolveRouteClientImports(
        routeResult,
        projectRoot,
        currentAssetManifest,
      );
      return rewriteHydrationDataScript(
        document,
        normalizeHydrationDataForClient(
          result.hydrationData,
          projectRoot,
          [
            ...routeClientImports,
            ...resolveHydrationRootClientImports(
              result.hydrationData,
              currentAssetResolver,
            ),
          ],
        ),
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
    async invalidateDevelopmentState(changedPaths = null) {
      if (mode !== "development") {
        return;
      }

      return enqueueDevClientAssetWork(async () => {
        developmentMetrics.invalidations += 1;
        const normalizedChangedPaths = Array.isArray(changedPaths) && changedPaths.length > 0
          ? new Set(changedPaths.map((changedPath) => path.resolve(changedPath)))
          : null;
        invalidateDevelopmentCompilationCache(projectRoot, changedPaths);
        const affectedClientModules = normalizedChangedPaths == null
          ? new Set(devPreparedClientModules)
          : new Set(
            [...devClientModuleDependencies]
              .filter(([, dependencies]) =>
                [...dependencies].some((dependency) => normalizedChangedPaths.has(dependency))
              )
              .map(([clientModule]) => clientModule),
          );

        if (affectedClientModules.size > 0 || normalizedChangedPaths == null) {
          developmentMetrics.selectivelyInvalidatedClientEntries += affectedClientModules.size;
          // The public asset origin can still be serving this manifest while
          // the next bundle is being emitted. Retain its files for exactly one
          // generation to make the manifest/file-system transition safe.
          devPreviousAssetOutputPaths = new Set(
            (currentAssetManifest?.assets ?? []).map((asset) => asset.outputPath),
          );
          currentAssetManifest = null;
          currentAssetResolver = createAssetResolver(projectRoot, {
            assetManifest: currentAssetManifest,
          });
          devRollupCache = null;
          for (const clientModule of affectedClientModules) {
            devPreparedClientModules.delete(clientModule);
            devClientModuleDependencies.delete(clientModule);
          }
        }

        reportDevelopmentEvent({
          type: "invalidated",
          changedPathCount: normalizedChangedPaths?.size ?? null,
          affectedClientEntryCount: affectedClientModules.size,
        });

        if (usesFrameworkRouteResolver) {
          const segmentEntryCount = effectiveRouteResolver.invalidateSegmentCache?.(changedPaths) ?? 0;
          reportDevelopmentEvent({ type: "segment-cache-invalidated", entryCount: segmentEntryCount });
          effectiveRouteResolver = await createFrameworkRouteResolver();
        }
      });
    },
    async prepareRouteClientArtifacts(routeResult) {
      if (routeResult.type !== "route" && !routeResult.boundaryModule) {
        return;
      }

      const clientModules = [
        ...(routeResult.type === "route" ? [routeResult.route.page, ...routeResult.route.layouts] : []),
        ...(routeResult.boundaryModule ? [routeResult.boundaryModule] : []),
      ];

      if (mode !== "development") {
        for (const clientModule of new Set(clientModules)) {
          await compileModuleGraph(clientModule, {
            projectRoot,
            mode,
            sourceMaps: false,
            target: "client",
            onDevelopmentEvent,
          });
        }
        return;
      }

      return enqueueDevClientAssetWork(async () => {
        let discoveredClientEntry = false;
        for (const clientModule of new Set(clientModules)) {
          const clientModuleKey = getDevClientModuleKey(clientModule);
          if (devPreparedClientModules.has(clientModuleKey)) {
            continue;
          }

          const clientBuild = await compileModuleGraph(clientModule, {
            projectRoot,
            mode,
            sourceMaps: true,
            target: "client",
            onDevelopmentEvent,
          });
          devPreparedClientModules.add(clientModuleKey);
          devClientModuleDependencies.set(
            clientModuleKey,
            new Set(clientBuild.sourceFiles ?? [clientModuleKey]),
          );
          devBundledEntries.add(
            path.relative(clientBuild.outputRoot, clientBuild.entrypoint).split(path.sep).join("/"),
          );
          discoveredClientEntry = true;
        }

        if (!discoveredClientEntry && currentAssetManifest) {
          developmentMetrics.clientArtifactCacheHits += 1;
          reportDevelopmentEvent({ type: "client-assets-cache-hit" });
          return;
        }

        developmentMetrics.clientArtifactBuilds += 1;
        const buildStartedAt = performance.now();
        reportDevelopmentEvent({
          type: "client-assets-building",
          entryCount: devBundledEntries.size,
        });
        const bundledClientAssets = await emitBundledClientAssetsWithState(projectRoot, {
          mode: "development",
          entryClientModules: devBundledEntries,
          rollupCache: devRollupCache,
          retainOutputPaths: devPreviousAssetOutputPaths,
        });
        currentAssetManifest = bundledClientAssets.manifest;
        devPreviousAssetOutputPaths = new Set();
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
        reportDevelopmentEvent({
          type: "client-assets-ready",
          durationMs: Math.round(performance.now() - buildStartedAt),
          entryCount: devBundledEntries.size,
        });
      });
    },
    async resolveRoutePolicy(request) {
      return effectiveRouteResolver.resolveRoutePolicy(request);
    },
    async renderRoute(request, routePolicyResult = null) {
      return runWithOptionalSsrUrqlScope(async (urqlAdapter) => {
        const shouldPrepareBeforeResolve = mode === "development" && !currentAssetManifest;
        let resolvedRoutePolicyResult = routePolicyResult;
        if (shouldPrepareBeforeResolve) {
          resolvedRoutePolicyResult ??= await effectiveRouteResolver.resolveRoutePolicy(request);
          await this.prepareRouteClientArtifacts(resolvedRoutePolicyResult);
        }

        const routeResult = await effectiveRouteResolver.resolveRequest(request, resolvedRoutePolicyResult);
        if (!shouldPrepareBeforeResolve || routeResult.boundaryModule) {
          await this.prepareRouteClientArtifacts(routeResult);
        }
        const renderedResponse = await renderRouteTreeWithAdapter(routeResult, ssrAdapter);
        const response = urqlAdapter
          ? appendSsrUrqlData(renderedResponse, await urqlAdapter.getUrqlSsrData())
          : renderedResponse;
        return {
          routeResult,
          response,
        };
      });
    },
    get assetManifest() {
      return currentAssetManifest;
    },
    get developmentMetrics() {
      return mode === "development" ? { ...developmentMetrics } : null;
    },
  };
}

export async function createDeploymentRuntime({
  projectRoot,
  mode,
  assetManifest,
  responseCacheRuntime,
  routeResolver,
  onDevelopmentEvent,
} = {}) {
  function reportDevelopmentEvent(event) {
    if (mode === "development" && typeof onDevelopmentEvent === "function") {
      onDevelopmentEvent(event);
    }
  }

  if (mode === "development") {
    reportDevelopmentEvent({ type: "initializing" });
    const developmentRoot = path.join(projectRoot, INTERNAL_DIRECTORY, DEV_DIRECTORY);
    await fs.rm(developmentRoot, { recursive: true, force: true });
    invalidateDevelopmentCompilationCache(projectRoot);
    resetDevelopmentAssetCaches(projectRoot);
    await buildSharedVendorRuntime(projectRoot, "development", {
      additionalEntrySpecifiers: [],
    });
    reportDevelopmentEvent({ type: "vendor-runtime-ready" });
  }

  const effectiveResponseCacheRuntime = responseCacheRuntime
    ?? await resolveResponseCacheRuntime(
      projectRoot,
      mode,
      await loadEvolitConfig(projectRoot),
    );
  const runtimeState = {
    assetManifest: mode === "development" ? null : normalizeClientAssetManifest(assetManifest),
  };

  function formatResponseForRequest(request, response) {
    const representation = request.headers.get("accept")?.includes("application/vnd.evolit.navigation+json")
      ? createNavigationResponseFromDocument(response)
      : response;
    // The same URL has an HTML document representation and a navigation
    // delta representation. Tell intermediary HTTP caches that Accept selects
    // between them.
    return addNavigationVaryHeader(representation);
  }
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
    onDevelopmentEvent,
  });

  return {
    assets,
    cache: renderer.responseCacheController,
    renderer,
    async invalidateDevelopmentState(changedPaths = null) {
      if (mode !== "development") {
        return;
      }

      await renderer.invalidateDevelopmentState(changedPaths);
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
          return formatResponseForRequest(request, cachedResponse.response);
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

        return formatResponseForRequest(request, cachedResponse.response);
      }

      const { routeResult, response } = await renderer.renderRoute(request, routePolicyResult);
      runtimeState.assetManifest = normalizeClientAssetManifest(renderer.assetManifest);
      return formatResponseForRequest(
        request,
        await renderer.responseCacheController.write(request, routeResult, response),
      );
    },
    async close() {
      const revalidationTasks = this.revalidationTasks;
      if (revalidationTasks) {
        await Promise.all(revalidationTasks.values());
      }
    },
  };
}

function addNavigationVaryHeader(response) {
  if (!response?.headers) return response;
  const fields = String(response.headers.vary ?? "")
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  if (!fields.some((field) => field.toLowerCase() === "accept")) fields.push("accept");
  return {
    ...response,
    headers: { ...response.headers, vary: fields.join(", ") },
  };
}
