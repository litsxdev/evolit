import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import {
  buildSharedVendorRuntime,
  canonicalizePackageModuleId,
  collectClientVendorSpecifiers,
  collectSharedVendorSpecifiers,
  createBrowserSpecifierPublicUrl,
  createBrowserPackageBaseUrl,
  createAssetResolver,
  createHydrationBootstrap,
  emitBundledClientAssets,
  getAssetByClientModule,
  getAssetByPublicUrl,
  getAssetsByKind,
  getSharedOutputRoot,
  normalizeHydrationDataForClient,
  normalizeClientAssetManifest,
  resolveHydrationRootClientImports,
  resolveRouteClientImports,
  resolveBrowserPackageAssetFilePath,
  resolveBrowserSpecifierFilePath,
  resolvePackageRoot,
} from "../src/client-assets.js";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import { compileModuleGraph } from "../src/compiler.js";
import { scaffoldSite } from "../src/scaffold.js";

async function writeFixturePackage(projectRoot, packageName, packageJson, files) {
  const packageRoot = path.join(projectRoot, "node_modules", ...packageName.split("/"));
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: packageName, ...packageJson }, null, 2)}\n`,
    "utf8",
  );
  await Promise.all(Object.entries(files).map(async ([relativePath, contents]) => {
    const filePath = path.join(packageRoot, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents, "utf8");
  }));
  return packageRoot;
}

test("package roots resolve through an exported package.json for import-only ESM packages", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-esm-package-root-"));
  const packageName = "@fixture/import-only";

  try {
    const packageRoot = await writeFixturePackage(
      projectRoot,
      packageName,
      {
        type: "module",
        exports: {
          ".": { types: "./index.d.ts", import: "./index.js" },
          "./package.json": "./package.json",
        },
      },
      {
        "index.js": 'export const marker = "import-only";\n',
        "index.d.ts": "export declare const marker: string;\n",
      },
    );

    const resolution = await resolvePackageRoot(packageName, { projectRoot });
    assert.equal(resolution.packageRoot, await fs.realpath(packageRoot));
    assert.equal(resolution.packageJson.name, packageName);
    assert.equal(
      await resolveBrowserSpecifierFilePath(packageName, { projectRoot }),
      path.join(await fs.realpath(packageRoot), "index.js"),
    );
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("package root resolution falls back to the package entry when package.json is not exported", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-package-root-fallback-"));
  const packageName = "fixture-package-root-fallback";

  try {
    const packageRoot = await writeFixturePackage(
      projectRoot,
      packageName,
      {
        exports: {
          ".": { import: "./index.js", require: "./index.cjs" },
        },
      },
      {
        "index.js": 'export const marker = "esm";\n',
        "index.cjs": 'module.exports = { marker: "commonjs" };\n',
      },
    );

    const resolution = await resolvePackageRoot(packageName, { projectRoot });
    assert.equal(resolution.packageRoot, await fs.realpath(packageRoot));
    assert.equal(resolution.packageJson.name, packageName);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("package roots resolve import-only browser packages without a package.json export", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-browser-package-root-"));
  const packageName = "@fixture/browser-import-only";

  try {
    const packageRoot = await writeFixturePackage(
      projectRoot,
      packageName,
      {
        type: "module",
        exports: {
          ".": { browser: "./browser.js", import: "./index.js" },
        },
      },
      {
        "browser.js": 'export const runtime = "browser";\n',
        "index.js": 'export const runtime = "import";\n',
      },
    );

    const resolution = await resolvePackageRoot(packageName, { projectRoot });
    assert.equal(resolution.packageRoot, await fs.realpath(packageRoot));
    assert.equal(
      await resolveBrowserSpecifierFilePath(packageName, { projectRoot }),
      path.join(await fs.realpath(packageRoot), "browser.js"),
    );
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("physical workspace package modules canonicalize to their exported package subpath", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-workspace-package-"));
  const projectRoot = path.join(workspaceRoot, "apps", "site");
  const packageRoot = path.join(workspaceRoot, "packages", "features");
  const packageName = "@fixture/workspace-features";

  try {
    await fs.mkdir(path.join(projectRoot, "node_modules", "@fixture"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
      name: "fixture-site",
      private: true,
      dependencies: { [packageName]: "workspace:*" },
    }), "utf8");
    await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
    await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
      name: packageName,
      type: "module",
      exports: { "./features": { browser: "./dist/features.mjs", import: "./dist/features.mjs" } },
    }), "utf8");
    const entryPath = path.join(packageRoot, "dist", "features.mjs");
    await fs.writeFile(entryPath, "export class Feature {}\n", "utf8");
    await fs.symlink(packageRoot, path.join(projectRoot, "node_modules", "@fixture", "workspace-features"), "dir");

    assert.equal(
      await canonicalizePackageModuleId(projectRoot, entryPath, [`${packageName}/features`]),
      `${packageName}/features`,
    );
    assert.equal(
      await canonicalizePackageModuleId(
        projectRoot,
        pathToFileURL(entryPath).href,
        [`${packageName}/features`],
      ),
      `${packageName}/features`,
    );
    const packageJsonPath = path.join(projectRoot, "package.json");
    await fs.writeFile(packageJsonPath, JSON.stringify({ name: "fixture-site", private: true }), "utf8");
    assert.equal(
      await canonicalizePackageModuleId(projectRoot, entryPath, [`${packageName}/features`]),
      null,
    );
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("package root resolution rejects an exported manifest owned by another package", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-package-root-name-"));
  const packageName = "fixture-package-root-name";

  try {
    const packageRoot = path.join(projectRoot, "node_modules", packageName);
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "another-package",
        exports: {
          ".": "./index.cjs",
          "./package.json": "./package.json",
        },
      }),
      "utf8",
    );
    await fs.writeFile(path.join(packageRoot, "index.cjs"), "module.exports = {};\n", "utf8");

    await assert.rejects(
      resolvePackageRoot(packageName, { projectRoot }),
      new RegExp(`Unable to resolve package root for ${packageName}`),
    );
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

for (const mode of ["development", "production"]) {
  test(`package CSS subpaths use the static asset pipeline in ${mode}`, async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), `evolit-package-css-${mode}-`));
    const packageName = "@fixture/package-assets";
    const entryPath = path.join(projectRoot, "entry.js");

    try {
      await fs.writeFile(path.join(projectRoot, "package.json"), '{"type":"module"}\n', "utf8");
      await writeFixturePackage(
        projectRoot,
        packageName,
        {
          type: "module",
          exports: {
            ".": { types: "./index.d.ts", import: "./index.js" },
            "./package.json": "./package.json",
            "./tokens.css": "./styles/tokens.css",
            "./theme.css": "./styles/theme.css",
          },
        },
        {
          "index.js": 'export const marker = "package-assets";\n',
          "index.d.ts": "export declare const marker: string;\n",
          "styles/tokens.css": '@import "./base.css";\n.tokens { background: url("./grid.svg#tile"); }\n',
          "styles/base.css": ":root { --fixture-color: rebeccapurple; }\n",
          "styles/theme.css": ".theme { color: var(--fixture-color); }\n",
          "styles/grid.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>\n',
        },
      );
      await fs.writeFile(
        entryPath,
        [
          `import { marker } from ${JSON.stringify(packageName)};`,
          `import ${JSON.stringify(`${packageName}/tokens.css`)};`,
          `import ${JSON.stringify(`${packageName}/theme.css`)};`,
          "export { marker };",
          "",
        ].join("\n"),
        "utf8",
      );

      await compileModuleGraph(entryPath, {
        projectRoot,
        mode,
        sourceMaps: mode === "development",
        target: "client",
      });
      const metadata = JSON.parse(await fs.readFile(
        path.join(projectRoot, ".evolit", mode === "development" ? "dev" : "build", "client", "entry.mjs.meta.json"),
        "utf8",
      ));
      assert.deepEqual(metadata.vendorImports, [packageName]);
      assert.deepEqual(metadata.styleImports, [
        "node_modules/@fixture/package-assets/styles/theme.css",
        "node_modules/@fixture/package-assets/styles/tokens.css",
      ]);

      const manifest = await emitBundledClientAssets(projectRoot, {
        mode,
        entryClientModules: ["entry.mjs"],
      });
      const entryAsset = getAssetByClientModule(manifest, "entry.mjs");
      const tokensAsset = getAssetByClientModule(
        manifest,
        "node_modules/@fixture/package-assets/styles/tokens.css",
      );
      const baseAsset = getAssetByClientModule(
        manifest,
        "node_modules/@fixture/package-assets/styles/base.css",
      );
      const gridAsset = getAssetByClientModule(
        manifest,
        "node_modules/@fixture/package-assets/styles/grid.svg",
      );
      assert.ok(entryAsset);
      assert.ok(tokensAsset);
      assert.ok(baseAsset);
      assert.ok(gridAsset);
      assert.deepEqual(entryAsset.styleImports, [
        "node_modules/@fixture/package-assets/styles/theme.css",
        "node_modules/@fixture/package-assets/styles/tokens.css",
      ]);
      assert.equal(entryAsset.styleUrls.includes(tokensAsset.publicUrl), true);
      const emittedCss = await fs.readFile(tokensAsset.outputPath, "utf8");
      assert.match(emittedCss, new RegExp(path.basename(baseAsset.publicUrl).replaceAll(".", "\\.")));
      assert.match(emittedCss, new RegExp(`${path.basename(gridAsset.publicUrl).replaceAll(".", "\\.")}#tile`));
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });
}

