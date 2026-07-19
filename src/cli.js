#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { buildProject } from "./build.js";
import { scaffoldSite } from "./scaffold.js";
import { createDevServer, createStartServer } from "./server.js";

function parseArguments(argv) {
  const [command = "dev", ...rest] = argv;
  const options = {};
  const positionals = [];

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--port" || value === "-p") {
      options.port = Number.parseInt(rest[index + 1] ?? "3000", 10);
      index += 1;
      continue;
    }

    positionals.push(value);
  }

  return { command, options, positionals };
}

async function run() {
  const { command, options, positionals } = parseArguments(process.argv.slice(2));
  const projectRoot = process.cwd();

  if (command === "init") {
    const targetDirectory = positionals[0];
    if (!targetDirectory) {
      throw new Error("Usage: nextsx init <directory>");
    }

    const createdDirectory = await scaffoldSite(path.resolve(projectRoot, targetDirectory));
    console.log(`Created nextsx site: ${createdDirectory}`);
    return;
  }

  if (command === "build") {
    const manifestPath = await buildProject(projectRoot);
    console.log(`Built nextsx app: ${path.relative(projectRoot, manifestPath)}`);
    return;
  }

  if (command === "start") {
    const server = await createStartServer(projectRoot, options);
    await server.listen();
    console.log(`nextsx start listening on http://localhost:${server.port}`);
    return;
  }

  if (command === "dev") {
    const server = await createDevServer(projectRoot, options);
    await server.listen();
    console.log(`nextsx dev listening on http://localhost:${server.port}`);
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error("Usage: nextsx <init|dev|build|start> [--port 3000]");
  process.exitCode = 1;
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
