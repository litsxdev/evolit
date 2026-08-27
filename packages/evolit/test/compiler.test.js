import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  compileModuleGraph,
  collectClientBoundaryModules,
  collectClientGraphInventory,
  emitClientStaticAssets,
  importCompiledModule,
  invalidateDevelopmentCompilationCache,
  resolveProjectModuleSpecifier,
} from "../src/compiler.js";

for (const mode of ["development", "production"]) {
  test(`compiler resolves extensionless imports with intermediate suffixes in ${mode}`, async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-compiler-imports-"));
    const sourceRoot = path.join(projectRoot, "src");

    try {
      await fs.mkdir(path.join(sourceRoot, "generated"), { recursive: true });
      await fs.mkdir(path.join(sourceRoot, "assets"), { recursive: true });
      await Promise.all([
        fs.writeFile(path.join(sourceRoot, "foo.ts"), "export default 'foo';\n", "utf8"),
        fs.writeFile(
          path.join(sourceRoot, "generated", "hooks.generated.ts"),
          "export default 'hooks';\n",
          "utf8",
        ),
        fs.writeFile(
          path.join(sourceRoot, "generated", "types.generated.ts"),
          "export default 'types';\n",
          "utf8",
        ),
        fs.writeFile(path.join(sourceRoot, "assets", "logo.svg"), "<svg />\n", "utf8"),
        fs.writeFile(
          path.join(sourceRoot, "entry.js"),
          [
            'import foo from "./foo";',
            'import explicitFoo from "./foo.ts";',
            'import hooks from "./generated/hooks.generated";',
            'import types from "./generated/types.generated";',
            'import logo from "./assets/logo.svg";',
            "export default { foo, explicitFoo, hooks, types, logo };",
            "",
          ].join("\n"),
          "utf8",
        ),
      ]);

      const { entrypoint } = await compileModuleGraph(path.join(sourceRoot, "entry.js"), {
        projectRoot,
        mode,
        sourceMaps: false,
      });
      const output = await fs.readFile(entrypoint, "utf8");
      const importSuffix = mode === "development" ? "\\?t=\\d+" : "";

      assert.equal(
        output.match(new RegExp(`from "\\./foo\\.mjs${importSuffix}"`, "g"))?.length,
        2,
        "both extensionless and explicit TypeScript imports should resolve",
      );
      assert.match(output, new RegExp(`from "\\./generated/hooks\\.generated\\.mjs${importSuffix}"`));
      assert.match(output, new RegExp(`from "\\./generated/types\\.generated\\.mjs${importSuffix}"`));
      assert.match(output, new RegExp(`from "\\./assets/logo\\.svg\\.mjs${importSuffix}"`));
      await assert.doesNotReject(fs.access(path.join(path.dirname(entrypoint), "generated", "hooks.generated.mjs")));
      await assert.doesNotReject(fs.access(path.join(path.dirname(entrypoint), "generated", "types.generated.mjs")));
      await assert.doesNotReject(fs.access(path.join(path.dirname(entrypoint), "assets", "logo.svg.mjs")));
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });
}

