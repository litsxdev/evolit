import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  compileModuleGraph,
  importCompiledModule,
  invalidateDevelopmentCompilationCache,
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
