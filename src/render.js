import { discoverAppRoutes, matchRoute } from "./app-discovery.js";
import { importCompiledModule } from "./compiler.js";
import { mergeRouteConfig, normalizeRouteCachePolicy } from "./route-config.js";
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

function getStaticParamsGenerator(moduleRecord) {
  if (moduleRecord?.generateStaticParams == null) {
    return null;
  }

  if (typeof moduleRecord.generateStaticParams !== "function") {
    throw new Error("Expected generateStaticParams to export a function.");
  }

  return moduleRecord.generateStaticParams;
}

async function loadRouteModules(route, projectRoot, mode) {
  const moduleOptions = { projectRoot, mode, ssr: true };
  const pageModule = await importCompiledModule(route.page, moduleOptions);
  const layoutModules = await Promise.all(
    route.layouts.map((layoutPath) => importCompiledModule(layoutPath, moduleOptions)),
  );

  return {
    pageModule,
    layoutModules,
  };
}

export async function resolveStaticParamsForRoute(route, projectRoot, mode = "production") {
  const { pageModule, layoutModules } = await loadRouteModules(route, projectRoot, mode);
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

export async function createRouteResolver(projectRoot, mode = "development") {
  const routes = await discoverAppRoutes(projectRoot);

  async function resolveMatchedRequest(request, options = {}) {
    const url = new URL(request.url);
    const match = matchRoute(url.pathname, routes);

    if (!match) {
      return {
        type: "not-found",
        status: 404,
      };
    }

    const { pageModule, layoutModules } = await loadRouteModules(match.route, projectRoot, mode);
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
        cacheKey: url.pathname,
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

    const requestContext = {
      params: match.params,
      searchParams: collectSearchParams(url),
      request,
    };

    let tree = await pageComponent(requestContext);

    for (let index = layoutComponents.length - 1; index >= 0; index -= 1) {
      tree = await layoutComponents[index]({
        ...requestContext,
        children: tree,
      });
    }

    return {
      type: "route",
      status: 200,
      tree,
      metadata: mergeMetadata([...layoutModules, pageModule]),
      route: match.route,
      params: match.params,
      searchParams: collectSearchParams(url),
      routeConfig,
      cachePolicy,
      cacheKey: url.pathname,
    };
  }

  return {
    routes,
    async resolveRoutePolicy(request) {
      return resolveMatchedRequest(request, { renderTree: false });
    },
    async resolveRequest(request) {
      return resolveMatchedRequest(request, { renderTree: true });
    },
  };
}
