import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runServerSetup } from "../src/server-setup.js";

test("runs an inline server setup and disposes its returned resource", async () => {
  const calls = [];
  const cleanup = await runServerSetup({
    projectRoot: "/tmp/evolit-inline-setup",
    mode: "development",
    evolitConfig: {
      server: {
        setup(context) {
          calls.push(["setup", context]);
          return () => calls.push(["cleanup"]);
        },
      },
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "setup");
  assert.equal(calls[0][1].mode, "development");
  await cleanup();
  assert.deepEqual(calls[1], ["cleanup"]);
});

test("compiles and runs a configured TypeScript server setup module", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-server-setup-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ type: "module" }));
  await fs.writeFile(
    path.join(projectRoot, "setup.server.ts"),
    [
      "export function setup(context: { mode: string }) {",
      "  globalThis.__evolitServerSetupMode = context.mode;",
      "  return { dispose() { delete globalThis.__evolitServerSetupMode; } };",
      "}",
    ].join("\n"),
  );

  const cleanup = await runServerSetup({
    projectRoot,
    mode: "production",
    evolitConfig: { server: { setup: "./setup.server.ts" } },
  });

  assert.equal(globalThis.__evolitServerSetupMode, "production");
  await cleanup();
  assert.equal(globalThis.__evolitServerSetupMode, undefined);
});

test("rejects an invalid server setup export", async () => {
  await assert.rejects(
    runServerSetup({
      projectRoot: "/tmp/evolit-invalid-setup",
      mode: "development",
      evolitConfig: { server: { setup: true } },
    }),
    /function or module specifier/,
  );
});