test("the hot component runtime is a development-only shared vendor", async () => {
  assert.ok(
    (await collectSharedVendorSpecifiers([], { mode: "development" }))
      .includes("evolit/internal/development-hot"),
  );
  assert.ok(
    !(await collectSharedVendorSpecifiers([], { mode: "production" }))
      .includes("evolit/internal/development-hot"),
  );
});

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

test("createHydrationBootstrap delegates resource-only document hydration to hydratePage", () => {
  const hydrationData = {
    version: 1,
    roots: [],
    payload: {
      roots: {},
      instances: {},
      resources: { "library:i18n": { locale: "es" } },
    },
    clientImports: [],
  };
  const bootstrap = createHydrationBootstrap({ hydrationData });

  assert.match(bootstrap, /hydratePage/);
  assert.match(bootstrap, /registerHydrationModules/);
});

test("createHydrationBootstrap initializes development navigation without hydration roots", () => {
  const bootstrap = createHydrationBootstrap({
    hydrationData: { roots: [] },
    navigationModuleUrl: "/_evolit/shared/evolit__navigation.mjs",
  });

  assert.match(bootstrap, /import \{ getNavigation \}/);
  assert.match(bootstrap, /import \{ registerNavigationExtensions \}/);
  assert.match(bootstrap, /getNavigation\(\)/);
  assert.doesNotMatch(bootstrap, /hydratePage/);
});

