import fs from "node:fs/promises";
import path from "node:path";
import { discoverAppRoutes } from "./app-discovery.js";
import { compileModuleGraph } from "./compiler.js";
import { emitHashedClientAssets, rewriteServerAssetPlaceholders } from "./client-assets.js";
import {
  BUILD_DIRECTORY,
  INTERNAL_DIRECTORY,
  MANIFEST_FILENAME,
} from "./constants.js";
import { ensureDirectory, writeJson } from "./fs-utils.js";

export async function buildProject(projectRoot) {
  const routes = await discoverAppRoutes(projectRoot);
  const buildRoot = path.join(projectRoot, INTERNAL_DIRECTORY, BUILD_DIRECTORY);
  const entryClientModules = new Set();

  await ensureDirectory(buildRoot);

  for (const route of routes) {
    await compileModuleGraph(route.page, {
      projectRoot,
      mode: "production",
      sourceMaps: false,
      ssr: true,
      target: "server",
    });

    const pageClientBuild = await compileModuleGraph(route.page, {
      projectRoot,
      mode: "production",
      sourceMaps: false,
      target: "client",
    });
    entryClientModules.add(
      path.relative(pageClientBuild.outputRoot, pageClientBuild.entrypoint).split(path.sep).join("/"),
    );

    for (const layoutPath of route.layouts) {
      await compileModuleGraph(layoutPath, {
        projectRoot,
        mode: "production",
        sourceMaps: false,
        ssr: true,
        target: "server",
      });

      const layoutClientBuild = await compileModuleGraph(layoutPath, {
        projectRoot,
        mode: "production",
        sourceMaps: false,
        target: "client",
      });
      entryClientModules.add(
        path.relative(layoutClientBuild.outputRoot, layoutClientBuild.entrypoint).split(path.sep).join("/"),
      );
    }
  }

  const clientAssets = await emitHashedClientAssets(projectRoot, {
    entryClientModules,
  });
  await rewriteServerAssetPlaceholders(projectRoot, clientAssets);

  const manifestPath = path.join(buildRoot, MANIFEST_FILENAME);
  await writeJson(manifestPath, {
    routes,
    clientAssets,
    builtAt: new Date().toISOString(),
  });

  return manifestPath;
}
