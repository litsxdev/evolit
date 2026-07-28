import { terminal } from "./terminal.js";

/**
 * Creates the default development-event sink used by the CLI and dev server.
 * Keeping presentation here lets integrations replace it with onDevelopmentEvent
 * without losing any lifecycle, build, or request diagnostics.
 */
export function createDevelopmentEventReporter() {
  return (event) => {
    switch (event.type) {
      case "server-starting":
        console.log(`${terminal.cyan("▲")} ${terminal.bold("Evolit")} ${terminal.cyan(event.mode ?? "dev")}`);
        break;
      case "usage":
        console.log(`${terminal.bold("Usage:")} evolit <directory>`);
        console.log(`       evolit ${terminal.cyan("init")} <directory>`);
        console.log(`       evolit ${terminal.cyan("<dev|build|start>")} [--port 3000]`);
        break;
      case "site-created":
        console.log(`${terminal.green("✓")} Created evolit site: ${terminal.cyan(event.directory)}`);
        break;
      case "build-ready":
        console.log(`${terminal.green("✓")} Built Evolit app: ${terminal.cyan(event.manifestPath)}`);
        break;
      case "initializing":
        console.log(`${terminal.cyan("[evolit]")} ${terminal.yellow("○")} Preparing development runtime…`);
        break;
      case "vendor-runtime-ready":
        console.log(`${terminal.cyan("[evolit]")} ${terminal.green("✓")} Vendor runtime ready.`);
        break;
      case "client-assets-building":
        console.log(`${terminal.cyan("[evolit]")} ${terminal.magenta("○")} Compiling client assets (${event.entryCount} entries)…`);
        break;
      case "client-assets-ready":
        console.log(`${terminal.cyan("[evolit]")} ${terminal.green("✓")} Client assets compiled in ${terminal.dim(`${event.durationMs}ms`)} (${event.entryCount} entries).`);
        break;
      case "client-assets-cache-hit":
        console.log(`${terminal.cyan("[evolit]")} ${terminal.blue("●")} Client assets served from cache.`);
        break;
      case "invalidated":
        console.log(
          `${terminal.cyan("[evolit]")} ${terminal.yellow("△")} Source change detected${event.changedPathCount == null ? "" : ` (${event.changedPathCount} files)`}; invalidated ${event.affectedClientEntryCount} client entries.`,
        );
        break;
      case "unmanaged-import":
        console.warn(
          `${terminal.yellow("[evolit]")} ${terminal.yellow("⚠")} Unmanaged import ${terminal.cyan(JSON.stringify(event.resolvedImportPath))} from ${terminal.cyan(JSON.stringify(event.sourcePath))} is outside the project root. Evolit does not watch it; changes may not trigger a rebuild, and it may be unavailable in another checkout or deployment. It will be emitted under ${terminal.cyan("/_evolit/static/__unmanaged__/")}.`,
        );
        break;
      case "server-ready":
        console.log(`${terminal.green("✓")} Ready on ${terminal.cyan(`http://localhost:${event.port}`)}`);
        break;
      case "request": {
        const statusColor = event.status >= 500
          ? terminal.red
          : event.status >= 400
            ? terminal.yellow
            : event.status >= 300
              ? terminal.blue
              : terminal.green;
        console.log(
          `${terminal.cyan("[evolit]")} ${terminal.dim(event.method)} ${event.pathname} ${statusColor(event.status)} in ${terminal.dim(`${event.durationMs}ms`)}${event.cacheState ? ` ${terminal.blue(`(${event.cacheState})`)}` : ""}`,
        );
        break;
      }
      case "request-error":
        console.error(
          `${terminal.red("[evolit]")} ${terminal.red("✖")} ${event.method} ${event.pathname} failed`,
          event.error,
        );
        break;
      case "fatal-error":
        console.error(
          `${terminal.red("[evolit]")} ${terminal.red("✖")} ${event.error instanceof Error ? event.error.stack ?? event.error.message : String(event.error)}`,
        );
        break;
      case "route-error":
        console.error(
          `${terminal.red("[evolit]")} ${terminal.red("✖")} Route rendering failed ${terminal.dim(`(${event.digest})`)} at ${terminal.cyan(event.pathname)}`,
          event.error,
        );
        break;
      default:
        break;
    }
  };
}
