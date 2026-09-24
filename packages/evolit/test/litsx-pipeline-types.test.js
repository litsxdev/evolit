import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => resolve({ code, output }));
  });
}

test("public LitSX helpers infer compiler and lifecycle contracts", async () => {
  const fixturePath = path.join(packageRoot, `.litsx-pipeline-types-${process.pid}.ts`);
  await fs.writeFile(fixturePath, [
    'import { defineEvolitConfig, defineLitsxIntegration } from "evolit/litsx";',
    'import type { EvolitLitsxIntegration } from "evolit/litsx";',
    'const integration: EvolitLitsxIntegration = defineLitsxIntegration({',
    '  name: "typed",',
    '  create(context) {',
    '    context.projectRoot satisfies string;',
    '    return {',
    '      compiler: { defaultDomMode: "shadow", reactCompat: false },',
    '      processModule({ result, target }) {',
    '        target satisfies "server" | "client";',
    '        return { code: result.code, dependencies: ["uno.config.ts"] };',
    '      },',
    '      resolveModule({ specifier }) {',
    '        return specifier === "virtual:typed" ? { code: "export {};", dependencies: ["uno.config.ts"] } : null;',
    '      },',
    '      finalize() {',
    '        return { outputs: [{ id: "theme.css", kind: "style", content: ":root{}", document: true }] };',
    '      },',
    '    };',
    '  },',
    '});',
    'defineEvolitConfig({ litsx: { compiler: { sourceMaps: true }, integrations: [integration] } });',
    '// @ts-expect-error Evolit owns the SSR target.',
    'defineEvolitConfig({ litsx: { compiler: { ssr: false } } });',
    '// @ts-expect-error Evolit supplies the source filename.',
    'defineEvolitConfig({ litsx: { compiler: { filename: "other.jsx" } } });',
    '// @ts-expect-error Evolit only supports native LitSX lowering.',
    'defineEvolitConfig({ litsx: { compiler: { reactCompat: true } } });',
    '',
  ].join("\n"));
  try {
    const result = await run(process.execPath, [
      path.resolve(packageRoot, "../../node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--module", "NodeNext",
      "--moduleResolution", "NodeNext",
      "--target", "ES2022",
      fixturePath,
    ]);
    assert.equal(result.code, 0, result.output);
  } finally {
    await fs.rm(fixturePath, { force: true });
  }
});
