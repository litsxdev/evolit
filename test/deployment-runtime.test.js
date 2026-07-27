import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProject } from "../src/build.js";
import { createDeploymentRuntime } from "../src/deployment-runtime.js";
import { scaffoldSite } from "../src/scaffold.js";

const frameworkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("createDeploymentRuntime resolves assets, cache hits, and render misses through the same runtime contract", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-runtime-"));
  const fixtureRoot = path.join(tempRoot, "app");

  try {
    await scaffoldSite(fixtureRoot);
    await fs.symlink(
      path.join(frameworkRoot, "node_modules"),
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
      (asset) => asset.clientModule === "app/page.mjs",
    )?.publicUrl;
    assert.ok(assetPublicUrl);

    const assetResponse = await runtime.handle(new Request(`http://evolit.local${assetPublicUrl}`));
    const assetSource = String(assetResponse.body);
    assert.equal(assetResponse.status, 200);
    assert.equal(assetResponse.headers["content-type"], "text/javascript; charset=utf-8");
    assert.match(assetSource, /\.\/components\/feature-card-[A-Za-z0-9_-]+\.mjs/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("development requests reuse hot client assets until development state is invalidated", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-runtime-dev-assets-"));
  const fixtureRoot = path.join(tempRoot, "app");

  try {
    await scaffoldSite(fixtureRoot);
    await fs.symlink(
      path.join(frameworkRoot, "node_modules"),
      path.join(fixtureRoot, "node_modules"),
      "dir",
    );

    const runtime = await createDeploymentRuntime({
      projectRoot: fixtureRoot,
      mode: "development",
    });
    await runtime.handle(new Request("http://evolit.local/"));
    assert.equal(runtime.renderer.developmentMetrics.clientArtifactBuilds, 1);

    const sentinelPath = path.join(
      fixtureRoot,
      ".evolit",
      "dev",
      "static",
      "request-cache-sentinel",
    );
    await fs.writeFile(sentinelPath, "preserved", "utf8");

    await runtime.handle(new Request("http://evolit.local/"));
    assert.equal(await fs.readFile(sentinelPath, "utf8"), "preserved");
    assert.equal(runtime.renderer.developmentMetrics.clientArtifactCacheHits, 1);

    await runtime.invalidateDevelopmentState();
    await runtime.handle(new Request("http://evolit.local/"));
    await assert.rejects(fs.readFile(sentinelPath, "utf8"), { code: "ENOENT" });
    assert.equal(runtime.renderer.developmentMetrics.invalidations, 1);
    assert.equal(runtime.renderer.developmentMetrics.clientArtifactBuilds, 2);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
