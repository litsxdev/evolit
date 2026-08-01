#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { scaffoldSite } from "./scaffold.js";
import { createDevelopmentEventReporter } from "./development-events.js";

const reportEvent = createDevelopmentEventReporter();

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
  reportEvent({ type: "usage" });
}

async function createSite(projectRoot, targetDirectory) {
  if (!targetDirectory) {
    throw new Error("Usage: evolit init <directory>");
  }

  const createdDirectory = await scaffoldSite(path.resolve(projectRoot, targetDirectory));
  reportEvent({ type: "site-created", directory: createdDirectory });
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
    reportEvent({
      type: "build-ready",
      manifestPath: path.relative(projectRoot, manifestPath),
    });
    return;
  }

  if (command === "start") {
    const { createStartServer } = await import("./server.js");
    reportEvent({ type: "server-starting", mode: "start" });
    const server = await createStartServer(projectRoot, options);
    await server.listen();
    reportEvent({ type: "server-ready", port: server.port });
    return;
  }

  if (command === "dev") {
    const { createDevServer } = await import("./server.js");
    const server = await createDevServer(projectRoot, {
      ...options,
      onDevelopmentEvent: reportEvent,
    });
    await server.listen();
    return;
  }

  await createSite(projectRoot, command);
}

run().catch((error) => {
  reportEvent({ type: "fatal-error", error });
  process.exitCode = 1;
});
