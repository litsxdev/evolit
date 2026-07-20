import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createRouteResolver } from "./render.js";
import { createSsrAdapter, renderRouteTreeWithAdapter } from "./ssr-adapter.js";
import { compileModuleGraph } from "./compiler.js";
import {
  BUILD_DIRECTORY,
  INTERNAL_DIRECTORY,
  MANIFEST_FILENAME,
} from "./constants.js";
import {
  createAssetResolver,
  collectDevStyleUrls,
  collectTransitiveAssetPreloads,
  collectTransitiveStyleUrls,
  createHydrationBootstrap,
  createFrameworkImportMap,
  getClientOutputRoot,
} from "./client-assets.js";
import { pathExists, readJson } from "./fs-utils.js";
import { createRequire } from "node:module";

const requireFromHere = createRequire(import.meta.url);

function getContentType(filePath) {
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }

  return "text/javascript; charset=utf-8";
}

function getPort(explicitPort) {
  const port = explicitPort ?? process.env.PORT ?? "3000";
  return Number.parseInt(String(port), 10);
}

function getClientAssetFilePath(projectRoot, mode, pathname) {
  const clientRoot = getClientOutputRoot(projectRoot, mode);
  const relativePath = pathname.slice("/_nextsx/client/".length);
  return path.join(clientRoot, relativePath);
}

async function sendFileResponse(res, filePath, contentType = getContentType(filePath)) {
  const body = await fs.readFile(filePath);
  res.writeHead(200, { "content-type": contentType });
  res.end(body);
}

async function createServer(projectRoot, mode, explicitPort, options = {}) {
  const resolveRequest = await createRouteResolver(projectRoot, mode);
  const assetResolver = createAssetResolver(projectRoot, {
    assetManifest: options.assetManifest,
  });
  const frameworkImportMap = await createFrameworkImportMap();
  const importMapMarkup = `<script type="importmap">${JSON.stringify(frameworkImportMap)}</script>`;
  const ssrAdapter = createSsrAdapter({
    assetResolver,
    head: importMapMarkup,
    async resolveAdditionalHead({ result }) {
      const clientImports = Array.isArray(result.clientImports) ? result.clientImports : [];
      const urls = options.assetManifest
        ? collectTransitiveAssetPreloads(clientImports, options.assetManifest)
        : [];
      const styleUrls = options.assetManifest
        ? collectTransitiveStyleUrls(clientImports, options.assetManifest)
        : await collectDevStyleUrls(projectRoot, clientImports, mode);
      if (urls.length === 0 && styleUrls.length === 0) {
        return "";
      }

      return [
        ...urls.map((href) => `<link rel="modulepreload" href="${href}">`),
        ...styleUrls.map((href) => `<link rel="stylesheet" href="${href}">`),
      ].join("\n");
    },
    resolveBootstrap({ result }) {
      return createHydrationBootstrap({
        hydrationData: result.hydrationData,
        assetResolver,
      });
    },
  });
  const port = getPort(explicitPort);

  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? "/", `http://localhost:${port}`).pathname;

      if (pathname.startsWith("/_nextsx/client/")) {
        const assetPath = getClientAssetFilePath(projectRoot, mode, pathname);
        await sendFileResponse(res, assetPath);
        return;
      }

      if (pathname.startsWith("/_nextsx/static/")) {
        const assetPath = options.assetManifest?.byPublicPath?.[pathname] ?? null;
        if (!assetPath) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("Asset not found.");
          return;
        }
        await sendFileResponse(res, assetPath);
        return;
      }

      if (pathname.startsWith("/_nextsx/pkg/")) {
        const specifier = decodeURIComponent(pathname.slice("/_nextsx/pkg/".length));
        const packageFile = requireFromHere.resolve(specifier);
        await sendFileResponse(res, packageFile);
        return;
      }

      const origin = `http://${req.headers.host ?? `localhost:${port}`}`;
      const request = new Request(new URL(req.url ?? "/", origin), {
        method: req.method,
        headers: req.headers,
      });
      const routeResult = await resolveRequest(request);

      if (routeResult.type === "route") {
        await compileModuleGraph(routeResult.route.page, {
          projectRoot,
          mode,
          sourceMaps: mode === "development",
          target: "client",
        });

        for (const layoutPath of routeResult.route.layouts) {
          await compileModuleGraph(layoutPath, {
            projectRoot,
            mode,
            sourceMaps: mode === "development",
            target: "client",
          });
        }
      }

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

  const manifest = await readJson(manifestPath);
  return createServer(projectRoot, "production", options.port, {
    assetManifest: manifest.clientAssets ?? null,
  });
}
