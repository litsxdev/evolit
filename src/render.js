import { discoverAppRoutes, matchRoute } from "./app-discovery.js";
import { importCompiledModule } from "./compiler.js";

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

function mergeMetadata(modules) {
  return modules.reduce((metadata, moduleRecord) => {
    if (moduleRecord?.metadata && typeof moduleRecord.metadata === "object") {
      return { ...metadata, ...moduleRecord.metadata };
    }

    return metadata;
  }, {});
}

export async function createRouteResolver(projectRoot, mode = "development") {
  const routes = await discoverAppRoutes(projectRoot);

  return async function resolveRequest(request) {
    const url = new URL(request.url);
    const match = matchRoute(url.pathname, routes);

    if (!match) {
      return {
        type: "not-found",
        status: 404,
      };
    }

    const moduleOptions = { projectRoot, mode };
    const pageModule = await importCompiledModule(match.route.page, moduleOptions);
    const layoutModules = await Promise.all(
      match.route.layouts.map((layoutPath) => importCompiledModule(layoutPath, moduleOptions)),
    );

    const pageComponent = await resolveDefaultExport(pageModule, match.route.page);
    const layoutComponents = await Promise.all(
      layoutModules.map((moduleRecord, index) =>
        resolveDefaultExport(moduleRecord, match.route.layouts[index]),
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
    };
  };
}
