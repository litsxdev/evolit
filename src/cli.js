#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { scaffoldSite } from "./scaffold.js";

function parseArguments(argv) {
  const [command, ...rest] = argv;
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

function printUsage() {
  console.log("Usage: evolit <directory>");
  console.log("       evolit init <directory>");
  console.log("       evolit <dev|build|start> [--port 3000]");
}

async function createSite(projectRoot, targetDirectory) {
  if (!targetDirectory) {
    throw new Error("Usage: evolit init <directory>");
  }

  const createdDirectory = await scaffoldSite(path.resolve(projectRoot, targetDirectory));
  console.log(`Created evolit site: ${createdDirectory}`);
}

async function run() {
  const { command, options, positionals } = parseArguments(process.argv.slice(2));
  const projectRoot = process.cwd();

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command === "init") {
    await createSite(projectRoot, positionals[0]);
    return;
  }

  if (command === "build") {
    const { buildProject } = await import("./build.js");
    const manifestPath = await buildProject(projectRoot);
    console.log(`Built evolit app: ${path.relative(projectRoot, manifestPath)}`);
    return;
  }

  if (command === "start") {
    const { createStartServer } = await import("./server.js");
    const server = await createStartServer(projectRoot, options);
    await server.listen();
    console.log(`evolit start listening on http://localhost:${server.port}`);
    return;
  }

  if (command === "dev") {
    const { createDevServer } = await import("./server.js");
    const server = await createDevServer(projectRoot, options);
    await server.listen();
    console.log(`evolit dev listening on http://localhost:${server.port}`);
    return;
  }

  await createSite(projectRoot, command);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
