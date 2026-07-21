import http from "node:http";
import path from "node:path";
import { loadNextsxConfig } from "./config.js";
import { createDeploymentRuntime } from "./deployment-runtime.js";
import { BUILD_DIRECTORY, INTERNAL_DIRECTORY, MANIFEST_FILENAME } from "./constants.js";
import { normalizeClientAssetManifest } from "./client-assets.js";
import { pathExists, readJson } from "./fs-utils.js";
import { createDefaultRouteCacheKey, resolveResponseCacheRuntime } from "./response-cache.js";

function getPort(explicitPort) {
  const port = explicitPort ?? process.env.PORT ?? "3000";
  return Number.parseInt(String(port), 10);
}

async function createServer(projectRoot, mode, explicitPort, options = {}) {
  const nextsxConfig = options.nextsxConfig ?? await loadNextsxConfig(projectRoot);
  const responseCacheRuntime = options.responseCacheStore
    ? {
      store: options.responseCacheStore,
      createKey: options.createResponseCacheKey ?? (({ request }) => createDefaultRouteCacheKey(request)),
    }
    : await resolveResponseCacheRuntime(projectRoot, mode, nextsxConfig);
  const deploymentRuntime = await createDeploymentRuntime({
    projectRoot,
    mode,
    assetManifest: normalizeClientAssetManifest(options.assetManifest),
    responseCacheRuntime,
  });
  const port = getPort(explicitPort);

  const server = http.createServer(async (req, res) => {
    try {
      const origin = `http://${req.headers.host ?? `localhost:${port}`}`;
      const request = new Request(new URL(req.url ?? "/", origin), {
        method: req.method,
        headers: req.headers,
      });
      const response = await deploymentRuntime.handle(request);

      res.writeHead(response.status, response.headers);
      res.end(response.body);
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.stack ?? error.message : String(error));
    }
  });

  return {
    port,
    deploymentRuntime,
    async listen() {
      await new Promise((resolve) => {
        server.listen(port, resolve);
      });
      return server;
    },
    close() {
      server.close();
    },
  };
}

export async function createDevServer(projectRoot, options = {}) {
  return createServer(projectRoot, "development", options.port, options);
}

export async function createStartServer(projectRoot, options = {}) {
  const manifestPath = path.join(
    projectRoot,
    INTERNAL_DIRECTORY,
    BUILD_DIRECTORY,
    MANIFEST_FILENAME,
  );

  if (!(await pathExists(manifestPath))) {
    throw new Error("Build output not found. Run `yarn build` before `yarn start`.");
  }

  const manifest = await readJson(manifestPath);
  return createServer(projectRoot, "production", options.port, {
    ...options,
    assetManifest: manifest.clientAssets ?? null,
  });
}
