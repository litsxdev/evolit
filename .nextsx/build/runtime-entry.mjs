import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

let createDeploymentRuntime;
try {
  ({ createDeploymentRuntime } = await import("nextsx"));
} catch {
  ({ createDeploymentRuntime } = await import("file:///Users/rafabernad/Workspace/nextsx/src/index.js"));
}

const buildRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(buildRoot, "..", "..");
let runtimePromise = null;

export async function createBuiltDeploymentRuntime(options = {}) {
  const manifest = JSON.parse(await fs.readFile(path.join(buildRoot, "manifest.json"), "utf8"));
  return createDeploymentRuntime({
    projectRoot: options.projectRoot ?? projectRoot,
    mode: "production",
    assetManifest: manifest.clientAssets ?? null,
    responseCacheRuntime: options.responseCacheRuntime,
    routeResolver: options.routeResolver,
  });
}

export async function getBuiltDeploymentRuntime(options = {}) {
  if (!runtimePromise) {
    runtimePromise = createBuiltDeploymentRuntime(options);
  }
  return runtimePromise;
}

export async function handleRequest(request, options = {}) {
  const runtime = await getBuiltDeploymentRuntime(options);
  return runtime.handle(request);
}
