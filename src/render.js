import path from "node:path";
import { randomUUID } from "node:crypto";
import { html } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { renderToString } from "@litsx/ssr";
import { discoverAppRouteHandlers, discoverAppRoutes, matchRoute } from "./app-discovery.js";
import { importCompiledModule } from "./compiler.js";
import { APP_DIRECTORY, MODULE_EXTENSIONS } from "./constants.js";
import { pathExists } from "./fs-utils.js";
import { mergeRouteConfig, normalizeRouteCachePolicy } from "./route-config.js";
import { createRouteSegmentPlan, wrapRouteSegment } from "./route-segments.js";
import {
  createRequestContext,
  applyRequestContextToResponse,
  getRequestContextResponse,
  isEvolitHttpSignal,
  runWithRequestContext,
} from "./request-context.js";
import { createDevelopmentEventReporter } from "./development-events.js";
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
    createDevelopmentEventReporter()({
      type: "route-error",
      digest,
      pathname: route.pathname,
      error: originalError,
    });
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
    onDevelopmentEvent: options.onDevelopmentEvent,
    managedSourceRoots: options.managedSourceRoots,
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

async function renderComponentTree(
  component,
  layoutComponents,
  requestContext,
  request,
  extraProps = {},
  segments = [],
) {
  let renderedTree = wrapRouteSegment(
    segments.at(-1),
    await component({
      params: requestContext.params,
      searchParams: requestContext.searchParams,
      request,
      ...extraProps,
    }),
  );

  for (let index = layoutComponents.length - 1; index >= 0; index -= 1) {
    renderedTree = wrapRouteSegment(segments[index], await layoutComponents[index]({
      params: requestContext.params,
      searchParams: requestContext.searchParams,
      request,
      children: renderedTree,
    }));
  }

  return renderedTree;
}

function createSegmentChildrenMarker(segment) {
  return `<!--evolit:children:${segment.id}-->`;
}

export function combineSegmentSsrArtifacts(results) {
  const roots = [];
  const payload = { roots: {}, instances: {}, resources: {} };
  const clientImports = new Set();
  const headTags = new Set();

  for (const result of results) {
    if (!result) continue;
    for (const clientImport of result.clientImports ?? []) clientImports.add(clientImport);
    for (const headTag of result.headTags ?? []) headTags.add(headTag);
    if (!result.hydrationData) continue;
    roots.push(...(result.hydrationData.roots ?? []).map((root) => ({
      ...root,
      ...(typeof result.segmentModulePath === "string"
        ? { segmentModulePath: result.segmentModulePath }
        : {}),
    })));
    Object.assign(payload.roots, result.hydrationData.payload?.roots ?? {});
    Object.assign(payload.instances, result.hydrationData.payload?.instances ?? {});
    Object.assign(payload.resources, result.hydrationData.payload?.resources ?? {});
  }

  const hasResources = Object.keys(payload.resources).length > 0;

  return {
    clientImports: [...clientImports],
    headTags: [...headTags],
    hydrationData: roots.length > 0 || hasResources
      ? { version: 1, roots, payload, clientImports: [...clientImports] }
      : null,
  };
}

function createTrackedRouteValues(values) {
  const accessedKeys = new Set();
  let accessedAll = false;
  const value = new Proxy(values, {
    get(target, property, receiver) {
      if (typeof property === "string") accessedKeys.add(property);
      return Reflect.get(target, property, receiver);
    },
    has(target, property) {
      if (typeof property === "string") accessedKeys.add(property);
      return Reflect.has(target, property);
    },
    ownKeys(target) {
      accessedAll = true;
      return Reflect.ownKeys(target);
    },
  });

  return {
    value,
    profile() {
      return accessedAll ? { all: true, keys: [] } : { all: false, keys: [...accessedKeys].sort() };
    },
  };
}

function createSegmentCacheKey(segment, idPrefix, profile, params, searchParams) {
  const select = (values) => Object.fromEntries(
    (profile.all ? Object.keys(values) : profile.keys)
      .sort()
      .map((key) => [key, values[key]]),
  );
  return JSON.stringify({
    modulePath: segment.modulePath,
    idPrefix,
    params: select(params),
    searchParams: select(searchParams),
  });
}

function createSegmentInputKey(profile, params, searchParams) {
  const select = (values) => Object.fromEntries(
    (profile.all ? Object.keys(values) : profile.keys)
      .sort()
      .map((key) => [key, values[key]]),
  );
  return JSON.stringify({
    params: select(params),
    searchParams: select(searchParams),
  });
}

