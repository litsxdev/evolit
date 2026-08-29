import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverAppRouteHandlers,
  discoverAppRoutes,
  resolveRoutePathname,
  routeHasDynamicSegments,
} from "./app-discovery.js";
import {
  collectTransitiveAssetPreloads,
  collectTransitiveStyleUrls,
  buildSharedVendorRuntime,
  canonicalizePackageModuleId,
  createAssetResolver,
  createHydrationBootstrap,
  createStaticAssetPublicUrlMap,
  emitBundledClientAssets,
  emitHashedClientAssets,
  normalizeHydrationDataForClient,
  resolveServerStyleUrls,
  resolveHydrationRootClientImports,
  resolveSharedVendorModuleUrl,
  rewriteHydrationDataScript,
  rewriteServerAssetPlaceholders,
} from "./client-assets.js";
import {
  collectClientGraphInventory,
  compileModuleGraph,
  emitClientStaticAssets,
  getClientStaticAssetModule,
  importCompiledModule,
  resolveProjectModuleSpecifier,
} from "./compiler.js";
import { loadEvolitConfig } from "./config.js";
import { getExtensionClientDescriptors, resolveEvolitExtensions } from "./extensions.js";
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

function getBarePackageName(specifier) {
  if (typeof specifier !== "string" || specifier.length === 0) return null;
  const segments = specifier.split("/");
  return specifier.startsWith("@")
    ? segments.length >= 2 ? `${segments[0]}/${segments[1]}` : null
    : segments[0];
}

export function collectSsrDevDependencyWarnings(packageJson, packageSpecifiers) {
  const productionDependencies = new Set([
    ...Object.keys(packageJson?.dependencies ?? {}),
    ...Object.keys(packageJson?.optionalDependencies ?? {}),
    ...Object.keys(packageJson?.peerDependencies ?? {}),
  ]);
  const devDependencies = new Set(Object.keys(packageJson?.devDependencies ?? {}));
  return [...new Set(packageSpecifiers
    .map(getBarePackageName)
    .filter((packageName) => (
      packageName
      && devDependencies.has(packageName)
      && !productionDependencies.has(packageName)
    )))]
    .sort();
}

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

