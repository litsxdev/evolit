import http from "node:http";
import path from "node:path";
import { createRouteResolver } from "./render.js";
import { createSsrAdapter, renderRouteTreeWithAdapter } from "./ssr-adapter.js";
import {
  BUILD_DIRECTORY,
  INTERNAL_DIRECTORY,
  MANIFEST_FILENAME,
} from "./constants.js";
import { pathExists, readJson } from "./fs-utils.js";

function getPort(explicitPort) {
  const port = explicitPort ?? process.env.PORT ?? "3000";
  return Number.parseInt(String(port), 10);
}

async function createServer(projectRoot, mode, explicitPort) {
  const resolveRequest = await createRouteResolver(projectRoot, mode);
  const ssrAdapter = createSsrAdapter();
  const port = getPort(explicitPort);

  const server = http.createServer(async (req, res) => {
    try {
      const origin = `http://${req.headers.host ?? `localhost:${port}`}`;
      const request = new Request(new URL(req.url ?? "/", origin), {
        method: req.method,
        headers: req.headers,
      });
      const routeResult = await resolveRequest(request);
      const response = await renderRouteTreeWithAdapter(routeResult, ssrAdapter);

      res.writeHead(response.status, response.headers);
      res.end(response.body);
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.stack ?? error.message : String(error));
    }
  });

  return {
    port,
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
  return createServer(projectRoot, "development", options.port);
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

  await readJson(manifestPath);
  return createServer(projectRoot, "production", options.port);
}
