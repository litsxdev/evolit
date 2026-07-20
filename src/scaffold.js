import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyDirectory, ensureDirectory, pathExists, writeJson } from "./fs-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_ROOT = path.resolve(__dirname, "../templates/default");

async function writeSitePackageJson(targetDirectory, siteName) {
  const packageJsonPath = path.join(targetDirectory, "package.json");
  const packageJson = {
    name: siteName,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      dev: "nextsx dev",
      build: "nextsx build",
      start: "nextsx start",
      typecheck: "litsx-tsc -p jsconfig.json --noEmit",
    },
    dependencies: {
      "@litsx/core": "0.17.0-canary-feat-ssr-20260720145007",
      nextsx: "^0.1.0",
    },
    devDependencies: {
      "@litsx/typescript": "^0.9.0",
      "typescript": "^6.0.0",
    },
  };

  await writeJson(packageJsonPath, packageJson);
}

export async function scaffoldSite(targetDirectory, options = {}) {
  const absoluteTargetDirectory = path.resolve(targetDirectory);
  const siteName = options.name ?? path.basename(absoluteTargetDirectory);

  if (await pathExists(absoluteTargetDirectory)) {
    const entries = await fs.readdir(absoluteTargetDirectory);
    if (entries.length > 0) {
      throw new Error(`Target directory is not empty: ${absoluteTargetDirectory}`);
    }
  } else {
    await ensureDirectory(absoluteTargetDirectory);
  }

  await copyDirectory(TEMPLATE_ROOT, absoluteTargetDirectory);
  await writeSitePackageJson(absoluteTargetDirectory, siteName);
  await fs.writeFile(
    path.join(absoluteTargetDirectory, "nextsx.config.js"),
    `export default {\n  // Reserved for framework configuration.\n  // Client asset and hydration configuration will land here.\n};\n`,
    "utf8",
  );

  return absoluteTargetDirectory;
}
