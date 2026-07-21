import path from "node:path";
import { pathToFileURL } from "node:url";
import { pathExists } from "./fs-utils.js";

const CONFIG_FILENAME = "nextsx.config.js";

export async function loadNextsxConfig(projectRoot) {
  const configPath = path.join(projectRoot, CONFIG_FILENAME);
  if (!(await pathExists(configPath))) {
    return {};
  }

  const moduleRecord = await import(pathToFileURL(configPath).href);
  const config = moduleRecord.default ?? {};
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Expected nextsx.config.js to export a default object.");
  }

  return config;
}
