import path from "node:path";
import { randomUUID } from "node:crypto";
import { discoverAppRouteHandlers, discoverAppRoutes, matchRoute } from "./app-discovery.js";
import { importCompiledModule } from "./compiler.js";
import { APP_DIRECTORY, MODULE_EXTENSIONS } from "./constants.js";
import { pathExists } from "./fs-utils.js";
import { mergeRouteConfig, normalizeRouteCachePolicy } from "./route-config.js";
import {
  createRequestContext,
  applyRequestContextToResponse,
  getRequestContextResponse,
  isNextsxHttpSignal,
  runWithRequestContext,
} from "./request-context.js";
import {
  LITSX_COMPONENT,
  LITSX_SERVER_COMPONENT,
} from "@litsx/core/elements";

function collectSearchParams(url) {
  const values = {};

  for (const [key, value] of url.searchParams.entries()) {
    if (Object.hasOwn(values, key)) {
      const previous = values[key];
      values[key] = Array.isArray(previous) ? [...previous, value] : [previous, value];
      continue;
    }

    values[key] = value;
  }

  return values;
}

function createRequestCacheKey(url) {
  return `${url.pathname}${url.search}`;
}

async function resolveDefaultExport(moduleRecord, filePath) {
  if (typeof moduleRecord.default !== "function") {
    throw new Error(`Expected a default function export in ${filePath}`);
  }

  return moduleRecord.default;
}

function assertServerComponent(moduleExport, filePath) {
  if (moduleExport?.[LITSX_SERVER_COMPONENT] === true) {
    return moduleExport;
  }

  if (moduleExport?.[LITSX_COMPONENT] === true) {
    throw new Error(
      [
        `Expected ${filePath} to export an async server component.`,
        "Synchronous LitSX page and layout functions compile to client components, not SSR route handlers.",
        "Use `export default async function ...` for app pages and layouts.",
      ].join(" "),
    );
  }

  return moduleExport;
}

function mergeMetadata(modules) {
  return modules.reduce((metadata, moduleRecord) => {
    if (moduleRecord?.metadata && typeof moduleRecord.metadata === "object") {
      return { ...metadata, ...moduleRecord.metadata };
    }

    return metadata;
  }, {});
}

function createBoundaryError(error, { mode, route, reportRouteError }) {
  const originalError = error instanceof Error ? error : new Error(String(error));

  if (mode === "development") {
    return originalError;
  }

  const digest = randomUUID();
  const report = {
    digest,
    error: originalError,
    route,
  };
  if (typeof reportRouteError === "function") {
    reportRouteError(report);
  } else {
    console.error(`[nextsx] Route rendering failed (${digest}) at ${route.pathname}`, originalError);
  }

  const boundaryError = new Error("An unexpected server error occurred.");
  boundaryError.digest = digest;
  return boundaryError;
}

function getStaticParamsGenerator(moduleRecord) {
  if (moduleRecord?.generateStaticParams == null) {
    return null;
  }

  if (typeof moduleRecord.generateStaticParams !== "function") {
    throw new Error("Expected generateStaticParams to export a function.");
  }

  return moduleRecord.generateStaticParams;
}

async function loadRouteModules(route, projectRoot, mode, options = {}) {
  const moduleOptions = createRouteModuleOptions(projectRoot, mode, options);
  const pageModule = await importCompiledModule(route.page, moduleOptions);
  const layoutModules = await Promise.all(
    route.layouts.map((layoutPath) => importCompiledModule(layoutPath, moduleOptions)),
  );

  return {
    pageModule,
    layoutModules,
  };
}

function createRouteModuleOptions(projectRoot, mode, options = {}) {
  const resolvedStaticAssetPublicUrls =
    typeof options.getStaticAssetPublicUrls === "function"
      ? options.getStaticAssetPublicUrls()
      : (options.staticAssetPublicUrls ?? null);

  return {
    projectRoot,
    mode,
    ssr: true,
    staticAssetPublicUrls: resolvedStaticAssetPublicUrls,
  };
}

async function findAppModule(projectRoot, stem) {
  const appRoot = path.join(projectRoot, APP_DIRECTORY);

  for (const extension of MODULE_EXTENSIONS) {
    const candidate = path.join(appRoot, `${stem}${extension}`);
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

function getNearestBoundary(route, boundaryName) {
  return (route?.[boundaryName] ?? []).at(-1)?.module ?? null;
}

async function renderComponentTree(component, layoutComponents, requestContext, request, extraProps = {}) {
  let renderedTree = await component({
    params: requestContext.params,
    searchParams: requestContext.searchParams,
    request,
    ...extraProps,
  });

  for (let index = layoutComponents.length - 1; index >= 0; index -= 1) {
    renderedTree = await layoutComponents[index]({
      params: requestContext.params,
      searchParams: requestContext.searchParams,
      request,
      children: renderedTree,
    });
  }

  return renderedTree;
}

export async function resolveStaticParamsForRoute(route, projectRoot, mode = "production", options = {}) {
  const { pageModule, layoutModules } = await loadRouteModules(route, projectRoot, mode, options);
  const generators = [...layoutModules, pageModule]
    .map((moduleRecord) => getStaticParamsGenerator(moduleRecord))
    .filter(Boolean);

  let paramsList = [{}];

  for (const generateStaticParams of generators) {
    const nextParamsList = [];

    for (const params of paramsList) {
      const generatedEntries = await generateStaticParams({
        params: Object.freeze({ ...params }),
      });

      if (!Array.isArray(generatedEntries)) {
        throw new Error("Expected generateStaticParams() to return an array.");
      }

      for (const entry of generatedEntries) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new Error("Expected each generateStaticParams() entry to be an object.");
        }

        nextParamsList.push({
          ...params,
          ...entry,
        });
      }
    }

    paramsList = nextParamsList;
  }

  return {
    hasGenerateStaticParams: generators.length > 0,
    paramsList,
  };
}

