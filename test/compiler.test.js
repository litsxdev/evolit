import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compileModuleGraph } from "../src/compiler.js";

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
