import fs from "node:fs/promises";
import path from "node:path";
import {
  discoverAppRouteHandlers,
  discoverAppRoutes,
  resolveRoutePathname,
  routeHasDynamicSegments,
} from "./app-discovery.js";
import {
  collectTransitiveAssetPreloads,
  collectTransitiveStyleUrls,
  createAssetResolver,
  createHydrationBootstrap,
  createStaticAssetPublicUrlMap,
  emitBundledClientAssets,
  emitHashedClientAssets,
  normalizeHydrationDataForClient,
  resolveHydrationRootClientImports,
  resolveRouteClientImports,
  resolveSharedVendorModuleUrl,
  rewriteHydrationDataScript,
  rewriteServerAssetPlaceholders,
} from "./client-assets.js";
import { compileModuleGraph, importCompiledModule } from "./compiler.js";
import { loadEvolitConfig } from "./config.js";
import {
  BUILD_DIRECTORY,
  DEPLOY_ASSETS_MANIFEST_FILENAME,
  DEPLOY_ROUTES_MANIFEST_FILENAME,
  DEPLOY_SERVER_MANIFEST_FILENAME,
  INTERNAL_DIRECTORY,
  MANIFEST_FILENAME,
} from "./constants.js";
import { createRouteResolver, resolveStaticParamsForRoute } from "./render.js";
import {
  createCachedRouteResponse,
  getRouteCacheArtifactFileName,
  resolveResponseCacheRuntime,
} from "./response-cache.js";
import { serializeRouteCachePolicy } from "./route-config.js";
import { createSsrAdapter, renderRouteTreeWithAdapter } from "./ssr-adapter.js";
import { ensureDirectory, writeJson } from "./fs-utils.js";
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

function getContentTypeForBuildArtifact(filePath) {
  return CONTENT_TYPE_BY_EXTENSION.get(path.extname(filePath)) ?? "application/octet-stream";
}

function toBuildRelativePath(projectRoot, targetPath) {
  return path.relative(projectRoot, targetPath).split(path.sep).join("/");
}