export async function createRouteResolver(projectRoot, mode = "development", resolverOptions = {}) {
  const routes = await discoverAppRoutes(projectRoot);
  const routeHandlers = await discoverAppRouteHandlers(projectRoot);
  const rootLayoutPath = await findAppModule(projectRoot, "layout");
  const rootNotFoundPath = await findAppModule(projectRoot, "not-found");

  async function loadBoundaryComponent(boundaryPath) {
    if (!boundaryPath) {
      return null;
    }

    const moduleRecord = await importCompiledModule(
      boundaryPath,
      createRouteModuleOptions(projectRoot, mode, resolverOptions),
    );
    return {
      moduleRecord,
      component: assertServerComponent(
        await resolveDefaultExport(moduleRecord, boundaryPath),
        boundaryPath,
      ),
    };
  }

  async function renderNotFound(request, options = {}) {
    const route = options.route ?? null;
    const requestContext = options.requestContext ?? createRequestContext({
      request,
      params: options.params ?? {},
      searchParams: options.searchParams ?? collectSearchParams(new URL(request.url)),
    });
    const boundaryPath = getNearestBoundary(route, "notFoundBoundaries") ?? rootNotFoundPath;

    if (!boundaryPath) {
      return {
        type: "not-found",
        status: 404,
        boundaryModule: null,
        route,
        params: requestContext.params,
        searchParams: requestContext.searchParams,
        cachePolicy: { mode: "dynamic" },
        cacheKey: createRequestCacheKey(new URL(request.url)),
        responseHeaders: getRequestContextResponse(requestContext).headers,
      };
    }

    const boundary = await loadBoundaryComponent(boundaryPath);
    const layoutModules = options.layoutModules ?? await Promise.all(
      (rootLayoutPath ? [rootLayoutPath] : []).map((layoutPath) =>
        importCompiledModule(
          layoutPath,
          createRouteModuleOptions(projectRoot, mode, resolverOptions),
        ),
      ),
    );
    const layoutComponents = options.layoutComponents ?? await Promise.all(
      layoutModules.map((moduleRecord, index) => {
        const layoutPath = route?.layouts[index] ?? rootLayoutPath;
        return resolveDefaultExport(moduleRecord, layoutPath).then((entry) =>
          assertServerComponent(entry, layoutPath),
        );
      }),
    );
    const tree = await runWithRequestContext(requestContext, () =>
      renderComponentTree(boundary.component, layoutComponents, requestContext, requestContext.routeRequest),
    );
    const contextResponse = getRequestContextResponse(requestContext);

    return {
      type: "not-found",
      status: 404,
      tree,
      boundaryModule: boundaryPath,
      metadata: mergeMetadata([...layoutModules, boundary.moduleRecord]),
      route,
      params: requestContext.params,
      searchParams: requestContext.searchParams,
      cachePolicy: { mode: "dynamic" },
      cacheKey: createRequestCacheKey(new URL(request.url)),
      responseHeaders: contextResponse.headers,
    };
  }

  async function resolveRouteHandler(request, match, options = {}) {
    const url = new URL(request.url);
    if (options.renderTree === false) {
      return {
        type: "handler",
        status: 200,
        route: match.route,
        params: match.params,
        searchParams: collectSearchParams(url),
        cachePolicy: { mode: "dynamic" },
        cacheKey: createRequestCacheKey(url),
      };
    }

    const handlerModule = await importCompiledModule(
      match.route.handler,
      createRouteModuleOptions(projectRoot, mode, resolverOptions),
    );
    const method = (request.method || "GET").toUpperCase();
    const allowedMethods = Object.keys(handlerModule)
      .filter((name) => /^[A-Z]+$/.test(name) && typeof handlerModule[name] === "function")
      .sort();
    const handler = handlerModule[method];
    if (typeof handler !== "function") {
      const response = new Response(null, {
        status: 405,
        headers: { allow: allowedMethods.join(", ") },
      });
      return {
        type: "handler",
        status: response.status,
        response,
        route: match.route,
        params: match.params,
        searchParams: collectSearchParams(url),
        cachePolicy: { mode: "dynamic" },
        cacheKey: createRequestCacheKey(url),
      };
    }

    const requestContext = createRequestContext({
      request,
      params: match.params,
      searchParams: collectSearchParams(url),
    });
    const response = applyRequestContextToResponse(
      await runWithRequestContext(requestContext, () => handler(requestContext.routeRequest, {
        params: requestContext.params,
        searchParams: requestContext.searchParams,
      })),
      requestContext,
    );

    return {
      type: "handler",
      status: response.status,
      response,
      route: match.route,
      params: match.params,
      searchParams: requestContext.searchParams,
      cachePolicy: { mode: "dynamic" },
      cacheKey: createRequestCacheKey(url),
    };
  }

  async function resolveMatchedRequest(request, options = {}) {
    const url = new URL(request.url);
    const handlerMatch = matchRoute(url.pathname, routeHandlers);
    if (handlerMatch) {
      return resolveRouteHandler(request, handlerMatch, options);
    }
    const match = matchRoute(url.pathname, routes);

    if (!match) {
      if (options.renderTree === false) {
        return {
          type: "not-found",
          status: 404,
          cachePolicy: { mode: "dynamic" },
          cacheKey: createRequestCacheKey(url),
        };
      }

      return renderNotFound(request);
    }

    const { pageModule, layoutModules } = await loadRouteModules(
      match.route,
      projectRoot,
      mode,
      resolverOptions,
    );
    const routeConfig = mergeRouteConfig([...layoutModules, pageModule]);
    const cachePolicy = normalizeRouteCachePolicy(routeConfig);

    if (options.renderTree === false) {
      return {
        type: "route",
        status: 200,
        route: match.route,
        params: match.params,
        searchParams: collectSearchParams(url),
        routeConfig,
        cachePolicy,
        cacheKey: createRequestCacheKey(url),
      };
    }

    const pageComponent = assertServerComponent(
      await resolveDefaultExport(pageModule, match.route.page),
      match.route.page,
    );
    const layoutComponents = await Promise.all(
      layoutModules.map((moduleRecord, index) =>
        resolveDefaultExport(moduleRecord, match.route.layouts[index]).then((entry) =>
          assertServerComponent(entry, match.route.layouts[index]),
        ),
      ),
    );

    const requestContext = createRequestContext({
      request,
      params: match.params,
      searchParams: collectSearchParams(url),
    });

    try {
      const tree = await runWithRequestContext(requestContext, () =>
        renderComponentTree(pageComponent, layoutComponents, requestContext, requestContext.routeRequest),
      );
      const contextResponse = getRequestContextResponse(requestContext);

      return {
        type: "route",
        status: 200,
        tree,
        metadata: mergeMetadata([...layoutModules, pageModule]),
        route: match.route,
        params: match.params,
        searchParams: requestContext.searchParams,
        routeConfig,
        cachePolicy: contextResponse.didUseDynamicRequestData ? { mode: "dynamic" } : cachePolicy,
        cacheKey: createRequestCacheKey(url),
        responseHeaders: contextResponse.headers,
      };
    } catch (error) {
      if (isNextsxHttpSignal(error)) {
        if (error.type === "not-found") {
          return renderNotFound(request, {
            route: match.route,
            requestContext,
            layoutModules,
            layoutComponents,
          });
        }

        const contextResponse = getRequestContextResponse(requestContext);
        return {
          type: error.type,
          status: error.status,
          location: error.location,
          route: match.route,
          params: match.params,
          searchParams: requestContext.searchParams,
          routeConfig,
          cachePolicy: { mode: "dynamic" },
          cacheKey: createRequestCacheKey(url),
          responseHeaders: contextResponse.headers,
        };
      }

      const errorBoundaryPath = getNearestBoundary(match.route, "errorBoundaries");
      if (!errorBoundaryPath) {
        throw error;
      }

      const boundary = await loadBoundaryComponent(errorBoundaryPath);
      const boundaryError = createBoundaryError(error, {
        mode,
        route: match.route,
        reportRouteError: resolverOptions.reportRouteError,
      });
      const tree = await runWithRequestContext(requestContext, () =>
        renderComponentTree(boundary.component, layoutComponents, requestContext, requestContext.routeRequest, {
          error: boundaryError,
        }),
      );
      const contextResponse = getRequestContextResponse(requestContext);
      return {
        type: "error",
        status: 500,
        tree,
        boundaryModule: errorBoundaryPath,
        metadata: mergeMetadata([...layoutModules, boundary.moduleRecord]),
        route: match.route,
        params: match.params,
        searchParams: requestContext.searchParams,
        routeConfig,
        cachePolicy: { mode: "dynamic" },
        cacheKey: createRequestCacheKey(url),
        responseHeaders: contextResponse.headers,
      };
    }
  }

  return {
    routes,
    routeHandlers,
    async resolveRoutePolicy(request) {
      return resolveMatchedRequest(request, { renderTree: false });
    },
    async resolveRequest(request) {
      return resolveMatchedRequest(request, { renderTree: true });
    },
  };
}
