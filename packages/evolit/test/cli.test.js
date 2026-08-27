import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import frameworkPackageJson from "../package.json" with { type: "json" };

const execFileAsync = promisify(execFile);
const frameworkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(frameworkRoot, "src", "cli.js");

test("CLI scaffolds a site from a directory argument", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-cli-"));
  const targetDirectory = path.join(workspace, "my-site");

  const { stdout } = await execFileAsync(process.execPath, [cliPath, "my-site"], {
    cwd: workspace,
  });

  assert.match(stdout, /Created evolit site:/);
  const packageJson = JSON.parse(await fs.readFile(path.join(targetDirectory, "package.json"), "utf8"));
  const jsconfig = JSON.parse(await fs.readFile(path.join(targetDirectory, "jsconfig.json"), "utf8"));
  assert.equal(packageJson.name, "my-site");
  assert.equal(packageJson.dependencies.evolit, frameworkPackageJson.version);
  assert.equal(packageJson.dependencies["@litsx/core"], frameworkPackageJson.dependencies["@litsx/core"]);
  assert.equal(packageJson.engines.node, frameworkPackageJson.engines.node);
  assert.equal(jsconfig.compilerOptions.jsx, "react-jsx");
  assert.equal(jsconfig.compilerOptions.jsxImportSource, "@litsx/core");
  assert.deepEqual(jsconfig.compilerOptions.paths, { "@/*": ["./*"] });
  await fs.access(path.join(targetDirectory, "app", "page.jsx"));
  assert.match(
    await fs.readFile(path.join(targetDirectory, "app", "page.jsx"), "utf8"),
    /from "@\/app\/components\/feature-card"/,
  );
  assert.equal(
    await fs.readFile(path.join(targetDirectory, ".yarnrc.yml"), "utf8"),
    "nodeLinker: node-modules\n",
  );
});

test("CLI keeps init as an explicit scaffolding alias", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-cli-"));
  const targetDirectory = path.join(workspace, "explicit-site");

  await execFileAsync(process.execPath, [cliPath, "init", "explicit-site"], {
    cwd: workspace,
  });

  await fs.access(path.join(targetDirectory, "app", "page.jsx"));
});

test("CLI shows usage without a command", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath], {
    cwd: frameworkRoot,
  });

  assert.match(stdout, /Usage: evolit <directory>/);
});