test("createHydrationBootstrap deduplicates module imports by moduleId", () => {
  const bootstrap = createHydrationBootstrap({
    hydrationData: {
      roots: [
        { id: "root-0", moduleId: "/app/components/feature-card.jsx" },
        { id: "root-1", moduleId: "/app/components/feature-card.jsx" },
        { id: "root-2", moduleId: "/app/components/hero-banner.jsx" },
        { id: "root-3", moduleId: "" },
        { id: "root-4" },
      ],
    },
    assetResolver(moduleId) {
      return `/_evolit/static${moduleId.replace(/\.jsx$/, ".mjs")}`;
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

test("resolveHydrationRootClientImports includes component modules without route re-exports", () => {
  const imports = resolveHydrationRootClientImports({
    roots: [
      { id: "root-0", moduleId: "/app/components/payload-card.jsx" },
      { id: "root-1", moduleId: "/app/components/payload-card.jsx" },
      { id: "root-2", moduleId: "/app/components/hero-banner.jsx" },
      { id: "root-3" },
    ],
  }, (moduleId) => (typeof moduleId === "string"
    ? `/_evolit/static${moduleId.replace(/\.jsx$/, ".mjs")}`
    : null));

  assert.deepEqual(imports, [
    "/_evolit/static/app/components/payload-card.mjs",
    "/_evolit/static/app/components/hero-banner.mjs",
  ]);
});

test("package hydration roots resolve through the canonical shared vendor mapping", () => {
  const resolver = createAssetResolver("/workspace/site", {
    assetManifest: { assets: [], byClientModule: {} },
    packageImports: {
      "@fixture/components/features": "/_evolit/shared/vendor-fixture/features.mjs",
    },
  });
  const hydrationData = {
    version: 1,
    roots: [
      { id: "root-0", moduleId: "@fixture/components/features" },
      { id: "root-1", moduleId: "@fixture/components/features" },
    ],
    clientImports: ["@fixture/components/features"],
  };

  assert.deepEqual(resolveHydrationRootClientImports(hydrationData, resolver), [
    "/_evolit/shared/vendor-fixture/features.mjs",
  ]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(normalizeHydrationDataForClient(
      hydrationData,
      "/workspace/site",
      resolveHydrationRootClientImports(hydrationData, resolver),
      resolver,
    ))),
    {
      version: 1,
      roots: [
        { id: "root-0", moduleId: "@fixture/components/features" },
        { id: "root-1", moduleId: "@fixture/components/features" },
      ],
      clientImports: ["/_evolit/shared/vendor-fixture/features.mjs"],
    },
  );
});

test("createHydrationBootstrap registers route client imports alongside hydration roots", () => {
  const bootstrap = createHydrationBootstrap({
    hydrationData: {
      roots: [],
      clientImports: ["/_evolit/static/app/explore/*...slug*/page.mjs"],
    },
  });

  assert.match(bootstrap, /registerHydrationModules/);
  assert.match(bootstrap, /app\/explore\/\*\.\.\.slug\*\/page\.mjs/);
  assert.match(bootstrap, /clientImports: \["\/_evolit\/static\/app\/explore\/\*\.\.\.slug\*\/page\.mjs"\]/);
});

test("createAssetResolver resolves hydratable modules outside the project root", () => {
  const resolver = createAssetResolver("/workspace/vend.io/site", {
    assetManifest: {
      assets: [],
      byClientModule: {
        "__unmanaged__/__up__/src/components/navigation/vds-breadcrumbs.mjs": "/_evolit/static/__unmanaged__/__up__/src/components/navigation/vds-breadcrumbs.mjs",
      },
    },
  });

  assert.equal(
    resolver("/workspace/vend.io/src/components/navigation/vds-breadcrumbs.jsx"),
    "/_evolit/static/__unmanaged__/__up__/src/components/navigation/vds-breadcrumbs.mjs",
  );
});

test("resolveRouteClientImports resolves sanitized dynamic route entry names", () => {
  const projectRoot = "/workspace/site";
  const scenarios = [
    ["app/product/[slug]/page.jsx", "app/product/_slug_/page.mjs"],
    ["app/explore/[...slug]/page.jsx", "app/explore/_...slug_/page.mjs"],
    ["app/docs/[[...slug]]/page.jsx", "app/docs/__...slug__/page.mjs"],
    ["app/catalog/[category]/[slug]/page.jsx", "app/catalog/_category_/_slug_/page.mjs"],
  ];
  const byClientModule = Object.fromEntries(
    scenarios.map(([, emittedClientModule]) => [
      emittedClientModule,
      `/_evolit/static/${emittedClientModule}`,
    ]),
  );

  for (const [routeModule, emittedClientModule] of scenarios) {
    const imports = resolveRouteClientImports({
      route: {
        page: path.join(projectRoot, routeModule),
        layouts: [],
      },
    }, projectRoot, {
      byClientModule,
      assets: [],
    });

    assert.deepEqual(imports, [`/_evolit/static/${emittedClientModule}`]);
  }
});

test("createHydrationBootstrap ignores unresolved module ids", () => {
  const bootstrap = createHydrationBootstrap({
    hydrationData: {
      roots: [
        { id: "root-0", moduleId: "/outside/project/component-a.jsx" },
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
        moduleId: "/Users/example/site/app/components/feature-card.jsx",
      },
      {
        id: "root-1",
        moduleId: "/outside/project/hero-banner.jsx",
      },
      {
        id: "root-2",
        moduleId: "/outside/project/ignored.jsx",
      },
    ],
  };
  Object.defineProperties(hydrationData, {
    payload: {
      enumerable: false,
      value: {
        roots: { "root-0": { props: { title: "Feature" } } },
        instances: {},
        resources: {
          "library:i18n": { locale: "es", messages: { title: "Inicio" } },
        },
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

  assert.strictEqual(
    normalizedHydrationData.payload.resources,
    hydrationData.payload.resources,
  );
  assert.deepEqual(normalizedHydrationData.roots, [
    {
      id: "root-0",
      moduleId: "/app/components/feature-card.jsx",
    },
    {
      id: "root-1",
      moduleId: "/__unmanaged__/__up__/__up__/__up__/outside/project/hero-banner.jsx",
    },
    {
      id: "root-2",
      moduleId: "/__unmanaged__/__up__/__up__/__up__/outside/project/ignored.jsx",
    },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(normalizedHydrationData)), {
    version: 1,
    roots: [
      {
        id: "root-0",
        moduleId: "/app/components/feature-card.jsx",
      },
      {
        id: "root-1",
        moduleId: "/__unmanaged__/__up__/__up__/__up__/outside/project/hero-banner.jsx",
      },
      {
        id: "root-2",
        moduleId: "/__unmanaged__/__up__/__up__/__up__/outside/project/ignored.jsx",
      },
    ],
    payload: {
      roots: { "root-0": { props: { title: "Feature" } } },
      instances: {},
      resources: {
        "library:i18n": { locale: "es", messages: { title: "Inicio" } },
      },
    },
    clientImports: ["/_evolit/static/app/components/feature-card.hash.mjs"],
  });
});

test("client asset manifest helpers normalize and query structured asset entries", () => {
  const manifest = normalizeClientAssetManifest({
    resources: ["app/components/card-accent.svg"],
    sharedImports: {
      "@fixture/components/features": "/_evolit/shared/vendor-fixture/features.mjs",
    },
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
  assert.deepEqual(manifest.sharedImports, {
    "@fixture/components/features": "/_evolit/shared/vendor-fixture/features.mjs",
  });
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

for (const mode of ["development", "production"]) {
  test(`shared vendor runtime preserves ESM and CommonJS exports in ${mode}`, async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), `evolit-vendor-exports-${mode}-`));
    const packages = {
      "fixture-esm-default": {
        packageJson: { type: "module", exports: { browser: "./browser.js", default: "./server.js" } },
        files: {
          "browser.js": 'export default "browser-default"; export const named = "named";\n',
          "server.js": 'throw new Error("server entry selected");\n',
        },
      },
      "fixture-commonjs-default": {
        packageJson: { main: "./index.cjs" },
        files: { "index.cjs": 'module.exports = function commonjsDefault() { return "commonjs-default"; };\n' },
      },
      "fixture-esm-named": {
        packageJson: { type: "module", module: "./index.js" },
        files: { "index.js": 'export const alpha = "alpha"; export const beta = "beta";\n' },
      },
    };

    try {
      await fs.writeFile(path.join(projectRoot, "package.json"), '{"type":"module"}\n', "utf8");
      for (const [packageName, fixture] of Object.entries(packages)) {
        const packageRoot = path.join(projectRoot, "node_modules", packageName);
        await fs.mkdir(packageRoot, { recursive: true });
        await fs.writeFile(
          path.join(packageRoot, "package.json"),
          JSON.stringify({ name: packageName, ...fixture.packageJson }),
          "utf8",
        );
        await Promise.all(Object.entries(fixture.files).map(([fileName, source]) =>
          fs.writeFile(path.join(packageRoot, fileName), source, "utf8")
        ));
      }

      const specifiers = Object.keys(packages);
      const runtime = await buildSharedVendorRuntime(projectRoot, mode, {
        additionalEntrySpecifiers: specifiers,
        includeBase: false,
        vendorGroup: "fixture-exports",
      });
      async function importPublishedVendor(specifier) {
        const publicUrl = runtime.imports[specifier];
        assert.match(publicUrl, /^\/_evolit\/shared\/fixture-exports\/.+\.mjs$/);
        const filePath = path.join(
          getSharedOutputRoot(projectRoot, mode),
          publicUrl.slice("/_evolit/shared/".length),
        );
        return import(`${pathToFileURL(filePath).href}?fixture=${specifier}`);
      }

      const esmDefault = await importPublishedVendor("fixture-esm-default");
      assert.equal(esmDefault.default, "browser-default");
      assert.equal(esmDefault.named, "named");

      const commonjsDefault = await importPublishedVendor("fixture-commonjs-default");
      assert.equal(commonjsDefault.default(), "commonjs-default");

      const namedOnly = await importPublishedVendor("fixture-esm-named");
      assert.deepEqual(Object.keys(namedOnly).sort(), ["alpha", "beta"]);
      assert.equal("default" in namedOnly, false);
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });
}

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

    const pagePath = path.join(fixtureRoot, "app", "page.jsx");
    const pageSource = await fs.readFile(pagePath, "utf8");
    await fs.writeFile(
      pagePath,
      pageSource.replace("export default async function HomePage", "export default function HomePage"),
      "utf8",
    );

    await compileModuleGraph(pagePath, {
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
      ".evolit",
      "dev",
      "static",
      pageAsset.publicUrl.replace("/_evolit/static/", ""),
    ) + ".map";
    const sourceMap = JSON.parse(await fs.readFile(sourceMapPath, "utf8"));

    assert.deepEqual(sourceMap.sources, ["/app/page.jsx"]);
    assert.ok(Array.isArray(sourceMap.sourcesContent));
    assert.match(sourceMap.sourcesContent[0], /export default function HomePage/);
    assert.match(sourceMap.sourcesContent[0], /<FeatureCard/);
    assert.doesNotMatch(sourceMap.sourcesContent[0], /import \{ LitElement, css, html \} from "lit"/);

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
      path.join(appRoot, "components", "shell.jsx"),
      "export default function PageShell(props) { return <section>{props.children}</section>; }\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(appRoot, "page.jsx"),
      [
        'import PageShell from "./components/shell.jsx";',
        "",
        "export default function RoutePage() {",
        "  return <PageShell />;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const { entrypoint } = await compileModuleGraph(path.join(appRoot, "page.jsx"), {
      projectRoot: tempRoot,
      mode: "development",
      sourceMaps: true,
      target: "client",
    });
    const sourceMap = JSON.parse(await fs.readFile(`${entrypoint}.map`, "utf8"));
    const traceMap = new TraceMap(sourceMap);
    const importPosition = originalPositionFor(traceMap, { line: 3, column: 0 });

    assert.deepEqual(sourceMap.sources, [path.join(appRoot, "page.jsx")]);
    assert.match(sourceMap.sourcesContent[0], /import PageShell from "\.\/components\/shell\.jsx"/);
    assert.equal(importPosition.source, path.join(appRoot, "page.jsx"));
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
      path.join(appRoot, "components", "shell.jsx"),
      "export default function PageShell() { return <section />; }\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(appRoot, "page.jsx"),
      [
        'import PageShell from "./components/shell.jsx";',
        "",
        "export default function RoutePage() {",
        "  return <PageShell />;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const { entrypoint } = await compileModuleGraph(path.join(appRoot, "page.jsx"), {
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
