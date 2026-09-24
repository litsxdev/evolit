import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileModuleGraph } from "../src/compiler.js";
import { createPublicAssetOrigin } from "../src/deployment-runtime.js";
import {
  createLitsxPipeline,
  defineEvolitConfig,
  defineLitsxIntegration,
  mergeLitsxAssetsIntoManifest,
} from "../src/litsx-pipeline.js";

test("composes compiler options in declaration order while preserving Evolit invariants", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-litsx-options-"));
  const firstAuthoring = { name: "first-authoring" };
  const appOutput = { name: "app-output" };
  const secondOutput = { name: "second-output" };
  const pipeline = await createLitsxPipeline({
    projectRoot,
    mode: "development",
    config: defineEvolitConfig({
      litsx: {
        compiler: {
          defaultDomMode: "light",
          outputPlugins: [appOutput],
          reactCompat: true,
          sourceMaps: false,
        },
        integrations: [
          defineLitsxIntegration({
            name: "first",
            create: () => ({
              compiler: { authoringPlugins: [firstAuthoring], defaultDomMode: "shadow" },
            }),
          }),
          defineLitsxIntegration({
            name: "second",
            create: () => ({ compiler: { outputPlugins: [secondOutput], ssr: false } }),
          }),
        ],
      },
    }),
  });

  try {
    const options = pipeline.getCompilerOptions({
      filename: path.join(projectRoot, "app/page.jsx"),
      sourceMaps: true,
      ssr: true,
    });
    assert.equal(options.filename, path.join(projectRoot, "app/page.jsx"));
    assert.equal(options.sourceMaps, false);
    assert.equal(options.ssr, true);
    assert.equal(options.reactCompat, false);
    assert.equal(options.defaultDomMode, "shadow");
    assert.deepEqual(options.authoringPlugins, [firstAuthoring]);
    assert.deepEqual(options.outputPlugins, [appOutput, secondOutput]);
  } finally {
    await pipeline.dispose();
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("processes compiled modules, tracks dependencies, publishes outputs, invalidates, forgets, and cleans up", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-litsx-lifecycle-"));
  const sourcePath = path.join(projectRoot, "component.jsx");
  const dependencyPath = path.join(projectRoot, "tokens.config.js");
  const calls = [];
  let includeOutput = true;
  const pipeline = await createLitsxPipeline({
    projectRoot,
    mode: "development",
    config: {
      litsx: {
        compiler: { defaultDomMode: "shadow" },
        integrations: [{
          name: "fixture",
          create(context) {
            calls.push(["create", context.identity]);
            return {
              processModule({ result, target }) {
                calls.push(["process", target]);
                return {
                  code: `${result.code}\nexport { generated } from "virtual:fixture";\n/* fixture processed */`,
                  dependencies: [dependencyPath],
                };
              },
              resolveModule({ specifier }) {
                if (specifier !== "virtual:fixture") return null;
                return {
                  code: 'export const generated = "fixture";\n',
                  dependencies: [dependencyPath],
                };
              },
              finalize() {
                calls.push(["finalize"]);
                return includeOutput ? {
                  outputs: [
                    {
                      id: "document/theme.css",
                      kind: "style",
                      content: ":root{--brand:tomato}",
                      document: true,
                    },
                    {
                      id: "modules/fixture.mjs",
                      kind: "module",
                      specifier: "virtual:fixture",
                      content: 'export const generated = "finalized";\n',
                    },
                  ],
                } : undefined;
              },
              invalidate({ affected }) {
                calls.push(["invalidate", affected]);
              },
              forget({ moduleId }) {
                calls.push(["forget", moduleId]);
              },
              dispose() {
                calls.push(["dispose"]);
              },
            };
          },
        }],
      },
    },
  });

  try {
    await fs.writeFile(sourcePath, "export function CardView() { return <p>card</p>; }\n");
    const graph = await compileModuleGraph(sourcePath, {
      projectRoot,
      mode: "development",
      sourceMaps: true,
      target: "client",
      litsxPipeline: pipeline,
    });
    assert.ok(graph.sourceFiles.includes(dependencyPath));
    const virtualSource = graph.sourceFiles.find((filePath) => filePath.includes(`${path.sep}virtual${path.sep}`));
    assert.ok(virtualSource, "the virtual module participates in the compiled graph");
    assert.equal(await fs.readFile(virtualSource, "utf8"), 'export const generated = "fixture";\n');
    assert.match(await fs.readFile(graph.entrypoint, "utf8"), /fixture processed/);

    const manifest = await pipeline.finalize({ sourceFiles: graph.sourceFiles });
    assert.equal(manifest.documentStyles.length, 1);
    assert.equal(await fs.readFile(virtualSource, "utf8"), 'export const generated = "finalized";\n');
    assert.equal(await fs.readFile(manifest.documentStyles[0].outputPath, "utf8"), ":root{--brand:tomato}");
    const assetManifest = mergeLitsxAssetsIntoManifest({
      version: 1,
      assets: [],
      byPublicPath: {},
    }, manifest);
    assert.equal(assetManifest.documentStyles.length, 1);
    assert.match(assetManifest.documentStyles[0], /^\/_evolit\/static\/integrations\/fixture\/document\/theme\.[a-f0-9]{8}\.css$/u);
    const assetResponse = await createPublicAssetOrigin({
      projectRoot,
      mode: "development",
      assetManifest,
    }).read(assetManifest.documentStyles[0]);
    assert.equal(assetResponse.headers["content-type"], "text/css; charset=utf-8");
    assert.equal(assetResponse.body.toString(), ":root{--brand:tomato}");
    assert.equal(await pipeline.finalize(), null, "finalize is exact-once per generation");

    assert.equal(await pipeline.invalidate([dependencyPath]), true);
    includeOutput = false;
    const emptyManifest = await pipeline.finalize();
    assert.deepEqual(emptyManifest.assets, []);
    await assert.rejects(fs.access(manifest.documentStyles[0].outputPath), /ENOENT/);

    await pipeline.forget(sourcePath);
    assert.equal(pipeline.dependencies.length, 0);
    assert.deepEqual(calls.filter(([name]) => name === "finalize").length, 2);
    assert.ok(calls.some(([name, affected]) => name === "invalidate" && affected === true));
    assert.ok(calls.some(([name, moduleId]) => name === "forget" && moduleId === sourcePath));
  } finally {
    await pipeline.dispose();
    await pipeline.dispose();
    assert.equal(calls.filter(([name]) => name === "dispose").length, 1);
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("isolates mutable integration state across concurrent pipeline instances", async () => {
  const roots = await Promise.all([
    fs.mkdtemp(path.join(os.tmpdir(), "evolit-litsx-isolation-a-")),
    fs.mkdtemp(path.join(os.tmpdir(), "evolit-litsx-isolation-b-")),
  ]);
  const identities = [];
  const integration = {
    name: "isolated",
    create({ identity }) {
      identities.push(identity);
      let count = 0;
      return {
        processModule() {
          count += 1;
          return { metadata: { isolatedCount: count } };
        },
      };
    },
  };
  const [first, second] = await Promise.all(roots.map((projectRoot) => createLitsxPipeline({
    projectRoot,
    mode: "production",
    config: { litsx: { integrations: [integration] } },
  })));

  try {
    const base = { code: "export {};", map: null, metadata: {} };
    const context = (projectRoot) => ({
      source: "export {};",
      sourcePath: path.join(projectRoot, "entry.jsx"),
      sourceMaps: false,
      ssr: true,
      target: "server",
    });
    assert.equal((await first.processModule(base, context(roots[0]))).metadata.isolatedCount, 1);
    assert.equal((await second.processModule(base, context(roots[1]))).metadata.isolatedCount, 1);
    assert.notEqual(identities[0], identities[1]);
    assert.notEqual(first.identity.id, second.identity.id);
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
    await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
  }
});

test("rejects unsafe outputs, collisions, duplicate descriptors, and preserves hook causes", async () => {
  for (const name of [".", "..", "unsafe/name", "unsafe name"]) {
    await assert.rejects(
      createLitsxPipeline({
        projectRoot: "/tmp/evolit-unsafe-name",
        mode: "production",
        config: { litsx: { integrations: [{ name, create: () => ({}) }] } },
      }),
      /must be a safe identifier/,
    );
  }
  await assert.rejects(
    createLitsxPipeline({
      projectRoot: "/tmp/evolit-duplicate",
      mode: "production",
      config: { litsx: { integrations: [
        { name: "same", create: () => ({}) },
        { name: "same", create: () => ({}) },
      ] } },
    }),
    /Duplicate LitSX integration name/,
  );

  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-litsx-invalid-"));
  const original = new Error("processor exploded");
  const failing = await createLitsxPipeline({
    projectRoot,
    mode: "production",
    config: { litsx: { integrations: [{
      name: "failing",
      create: () => ({ processModule: () => { throw original; } }),
    }] } },
  });
  try {
    await assert.rejects(
      failing.processModule(
        { code: "", map: null, metadata: {} },
        { source: "", sourcePath: path.join(projectRoot, "entry.jsx"), sourceMaps: false, ssr: true, target: "server" },
      ),
      (error) => error.cause === original && /integration="failing"/.test(error.message),
    );
  } finally {
    await failing.dispose();
  }

  for (const id of ["../escape.css", "/absolute.css", "https://example.com/a.css"]) {
    const pipeline = await createLitsxPipeline({
      projectRoot,
      mode: "production",
      config: { litsx: { integrations: [{
        name: "unsafe",
        create: () => ({ finalize: () => ({ outputs: [{ id, kind: "style", content: "x{}" }] }) }),
      }] } },
    });
    await assert.rejects(pipeline.finalize(), /Unsafe LitSX integration output id/);
    await pipeline.dispose();
  }
  const collision = await createLitsxPipeline({
    projectRoot,
    mode: "production",
    config: { litsx: { integrations: ["first", "second"].map((name) => ({
      name,
      create: () => ({
        finalize: () => ({ outputs: [{ id: "shared.css", kind: "style", content: `${name}{}` }] }),
      }),
    })) } },
  });
  await assert.rejects(collision.finalize(), /output collision/);
  await collision.dispose();
  const kindCollision = await createLitsxPipeline({
    projectRoot,
    mode: "production",
    config: { litsx: { integrations: [{
      name: "kind-collision",
      create: () => ({
        finalize: () => ({ outputs: [
          { id: "same.out", kind: "asset", content: "asset" },
          { id: "same.out", kind: "module", content: "module" },
        ] }),
      }),
    }] } },
  });
  await assert.rejects(kindCollision.finalize(), /output collision/);
  await kindCollision.dispose();
  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("opens incremental generations, replaces graph dependencies, and forgets changed modules", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-litsx-generations-"));
  const firstSource = path.join(projectRoot, "first.jsx");
  const secondSource = path.join(projectRoot, "second.jsx");
  const firstConfig = path.join(projectRoot, "first.config.js");
  const secondConfig = path.join(projectRoot, "second.config.js");
  let dependency = firstConfig;
  let seen = 0;
  let finalizeCalls = 0;
  const forgotten = [];
  const pipeline = await createLitsxPipeline({
    projectRoot,
    mode: "development",
    config: { litsx: { integrations: [{
      name: "epochs",
      create: () => ({
        processModule() { seen += 1; },
        finalize() {
          finalizeCalls += 1;
          return {
            dependencies: [dependency],
            outputs: [{ id: "epoch.txt", kind: "asset", content: String(seen) }],
          };
        },
        forget({ moduleId }) { forgotten.push(moduleId); },
      }),
    }] } },
  });
  const context = (sourcePath) => ({
    source: "", sourcePath, sourceMaps: true, ssr: false, target: "client",
  });
  try {
    await pipeline.processModule({ code: "", map: null, metadata: {} }, context(firstSource));
    const first = await pipeline.finalize();
    assert.equal(await fs.readFile(first.assets[0].outputPath, "utf8"), "1");
    assert.deepEqual(pipeline.dependencies, [firstConfig]);

    dependency = secondConfig;
    await pipeline.processModule({ code: "", map: null, metadata: {} }, context(secondSource));
    const second = await pipeline.finalize();
    assert.equal(await fs.readFile(second.assets[0].outputPath, "utf8"), "2");
    assert.deepEqual(pipeline.dependencies, [secondConfig]);
    assert.equal(finalizeCalls, 2);

    await pipeline.invalidate([firstSource]);
    assert.ok(forgotten.includes(firstSource));
  } finally {
    await pipeline.dispose();
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("keeps the previous generation when preparing a later integration fails", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-litsx-atomic-"));
  let broken = false;
  const pipeline = await createLitsxPipeline({
    projectRoot,
    mode: "production",
    config: { litsx: { integrations: [
      {
        name: "first",
        create: () => ({ finalize: () => ({ outputs: [{ id: "value.txt", kind: "asset", content: broken ? "new" : "old" }] }) }),
      },
      {
        name: "second",
        create: () => ({ finalize: () => ({ outputs: broken ? [
          { id: "conflict", kind: "asset", content: "file" },
          { id: "conflict/nested.txt", kind: "asset", content: "nested" },
        ] : [{ id: "stable.txt", kind: "asset", content: "stable" }] }) }),
      },
    ] } },
  });
  try {
    const first = await pipeline.finalize();
    const firstOutput = first.assets.find((asset) => asset.integration === "first").outputPath;
    assert.equal(await fs.readFile(firstOutput, "utf8"), "old");
    broken = true;
    await pipeline.invalidate();
    await assert.rejects(pipeline.finalize(), /phase="publish"/);
    assert.equal(await fs.readFile(firstOutput, "utf8"), "old");
  } finally {
    await pipeline.dispose();
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("disposes partially initialized integrations in reverse order", async () => {
  const calls = [];
  const original = new Error("cannot initialize");
  await assert.rejects(
    createLitsxPipeline({
      projectRoot: "/tmp/evolit-partial-init",
      mode: "development",
      config: { litsx: { integrations: [
        { name: "first", create: () => ({ dispose: () => calls.push("first") }) },
        { name: "second", create: () => ({ dispose: () => calls.push("second") }) },
        { name: "third", create: () => { throw original; } },
      ] } },
    }),
    (error) => error.cause === original,
  );
  assert.deepEqual(calls, ["second", "first"]);
});
