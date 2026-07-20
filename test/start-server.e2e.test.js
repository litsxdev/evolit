import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { buildProject } from "../src/build.js";
import { createStartServer } from "../src/server.js";
import { scaffoldSite } from "../src/scaffold.js";

const frameworkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let fixtureRoot;
let server;
let baseUrl;
let buildManifest;

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.listen(0, () => {
      const address = socket.address();
      if (!address || typeof address === "string") {
        socket.close();
        reject(new Error("Failed to resolve an ephemeral port for the test server."));
        return;
      }
      const { port } = address;
      socket.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    socket.on("error", reject);
  });
}

before(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nextsx-start-e2e-"));
  fixtureRoot = path.join(tempRoot, "app");

  await scaffoldSite(fixtureRoot);
  await fs.symlink(
    path.join(frameworkRoot, "node_modules"),
    path.join(fixtureRoot, "node_modules"),
    "dir",
  );
  await fs.writeFile(
    path.join(fixtureRoot, "app", "components", "card-accent.litsx"),
    [
      'import "./card-accent.css";',
      "",
      "export default function CardAccent() {",
      '  return <span style={{ display: "inline-block", width: "10px", height: "10px", borderRadius: "999px", background: "#ef9459" }} />;',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(fixtureRoot, "app", "components", "card-accent.css"),
    [
      ".card-accent {",
      "  display: inline-block;",
      "  width: 10px;",
      "  height: 10px;",
      "  border-radius: 999px;",
      "  background: #ef9459;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const featureCardPath = path.join(fixtureRoot, "app", "components", "feature-card.litsx");
  const featureCardSource = await fs.readFile(featureCardPath, "utf8");
  await fs.writeFile(
    featureCardPath,
    [
      'import CardAccent from "./card-accent.litsx";',
      "",
      featureCardSource.replace(
        '      <h2 style={{ margin: "0 0 12px", fontSize: "1.25rem" }}>{title}</h2>',
        [
          "      <CardAccent />",
          '      <h2 style={{ margin: "0 0 12px", fontSize: "1.25rem" }}>{title}</h2>',
        ].join("\n"),
      ),
    ].join("\n"),
    "utf8",
  );
  await buildProject(fixtureRoot);
  buildManifest = JSON.parse(
    await fs.readFile(
      path.join(fixtureRoot, ".nextsx", "build", "manifest.json"),
      "utf8",
    ),
  );

  const port = await getAvailablePort();
  server = await createStartServer(fixtureRoot, { port });
  await server.listen();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve) => {
      server.close();
      resolve();
    });
  }

  if (fixtureRoot) {
    await fs.rm(path.dirname(fixtureRoot), { recursive: true, force: true });
  }
});

test("start server emits hashed public asset URLs for hydration bootstrap", async () => {
  const response = await fetch(`${baseUrl}/`);
  const html = await response.text();
  const featureCardAsset = buildManifest.clientAssets.assets.find(
    (asset) => asset.clientModule === "app/components/feature-card.mjs",
  );

  assert.equal(response.status, 200);
  assert.ok(featureCardAsset);
  assert.match(html, /registerHydrationModules/);
  assert.match(
    html,
    new RegExp(featureCardAsset.publicUrl.replaceAll(".", "\\.")),
  );
  assert.doesNotMatch(html, /\/_nextsx\/client\/app\/components\/feature-card\.mjs/);
});

