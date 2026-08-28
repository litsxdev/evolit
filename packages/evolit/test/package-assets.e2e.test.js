import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProject } from "../src/build.js";
import { scaffoldSite } from "../src/scaffold.js";
import { createDevServer, createStartServer } from "../src/server.js";

const frameworkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frameworkNodeModules = path.resolve(frameworkRoot, "..", "..", "node_modules");
const packageName = "@fixture/package-assets-e2e";

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.listen(0, () => {
      const address = socket.address();
      if (!address || typeof address === "string") {
        socket.close();
        reject(new Error("Failed to resolve an ephemeral port for the package asset fixture."));
        return;
      }
      socket.close((error) => error ? reject(error) : resolve(address.port));
    });
    socket.on("error", reject);
  });
}

async function createPackageAssetFixture() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-package-assets-e2e-"));
  const workspaceRoot = path.join(tempRoot, "workspace");
  const projectRoot = path.join(workspaceRoot, "app");
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.symlink(frameworkNodeModules, path.join(workspaceRoot, "node_modules"), "dir");
  await scaffoldSite(projectRoot);

  const packageRoot = path.join(projectRoot, "node_modules", "@fixture", "package-assets-e2e");
  await fs.mkdir(path.join(packageRoot, "styles", "assets"), { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify({
        name: packageName,
        type: "module",
        exports: {
          ".": { types: "./index.d.ts", import: "./index.js" },
          "./package.json": "./package.json",
          "./tokens.css": "./styles/tokens.css",
          "./theme.css": "./styles/theme.css",
        },
      }, null, 2)}\n`,
      "utf8",
    ),
    fs.writeFile(path.join(packageRoot, "index.js"), 'export const marker = "package-assets-e2e";\n', "utf8"),
    fs.writeFile(path.join(packageRoot, "index.d.ts"), "export declare const marker: string;\n", "utf8"),
    fs.writeFile(
      path.join(packageRoot, "styles", "tokens.css"),
      '@import "./base.css";\n:root { background-image: url("./assets/grid.svg"); }\n',
      "utf8",
    ),
    fs.writeFile(path.join(packageRoot, "styles", "base.css"), ":root { --fixture: #663399; }\n", "utf8"),
    fs.writeFile(path.join(packageRoot, "styles", "theme.css"), "body { color: var(--fixture); }\n", "utf8"),
    fs.writeFile(
      path.join(packageRoot, "styles", "assets", "grid.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>\n',
      "utf8",
    ),
  ]);

  const layoutPath = path.join(projectRoot, "app", "layout.jsx");
  const layoutSource = await fs.readFile(layoutPath, "utf8");
  await fs.writeFile(
    layoutPath,
    [
      `import ${JSON.stringify(`${packageName}/tokens.css`)};`,
      `import ${JSON.stringify(`${packageName}/theme.css`)};`,
      layoutSource,
    ].join("\n"),
    "utf8",
  );

  return { tempRoot, projectRoot };
}

function findAsset(manifest, clientModule) {
  const asset = manifest.assets.find((entry) => entry.clientModule === clientModule);
  assert.ok(asset, `Expected package fixture asset ${clientModule}`);
  return asset;
}

async function assertPackageStylesInDocument(baseUrl, manifest) {
  const tokens = findAsset(
    manifest,
    "node_modules/@fixture/package-assets-e2e/styles/tokens.css",
  );
  const theme = findAsset(
    manifest,
    "node_modules/@fixture/package-assets-e2e/styles/theme.css",
  );
  const base = findAsset(
    manifest,
    "node_modules/@fixture/package-assets-e2e/styles/base.css",
  );
  const grid = findAsset(
    manifest,
    "node_modules/@fixture/package-assets-e2e/styles/assets/grid.svg",
  );
  const response = await fetch(`${baseUrl}/`);
  const html = await response.text();

  assert.equal(response.status, 200, html);
  for (const style of [tokens, theme]) {
    assert.match(
      html,
      new RegExp(`<link rel="stylesheet" href="${style.publicUrl.replaceAll(".", "\\.")}" data-evolit-route-asset="style">`),
    );
  }

  const cssResponse = await fetch(`${baseUrl}${tokens.publicUrl}`);
  const css = await cssResponse.text();
  assert.equal(cssResponse.status, 200);
  assert.match(css, new RegExp(path.basename(base.publicUrl).replaceAll(".", "\\.")));
  assert.match(css, new RegExp(path.basename(grid.publicUrl).replaceAll(".", "\\.")));
}

test("package CSS exports are emitted into development and production documents", async () => {
  const { tempRoot, projectRoot } = await createPackageAssetFixture();
  let devServer;
  let startServer;

  try {
    const devPort = await getAvailablePort();
    devServer = await createDevServer(projectRoot, { port: devPort });
    await devServer.listen();
    const devBaseUrl = `http://127.0.0.1:${devPort}`;
    await fetch(`${devBaseUrl}/`);
    const devManifest = JSON.parse(await fs.readFile(
      path.join(projectRoot, ".evolit", "dev", "client-assets.json"),
      "utf8",
    ));
    assert.deepEqual(
      devManifest.serverAssetImportsByEntry["app/layout.jsx"].styles.filter((value) => value.includes(packageName)),
      [
        "node_modules/@fixture/package-assets-e2e/styles/base.css",
        "node_modules/@fixture/package-assets-e2e/styles/theme.css",
        "node_modules/@fixture/package-assets-e2e/styles/tokens.css",
      ],
    );
    await assertPackageStylesInDocument(devBaseUrl, devManifest);
    await devServer.close();
    devServer = null;

    const buildManifestPath = await buildProject(projectRoot);
    const buildManifest = JSON.parse(await fs.readFile(buildManifestPath, "utf8"));
    const startPort = await getAvailablePort();
    startServer = await createStartServer(projectRoot, { port: startPort });
    await startServer.listen();
    await assertPackageStylesInDocument(`http://127.0.0.1:${startPort}`, buildManifest.clientAssets);
  } finally {
    await devServer?.close();
    await startServer?.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