test("compiler preserves plain route-handler exports outside the LitSX authoring pipeline", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-plain-route-handler-"));
  const sourcePath = path.join(projectRoot, "route.js");

  try {
    await fs.writeFile(
      sourcePath,
      'export async function GET() { return new Response("ok"); }\n',
      "utf8",
    );
    const { entrypoint } = await compileModuleGraph(sourcePath, {
      projectRoot,
      mode: "production",
      sourceMaps: true,
      target: "server",
    });

    assert.match(await fs.readFile(entrypoint, "utf8"), /export async function GET/);
    assert.equal((await import(`${pathToFileURL(entrypoint).href}?test=${Date.now()}`)).GET instanceof Function, true);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("compiler preserves LitSX side-effect imports for asset discovery", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-side-effect-imports-"));
  const sourcePath = path.join(projectRoot, "feature-card.jsx");
  const stylePath = path.join(projectRoot, "feature-card.css");

  try {
    await fs.writeFile(stylePath, ":host { display: block; }\n", "utf8");
    await fs.writeFile(
      sourcePath,
      'import "./feature-card.css"; export default function FeatureCard() { return <article />; }\n',
      "utf8",
    );
    const { entrypoint } = await compileModuleGraph(sourcePath, {
      projectRoot,
      mode: "production",
      sourceMaps: true,
      target: "client",
    });

    assert.match(await fs.readFile(entrypoint, "utf8"), /import "\.\/feature-card\.css\.mjs"/);
    await assert.doesNotReject(fs.access(path.join(projectRoot, ".evolit", "build", "client", "feature-card.css")));
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("compiler composes imported .jsx Server Components during SSR", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-server-composition-"));
  const childPath = path.join(projectRoot, "catalog-fragment.jsx");
  const pagePath = path.join(projectRoot, "page.jsx");

  try {
    await fs.writeFile(
      childPath,
      "export default async function CatalogFragment() { return <main>catalog</main>; }\n",
      "utf8",
    );
    await fs.writeFile(
      pagePath,
      'import CatalogFragment from "./catalog-fragment.jsx"; export default async function CatalogPage() { return <CatalogFragment />; }\n',
      "utf8",
    );
    const { entrypoint } = await compileModuleGraph(pagePath, {
      projectRoot,
      mode: "production",
      sourceMaps: false,
      ssr: true,
      target: "server",
    });
    const output = await fs.readFile(entrypoint, "utf8");

    assert.match(output, /__litsxServerComponentCall\(CatalogFragment, \{\}\)/);
    assert.match(output, /CatalogPage\[LITSX_SERVER_COMPONENT\] = true/);
    assert.doesNotMatch(output, /annotateHydratableCustomElement\(CatalogFragment/);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("compiler reuses development graphs until they are invalidated", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-compiler-cache-"));
  const sourcePath = path.join(projectRoot, "entry.js");

  try {
    await fs.writeFile(sourcePath, "export default 'first';\n", "utf8");
    const first = await compileModuleGraph(sourcePath, {
      projectRoot,
      mode: "development",
      sourceMaps: false,
    });
    await fs.writeFile(sourcePath, "export default 'second';\n", "utf8");

    const cached = await compileModuleGraph(sourcePath, {
      projectRoot,
      mode: "development",
      sourceMaps: false,
    });
    assert.equal(cached.entrypoint, first.entrypoint);
    assert.match(await fs.readFile(cached.entrypoint, "utf8"), /first/);

    invalidateDevelopmentCompilationCache(projectRoot);
    const invalidated = await compileModuleGraph(sourcePath, {
      projectRoot,
      mode: "development",
      sourceMaps: false,
    });
    assert.match(await fs.readFile(invalidated.entrypoint, "utf8"), /second/);
  } finally {
    invalidateDevelopmentCompilationCache(projectRoot);
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("development client modules export stable Evolit hot component proxies", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-hot-component-"));
  const sourcePath = path.join(projectRoot, "src", "card.jsx");

  try {
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(
      sourcePath,
      [
        "export default function FeatureCard() { return <button>default</button>; }",
        "export function StatusBadge() { return <span>named</span>; }",
        "",
      ].join("\n"),
      "utf8",
    );

    const development = await compileModuleGraph(sourcePath, {
      projectRoot,
      mode: "development",
      sourceMaps: false,
      target: "client",
    });
    const developmentCode = await fs.readFile(development.entrypoint, "utf8");
    assert.match(
      developmentCode,
      /import \{ hotComponent as __evolitHotComponent \} from "evolit\/internal\/development-hot"/,
    );
    assert.match(developmentCode, /__evolitHotComponent\("src\/card\.jsx", FeatureCard\)/);
    assert.match(developmentCode, /export default __evolit_hot_FeatureCard_0/);
    assert.match(developmentCode, /export \{ __evolit_hot_StatusBadge_1 as StatusBadge \}/);

    const production = await compileModuleGraph(sourcePath, {
      projectRoot,
      mode: "production",
      sourceMaps: false,
      target: "client",
    });
    const productionCode = await fs.readFile(production.entrypoint, "utf8");
    assert.doesNotMatch(productionCode, /development-hot|__evolitHotComponent/);
  } finally {
    invalidateDevelopmentCompilationCache(projectRoot);
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("compiler rejects a client graph that reaches a LitSX Server Component", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-client-server-boundary-"));
  const clientPath = path.join(projectRoot, "src", "client-card.jsx");
  const serverPath = path.join(projectRoot, "src", "server-fragment.jsx");

  try {
    await fs.mkdir(path.dirname(clientPath), { recursive: true });
    await Promise.all([
      fs.writeFile(
        serverPath,
        'export default async function ServerFragment() { return <p>server only</p>; }\n',
        "utf8",
      ),
      fs.writeFile(
        clientPath,
        [
          'import ServerFragment from "./server-fragment.jsx";',
          "export function ClientCard() { return <section><ServerFragment /></section>; }",
          "",
        ].join("\n"),
        "utf8",
      ),
    ]);

    await assert.rejects(
      compileModuleGraph(clientPath, {
        projectRoot,
        mode: "production",
        sourceMaps: false,
        target: "client",
      }),
      (error) => {
        assert.match(error.message, /client\/hydratable module cannot import a LitSX Server Component/);
        assert.match(error.message, /client-card\.jsx.*server-fragment\.jsx/);
        assert.match(error.message, /LITSX_SERVER_COMPONENT/);
        return true;
      },
    );
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("compiler emits the client projection of a mixed Server Component module", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-mixed-boundary-"));
  try {
    await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
    const serverDependency = path.join(projectRoot, "src", "server-data.js");
    const mixedModule = path.join(projectRoot, "src", "mixed.jsx");
    await fs.writeFile(serverDependency, 'import "node:fs"; export const message = "server";\n');
    await fs.writeFile(
      mixedModule,
      [
        'import { message } from "./server-data.js";',
        "export default async function ServerFragment() { return <p>{message}</p>; }",
        "export function ClientCard() { return <button>client</button>; }",
        "",
      ].join("\n"),
    );

    const inventory = await collectClientGraphInventory([mixedModule], { projectRoot });
    assert.deepEqual(inventory.clientBoundaries, [mixedModule]);
    const clientBuild = await compileModuleGraph(mixedModule, {
      projectRoot,
      mode: "production",
      sourceMaps: false,
      target: "client",
    });
    const clientCode = await fs.readFile(clientBuild.entrypoint, "utf8");
    assert.doesNotMatch(clientCode, /ServerFragment|server-data|LITSX_SERVER_COMPONENT/);
    assert.match(clientCode, /class ClientCard extends LitElement/);

    const clientConsumer = path.join(projectRoot, "src", "client-consumer.jsx");
    await fs.writeFile(
      clientConsumer,
      'import { ClientCard } from "./mixed.jsx"; export function ClientConsumer() { return <ClientCard />; }\n',
    );
    await compileModuleGraph(clientConsumer, {
      projectRoot,
      mode: "production",
      sourceMaps: false,
      target: "client",
    });

    const invalidConsumer = path.join(projectRoot, "src", "invalid-consumer.jsx");
    await fs.writeFile(
      invalidConsumer,
      'import ServerFragment from "./mixed.jsx"; export function ClientConsumer() { return <ServerFragment />; }\n',
    );
    await assert.rejects(
      compileModuleGraph(invalidConsumer, {
        projectRoot,
        mode: "production",
        sourceMaps: false,
        target: "client",
      }),
      /imports Server Component export.*default/,
    );
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("collects client boundaries through arbitrary Server Component modules", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-server-boundaries-"));
  try {
    await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "src", "card.jsx"), "export function FeatureCard() { return <button>client</button>; }\n");
    await fs.writeFile(path.join(projectRoot, "src", "fragment.jsx"), 'import { FeatureCard } from "./card.jsx"; export async function ServerFragment() { return <FeatureCard />; }\n');
    const entry = path.join(projectRoot, "entry.jsx");
    await fs.writeFile(entry, 'import { ServerFragment } from "./src/fragment.jsx"; export default async function RoutePage() { return <ServerFragment />; }\n');
    assert.deepEqual(await collectClientBoundaryModules([entry], { projectRoot }), [path.join(projectRoot, "src", "card.jsx")]);
  } finally { await fs.rm(projectRoot, { recursive: true, force: true }); }
});

test("keeps Server Component assets public without emitting the server module as client JS", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-server-assets-"));
  try {
    await fs.mkdir(path.join(projectRoot, "src", "styles"), { recursive: true });
    await fs.mkdir(path.join(projectRoot, "src", "images"), { recursive: true });
    const page = path.join(projectRoot, "src", "catalog.jsx");
    const theme = path.join(projectRoot, "src", "styles", "theme.css");
    const tokens = path.join(projectRoot, "src", "styles", "tokens.css");
    const image = path.join(projectRoot, "src", "images", "mark.svg");
    await fs.writeFile(page, 'import "./styles/theme.css"; export async function CatalogPage() { return <main>catalog</main>; }\n');
    await fs.writeFile(theme, '@import "./tokens.css"; main { background: url("../images/mark.svg"); }\n');
    await fs.writeFile(tokens, ":root { --brand: red; }\n");
    await fs.writeFile(image, "<svg></svg>\n");

    const inventory = await collectClientGraphInventory([page], { projectRoot });
    assert.deepEqual(inventory.clientBoundaries, []);
    assert.deepEqual(inventory.styles, [theme, tokens].sort());
    assert.deepEqual(inventory.assets, [image]);

    const emitted = await emitClientStaticAssets([...inventory.styles, ...inventory.assets], {
      projectRoot,
      mode: "development",
    });
    assert.deepEqual(emitted, [
      "src/images/mark.svg",
      "src/styles/theme.css",
      "src/styles/tokens.css",
    ]);
    await assert.rejects(fs.access(path.join(projectRoot, ".evolit", "dev", "client", "src", "catalog.mjs")));
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("resolves path aliases to client boundaries and rewrites aliases in the server graph", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-aliased-boundary-"));
  try {
    await fs.mkdir(path.join(projectRoot, "src", "ui"), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, "jsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@ui/*": ["src/ui/*"] } } }),
    );
    const card = path.join(projectRoot, "src", "ui", "card.jsx");
    const entry = path.join(projectRoot, "entry.jsx");
    await fs.writeFile(card, "export default function FeatureCard() { return <button>aliased</button>; }\n");
    await fs.writeFile(
      entry,
      'import FeatureCard from "@ui/card"; export default async function RoutePage() { return <FeatureCard />; }\n',
    );

    const inventory = await collectClientGraphInventory([entry], { projectRoot });
    assert.deepEqual(inventory.clientBoundaries, [card]);
    const serverBuild = await compileModuleGraph(entry, {
      projectRoot,
      mode: "production",
      sourceMaps: false,
      ssr: true,
      target: "server",
    });
    const output = await fs.readFile(serverBuild.entrypoint, "utf8");
    assert.doesNotMatch(output, /import FeatureCard from "@ui\/card"/);
    assert.match(output, /\.\/src\/ui\/card\.mjs/);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("resolves @/ imports from the project root without alias configuration", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-root-alias-"));
  const projectRoot = path.join(workspaceRoot, "site");
  try {
    await fs.mkdir(path.join(projectRoot, "app"), { recursive: true });
    await fs.mkdir(path.join(projectRoot, "src", "ui"), { recursive: true });
    const card = path.join(projectRoot, "src", "ui", "card.jsx");
    const entry = path.join(projectRoot, "app", "page.jsx");
    const outside = path.join(workspaceRoot, "outside.jsx");
    await fs.writeFile(card, "export default function FeatureCard() { return <button>root alias</button>; }\n");
    await fs.writeFile(outside, "export default function Outside() { return <span />; }\n");
    await fs.writeFile(
      entry,
      'import FeatureCard from "@/src/ui/card"; export default async function RoutePage() { return <FeatureCard />; }\n',
    );

    assert.equal(
      await fs.realpath(await resolveProjectModuleSpecifier(projectRoot, entry, "@/src/ui/card")),
      await fs.realpath(card),
    );
    assert.equal(
      await resolveProjectModuleSpecifier(projectRoot, entry, "@/../outside"),
      null,
    );
    assert.deepEqual(await collectClientBoundaryModules([entry], { projectRoot }), [card]);

    const serverBuild = await compileModuleGraph(entry, {
      projectRoot,
      mode: "production",
      sourceMaps: false,
      ssr: true,
      target: "server",
    });
    const output = await fs.readFile(serverBuild.entrypoint, "utf8");
    assert.doesNotMatch(output, /import FeatureCard from "@\/src\/ui\/card"/);
    assert.match(output, /\.\.\/src\/ui\/card\.mjs/);
    assert.match(output, /moduleId: "@\/src\/ui\/card"/);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("treats a component package entry as a client boundary without pulling server packages", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-package-boundary-"));
  try {
    const packageRoot = path.join(projectRoot, "node_modules", "@fixture", "card");
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(path.join(projectRoot, "package.json"), '{"type":"module"}\n');
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      '{"name":"@fixture/card","type":"module","exports":{".":{"browser":"./index.js","import":"./server.js"}}}\n',
    );
    const packageEntry = path.join(packageRoot, "index.js");
    await fs.writeFile(
      packageEntry,
      "export default class PackageCard extends HTMLElement {}\n",
    );
    await fs.writeFile(path.join(packageRoot, "server.js"), 'throw new Error("server export selected");\n');
    const serverOnlyPackageRoot = path.join(projectRoot, "node_modules", "@fixture", "server-only");
    await fs.mkdir(serverOnlyPackageRoot, { recursive: true });
    await fs.writeFile(
      path.join(serverOnlyPackageRoot, "package.json"),
      '{"name":"@fixture/server-only","type":"module","exports":"./index.js"}\n',
    );
    await fs.writeFile(
      path.join(serverOnlyPackageRoot, "index.js"),
      'export default function sanitize(value) { return value; }\n',
    );
    const entry = path.join(projectRoot, "entry.jsx");
    await fs.writeFile(
      entry,
      [
        'import PackageCard from "@fixture/card";',
        'import sanitize from "@fixture/server-only";',
        'import { createHash } from "node:crypto";',
        "export default async function RoutePage() {",
        '  createHash("sha1");',
        '  sanitize("server-only");',
        "  return <PackageCard />;",
        "}",
        "",
      ].join("\n"),
    );

    const inventory = await collectClientGraphInventory([entry], { projectRoot });
    assert.equal(inventory.clientBoundaries.length, 1);
    assert.equal(
      await fs.realpath(inventory.clientBoundaries[0]),
      await fs.realpath(packageEntry),
    );
    assert.equal(inventory.sourceFiles.some((filePath) => filePath.includes("node:crypto")), false);
    assert.equal(inventory.sourceFiles.some((filePath) => filePath.includes("server-only")), false);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("resolves inherited TypeScript path aliases", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-inherited-alias-"));
  const projectRoot = path.join(workspaceRoot, "site");
  try {
    await fs.mkdir(path.join(projectRoot, "src", "ui"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "tsconfig.base.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@workspace/*": ["site/src/*"] } } }),
    );
    await fs.writeFile(
      path.join(projectRoot, "tsconfig.json"),
      JSON.stringify({ extends: "../tsconfig.base.json" }),
    );
    const componentPath = path.join(projectRoot, "src", "ui", "card.jsx");
    const importerPath = path.join(projectRoot, "app", "page.jsx");
    await fs.mkdir(path.dirname(importerPath), { recursive: true });
    await fs.writeFile(componentPath, "export function FeatureCard() { return <span />; }\n");
    await fs.writeFile(importerPath, "export default async function RoutePage() { return <main />; }\n");

    assert.equal(
      await fs.realpath(await resolveProjectModuleSpecifier(projectRoot, importerPath, "@workspace/ui/card")),
      await fs.realpath(componentPath),
    );
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("resolves package import maps and browser object mappings", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-package-imports-"));
  try {
    await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(projectRoot, "node_modules", "mapped-package"), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ type: "module", imports: { "#ui/*": "./src/*.jsx" } }),
    );
    const importerPath = path.join(projectRoot, "src", "entry.jsx");
    const mappedPath = path.join(projectRoot, "src", "card.jsx");
    await fs.writeFile(importerPath, "export {};\n");
    await fs.writeFile(mappedPath, "export default function FeatureCard() { return <span />; }\n");
    const packageRoot = path.join(projectRoot, "node_modules", "mapped-package");
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "mapped-package", main: "./server.js", browser: { "./server.js": "./browser.js" } }),
    );
    await fs.writeFile(path.join(packageRoot, "server.js"), "export default 'server';\n");
    await fs.writeFile(path.join(packageRoot, "browser.js"), "export default 'browser';\n");

    assert.equal(
      await fs.realpath(await resolveProjectModuleSpecifier(projectRoot, importerPath, "#ui/card")),
      await fs.realpath(mappedPath),
    );
    await fs.writeFile(
      importerPath,
      'import FeatureCard from "#ui/card"; export default async function RoutePage() { return <FeatureCard />; }\n',
    );
    const inventory = await collectClientGraphInventory([importerPath], { projectRoot });
    assert.deepEqual(inventory.clientBoundaries, [mappedPath]);
    const serverBuild = await compileModuleGraph(importerPath, {
      projectRoot,
      mode: "production",
      sourceMaps: false,
      ssr: true,
      target: "server",
    });
    assert.doesNotMatch(await fs.readFile(serverBuild.entrypoint, "utf8"), /import FeatureCard from "#ui\/card"/);
    assert.equal(
      await fs.realpath(await resolveProjectModuleSpecifier(projectRoot, importerPath, "mapped-package")),
      await fs.realpath(path.join(packageRoot, "browser.js")),
    );
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("compiler invalidates only development graphs affected by changed files", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-compiler-selective-cache-"));
  const firstSourcePath = path.join(projectRoot, "first.js");
  const secondSourcePath = path.join(projectRoot, "second.js");

  try {
    await Promise.all([
      fs.writeFile(firstSourcePath, "export default 'first-v1';\n", "utf8"),
      fs.writeFile(secondSourcePath, "export default 'second-v1';\n", "utf8"),
    ]);
    const options = { projectRoot, mode: "development", sourceMaps: false };
    const [firstBuild, secondBuild] = await Promise.all([
      compileModuleGraph(firstSourcePath, options),
      compileModuleGraph(secondSourcePath, options),
    ]);
    await Promise.all([
      fs.writeFile(firstSourcePath, "export default 'first-v2';\n", "utf8"),
      fs.writeFile(secondSourcePath, "export default 'second-v2';\n", "utf8"),
    ]);

    invalidateDevelopmentCompilationCache(projectRoot, [firstSourcePath]);
    const [firstAfterInvalidation, secondAfterInvalidation] = await Promise.all([
      compileModuleGraph(firstSourcePath, options),
      compileModuleGraph(secondSourcePath, options),
    ]);

    assert.match(await fs.readFile(firstAfterInvalidation.entrypoint, "utf8"), /first-v2/);
    assert.equal(secondAfterInvalidation.entrypoint, secondBuild.entrypoint);
    assert.match(await fs.readFile(secondAfterInvalidation.entrypoint, "utf8"), /second-v1/);
    assert.equal(firstAfterInvalidation.entrypoint, firstBuild.entrypoint);
  } finally {
    invalidateDevelopmentCompilationCache(projectRoot);
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("compiler reuses evaluated development modules until they are invalidated", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-compiler-module-cache-"));
  const sourcePath = path.join(projectRoot, "entry.js");

  try {
    await fs.writeFile(
      sourcePath,
      [
        "globalThis.__evolitModuleEvaluations = (globalThis.__evolitModuleEvaluations ?? 0) + 1;",
        "export const evaluations = globalThis.__evolitModuleEvaluations;",
        "",
      ].join("\n"),
      "utf8",
    );

    const options = { projectRoot, mode: "development", sourceMaps: false };
    const first = await importCompiledModule(sourcePath, options);
    const cached = await importCompiledModule(sourcePath, options);
    assert.equal(first, cached);
    assert.equal(first.evaluations, 1);

    invalidateDevelopmentCompilationCache(projectRoot, [sourcePath]);
    const reloaded = await importCompiledModule(sourcePath, options);
    assert.equal(reloaded.evaluations, 2);
  } finally {
    delete globalThis.__evolitModuleEvaluations;
    invalidateDevelopmentCompilationCache(projectRoot);
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});
