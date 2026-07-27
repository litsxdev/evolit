import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import {
  buildSharedVendorRuntime,
  collectClientVendorSpecifiers,
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
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import { compileModuleGraph } from "../src/compiler.js";
import { scaffoldSite } from "../src/scaffold.js";

test("collectClientVendorSpecifiers follows compiled relative imports without metadata", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-client-vendors-"));
  const clientRoot = path.join(projectRoot, ".evolit", "dev", "client");

  try {
    await fs.mkdir(path.join(clientRoot, "app", "explore"), { recursive: true });
    await fs.mkdir(path.join(clientRoot, "app", "shared"), { recursive: true });
    await fs.mkdir(path.join(clientRoot, "src", "features", "explore"), { recursive: true });
    await fs.mkdir(path.join(clientRoot, "src", "graphql", "client"), { recursive: true });
    await Promise.all([
      fs.writeFile(
        path.join(clientRoot, "app", "explore", "page.mjs"),
        'import "../shared/util.mjs";\n',
        "utf8",
      ),
      fs.writeFile(
        path.join(clientRoot, "app", "shared", "util.mjs"),
        'import "./chunk.mjs#x";\n',
        "utf8",
      ),
      fs.writeFile(path.join(clientRoot, "app", "shared", "chunk.mjs"), 'import "lit";\n', "utf8"),
      fs.writeFile(
        path.join(clientRoot, "src", "features", "explore", "storefront-data.mjs"),
        'import "../../graphql/client/index.mjs?t=123";\n',
        "utf8",
      ),
      fs.writeFile(
        path.join(clientRoot, "src", "graphql", "client", "index.mjs"),
        'import "@litsx/core";\n',
        "utf8",
      ),
    ]);

    const specifiers = await collectClientVendorSpecifiers(projectRoot, [], {
      mode: "development",
      entryClientModules: [
        "app/explore/page.mjs",
        "src/features/explore/storefront-data.mjs",
      ],
    });

    assert.deepEqual(specifiers, ["@litsx/core", "lit"]);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("emitBundledClientAssets resolves dev imports with search params and hashes", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-dev-client-imports-"));
  const clientRoot = path.join(projectRoot, ".evolit", "dev", "client");
  const sourceRoot = path.join(clientRoot, "src", "features", "explore");
  const modelsRoot = path.join(clientRoot, "src", "models");

  try {
    await fs.mkdir(sourceRoot, { recursive: true });
    await fs.mkdir(modelsRoot, { recursive: true });
    await Promise.all([
      fs.writeFile(
        path.join(sourceRoot, "storefront-data.mjs"),
        [
          'import "../../models/plain.mjs";',
          'import "../../models/query.mjs?t=123";',
          'import "../../models/hash.mjs#x";',
          'import "../../models/query-and-hash.mjs?t=123#x";',
          "export default null;",
          "",
        ].join("\n"),
        "utf8",
      ),
      fs.writeFile(path.join(modelsRoot, "plain.mjs"), "export {};\n", "utf8"),
      fs.writeFile(path.join(modelsRoot, "query.mjs"), "export {};\n", "utf8"),
      fs.writeFile(path.join(modelsRoot, "hash.mjs"), "export {};\n", "utf8"),
      fs.writeFile(path.join(modelsRoot, "query-and-hash.mjs"), "export {};\n", "utf8"),
    ]);

    const manifest = await emitBundledClientAssets(projectRoot, {
      mode: "development",
      entryClientModules: ["src/features/explore/storefront-data.mjs"],
    });

    assert.ok(getAssetByClientModule(manifest, "src/features/explore/storefront-data.mjs"));
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("emitBundledClientAssets rewrites relative CSS imports to hashed assets", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-dev-css-imports-"));
  const stylesRoot = path.join(projectRoot, ".evolit", "dev", "client", "app", "styles");

  try {
    await fs.mkdir(path.join(stylesRoot, "shared"), { recursive: true });
    await Promise.all([
      fs.writeFile(
        path.join(stylesRoot, "main.css"),
        '@import url("./shared/base.css?t=123#theme");\n.page { color: red; }\n',
        "utf8",
      ),
      fs.writeFile(path.join(stylesRoot, "shared", "base.css"), ".base { color: blue; }\n", "utf8"),
    ]);

    const manifest = await emitBundledClientAssets(projectRoot, { mode: "development" });
    const mainStyle = getAssetByClientModule(manifest, "app/styles/main.css");
    const baseStyle = getAssetByClientModule(manifest, "app/styles/shared/base.css");
    assert.ok(mainStyle);
    assert.ok(baseStyle);

    const css = await fs.readFile(mainStyle.outputPath, "utf8");
    const baseFileName = baseStyle.publicUrl.split("/").at(-1);
    assert.match(css, new RegExp(`@import url\\("\\./shared/${baseFileName}\\?t=123#theme"\\)`));
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("emitBundledClientAssets resolves layout stylesheet metadata relative to its module", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-dev-layout-styles-"));
  const clientRoot = path.join(projectRoot, ".evolit", "dev", "client");
  const layoutPath = path.join(clientRoot, "app", "layout.mjs");

  try {
    await fs.mkdir(path.dirname(layoutPath), { recursive: true });
    await fs.mkdir(path.join(clientRoot, "src", "styles"), { recursive: true });
    await fs.mkdir(path.join(clientRoot, "src", "themes"), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(clientRoot, "src", "styles", "tokens.css"), ":root {}\n", "utf8"),
      fs.writeFile(path.join(clientRoot, "src", "themes", "composable.css"), "main {}\n", "utf8"),
      fs.writeFile(path.join(clientRoot, "app", "global.css"), "body {}\n", "utf8"),
    ]);
    await Promise.all([
      fs.writeFile(layoutPath, "export default null;\n", "utf8"),
      fs.writeFile(
        `${layoutPath}.meta.json`,
        JSON.stringify({
          moduleImports: [],
          vendorImports: [],
          styleImports: ["../src/styles/tokens.css", "../src/themes/composable.css", "app/global.css"],
          assetImports: [],
        }),
        "utf8",
      ),
    ]);

    const manifest = await emitBundledClientAssets(projectRoot, {
      mode: "development",
      entryClientModules: ["app/layout.mjs"],
    });
    const layoutAsset = getAssetByClientModule(manifest, "app/layout.mjs");
    const tokensStyle = getAssetByClientModule(manifest, "src/styles/tokens.css");
    const composableStyle = getAssetByClientModule(manifest, "src/themes/composable.css");
    const globalStyle = getAssetByClientModule(manifest, "app/global.css");

    assert.ok(layoutAsset);
    assert.ok(tokensStyle);
    assert.ok(composableStyle);
    assert.ok(globalStyle);
    assert.deepEqual(layoutAsset.styleImports, [
      "app/global.css",
      "src/styles/tokens.css",
      "src/themes/composable.css",
    ]);
    assert.deepEqual(layoutAsset.styleUrls, [
      globalStyle.publicUrl,
      tokensStyle.publicUrl,
      composableStyle.publicUrl,
    ]);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("createHydrationBootstrap returns an empty string when no hydratable roots exist", () => {
  const bootstrap = createHydrationBootstrap({
    hydrationData: {
      roots: [],
    },
    assetResolver(moduleId) {
      return `/_evolit/static/${moduleId}`;
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
      return `/_evolit/static${moduleId.replace(/\.litsx$/, ".mjs")}`;
    },
  });

  assert.match(bootstrap, /registerHydrationModules/);
  assert.match(bootstrap, /hydratePage\(\{/);
  assert.match(bootstrap, /clientImports: \[\]/);
  assert.match(bootstrap, /register: \(\) => registerHydrationModules\(\[/);
  assert.equal(
    bootstrap.includes("/_evolit/static/app/components/feature-card.mjs"),
    true,
  );
  assert.equal(
    bootstrap.includes("/_evolit/static/app/components/hero-banner.mjs"),
    true,
  );
  assert.equal(
    bootstrap.match(/feature-card\.mjs/g)?.length ?? 0,
    1,
  );
  assert.equal(
    bootstrap.includes("__evolit/hydration"),
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
      value: ["/_evolit/static/app/components/feature-card.hash.mjs"],
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
    clientImports: ["/_evolit/static/app/components/feature-card.hash.mjs"],
  });
});

test("client asset manifest helpers normalize and query structured asset entries", () => {
  const manifest = normalizeClientAssetManifest({
    resources: ["app/components/card-accent.svg"],
    assets: [
      {
        clientModule: "app/page.mjs",
        kind: "entry",
        publicUrl: "/_evolit/static/app/page.hash.mjs",
      },
      {
        clientModule: "app/components/card-accent.css",
        kind: "style",
        publicUrl: "/_evolit/static/app/components/card-accent.hash.css",
      },
    ],
  });

  assert.equal(manifest.version, 1);
  assert.equal(manifest.publicPathPrefix, "/_evolit/static/");
  assert.deepEqual(manifest.resources, ["app/components/card-accent.svg"]);
  assert.equal(
    getAssetByClientModule(manifest, "app/page.mjs")?.publicUrl,
    "/_evolit/static/app/page.hash.mjs",
  );
  assert.equal(
    getAssetByPublicUrl(manifest, "/_evolit/static/app/components/card-accent.hash.css")?.clientModule,
    "app/components/card-accent.css",
  );
  assert.deepEqual(
    getAssetsByKind(manifest, "style").map((asset) => asset.clientModule),
    ["app/components/card-accent.css"],
  );
});

test("shared vendor runtime resolves browser ESM entry files", async () => {
  const sharedRuntime = await buildSharedVendorRuntime(process.cwd(), "development");

  assert.match(sharedRuntime.imports["@litsx/core"], /^\/_evolit\/shared\/.+\.mjs$/);
  assert.match(sharedRuntime.imports["@litsx/ssr/hydration"], /^\/_evolit\/shared\/.+\.mjs$/);
  assert.match(sharedRuntime.imports["lit"], /^\/_evolit\/shared\/.+\.mjs$/);
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
    hydrationEntryUrl.replace("/_evolit/shared/", ""),
  );
  const hydrationEntrySource = await fs.readFile(hydrationEntryPath, "utf8");

  assert.match(hydrationEntrySource, /vendor-hydration-support/);
});

test("development vendors add bare imports without rebuilding the base runtime", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-dev-vendor-groups-"));

  try {
    const baseRuntime = await buildSharedVendorRuntime(projectRoot, "development");
    const baseHydrationUrl = baseRuntime.imports["@litsx/ssr/hydration"];
    const baseHydrationPath = path.join(
      getSharedOutputRoot(projectRoot, "development"),
      baseHydrationUrl.replace("/_evolit/shared/", ""),
    );
    const before = await fs.stat(baseHydrationPath);

    const expandedRuntime = await buildSharedVendorRuntime(projectRoot, "development", {
      additionalEntrySpecifiers: ["magic-string"],
    });
    const after = await fs.stat(baseHydrationPath);

    assert.equal(expandedRuntime.imports["@litsx/ssr/hydration"], baseHydrationUrl);
    assert.match(expandedRuntime.imports["magic-string"], /^\/_evolit\/shared\/vendor-[a-f0-9]+\/.+\.mjs$/);
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("browser package asset urls preserve package-relative paths", async () => {
  const corePublicUrl = await createBrowserSpecifierPublicUrl("@litsx/core");
  assert.equal(corePublicUrl, "/_evolit/pkg/%40litsx/core/src/index.js");
  assert.equal(createBrowserPackageBaseUrl("lit"), "/_evolit/pkg/lit/");

  const relativeFilePath = await resolveBrowserPackageAssetFilePath(
    "/_evolit/pkg/%40litsx/core/src/error-boundary.js",
  );
  assert.match(relativeFilePath, /@litsx\/core\/src\/error-boundary\.js$/);

  const exportedSubpathFilePath = await resolveBrowserPackageAssetFilePath(
    "/_evolit/pkg/%40litsx/core/elements",
  );
  assert.match(exportedSubpathFilePath, /@litsx\/core\/src\/elements\/index\.js$/);
});

test("bundled static sourcemaps preserve original litsx sourcesContent", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-client-assets-"));
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
    await compileModuleGraph(path.join(fixtureRoot, "app", "layout.litsx"), {
      projectRoot: fixtureRoot,
      mode: "development",
      sourceMaps: true,
      target: "client",
    });

    const manifest = await emitBundledClientAssets(fixtureRoot, {
      mode: "development",
      entryClientModules: new Set(["app/page.mjs", "app/layout.mjs"]),
    });
    const pageAsset = getAssetByClientModule(manifest, "app/page.mjs");
    assert.ok(pageAsset);

    const sourceMapPath = path.join(
      fixtureRoot,
      ".evolit",
      "dev",
      "static",
      pageAsset.publicUrl.replace("/_evolit/static/", ""),
    ) + ".map";
    const sourceMap = JSON.parse(await fs.readFile(sourceMapPath, "utf8"));

    assert.deepEqual(sourceMap.sources, ["/app/page.litsx"]);
    assert.ok(Array.isArray(sourceMap.sourcesContent));
    assert.match(sourceMap.sourcesContent[0], /export default async function HomePage/);
    assert.match(sourceMap.sourcesContent[0], /<FeatureCard/);
    assert.doesNotMatch(sourceMap.sourcesContent[0], /import \{ LitElement, css, html \} from "lit"/);

    const layoutAsset = getAssetByClientModule(manifest, "app/layout.mjs");
    assert.ok(layoutAsset);
    const layoutSourceMapPath = path.join(
      fixtureRoot,
      ".evolit",
      "dev",
      "static",
      layoutAsset.publicUrl.replace("/_evolit/static/", ""),
    ) + ".map";
    const layoutSourceMap = JSON.parse(await fs.readFile(layoutSourceMapPath, "utf8"));
    assert.deepEqual(layoutSourceMap.sources, ["/app/layout.litsx"]);

    const emittedCode = await fs.readFile(sourceMapPath.slice(0, -".map".length), "utf8");
    const traceMap = new TraceMap(sourceMap);
    const sourceLineCount = sourceMap.sourcesContent[0].split("\n").length;
    for (let generatedLine = 1; generatedLine <= emittedCode.split("\n").length; generatedLine += 1) {
      const position = originalPositionFor(traceMap, { line: generatedLine, column: 0 });
      if (position.source === sourceMap.sources[0]) {
        assert.ok(
          position.line <= sourceLineCount,
          `generated line ${generatedLine} mapped outside the original LitSX source`,
        );
      }
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("rewriting client-relative imports preserves LitSX sourcemap sources", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-compiler-map-"));
  const appRoot = path.join(tempRoot, "app");

  try {
    await fs.mkdir(path.join(appRoot, "components"), { recursive: true });
    await fs.writeFile(
      path.join(appRoot, "components", "shell.litsx"),
      "export default function Shell(props) { return <section>{props.children}</section>; }\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(appRoot, "page.litsx"),
      [
        'import Shell from "./components/shell.litsx";',
        "",
        "export default function Page() {",
        "  return <Shell />;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const { entrypoint } = await compileModuleGraph(path.join(appRoot, "page.litsx"), {
      projectRoot: tempRoot,
      mode: "development",
      sourceMaps: true,
      target: "client",
    });
    const sourceMap = JSON.parse(await fs.readFile(`${entrypoint}.map`, "utf8"));
    const traceMap = new TraceMap(sourceMap);
    const importPosition = originalPositionFor(traceMap, { line: 3, column: 0 });

    assert.deepEqual(sourceMap.sources, [path.join(appRoot, "page.litsx")]);
    assert.match(sourceMap.sourcesContent[0], /import Shell from "\.\/components\/shell\.litsx"/);
    assert.equal(importPosition.source, path.join(appRoot, "page.litsx"));
    assert.equal(importPosition.line, 1);
    assert.doesNotMatch(sourceMap.sources[0], /#evolit-transform$/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("rewriting client-relative imports also works without sourcemaps", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-compiler-build-"));
  const appRoot = path.join(tempRoot, "app");

  try {
    await fs.mkdir(path.join(appRoot, "components"), { recursive: true });
    await fs.writeFile(
      path.join(appRoot, "components", "shell.litsx"),
      "export default function Shell() { return <section />; }\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(appRoot, "page.litsx"),
      [
        'import Shell from "./components/shell.litsx";',
        "",
        "export default function Page() {",
        "  return <Shell />;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const { entrypoint } = await compileModuleGraph(path.join(appRoot, "page.litsx"), {
      projectRoot: tempRoot,
      mode: "production",
      sourceMaps: false,
      target: "client",
    });
    const output = await fs.readFile(entrypoint, "utf8");

    assert.match(output, /from "\.\/components\/shell\.mjs"/);
    await assert.rejects(fs.access(`${entrypoint}.map`));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