export async function buildProject(projectRoot, options = {}) {
  const evolitConfig = await loadEvolitConfig(projectRoot);
  const extensions = resolveEvolitExtensions(evolitConfig);
  const extensionClientDescriptors = getExtensionClientDescriptors(extensions);
  const packageClientSpecifiers = new Set(
    extensionClientDescriptors.map((descriptor) => descriptor.module),
  );
  const sharedVendorOptions = {
    additionalEntrySpecifiers: [],
  };
  const routes = await discoverAppRoutes(projectRoot);
  const routeHandlers = await discoverAppRouteHandlers(projectRoot);
  const buildRoot = path.join(projectRoot, INTERNAL_DIRECTORY, BUILD_DIRECTORY);
  const entryClientModules = new Set();
  const serverAssetImportsByEntry = {};
  const clientBoundariesByEntry = {};
  const deployHandlers = [];
  const compiledClientBoundaries = new Map();
  const inventoriesBySourceEntry = new Map();
  const ssrPackageImports = new Set();

  async function compileProductionServerEntry(sourcePath) {
    const result = await compileModuleGraph(sourcePath, {
      projectRoot,
      mode: "production",
      sourceMaps: false,
      ssr: true,
      target: "server",
    });
    result.packageImports.forEach((specifier) => ssrPackageImports.add(specifier));
    return result;
  }

  function getEntryInventory(entryPath) {
    let inventory = inventoriesBySourceEntry.get(entryPath);
    if (!inventory) {
      inventory = collectClientGraphInventory([entryPath], { projectRoot });
      inventoriesBySourceEntry.set(entryPath, inventory);
    }
    return inventory;
  }

  async function compileProductionClientBoundary(sourcePath) {
    let clientModule = compiledClientBoundaries.get(sourcePath);
    if (clientModule) return clientModule;
    const clientBuild = await compileModuleGraph(sourcePath, {
      projectRoot,
      mode: "production",
      sourceMaps: true,
      target: "client",
    });
    clientModule = path.relative(clientBuild.outputRoot, clientBuild.entrypoint)
      .split(path.sep)
      .join("/");
    compiledClientBoundaries.set(sourcePath, clientModule);
    entryClientModules.add(clientModule);
    return clientModule;
  }

  await ensureDirectory(buildRoot);

  for (const routeHandler of routeHandlers) {
    await compileProductionServerEntry(routeHandler.handler);

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
    await compileProductionServerEntry(route.page);

    for (const layoutPath of route.layouts) {
      await compileProductionServerEntry(layoutPath);

    }

    const boundaryModules = [
      ...(route.notFoundBoundaries ?? []).map((boundary) => boundary.module),
      ...(route.errorBoundaries ?? []).map((boundary) => boundary.module),
    ];
    for (const boundaryPath of new Set(boundaryModules)) {
      await compileProductionServerEntry(boundaryPath);
    }

    const toProjectRelative = (filePath) => path.relative(projectRoot, filePath).split(path.sep).join("/");
    const segmentEntries = [...new Set([route.page, ...route.layouts, ...boundaryModules])];
    const inventoriesByEntry = new Map(await Promise.all(segmentEntries.map(async (entryPath) => [
      entryPath,
      await getEntryInventory(entryPath),
    ])));
    const allStyles = new Set();
    const allAssets = new Set();
    const allClientBoundaries = new Set();
    for (const [entryPath, entryInventory] of inventoriesByEntry) {
      const packageBoundarySources = new Set(
        (entryInventory.packageClientBoundaries ?? []).map((entry) => entry.sourcePath),
      );
      for (const packageBoundary of entryInventory.packageClientBoundaries ?? []) {
        packageClientSpecifiers.add(packageBoundary.specifier);
      }
      serverAssetImportsByEntry[toProjectRelative(entryPath)] = {
        styles: entryInventory.styles.map((filePath) => getClientStaticAssetModule(projectRoot, filePath)),
        assets: entryInventory.assets.map((filePath) => getClientStaticAssetModule(projectRoot, filePath)),
      };
      entryInventory.styles.forEach((filePath) => allStyles.add(filePath));
      entryInventory.assets.forEach((filePath) => allAssets.add(filePath));
      entryInventory.clientBoundaries
        .filter((filePath) => !packageBoundarySources.has(filePath))
        .forEach((filePath) => allClientBoundaries.add(filePath));
    }
    await emitClientStaticAssets([...allStyles, ...allAssets], {
      projectRoot,
      mode: "production",
    });
    const compiledBoundaryModules = new Map();
    for (const clientBoundary of allClientBoundaries) {
      compiledBoundaryModules.set(
        clientBoundary,
        await compileProductionClientBoundary(clientBoundary),
      );
    }
    for (const [entryPath, entryInventory] of inventoriesByEntry) {
      clientBoundariesByEntry[toProjectRelative(entryPath)] = entryInventory.clientBoundaries
        .filter((clientBoundary) => !(entryInventory.packageClientBoundaries ?? [])
          .some((packageBoundary) => packageBoundary.sourcePath === clientBoundary))
        .map((clientBoundary) => compiledBoundaryModules.get(clientBoundary))
        .filter(Boolean)
        .sort();
    }
  }

  const projectPackageJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  const warn = options.onWarning ?? console.warn;
  for (const packageName of collectSsrDevDependencyWarnings(projectPackageJson, [...ssrPackageImports])) {
    warn(
      `[evolit] Production SSR imports ${JSON.stringify(packageName)}, but it is declared only in devDependencies. `
      + "Move it to dependencies or ensure production installations include development dependencies.",
    );
  }

  const configuredClientBoundaries = evolitConfig.clientBoundaries ?? [];
  if (!Array.isArray(configuredClientBoundaries)) {
    throw new Error("Expected clientBoundaries in evolit.config.js to be an array of module specifiers.");
  }
  for (const specifier of configuredClientBoundaries) {
    if (typeof specifier !== "string" || specifier.length === 0) {
      throw new Error("Expected every clientBoundaries entry to be a non-empty module specifier.");
    }
    const sourcePath = path.isAbsolute(specifier)
      ? specifier
      : await resolveProjectModuleSpecifier(
        projectRoot,
        path.join(projectRoot, "evolit.config.js"),
        specifier,
      );
    if (!sourcePath) {
      throw new Error(`Unable to resolve configured client boundary ${JSON.stringify(specifier)}.`);
    }
    await compileProductionClientBoundary(sourcePath);
  }

  sharedVendorOptions.additionalEntrySpecifiers = [...packageClientSpecifiers].sort();
  const clientAssets = await emitBundledClientAssets(projectRoot, {
    entryClientModules,
    additionalVendorSpecifiers: sharedVendorOptions.additionalEntrySpecifiers,
    serverAssetImportsByEntry,
    clientBoundariesByEntry,
  });
  const staticAssetPublicUrls = createStaticAssetPublicUrlMap(clientAssets);
  await rewriteServerAssetPlaceholders(projectRoot, clientAssets);

  const routeResolver = await createRouteResolver(projectRoot, "production", {
    staticAssetPublicUrls,
  });
  const sharedRuntime = await buildSharedVendorRuntime(projectRoot, "production", sharedVendorOptions);
  clientAssets.sharedImports = { ...sharedRuntime.imports };
  const packageImports = sharedRuntime.imports;
  const assetResolver = createAssetResolver(projectRoot, {
    assetManifest: clientAssets,
    packageImports,
  });
  const hydrationModuleUrl = await resolveSharedVendorModuleUrl(
    projectRoot,
    "production",
    "@litsx/ssr/hydration",
    sharedVendorOptions,
  );
  const navigationModuleUrl = await resolveSharedVendorModuleUrl(
    projectRoot,
    "production",
    "evolit/navigation",
    sharedVendorOptions,
  );
  const navigationExtensions = await Promise.all(extensionClientDescriptors.map(async (descriptor) => ({
    ...descriptor,
    module: await resolveSharedVendorModuleUrl(
      projectRoot,
      "production",
      descriptor.module,
      sharedVendorOptions,
    ),
  })));
  const ssrAdapter = createSsrAdapter({
    assetResolver,
    async onSsrResult({ routeResult, result }) {
      const renderedModules = [...new Set([
        ...(Array.isArray(result.clientImports) ? result.clientImports : []),
        ...(Array.isArray(result.hydrationData?.roots)
          ? result.hydrationData.roots.map((root) => root?.moduleId)
          : []),
      ].filter((moduleId) => typeof moduleId === "string" && moduleId.length > 0))];
      const unresolved = [];
      for (const moduleId of renderedModules) {
        const packageSpecifier = await canonicalizePackageModuleId(
          projectRoot,
          moduleId,
          packageClientSpecifiers,
        );
        if (packageSpecifier) {
          const publicUrl = packageImports[packageSpecifier] ?? null;
          if (!publicUrl) {
            unresolved.push(moduleId);
            continue;
          }
          const previousPublicUrl = assetResolver(moduleId);
          for (const root of result.hydrationData?.roots ?? []) {
            if (root?.moduleId === moduleId) root.moduleId = packageSpecifier;
          }
          if (Array.isArray(result.clientImports)) {
            result.clientImports = result.clientImports.map((value) => (
              value === moduleId || value === previousPublicUrl ? publicUrl : value
            ));
          }
          if (Array.isArray(result.hydrationData?.clientImports)) {
            result.hydrationData.clientImports = result.hydrationData.clientImports.map((value) => (
              value === moduleId || value === previousPublicUrl ? publicUrl : value
            ));
          }
          continue;
        }
        if (assetResolver(moduleId) || clientAssets.byPublicPath?.[moduleId]) continue;
        const importerPath = routeResult.boundaryModule
          ?? routeResult.route?.page
          ?? path.join(projectRoot, "app", "page.jsx");
        let sourcePath = null;
        if (moduleId.startsWith("file:")) {
          try { sourcePath = fileURLToPath(moduleId); } catch {}
        } else if (path.isAbsolute(moduleId) && !moduleId.startsWith("/app/") && !moduleId.startsWith("/src/")) {
          sourcePath = moduleId;
        } else if (moduleId.startsWith("/")) {
          sourcePath = await resolveProjectModuleSpecifier(projectRoot, importerPath, `.${moduleId}`);
        } else {
          sourcePath = await resolveProjectModuleSpecifier(projectRoot, importerPath, moduleId);
        }
        const publicUrl = sourcePath ? assetResolver(sourcePath) : null;
        if (!publicUrl) {
          unresolved.push(moduleId);
          continue;
        }
        for (const root of result.hydrationData?.roots ?? []) {
          if (root?.moduleId === moduleId) root.moduleId = sourcePath;
        }
        if (Array.isArray(result.clientImports)) {
          result.clientImports = result.clientImports.map((value) => value === moduleId ? publicUrl : value);
        }
        if (Array.isArray(result.hydrationData?.clientImports)) {
          result.hydrationData.clientImports = result.hydrationData.clientImports
            .map((value) => value === moduleId ? publicUrl : value);
        }
      }
      if (unresolved.length > 0) {
        throw new Error(
          `SSR rendered client boundaries without build artifacts for ${routeResult.route?.pathname ?? "route"}: `
          + `${unresolved.join(", ")}.`,
        );
      }
    },
    async resolveAdditionalHead({ routeResult, result }) {
      const clientImports = [...new Set([
        ...(Array.isArray(result.clientImports) ? result.clientImports : []),
        ...resolveHydrationRootClientImports(result.hydrationData, assetResolver),
      ])];
      const hydratedClientImports = clientImports;
      const urls = hydratedClientImports.length > 0
        ? [...new Set([
          ...hydratedClientImports,
          ...collectTransitiveAssetPreloads(hydratedClientImports, clientAssets),
        ])]
        : [];
      const styleUrls = [...new Set([
        ...collectTransitiveStyleUrls(clientImports, clientAssets),
        ...resolveServerStyleUrls(routeResult, projectRoot, clientAssets),
      ])];

      return [
        ...urls.map((href) => `<link rel="modulepreload" href="${href}" data-evolit-route-asset="preload">`),
        ...styleUrls.map((href) => `<link rel="stylesheet" href="${href}" data-evolit-route-asset="style">`),
      ].join("\n");
    },
    resolveBootstrap({ routeResult, result }) {
      return createHydrationBootstrap({
        hydrationData: normalizeHydrationDataForClient(
          result.hydrationData,
          projectRoot,
          resolveHydrationRootClientImports(result.hydrationData, assetResolver),
          assetResolver,
        ),
        assetResolver,
        hydrationModuleUrl,
        navigationModuleUrl,
        navigationExtensions,
      });
    },
    transformDocument({ routeResult, result, document }) {
      return rewriteHydrationDataScript(
        document,
        normalizeHydrationDataForClient(
          result.hydrationData,
          projectRoot,
          resolveHydrationRootClientImports(result.hydrationData, assetResolver),
          assetResolver,
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