test("build manifest classifies entry and chunk client assets with structured metadata", () => {
  const featureCardAsset = buildManifest.clientAssets.assets.find(
    (asset) => asset.clientModule === "app/components/feature-card.mjs",
  );
  const cardAccentAsset = buildManifest.clientAssets.assets.find(
    (asset) => asset.clientModule === "app/components/card-accent.mjs",
  );
  const homePageAsset = buildManifest.clientAssets.assets.find(
    (asset) => asset.clientModule === "app/page.mjs",
  );
  const cardAccentStyleAsset = buildManifest.clientAssets.assets.find(
    (asset) => asset.clientModule === "app/components/card-accent.css",
  );

  assert.ok(featureCardAsset);
  assert.ok(cardAccentAsset);
  assert.ok(homePageAsset);
  assert.ok(cardAccentStyleAsset);
  assert.equal(featureCardAsset.kind, "chunk");
  assert.equal(cardAccentAsset.kind, "chunk");
  assert.equal(homePageAsset.kind, "entry");
  assert.equal(cardAccentStyleAsset.kind, "style");
  assert.equal(cardAccentStyleAsset.type, "style");
  assert.equal(typeof homePageAsset.hash, "string");
  assert.equal(homePageAsset.hash.length, 8);
  assert.equal(typeof homePageAsset.size, "number");
  assert.equal(homePageAsset.size > 0, true);
  assert.equal(buildManifest.clientAssets.entries.includes("app/page.mjs"), true);
  assert.equal(buildManifest.clientAssets.chunks.includes("app/components/feature-card.mjs"), true);
  assert.equal(buildManifest.clientAssets.styles.includes("app/components/card-accent.css"), true);
});

test("start server serves hashed client asset files", async () => {
  const pageResponse = await fetch(`${baseUrl}/`);
  const html = await pageResponse.text();
  const match = html.match(/(\/_nextsx\/static\/app\/components\/feature-card\.[a-f0-9]{8}\.mjs)/);

  assert.ok(match);

  const assetResponse = await fetch(`${baseUrl}${match[1]}`);
  const source = await assetResponse.text();

  assert.equal(assetResponse.status, 200);
  assert.match(source, /litsx\.hydratableTag/);
  assert.match(source, /card-accent\.[a-f0-9]{8}\.mjs/);
});

test("start server emits hashed modulepreload links that match the asset manifest", async () => {
  const response = await fetch(`${baseUrl}/`);
  const html = await response.text();
  const featureCardAsset = buildManifest.clientAssets.assets.find(
    (asset) => asset.clientModule === "app/components/feature-card.mjs",
  );
  const cardAccentAsset = buildManifest.clientAssets.assets.find(
    (asset) => asset.clientModule === "app/components/card-accent.mjs",
  );
  const cardAccentStyleAsset = buildManifest.clientAssets.assets.find(
    (asset) => asset.clientModule === "app/components/card-accent.css",
  );

  assert.ok(featureCardAsset);
  assert.ok(cardAccentAsset);
  assert.ok(cardAccentStyleAsset);
  assert.match(
    html,
    new RegExp(
      `<link rel="modulepreload" href="${featureCardAsset.publicUrl.replaceAll(".", "\\.")}">`,
    ),
  );
  assert.match(
    html,
    new RegExp(
      `<link rel="modulepreload" href="${cardAccentAsset.publicUrl.replaceAll(".", "\\.")}">`,
    ),
  );
  assert.match(
    html,
    new RegExp(
      `<link rel="stylesheet" href="${cardAccentStyleAsset.publicUrl.replaceAll(".", "\\.")}">`,
    ),
  );
  assert.deepEqual(featureCardAsset.imports, ["app/components/card-accent.mjs"]);
  assert.deepEqual(featureCardAsset.importUrls, [cardAccentAsset.publicUrl]);
  assert.deepEqual(cardAccentAsset.styleImports, ["app/components/card-accent.css"]);
  assert.deepEqual(cardAccentAsset.styleUrls, [cardAccentStyleAsset.publicUrl]);
});

test("start server omits hashed hydration preload output for non-hydrated routes", async () => {
  const response = await fetch(`${baseUrl}/about`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.doesNotMatch(html, /rel="modulepreload"/);
  assert.doesNotMatch(html, /rel="stylesheet"/);
  assert.doesNotMatch(html, /registerHydrationModules/);
  assert.doesNotMatch(html, /__LITSX_HYDRATION__/);
});
