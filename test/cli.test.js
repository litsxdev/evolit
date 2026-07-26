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
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexel-cli-"));
  const targetDirectory = path.join(workspace, "my-site");

  const { stdout } = await execFileAsync(process.execPath, [cliPath, "my-site"], {
    cwd: workspace,
  });

  assert.match(stdout, /Created nexel site:/);
  const packageJson = JSON.parse(await fs.readFile(path.join(targetDirectory, "package.json"), "utf8"));
  assert.equal(packageJson.name, "my-site");
  assert.equal(packageJson.dependencies.nexel, frameworkPackageJson.version);
  await fs.access(path.join(targetDirectory, "app", "page.litsx"));
});

test("CLI keeps init as an explicit scaffolding alias", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexel-cli-"));
  const targetDirectory = path.join(workspace, "explicit-site");

  await execFileAsync(process.execPath, [cliPath, "init", "explicit-site"], {
    cwd: workspace,
  });

  await fs.access(path.join(targetDirectory, "app", "page.litsx"));
});

test("CLI shows usage without a command", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath], {
    cwd: frameworkRoot,
  });

  assert.match(stdout, /Usage: nexel <directory>/);
});