function getSegmentCacheExpiry(cachePolicy) {
  if (cachePolicy?.mode === "static") return Number.POSITIVE_INFINITY;
  if (cachePolicy?.mode === "revalidate" && Number.isFinite(cachePolicy.ttlSeconds)) {
    return Date.now() + (cachePolicy.ttlSeconds * 1_000);
  }
  return null;
}

function createSegmentRenderCache(projectRoot, onDevelopmentEvent) {
  const entries = new Map();
  const profiles = new Map();

  return {
    get(segment, idPrefix, params, searchParams) {
      const profile = profiles.get(segment.modulePath);
      if (!profile) {
        onDevelopmentEvent?.({ type: "segment-cache-miss", modulePath: segment.modulePath, reason: "cold" });
        return null;
      }
      const key = createSegmentCacheKey(segment, idPrefix, profile, params, searchParams);
      const entry = entries.get(key);
      if (!entry || entry.expiresAt <= Date.now()) {
        if (entry) entries.delete(key);
        onDevelopmentEvent?.({
          type: "segment-cache-miss",
          modulePath: segment.modulePath,
          reason: entry ? "expired" : "key-change",
        });
        return null;
      }
      onDevelopmentEvent?.({ type: "segment-cache-hit", modulePath: segment.modulePath });
      return entry.result;
    },
    getProfile(segment) {
      return profiles.get(segment.modulePath) ?? null;
    },
    set(segment, idPrefix, params, searchParams, profile, result, cachePolicy) {
      const expiresAt = getSegmentCacheExpiry(cachePolicy);
      if (expiresAt == null) return;
      profiles.set(segment.modulePath, profile);
      const key = createSegmentCacheKey(segment, idPrefix, profile, params, searchParams);
      entries.set(key, { result, expiresAt, modulePath: segment.modulePath });
      if (entries.size > 256) entries.delete(entries.keys().next().value);
    },
    invalidate(changedPaths = null) {
      if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
        const entryCount = entries.size;
        entries.clear();
        profiles.clear();
        return entryCount;
      }
      const normalizedPaths = new Set(changedPaths.map((changedPath) => path.resolve(changedPath)));
      const hasSharedChange = [...normalizedPaths].some((changedPath) =>
        !path.relative(projectRoot, changedPath).startsWith(`app${path.sep}`),
      );
      if (hasSharedChange) {
        const entryCount = entries.size;
        entries.clear();
        profiles.clear();
        return entryCount;
      }
      let entryCount = 0;
      for (const [key, entry] of entries) {
        if (normalizedPaths.has(path.resolve(projectRoot, entry.modulePath))) {
          entries.delete(key);
          entryCount += 1;
        }
      }
      for (const modulePath of profiles.keys()) {
        if (normalizedPaths.has(path.resolve(projectRoot, modulePath))) profiles.delete(modulePath);
      }
      return entryCount;
    },
    clear() {
      const entryCount = entries.size;
      entries.clear();
      profiles.clear();
      return entryCount;
    },
  };
}

/**
 * Renders route segments separately, then composes layout shells through an
 * internal children marker. Authored layouts still receive a normal Lit
 * renderable and can project children any number of times.
 */
