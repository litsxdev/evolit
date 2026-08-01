import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProject } from "../src/build.js";
import { getSharedOutputRoot } from "../src/client-assets.js";
import { createDeploymentRuntime, createPublicAssetOrigin } from "../src/deployment-runtime.js";
import { scaffoldSite } from "../src/scaffold.js";

const frameworkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frameworkNodeModules = path.resolve(frameworkRoot, "..", "..", "node_modules");

test("createDeploymentRuntime resolves assets, cache hits, and render misses through the same runtime contract", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-runtime-"));
  const fixtureRoot = path.join(tempRoot, "app");

  try {
    await scaffoldSite(fixtureRoot);
    await fs.symlink(
      frameworkNodeModules,
      path.join(fixtureRoot, "node_modules"),
      "dir",
    );
    await fs.mkdir(path.join(fixtureRoot, "app", "cached-static"), { recursive: true });
    await fs.mkdir(path.join(fixtureRoot, "app", "cached-request"), { recursive: true });
    await fs.writeFile(
      path.join(fixtureRoot, "app", "cached-static", "page.litsx"),
      [
        'export const routeConfig = { cache: "static" };',
        "",
        "export default async function CachedStaticPage() {",
        '  return "<main>static runtime</main>";',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(fixtureRoot, "app", "cached-request", "page.litsx"),
      [
        'export const routeConfig = { cache: "static" };',
        "",
        "export default async function CachedRequestPage({ request }) {",
        '  return `<main>request runtime:${request.headers.get("x-tenant")}</main>`;',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    await buildProject(fixtureRoot);
    const buildManifest = JSON.parse(
      await fs.readFile(
        path.join(fixtureRoot, ".evolit", "build", "manifest.json"),
        "utf8",
      ),
    );
    const runtime = await createDeploymentRuntime({
      projectRoot: fixtureRoot,
      mode: "production",
      assetManifest: buildManifest.clientAssets,
    });

    const htmlResponse = await runtime.handle(new Request("http://evolit.local/cached-static"));
    const html = String(htmlResponse.body);
    assert.equal(htmlResponse.headers["x-evolit-cache"], "HIT");
    assert.match(html, /static runtime/);

    const dynamicRequestResponse = await runtime.handle(new Request(
      "http://evolit.local/cached-request",
      { headers: { "x-tenant": "acme" } },
    ));
    assert.equal(dynamicRequestResponse.headers["x-evolit-cache"], "SKIP");
    assert.match(String(dynamicRequestResponse.body), /request runtime:acme/);

    const assetPublicUrl = buildManifest.clientAssets.assets.find(
      (asset) => asset.clientModule === "app/components/feature-card.mjs",
    )?.publicUrl;
    assert.ok(assetPublicUrl);

    const assetResponse = await runtime.handle(new Request(`http://evolit.local${assetPublicUrl}`));
    const assetSource = String(assetResponse.body);
    assert.equal(assetResponse.status, 200);
    assert.equal(assetResponse.headers["content-type"], "text/javascript; charset=utf-8");
    assert.match(assetSource, /customElements|LitElement|litsx/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("development requests reuse hot client assets until development state is invalidated", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-runtime-dev-assets-"));
  const fixtureRoot = path.join(tempRoot, "app");
  const developmentEvents = [];

  try {
    await scaffoldSite(fixtureRoot);
    await fs.symlink(
      frameworkNodeModules,
      path.join(fixtureRoot, "node_modules"),
      "dir",
    );
    const externalStylesRoot = path.join(tempRoot, "src");
    await fs.mkdir(path.join(externalStylesRoot, "styles"), { recursive: true });
    await fs.mkdir(path.join(externalStylesRoot, "themes"), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(externalStylesRoot, "styles", "tokens.css"), ":root { --theme: blue; }\n", "utf8"),
      fs.writeFile(path.join(externalStylesRoot, "themes", "composable.css"), "main { color: var(--theme); }\n", "utf8"),
    ]);
    const layoutPath = path.join(fixtureRoot, "app", "layout.litsx");
    const layoutSource = await fs.readFile(layoutPath, "utf8");
    await fs.writeFile(
      layoutPath,
      [
        'import "../../src/styles/tokens.css";',
        'import "../../src/themes/composable.css";',
        layoutSource,
      ].join("\n"),
      "utf8",
    );
    const staleAssetPath = path.join(
      fixtureRoot,
      ".evolit",
      "dev",
      "static",
      "stale-asset.mjs",
    );
    await fs.mkdir(path.dirname(staleAssetPath), { recursive: true });
    await fs.writeFile(staleAssetPath, "stale", "utf8");

    const runtime = await createDeploymentRuntime({
      projectRoot: fixtureRoot,
      mode: "development",
      onDevelopmentEvent(event) {
        developmentEvents.push(event);
      },
    });
    await assert.rejects(fs.readFile(staleAssetPath, "utf8"), { code: "ENOENT" });
    await fs.access(
      path.join(
        getSharedOutputRoot(fixtureRoot, "development"),
        "base",
        "litsx__ssr__hydration.mjs",
      ),
    );
    assert.deepEqual(
      developmentEvents.map((event) => event.type),
      ["initializing", "vendor-runtime-ready"],
    );
    const response = await runtime.handle(new Request("http://evolit.local/"));
    const html = String(response.body);
    assert.equal(runtime.renderer.developmentMetrics.clientArtifactBuilds, 1);
    assert.equal(developmentEvents.some((event) => event.type === "client-assets-building"), true);
    assert.equal(developmentEvents.some((event) => event.type === "client-assets-ready"), true);
    const externalStyleAssets = runtime.renderer.assetManifest.assets.filter(
      (asset) => asset.clientModule.startsWith("__unmanaged__/__up__/src/") && asset.type === "style",
    );
    assert.equal(
      runtime.renderer.assetManifest.assets.some((asset) => asset.clientModule === "app/layout.mjs"),
      false,
    );
    assert.equal(externalStyleAssets.length, 2);
    assert.equal(runtime.renderer.assetManifest.serverAssetImportsByEntry["app/page.litsx"].styles.length, 0);
    assert.equal(runtime.renderer.assetManifest.serverAssetImportsByEntry["app/layout.litsx"].styles.length, 3);
    assert.equal(developmentEvents.filter((event) => event.type === "unmanaged-import").length, 2);
    for (const styleAsset of externalStyleAssets) {
      await fs.access(styleAsset.outputPath);
      assert.match(
        html,
        new RegExp(`<link rel="stylesheet" href="${styleAsset.publicUrl.replaceAll(".", "\\.")}" data-evolit-route-asset="style">`),
      );
    }

    const sentinelPath = path.join(
      fixtureRoot,
      ".evolit",
      "dev",
      "static",
      "request-cache-sentinel",
    );
    await fs.writeFile(sentinelPath, "preserved", "utf8");

    await runtime.handle(new Request("http://evolit.local/?asset-cache=1"));
    assert.equal(await fs.readFile(sentinelPath, "utf8"), "preserved");
    assert.equal(runtime.renderer.developmentMetrics.clientArtifactCacheHits, 1);
    assert.equal(developmentEvents.some((event) => event.type === "client-assets-cache-hit"), true);
    assert.equal(developmentEvents.some((event) => event.type === "segment-cache-hit"), true);

    await runtime.invalidateDevelopmentState();
    await runtime.handle(new Request("http://evolit.local/"));
    await assert.rejects(fs.readFile(sentinelPath, "utf8"), { code: "ENOENT" });
    assert.equal(runtime.renderer.developmentMetrics.invalidations, 1);
    assert.equal(runtime.renderer.developmentMetrics.clientArtifactBuilds, 2);
    assert.equal(developmentEvents.some((event) => event.type === "invalidated"), true);
    assert.equal(developmentEvents.some((event) => event.type === "segment-cache-invalidated"), true);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("development rebuilds retain a catch-all route's previous CSS generation for in-flight requests", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-runtime-dev-catch-all-css-"));
  const fixtureRoot = path.join(tempRoot, "app");

  try {
    await scaffoldSite(fixtureRoot);
    await fs.symlink(
      frameworkNodeModules,
      path.join(fixtureRoot, "node_modules"),
      "dir",
    );
    const routeRoot = path.join(fixtureRoot, "app", "explore", "[...slug]");
    const stylePath = path.join(routeRoot, "page.css");
    await fs.mkdir(routeRoot, { recursive: true });
    await fs.writeFile(stylePath, ".explore { color: tomato; }\n", "utf8");
    await fs.writeFile(
      path.join(routeRoot, "page.litsx"),
      [
        'import "./page.css";',
        "",
        "export default async function ExplorePage() {",
        '  return "<main class=\\"explore\\">explore</main>";',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const runtime = await createDeploymentRuntime({ projectRoot: fixtureRoot, mode: "development" });
    await runtime.handle(new Request("http://evolit.local/explore/home-garden"));
    const previousManifest = runtime.renderer.assetManifest;
    const previousStyle = previousManifest.assets.find(
      (asset) => asset.clientModule === "app/explore/[...slug]/page.css",
    );
    assert.ok(previousStyle);

    // This models a stylesheet request already resolved using the manifest
    // that was live when the browser received the previous document.
    const previousAssetOrigin = createPublicAssetOrigin({
      projectRoot: fixtureRoot,
      mode: "development",
      assetManifest: previousManifest,
    });
    await fs.writeFile(stylePath, ".explore { color: rebeccapurple; }\n", "utf8");
    await runtime.invalidateDevelopmentState([stylePath]);
    await runtime.handle(new Request("http://evolit.local/explore/home-garden"));

    const refreshedStyle = runtime.renderer.assetManifest.assets.find(
      (asset) => asset.clientModule === "app/explore/[...slug]/page.css",
    );
    assert.ok(refreshedStyle);
    assert.notEqual(refreshedStyle.publicUrl, previousStyle.publicUrl);

    const encodedStyleUrl = new URL(`http://evolit.local${previousStyle.publicUrl}`).pathname;
    assert.match(encodedStyleUrl, /%5B\.\.\.slug%5D/);
    const response = await previousAssetOrigin.read(encodedStyleUrl);
    assert.equal(response?.status, 200);
    assert.match(String(response?.body), /tomato/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
