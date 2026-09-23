import path from "node:path";
import { importCompiledModule, resolveProjectModuleSpecifier } from "./compiler.js";

function resolveSetupExport(moduleRecord, setupPath) {
  const setup = moduleRecord.setup ?? moduleRecord.default;
  if (typeof setup !== "function") {
    throw new TypeError(
      `Expected server setup module ${JSON.stringify(setupPath)} to export a setup function or a default function.`,
    );
  }
  return setup;
}

function normalizeCleanup(result) {
  if (result == null) return null;
  if (typeof result === "function") return result;
  if (typeof result === "object" && typeof result.dispose === "function") {
    return () => result.dispose();
  }
  throw new TypeError("Evolit server setup must return nothing, a cleanup function, or an object with dispose().");
}

/** Runs the application server bootstrap once for a build or runtime instance. */
export async function runServerSetup({ projectRoot, mode, evolitConfig = {} }) {
  const serverConfig = evolitConfig.server;
  if (serverConfig == null) return null;
  if (!serverConfig || typeof serverConfig !== "object" || Array.isArray(serverConfig)) {
    throw new TypeError("Expected server in evolit.config.js to be an object.");
  }

  const configuredSetup = serverConfig.setup;
  if (configuredSetup == null) return null;

  let setup = configuredSetup;
  if (typeof configuredSetup === "string") {
    if (configuredSetup.length === 0) {
      throw new TypeError("Expected server.setup to be a non-empty module specifier.");
    }
    const setupPath = await resolveProjectModuleSpecifier(
      projectRoot,
      path.join(projectRoot, "evolit.config.js"),
      configuredSetup,
    );
    if (!setupPath) {
      throw new Error(`Unable to resolve configured server setup ${JSON.stringify(configuredSetup)}.`);
    }
    const moduleRecord = await importCompiledModule(setupPath, {
      projectRoot,
      mode,
      sourceMaps: mode === "development",
      target: "server",
    });
    setup = resolveSetupExport(moduleRecord, configuredSetup);
  }

  if (typeof setup !== "function") {
    throw new TypeError("Expected server.setup in evolit.config.js to be a function or module specifier.");
  }

  return normalizeCleanup(await setup({
    projectRoot,
    mode,
  }));
}
