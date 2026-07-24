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
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nextsx-runtime-"));
  const fixtureRoot = path.join(tempRoot, "app");

  try {
    await scaffoldSite(fixtureRoot);
    await fs.symlink(
      path.join(frameworkRoot, "node_modules"),
      path.join(fixtureRoot, "node_modules"),
      "dir",
    );
    await fs.mkdir(path.join(fixtureRoot, "app", "cached-static"), { recursive: true });
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

    await buildProject(fixtureRoot);
    const buildManifest = JSON.parse(
      await fs.readFile(
        path.join(fixtureRoot, ".nextsx", "build", "manifest.json"),
        "utf8",
      ),
    );
    const runtime = await createDeploymentRuntime({
      projectRoot: fixtureRoot,
      mode: "production",
      assetManifest: buildManifest.clientAssets,
    });

    const htmlResponse = await runtime.handle(new Request("http://nextsx.local/cached-static"));
    const html = String(htmlResponse.body);
    assert.equal(htmlResponse.headers["x-nextsx-cache"], "HIT");
    assert.match(html, /static runtime/);

    const assetPublicUrl = buildManifest.clientAssets.assets.find(
      (asset) => asset.clientModule === "app/page.mjs",
    )?.publicUrl;
    assert.ok(assetPublicUrl);

    const assetResponse = await runtime.handle(new Request(`http://nextsx.local${assetPublicUrl}`));
    const assetSource = String(assetResponse.body);
    assert.equal(assetResponse.status, 200);
    assert.equal(assetResponse.headers["content-type"], "text/javascript; charset=utf-8");
    assert.match(assetSource, /\.\/components\/feature-card-[A-Za-z0-9_-]+\.mjs/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
