import path from "node:path";
import { pathToFileURL } from "node:url";
import { pathExists } from "./fs-utils.js";

const CONFIG_FILENAME = "evolit.config.js";

export async function loadEvolitConfig(projectRoot) {
  const configPath = path.join(projectRoot, CONFIG_FILENAME);
  if (!(await pathExists(configPath))) {
    return {};
  }

  const moduleRecord = await import(pathToFileURL(configPath).href);
  const config = moduleRecord.default ?? {};
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Expected evolit.config.js to export a default object.");
  }

  return config;
}

export function resolveManagedSourceRoots(projectRoot, config = {}) {
  const configuredRoots = config.development?.managedSourceRoots;
  if (configuredRoots != null && !Array.isArray(configuredRoots)) {
    throw new Error("Expected development.managedSourceRoots to be an array of paths.");
  }
  const roots = [...new Set([
    path.resolve(projectRoot),
    ...(configuredRoots ?? []).map((sourceRoot) => {
      if (typeof sourceRoot !== "string" || sourceRoot.length === 0) {
        throw new Error("Expected every development.managedSourceRoots entry to be a non-empty path.");
      }
      return path.resolve(projectRoot, sourceRoot);
    }),
  ])];
  return roots.filter((candidate, index) => !roots.some((other, otherIndex) => {
    if (index === otherIndex) return false;
    const relativePath = path.relative(other, candidate);
    return relativePath === "" || (
      relativePath !== ".."
      && !relativePath.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relativePath)
    );
  }));
}
