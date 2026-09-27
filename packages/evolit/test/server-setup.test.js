import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runServerSetup } from "../src/server-setup.js";
import { getSsrUrqlAdapter } from "../src/urql-ssr.js";

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

test("server setup and SSR lifecycle resolve one project-owned server-conditioned URQL instance", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-server-urql-identity-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const packageRoot = path.join(projectRoot, "node_modules", "@litsx", "urql");
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ type: "module" }));
  await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "@litsx/urql",
    type: "module",
    exports: {
      ".": {
        browser: "./browser.js",
        import: "./server.js",
        default: "./server.js",
      },
    },
  }));
  await fs.writeFile(path.join(packageRoot, "browser.js"), [
    'export const fixtureInstance = "browser-stub";',
    'export function configureUrqlSsr() { throw new Error("browser stub selected"); }',
    "",
  ].join("\n"));
  await fs.writeFile(path.join(packageRoot, "server.js"), [
    'export const fixtureInstance = "project-server";',
    "let configured = false;",
    "export function configureUrqlSsr() {",
    "  configured = true;",
    "  return () => { configured = false; };",
    "}",
    "export async function runWithUrqlScope(_context, callback) {",
    '  if (!configured) throw new Error("server URQL instance was not configured");',
    "  return callback();",
    "}",
    "export async function getUrqlSsrData() { return { configured }; }",
    "",
  ].join("\n"));
  await fs.writeFile(path.join(projectRoot, "setup.js"), [
    'import { configureUrqlSsr } from "@litsx/urql";',
    "export function setup() { return configureUrqlSsr(); }",
    "",
  ].join("\n"));

  const cleanup = await runServerSetup({
    projectRoot,
    mode: "development",
    evolitConfig: { server: { setup: "./setup.js" } },
  });
  const adapter = await getSsrUrqlAdapter(projectRoot);

  assert.equal(adapter.fixtureInstance, "project-server");
  assert.deepEqual(
    await adapter.runWithUrqlScope(
      { request: new Request("http://evolit.test"), responseHeaders: new Headers() },
      () => adapter.getUrqlSsrData(),
    ),
    { configured: true },
  );
  await cleanup();
  await assert.rejects(
    adapter.runWithUrqlScope(
      { request: new Request("http://evolit.test"), responseHeaders: new Headers() },
      () => undefined,
    ),
    /not configured/,
  );
});