async function renderSegmentedComponentTree(
  component,
  layoutComponents,
  requestContext,
  request,
  extraProps = {},
  segments = [],
  options = {},
) {
  if (segments.length !== layoutComponents.length + 1) return null;
  const results = [];

  async function renderSegmentAt(index, projectionPath) {
    const segment = segments[index];
    const idPrefix = `${segment.id}-p${projectionPath.join("-") || "0"}`;

    if (index === layoutComponents.length) {
      const pageValue = await component({
        params: requestContext.params,
        searchParams: requestContext.searchParams,
        request,
        ...extraProps,
      });
      const pageResult = await renderToString(wrapRouteSegment(segment, pageValue), {
        assetResolver: options.assetResolver,
        context: { idPrefix },
      });
      pageResult.segmentModulePath = segment.modulePath;
      results.push(pageResult);
      return pageResult.html;
    }

    const childrenMarker = createSegmentChildrenMarker(segment);
    let profile = options.segmentCache?.getProfile(segment) ?? null;
    let layoutResult = options.segmentCache?.get(
      segment,
      idPrefix,
      requestContext.params,
      requestContext.searchParams,
    ) ?? null;
    if (!layoutResult) {
      const trackedParams = createTrackedRouteValues(requestContext.params);
      const trackedSearchParams = createTrackedRouteValues(requestContext.searchParams);
      const didUseDynamicRequestData = requestContext.didUseDynamicRequestData;
      const layoutValue = await layoutComponents[index]({
        params: trackedParams.value,
        searchParams: trackedSearchParams.value,
        request,
        children: html`${unsafeHTML(childrenMarker)}`,
      });
      layoutResult = await renderToString(wrapRouteSegment(segment, layoutValue), {
        assetResolver: options.assetResolver,
        context: { idPrefix },
      });
      layoutResult.segmentModulePath = segment.modulePath;
      profile = {
        all: trackedParams.profile().all || trackedSearchParams.profile().all,
        keys: [...new Set([
          ...trackedParams.profile().keys,
          ...trackedSearchParams.profile().keys,
        ])].sort(),
      };
      if (!didUseDynamicRequestData && !requestContext.didUseDynamicRequestData) {
        options.segmentCache?.set(
          segment,
          idPrefix,
          requestContext.params,
          requestContext.searchParams,
          profile,
          layoutResult,
          options.cachePolicy,
        );
      }
    }
    if (profile) {
      segment.inputKey = createSegmentInputKey(
        profile,
        requestContext.params,
        requestContext.searchParams,
      );
    }
    results.push(layoutResult);
    const projectionCount = layoutResult.html.split(childrenMarker).length - 1;
    if (projectionCount === 0) return null;

    const childHtml = [];
    for (let projection = 0; projection < projectionCount; projection += 1) {
      const renderedChild = await renderSegmentAt(index + 1, [...projectionPath, projection]);
      if (renderedChild == null) return null;
      childHtml.push(renderedChild);
    }
    let projection = 0;
    return layoutResult.html.replaceAll(childrenMarker, () => childHtml[projection++]);
  }

  const tree = await renderSegmentAt(0, []);
  return tree == null ? null : { tree, ssrArtifacts: combineSegmentSsrArtifacts(results) };
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
  const segmentRenderCache = resolverOptions.segmentRenderCache
    ?? createSegmentRenderCache(projectRoot, resolverOptions.onDevelopmentEvent);
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

    const preloadedModules = options.routePolicyResult?.route === match.route
      ? options.routePolicyResult.__evolitLoadedModules
      : null;
    const { pageModule, layoutModules } = preloadedModules ?? await loadRouteModules(
      match.route,
      projectRoot,
      mode,
      resolverOptions,
    );
    const routeConfig = mergeRouteConfig([...layoutModules, pageModule]);
    const cachePolicy = normalizeRouteCachePolicy(routeConfig);

    if (options.renderTree === false) {
      const routePolicyResult = {
        type: "route",
        status: 200,
        route: match.route,
        params: match.params,
        searchParams: collectSearchParams(url),
        routeConfig,
        cachePolicy,
        cacheKey: createRequestCacheKey(url),
      };
      Object.defineProperty(routePolicyResult, "__evolitLoadedModules", {
        value: { pageModule, layoutModules },
      });
      return routePolicyResult;
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
      const segments = createRouteSegmentPlan(match.route, projectRoot);
      const segmentedRender = await runWithRequestContext(requestContext, () =>
        renderSegmentedComponentTree(
          pageComponent,
          layoutComponents,
          requestContext,
          requestContext.routeRequest,
          {},
          segments,
          {
            assetResolver: resolverOptions.assetResolver,
            segmentCache: segmentRenderCache,
            cachePolicy,
          },
        ),
      );
      const tree = segmentedRender?.tree ?? await runWithRequestContext(requestContext, () =>
        renderComponentTree(
          pageComponent,
          layoutComponents,
          requestContext,
          requestContext.routeRequest,
          {},
          segments,
        ),
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
        segments,
        ssrArtifacts: segmentedRender?.ssrArtifacts ?? null,
        cachePolicy: contextResponse.didUseDynamicRequestData ? { mode: "dynamic" } : cachePolicy,
        cacheKey: createRequestCacheKey(url),
        responseHeaders: contextResponse.headers,
      };
    } catch (error) {
      if (isEvolitHttpSignal(error)) {
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
      const segments = createRouteSegmentPlan(match.route, projectRoot, {
        boundaryModule: errorBoundaryPath,
      });
      const tree = await runWithRequestContext(requestContext, () =>
        renderComponentTree(
          boundary.component,
          layoutComponents,
          requestContext,
          requestContext.routeRequest,
          { error: boundaryError },
          segments,
        ),
      );
      const contextResponse = getRequestContextResponse(requestContext);
      return {
        type: "error",
        status: 500,
        tree,
        boundaryModule: errorBoundaryPath,
        segments,
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
    async resolveRequest(request, routePolicyResult = null) {
      return resolveMatchedRequest(request, { renderTree: true, routePolicyResult });
    },
    invalidateSegmentCache(changedPaths = null) {
      return segmentRenderCache.invalidate(changedPaths);
    },
    segmentRenderCache,
  };
}
