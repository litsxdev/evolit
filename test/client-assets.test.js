import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import {
  buildSharedVendorRuntime,
  createBrowserSpecifierPublicUrl,
  createBrowserPackageBaseUrl,
  createHydrationBootstrap,
  emitBundledClientAssets,
  getAssetByClientModule,
  getAssetByPublicUrl,
  getAssetsByKind,
  getSharedOutputRoot,
  normalizeHydrationDataForClient,
  normalizeClientAssetManifest,
  resolveBrowserPackageAssetFilePath,
  resolveBrowserSpecifierFilePath,
} from "../src/client-assets.js";
import fs from "node:fs/promises";
import path from "node:path";
import { compileModuleGraph } from "../src/compiler.js";
import { scaffoldSite } from "../src/scaffold.js";

test("createHydrationBootstrap returns an empty string when no hydratable roots exist", () => {
  const bootstrap = createHydrationBootstrap({
    hydrationData: {
      roots: [],
    },
    assetResolver(moduleId) {
      return `/_nextsx/static/${moduleId}`;
    },
  });

  assert.equal(bootstrap, "");
});

test("createHydrationBootstrap deduplicates module imports by moduleId", () => {
  const bootstrap = createHydrationBootstrap({
    hydrationData: {
      roots: [
        { id: "root-0", moduleId: "/app/components/feature-card.litsx" },
        { id: "root-1", moduleId: "/app/components/feature-card.litsx" },
        { id: "root-2", moduleId: "/app/components/hero-banner.litsx" },
        { id: "root-3", moduleId: "" },
        { id: "root-4" },
      ],
    },
    assetResolver(moduleId) {
      return `/_nextsx/static${moduleId.replace(/\.litsx$/, ".mjs")}`;
    },
  });

  assert.match(bootstrap, /registerHydrationModules/);
  assert.match(bootstrap, /hydratePage\(\{/);
  assert.match(bootstrap, /clientImports: \[\]/);
  assert.match(bootstrap, /register: \(\) => registerHydrationModules\(\[/);
  assert.equal(
    bootstrap.includes("/_nextsx/static/app/components/feature-card.mjs"),
    true,
  );
  assert.equal(
    bootstrap.includes("/_nextsx/static/app/components/hero-banner.mjs"),
    true,
  );
  assert.equal(
    bootstrap.match(/feature-card\.mjs/g)?.length ?? 0,
    1,
  );
  assert.equal(
    bootstrap.includes("__nextsx/hydration"),
    false,
  );
  assert.equal(
    bootstrap.includes("customElements.define"),
    false,
  );
  assert.match(bootstrap, /\(\) => import\("/);
  assert.equal(
    bootstrap.includes("\\u003E"),
    false,
  );
});

test("createHydrationBootstrap ignores unresolved module ids", () => {
  const bootstrap = createHydrationBootstrap({
    hydrationData: {
      roots: [
        { id: "root-0", moduleId: "/outside/project/component-a.litsx" },
      ],
    },
    assetResolver() {
      return null;
    },
  });

  assert.equal(bootstrap, "");
});

test("normalizeHydrationDataForClient rewrites project-absolute module ids to public relative ids", () => {
  const hydrationData = {
    version: 1,
    roots: [
      {
        id: "root-0",
        moduleId: "/Users/example/site/app/components/feature-card.litsx",
      },
      {
        id: "root-1",
        moduleId: "/outside/project/hero-banner.litsx",
      },
      {
        id: "root-2",
        moduleId: "/outside/project/ignored.litsx",
      },
    ],
  };
  Object.defineProperties(hydrationData, {
    payload: {
      enumerable: false,
      value: {
        roots: { "root-0": { props: { title: "Feature" } } },
        instances: {},
      },
    },
    clientImports: {
      enumerable: false,
      value: ["/_nextsx/static/app/components/feature-card.hash.mjs"],
    },
    toJSON: {
      enumerable: false,
      value() {
        return {
          version: hydrationData.version,
          roots: hydrationData.roots,
          payload: hydrationData.payload,
          clientImports: hydrationData.clientImports,
        };
      },
    },
  });

  const normalizedHydrationData = normalizeHydrationDataForClient(
    hydrationData,
    "/Users/example/site",
  );

  assert.deepEqual(normalizedHydrationData.roots, [
    {
      id: "root-0",
      moduleId: "/app/components/feature-card.litsx",
    },
    {
      id: "root-1",
    },
    {
      id: "root-2",
    },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(normalizedHydrationData)), {
    version: 1,
    roots: [
      {
        id: "root-0",
        moduleId: "/app/components/feature-card.litsx",
      },
      {
        id: "root-1",
      },
      {
        id: "root-2",
      },
    ],
    payload: {
      roots: { "root-0": { props: { title: "Feature" } } },
      instances: {},
    },
    clientImports: ["/_nextsx/static/app/components/feature-card.hash.mjs"],
  });
});

test("client asset manifest helpers normalize and query structured asset entries", () => {
  const manifest = normalizeClientAssetManifest({
    resources: ["app/components/card-accent.svg"],
    assets: [
      {
        clientModule: "app/page.mjs",
        kind: "entry",
        publicUrl: "/_nextsx/static/app/page.hash.mjs",
      },
      {
        clientModule: "app/components/card-accent.css",
        kind: "style",
        publicUrl: "/_nextsx/static/app/components/card-accent.hash.css",
      },
    ],
  });

  assert.equal(manifest.version, 1);
  assert.equal(manifest.publicPathPrefix, "/_nextsx/static/");
  assert.deepEqual(manifest.resources, ["app/components/card-accent.svg"]);
  assert.equal(
    getAssetByClientModule(manifest, "app/page.mjs")?.publicUrl,
    "/_nextsx/static/app/page.hash.mjs",
  );
  assert.equal(
    getAssetByPublicUrl(manifest, "/_nextsx/static/app/components/card-accent.hash.css")?.clientModule,
    "app/components/card-accent.css",
  );
  assert.deepEqual(
    getAssetsByKind(manifest, "style").map((asset) => asset.clientModule),
    ["app/components/card-accent.css"],
  );
});

test("shared vendor runtime resolves browser ESM entry files", async () => {
  const sharedRuntime = await buildSharedVendorRuntime(process.cwd(), "development");

  assert.match(sharedRuntime.imports["@litsx/core"], /^\/_nextsx\/shared\/.+\.mjs$/);
  assert.match(sharedRuntime.imports["@litsx/ssr/hydration"], /^\/_nextsx\/shared\/.+\.mjs$/);
  assert.match(sharedRuntime.imports["lit"], /^\/_nextsx\/shared\/.+\.mjs$/);
  assert.equal(sharedRuntime.imports["lit-html"], undefined);

  const coreFilePath = await resolveBrowserSpecifierFilePath("@litsx/core");
  const hydrationFilePath = await resolveBrowserSpecifierFilePath("@litsx/ssr/hydration");

  assert.match(coreFilePath, /@litsx\/core\/src\/index\.js$/);
  assert.match(hydrationFilePath, /@litsx\/ssr\/src\/hydration\.js$/);
});

test("shared hydration entry eagerly loads lit hydrate support", async () => {
  const projectRoot = process.cwd();
  const sharedRuntime = await buildSharedVendorRuntime(projectRoot, "development");
  const hydrationEntryUrl = sharedRuntime.imports["@litsx/ssr/hydration"];
  const hydrationEntryPath = path.join(
    getSharedOutputRoot(projectRoot, "development"),
    hydrationEntryUrl.replace("/_nextsx/shared/", ""),
  );
  const hydrationEntrySource = await fs.readFile(hydrationEntryPath, "utf8");

  assert.match(hydrationEntrySource, /vendor-hydration-support/);
});

test("browser package asset urls preserve package-relative paths", async () => {
  const corePublicUrl = await createBrowserSpecifierPublicUrl("@litsx/core");
  assert.equal(corePublicUrl, "/_nextsx/pkg/%40litsx/core/src/index.js");
  assert.equal(createBrowserPackageBaseUrl("lit"), "/_nextsx/pkg/lit/");

  const relativeFilePath = await resolveBrowserPackageAssetFilePath(
    "/_nextsx/pkg/%40litsx/core/src/error-boundary.js",
  );
  assert.match(relativeFilePath, /@litsx\/core\/src\/error-boundary\.js$/);

  const exportedSubpathFilePath = await resolveBrowserPackageAssetFilePath(
    "/_nextsx/pkg/%40litsx/core/elements",
  );
  assert.match(exportedSubpathFilePath, /@litsx\/core\/src\/elements\/index\.js$/);
});

test("bundled static sourcemaps preserve original litsx sourcesContent", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nextsx-client-assets-"));
  const fixtureRoot = path.join(tempRoot, "app");

  try {
    await scaffoldSite(fixtureRoot);
    await fs.symlink(
      path.join(process.cwd(), "node_modules"),
      path.join(fixtureRoot, "node_modules"),
      "dir",
    );

    await compileModuleGraph(path.join(fixtureRoot, "app", "page.litsx"), {
      projectRoot: fixtureRoot,
      mode: "development",
      sourceMaps: true,
      target: "client",
    });

    const manifest = await emitBundledClientAssets(fixtureRoot, {
      mode: "development",
      entryClientModules: new Set(["app/page.mjs"]),
    });
    const pageAsset = getAssetByClientModule(manifest, "app/page.mjs");
    assert.ok(pageAsset);

    const sourceMapPath = path.join(
      fixtureRoot,
      ".nextsx",
      "dev",
      "static",
      pageAsset.publicUrl.replace("/_nextsx/static/", ""),
    ) + ".map";
    const sourceMap = JSON.parse(await fs.readFile(sourceMapPath, "utf8"));

    assert.deepEqual(sourceMap.sources, ["/app/page.litsx"]);
    assert.ok(Array.isArray(sourceMap.sourcesContent));
    assert.match(sourceMap.sourcesContent[0], /export default async function HomePage/);
    assert.match(sourceMap.sourcesContent[0], /<FeatureCard/);
    assert.doesNotMatch(sourceMap.sourcesContent[0], /import \{ LitElement, css, html \} from "lit"/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
