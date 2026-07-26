#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { buildProject } from "./build.js";
import { scaffoldSite } from "./scaffold.js";
import { createDevServer, createStartServer } from "./server.js";

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
  console.log("Usage: nexel <directory>");
  console.log("       nexel init <directory>");
  console.log("       nexel <dev|build|start> [--port 3000]");
}

async function createSite(projectRoot, targetDirectory) {
  if (!targetDirectory) {
    throw new Error("Usage: nexel init <directory>");
  }

  const createdDirectory = await scaffoldSite(path.resolve(projectRoot, targetDirectory));
  console.log(`Created nexel site: ${createdDirectory}`);
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
    const manifestPath = await buildProject(projectRoot);
    console.log(`Built nexel app: ${path.relative(projectRoot, manifestPath)}`);
    return;
  }

  if (command === "start") {
    const server = await createStartServer(projectRoot, options);
    await server.listen();
    console.log(`nexel start listening on http://localhost:${server.port}`);
    return;
  }

  if (command === "dev") {
    const server = await createDevServer(projectRoot, options);
    await server.listen();
    console.log(`nexel dev listening on http://localhost:${server.port}`);
    return;
  }

  await createSite(projectRoot, command);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