async function writeDeploymentRuntimeEntry(buildRoot) {
  const runtimeEntryPath = path.join(buildRoot, "runtime-entry.mjs");
  const frameworkEntryUrl = new URL("./index.js", import.meta.url).href;
  await fs.writeFile(
    runtimeEntryPath,
    [
      'import fs from "node:fs/promises";',
      'import path from "node:path";',
      'import { fileURLToPath } from "node:url";',
      "",
      "let createDeploymentRuntime;",
      "try {",
      '  ({ createDeploymentRuntime } = await import("evolit"));',
      "} catch {",
      `  ({ createDeploymentRuntime } = await import(${JSON.stringify(frameworkEntryUrl)}));`,
      "}",
      "",
      "const buildRoot = path.dirname(fileURLToPath(import.meta.url));",
      'const projectRoot = path.resolve(buildRoot, "..", "..");',
      "let runtimePromise = null;",
      "",
      "export async function createBuiltDeploymentRuntime(options = {}) {",
      '  const manifest = JSON.parse(await fs.readFile(path.join(buildRoot, "manifest.json"), "utf8"));',
      "  return createDeploymentRuntime({",
      "    projectRoot: options.projectRoot ?? projectRoot,",
      '    mode: "production",',
      "    assetManifest: manifest.clientAssets ?? null,",
      "    responseCacheRuntime: options.responseCacheRuntime,",
      "    routeResolver: options.routeResolver,",
      "  });",
      "}",
      "",
      "export async function getBuiltDeploymentRuntime(options = {}) {",
      "  if (!runtimePromise) {",
      "    runtimePromise = createBuiltDeploymentRuntime(options);",
      "  }",
      "  return runtimePromise;",
      "}",
      "",
      "export async function handleRequest(request, options = {}) {",
      "  const runtime = await getBuiltDeploymentRuntime(options);",
      "  return runtime.handle(request);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  return runtimeEntryPath;
}

export async function buildProject(projectRoot) {
  const evolitConfig = await loadEvolitConfig(projectRoot);
  const routes = await discoverAppRoutes(projectRoot);
  const routeHandlers = await discoverAppRouteHandlers(projectRoot);
  const buildRoot = path.join(projectRoot, INTERNAL_DIRECTORY, BUILD_DIRECTORY);
  const entryClientModules = new Set();
  const deployHandlers = [];

  await ensureDirectory(buildRoot);

  for (const routeHandler of routeHandlers) {
    await compileModuleGraph(routeHandler.handler, {
      projectRoot,
      mode: "production",
      sourceMaps: false,
      ssr: true,
      target: "server",
    });

    const handlerModule = await importCompiledModule(routeHandler.handler, {
      projectRoot,
      mode: "production",
      ssr: true,
      target: "server",
    });
    const methods = Object.keys(handlerModule)
      .filter((name) => /^[A-Z]+$/.test(name) && typeof handlerModule[name] === "function")
      .sort();
    if (methods.length === 0) {
      throw new Error(`Expected route handler ${routeHandler.handler} to export an HTTP method.`);
    }

    deployHandlers.push({
      pathname: routeHandler.pathname,
      methods,
      runtime: "server",
      cache: "dynamic",
    });
  }

  for (const route of routes) {
    await compileModuleGraph(route.page, {
      projectRoot,
      mode: "production",
      sourceMaps: false,
      ssr: true,
      target: "server",
    });

    const pageClientBuild = await compileModuleGraph(route.page, {
      projectRoot,
      mode: "production",
      sourceMaps: true,
      target: "client",
    });
    entryClientModules.add(
      path.relative(pageClientBuild.outputRoot, pageClientBuild.entrypoint).split(path.sep).join("/"),
    );

    for (const layoutPath of route.layouts) {
      await compileModuleGraph(layoutPath, {
        projectRoot,
        mode: "production",
        sourceMaps: false,
        ssr: true,
        target: "server",
      });

      const layoutClientBuild = await compileModuleGraph(layoutPath, {
        projectRoot,
        mode: "production",
        sourceMaps: true,
        target: "client",
      });
      entryClientModules.add(
        path.relative(layoutClientBuild.outputRoot, layoutClientBuild.entrypoint).split(path.sep).join("/"),
      );
    }

    const boundaryModules = [
      ...(route.notFoundBoundaries ?? []).map((boundary) => boundary.module),
      ...(route.errorBoundaries ?? []).map((boundary) => boundary.module),
    ];
    for (const boundaryPath of new Set(boundaryModules)) {
      await compileModuleGraph(boundaryPath, {
        projectRoot,
        mode: "production",
        sourceMaps: false,
        ssr: true,
        target: "server",
      });

      const boundaryClientBuild = await compileModuleGraph(boundaryPath, {
        projectRoot,
        mode: "production",
        sourceMaps: true,
        target: "client",
      });
      entryClientModules.add(
        path.relative(boundaryClientBuild.outputRoot, boundaryClientBuild.entrypoint)
          .split(path.sep)
          .join("/"),
      );
    }
  }

  const clientAssets = await emitBundledClientAssets(projectRoot, {
    entryClientModules,
  });
  const staticAssetPublicUrls = createStaticAssetPublicUrlMap(clientAssets);
  await rewriteServerAssetPlaceholders(projectRoot, clientAssets);

  const routeResolver = await createRouteResolver(projectRoot, "production", {
    staticAssetPublicUrls,
  });
  const assetResolver = createAssetResolver(projectRoot, {
    assetManifest: clientAssets,
  });
  const hydrationModuleUrl = await resolveSharedVendorModuleUrl(
    projectRoot,
    "production",
    "@litsx/ssr/hydration",
  );
  const ssrAdapter = createSsrAdapter({
    assetResolver,
    async resolveAdditionalHead({ routeResult, result }) {
      const clientImports = [
        ...(Array.isArray(result.clientImports) ? result.clientImports : []),
        ...resolveRouteClientImports(routeResult, projectRoot, clientAssets),
      ];
      const hydratedClientImports = Array.isArray(result.clientImports) ? result.clientImports : [];
      const urls = hydratedClientImports.length > 0
        ? [...new Set([
          ...hydratedClientImports,
          ...collectTransitiveAssetPreloads(hydratedClientImports, clientAssets),
        ])]
        : [];
      const styleUrls = collectTransitiveStyleUrls(clientImports, clientAssets);

      return [
        ...urls.map((href) => `<link rel="modulepreload" href="${href}" data-evolit-route-asset="preload">`),
        ...styleUrls.map((href) => `<link rel="stylesheet" href="${href}" data-evolit-route-asset="style">`),
      ].join("\n");
    },
    resolveBootstrap({ routeResult, result }) {
      const routeClientImports = resolveRouteClientImports(
        routeResult,
        projectRoot,
        clientAssets,
      );
      return createHydrationBootstrap({
        hydrationData: normalizeHydrationDataForClient(
          result.hydrationData,
          projectRoot,
          routeClientImports,
        ),
        assetResolver,
        hydrationModuleUrl,
      });
    },
    transformDocument({ routeResult, result, document }) {
      const routeClientImports = resolveRouteClientImports(
        routeResult,
        projectRoot,
        clientAssets,
      );
      return rewriteHydrationDataScript(
        document,
        normalizeHydrationDataForClient(
          result.hydrationData,
          projectRoot,
          [
            ...routeClientImports,
            ...resolveHydrationRootClientImports(result.hydrationData, assetResolver),
          ],
        ),
      );
    },
  });
  const responseCacheRuntime = await resolveResponseCacheRuntime(projectRoot, "production", evolitConfig);
  const prerenderedRoutes = [];
  const routeCache = [];
  const prerenderedRouteArtifacts = [];

  for (const route of routes) {
    const request = new Request(`http://evolit.local${route.pathname}`);
    const routePolicyResult = await routeResolver.resolveRoutePolicy(request);
    if (routePolicyResult.type !== "route") {
      continue;
    }

    routeCache.push({
      pathname: route.pathname,
      cache: serializeRouteCachePolicy(routePolicyResult.cachePolicy),
    });

    const isDynamicRoute = routeHasDynamicSegments(route.pathname);
    const staticParamsResult = isDynamicRoute && routePolicyResult.cachePolicy.mode !== "dynamic"
      ? await resolveStaticParamsForRoute(route, projectRoot, "production", {
        staticAssetPublicUrls,
      })
      : { hasGenerateStaticParams: false, paramsList: [] };
    const prerenderTargets = [];

    if (routePolicyResult.cachePolicy.mode === "static" && !isDynamicRoute) {
      prerenderTargets.push(route.pathname);
    }

    if (staticParamsResult.hasGenerateStaticParams) {
      for (const params of staticParamsResult.paramsList) {
        prerenderTargets.push(resolveRoutePathname(route.pathname, params));
      }
    }

    const seenPrerenderTargets = new Set();

    for (const targetPathname of prerenderTargets) {
      if (seenPrerenderTargets.has(targetPathname)) {
        continue;
      }
      seenPrerenderTargets.add(targetPathname);

      const targetRequest = new Request(`http://evolit.local${targetPathname}`);
      const { routeResult, response } = await runWithOptionalSsrUrqlScope(async (urqlAdapter) => {
        const resolvedRouteResult = await routeResolver.resolveRequest(targetRequest);
        if (resolvedRouteResult.type !== "route" || resolvedRouteResult.cachePolicy.mode === "dynamic") {
          return { routeResult: resolvedRouteResult, response: null };
        }

        const renderedResponse = await renderRouteTreeWithAdapter(resolvedRouteResult, ssrAdapter);
        return {
          routeResult: resolvedRouteResult,
          response: urqlAdapter
            ? appendSsrUrqlData(renderedResponse, await urqlAdapter.getUrqlSsrData())
            : renderedResponse,
        };
      });
      if (!response) {
        continue;
      }
      if (response.status !== 200) {
        continue;
      }

      const cacheKey = await responseCacheRuntime.createKey({
        request: targetRequest,
        routeResult,
      });
      await responseCacheRuntime.store.put(
        cacheKey,
        createCachedRouteResponse(response, routeResult.cachePolicy),
      );
      prerenderedRouteArtifacts.push({
        routePathname: route.pathname,
        pathname: targetPathname,
        cacheKey,
        outputPath: toBuildRelativePath(
          projectRoot,
          path.join(
            buildRoot,
            "route-cache",
            getRouteCacheArtifactFileName(cacheKey),
          ),
        ),
        contentType: "application/json; charset=utf-8",
      });
      prerenderedRoutes.push(targetPathname);
    }
  }

  const sortedRouteCache = routeCache.sort((left, right) => left.pathname.localeCompare(right.pathname));
  const deployRoutes = {
    version: 2,
    routes: sortedRouteCache.map((entry) => {
      const prerenderedArtifact = prerenderedRouteArtifacts.find(
        (artifact) => artifact.pathname === entry.pathname,
      );
      const prerenderedPaths = prerenderedRouteArtifacts
        .filter((artifact) => artifact.routePathname === entry.pathname)
        .map((artifact) => artifact.pathname)
        .sort();

      return {
        pathname: entry.pathname,
        cache: entry.cache,
        cacheKey: entry.pathname,
        prerendered: prerenderedPaths.length > 0,
        prerenderedPaths,
        responsePath: prerenderedArtifact?.outputPath ?? null,
      };
    }),
    handlers: deployHandlers.sort((left, right) => left.pathname.localeCompare(right.pathname)),
  };

  const deployAssets = {
    version: 1,
    assets: [
      ...clientAssets.assets.map((asset) => ({
        kind: asset.type,
        publicUrl: asset.publicUrl,
        outputPath: toBuildRelativePath(projectRoot, asset.outputPath),
        contentType: getContentTypeForBuildArtifact(asset.outputPath),
      })),
      ...prerenderedRouteArtifacts.map((artifact) => ({
        kind: "html",
        pathname: artifact.pathname,
        cacheKey: artifact.cacheKey,
        outputPath: artifact.outputPath,
        contentType: artifact.contentType,
        cache: sortedRouteCache.find((entry) => entry.pathname === artifact.routePathname)?.cache
          ?? "static",
      })),
    ],
  };
  const manifestPath = path.join(buildRoot, MANIFEST_FILENAME);
  const runtimeEntryPath = await writeDeploymentRuntimeEntry(buildRoot);
  const deployServer = {
    version: 1,
    runtimeEntry: toBuildRelativePath(projectRoot, runtimeEntryPath),
    exports: {
      factory: "createBuiltDeploymentRuntime",
      handler: "handleRequest",
    },
    manifestPath: toBuildRelativePath(projectRoot, manifestPath),
    serverOutputRoot: toBuildRelativePath(projectRoot, path.join(buildRoot, "server")),
  };

  await writeJson(manifestPath, {
    routes,
    routeCache: sortedRouteCache,
    prerenderedRoutes: prerenderedRoutes.sort(),
    clientAssets,
    builtAt: new Date().toISOString(),
  });
  await writeJson(path.join(buildRoot, DEPLOY_ROUTES_MANIFEST_FILENAME), deployRoutes);
  await writeJson(path.join(buildRoot, DEPLOY_ASSETS_MANIFEST_FILENAME), deployAssets);
  await writeJson(path.join(buildRoot, DEPLOY_SERVER_MANIFEST_FILENAME), deployServer);

  return manifestPath;
}
