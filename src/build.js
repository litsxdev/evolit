import fs from "node:fs/promises";
import path from "node:path";
import { discoverAppRoutes } from "./app-discovery.js";
import {
  collectTransitiveAssetPreloads,
  collectTransitiveStyleUrls,
  createAssetResolver,
  createFrameworkImportMap,
  createHydrationBootstrap,
  emitHashedClientAssets,
  rewriteServerAssetPlaceholders,
} from "./client-assets.js";
import { compileModuleGraph } from "./compiler.js";
import {
  BUILD_DIRECTORY,
  INTERNAL_DIRECTORY,
  MANIFEST_FILENAME,
  ROUTE_CACHE_DIRECTORY,
} from "./constants.js";
import { createRouteResolver } from "./render.js";
import { createCachedRouteResponse, FileSystemResponseCacheStore } from "./response-cache.js";
import { serializeRouteCachePolicy } from "./route-config.js";
import { createSsrAdapter, renderRouteTreeWithAdapter } from "./ssr-adapter.js";
import { ensureDirectory, writeJson } from "./fs-utils.js";

export async function buildProject(projectRoot) {
  const routes = await discoverAppRoutes(projectRoot);
  const buildRoot = path.join(projectRoot, INTERNAL_DIRECTORY, BUILD_DIRECTORY);
  const entryClientModules = new Set();

  await ensureDirectory(buildRoot);

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
      sourceMaps: false,
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
        sourceMaps: false,
        target: "client",
      });
      entryClientModules.add(
        path.relative(layoutClientBuild.outputRoot, layoutClientBuild.entrypoint).split(path.sep).join("/"),
      );
    }
  }

  const clientAssets = await emitHashedClientAssets(projectRoot, {
    entryClientModules,
  });
  await rewriteServerAssetPlaceholders(projectRoot, clientAssets);

  const routeResolver = await createRouteResolver(projectRoot, "production");
  const assetResolver = createAssetResolver(projectRoot, {
    assetManifest: clientAssets,
  });
  const frameworkImportMap = await createFrameworkImportMap();
  const importMapMarkup = `<script type="importmap">${JSON.stringify(frameworkImportMap)}</script>`;
  const ssrAdapter = createSsrAdapter({
    assetResolver,
    head: importMapMarkup,
    async resolveAdditionalHead({ result }) {
      const clientImports = Array.isArray(result.clientImports) ? result.clientImports : [];
      const urls = collectTransitiveAssetPreloads(clientImports, clientAssets);
      const styleUrls = collectTransitiveStyleUrls(clientImports, clientAssets);
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
  const responseCacheStore = new FileSystemResponseCacheStore(
    path.join(projectRoot, INTERNAL_DIRECTORY, BUILD_DIRECTORY, ROUTE_CACHE_DIRECTORY),
  );
  const prerenderedRoutes = [];
  const routeCache = [];

  for (const route of routes) {
    const request = new Request(`http://nextsx.local${route.pathname}`);
    const routePolicyResult = await routeResolver.resolveRoutePolicy(request);
    if (routePolicyResult.type !== "route") {
      continue;
    }

    routeCache.push({
      pathname: route.pathname,
      cache: serializeRouteCachePolicy(routePolicyResult.cachePolicy),
    });

    if (routePolicyResult.cachePolicy.mode !== "static") {
      continue;
    }

    if (route.pathname.includes(":") || route.pathname.includes("*")) {
      throw new Error(
        `Static route caching is not supported for dynamic route patterns yet: ${route.pathname}`,
      );
    }

    const routeResult = await routeResolver.resolveRequest(request);
    if (routeResult.type !== "route") {
      continue;
    }

    const response = await renderRouteTreeWithAdapter(routeResult, ssrAdapter);
    if (response.status !== 200) {
      continue;
    }

    await responseCacheStore.put(
      route.pathname,
      createCachedRouteResponse(response, routeResult.cachePolicy),
    );
    prerenderedRoutes.push(route.pathname);
  }

  const manifestPath = path.join(buildRoot, MANIFEST_FILENAME);
  await writeJson(manifestPath, {
    routes,
    routeCache: routeCache.sort((left, right) => left.pathname.localeCompare(right.pathname)),
    prerenderedRoutes: prerenderedRoutes.sort(),
    clientAssets,
    builtAt: new Date().toISOString(),
  });

  return manifestPath;
}
