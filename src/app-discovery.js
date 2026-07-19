import path from "node:path";
import { APP_DIRECTORY, MODULE_EXTENSIONS } from "./constants.js";
import { pathExists, walkFiles } from "./fs-utils.js";

function stripExtension(filename) {
  for (const extension of MODULE_EXTENSIONS) {
    if (filename.endsWith(extension)) {
      return filename.slice(0, -extension.length);
    }
  }

  return filename;
}

function normalizeSegment(segment) {
  if (segment.startsWith("(") && segment.endsWith(")")) {
    return null;
  }

  return segment;
}

function routePathFromSegments(segments) {
  if (segments.length === 0) {
    return "/";
  }

  const pathname = segments
    .map((segment) => normalizeSegment(segment))
    .filter(Boolean)
    .map((segment) => {
      if (segment.startsWith("[...") && segment.endsWith("]")) {
        return `*${segment.slice(4, -1)}`;
      }

      if (segment.startsWith("[") && segment.endsWith("]")) {
        return `:${segment.slice(1, -1)}`;
      }

      return segment;
    })
    .join("/");

  return pathname ? `/${pathname}` : "/";
}

function collectLayoutCandidates(routeDirectory, appRoot) {
  const layouts = [];
  let currentDirectory = routeDirectory;

  while (currentDirectory.startsWith(appRoot)) {
    layouts.push(currentDirectory);
    if (currentDirectory === appRoot) {
      break;
    }
    currentDirectory = path.dirname(currentDirectory);
  }

  return layouts.reverse();
}

function findModuleByStem(filesByStem, directory, stem) {
  for (const extension of MODULE_EXTENSIONS) {
    const candidate = path.join(directory, `${stem}${extension}`);
    if (filesByStem.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

export async function discoverAppRoutes(projectRoot) {
  const appRoot = path.join(projectRoot, APP_DIRECTORY);
  if (!(await pathExists(appRoot))) {
    return [];
  }

  const allFiles = await walkFiles(appRoot);
  const filesByStem = new Set(allFiles);

  const pageFiles = allFiles.filter((filePath) => {
    const baseName = path.basename(stripExtension(filePath));
    return baseName === "page";
  });

  return pageFiles.map((pagePath) => {
    const routeDirectory = path.dirname(pagePath);
    const relativeDirectory = path.relative(appRoot, routeDirectory);
    const routeSegments =
      relativeDirectory === "" ? [] : relativeDirectory.split(path.sep);
    const layoutFiles = collectLayoutCandidates(routeDirectory, appRoot)
      .map((directory) => findModuleByStem(filesByStem, directory, "layout"))
      .filter(Boolean);

    return {
      pathname: routePathFromSegments(routeSegments),
      page: pagePath,
      layouts: layoutFiles,
    };
  });
}

export function matchRoute(pathname, routes) {
  const requestSegments = pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));

  for (const route of routes) {
    const routeSegments = route.pathname.split("/").filter(Boolean);
    const params = {};
    let matched = true;

    for (let index = 0; index < routeSegments.length; index += 1) {
      const routeSegment = routeSegments[index];
      const requestSegment = requestSegments[index];

      if (routeSegment?.startsWith("*")) {
        params[routeSegment.slice(1)] = requestSegments.slice(index);
        break;
      }

      if (requestSegment == null) {
        matched = false;
        break;
      }

      if (routeSegment?.startsWith(":")) {
        params[routeSegment.slice(1)] = requestSegment;
        continue;
      }

      if (routeSegment !== requestSegment) {
        matched = false;
        break;
      }
    }

    if (!matched) {
      continue;
    }

    const lastSegment = routeSegments[routeSegments.length - 1] ?? null;
    const hasCatchAll = Boolean(lastSegment?.startsWith("*"));
    if (!hasCatchAll && routeSegments.length !== requestSegments.length) {
      continue;
    }

    return { route, params };
  }

  return null;
}
