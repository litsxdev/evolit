import { discoverAppRoutes, matchRoute } from "./app-discovery.js";
import { importCompiledModule } from "./compiler.js";
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

    const moduleOptions = { projectRoot, mode, ssr: true };
    const pageModule = await importCompiledModule(match.route.page, moduleOptions);
    const layoutModules = await Promise.all(
      match.route.layouts.map((layoutPath) => importCompiledModule(layoutPath, moduleOptions)),
    );

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
    };
  };
}
