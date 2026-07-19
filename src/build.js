import fs from "node:fs/promises";
import path from "node:path";
import { discoverAppRoutes } from "./app-discovery.js";
import { compileModuleGraph } from "./compiler.js";
import {
  BUILD_DIRECTORY,
  INTERNAL_DIRECTORY,
  MANIFEST_FILENAME,
} from "./constants.js";
import { ensureDirectory, writeJson } from "./fs-utils.js";

export async function buildProject(projectRoot) {
  const routes = await discoverAppRoutes(projectRoot);
  const buildRoot = path.join(projectRoot, INTERNAL_DIRECTORY, BUILD_DIRECTORY);

  await ensureDirectory(buildRoot);

  for (const route of routes) {
    await compileModuleGraph(route.page, {
      projectRoot,
      mode: "production",
      sourceMaps: false,
      ssr: true,
      target: "server",
    });

    await compileModuleGraph(route.page, {
      projectRoot,
      mode: "production",
      sourceMaps: false,
      target: "client",
    });

    for (const layoutPath of route.layouts) {
      await compileModuleGraph(layoutPath, {
        projectRoot,
        mode: "production",
        sourceMaps: false,
        ssr: true,
        target: "server",
      });

      await compileModuleGraph(layoutPath, {
        projectRoot,
        mode: "production",
        sourceMaps: false,
        target: "client",
      });
    }
  }

  const manifestPath = path.join(buildRoot, MANIFEST_FILENAME);
  await writeJson(manifestPath, {
    routes,
    builtAt: new Date().toISOString(),
  });

  return manifestPath;
}
