import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { transformLitsx } from "@litsx/compiler";
import {
  BUILD_DIRECTORY,
  CLIENT_DIRECTORY,
  DEV_DIRECTORY,
  INTERNAL_DIRECTORY,
  MODULE_EXTENSIONS,
  SERVER_DIRECTORY,
  STATIC_ASSET_EXTENSIONS,
} from "./constants.js";
import { ensureDirectory } from "./fs-utils.js";

const RELATIVE_IMPORT_PATTERN =
  /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function isRelativeSpecifier(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function shouldCompileModule(filePath) {
  return MODULE_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}

function isStaticAssetPath(filePath) {
  return STATIC_ASSET_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}

async function resolveImportPath(importerPath, specifier) {
  const basePath = path.resolve(path.dirname(importerPath), specifier);
  const candidates = [basePath];

  if (!path.extname(basePath)) {
    for (const extension of [...MODULE_EXTENSIONS, ...STATIC_ASSET_EXTENSIONS]) {
      candidates.push(`${basePath}${extension}`);
      candidates.push(path.join(basePath, `index${extension}`));
    }
  }

  for (const candidate of candidates) {
    try {
      const stats = await fs.stat(candidate);
      if (stats.isFile()) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function getOutputRoot(projectRoot, mode) {
  return getTypedOutputRoot(projectRoot, mode, "server");
}

function getTypedOutputRoot(projectRoot, mode, target = "server") {
  return path.join(
    projectRoot,
    INTERNAL_DIRECTORY,
    mode === "development" ? DEV_DIRECTORY : BUILD_DIRECTORY,
    target === "client" ? CLIENT_DIRECTORY : SERVER_DIRECTORY,
  );
}

function toOutputPath(projectRoot, outputRoot, sourcePath) {
  const relativePath = path.relative(projectRoot, sourcePath);
  const extension = path.extname(relativePath);
  if (!extension) {
    return path.join(outputRoot, `${relativePath}.mjs`);
  }

  return path.join(
    outputRoot,
    `${relativePath.slice(0, -extension.length)}.mjs`,
  );
}

async function rewriteRelativeSpecifiers({
  projectRoot,
  outputRoot,
  sourcePath,
  code,
  compileModule,
  moduleMetadata,
  target,
}) {
  let rewrittenCode = "";
  let previousIndex = 0;

  for (const match of code.matchAll(RELATIVE_IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? null;
    if (!specifier || !isRelativeSpecifier(specifier)) {
      continue;
    }

    const resolvedImportPath = await resolveImportPath(sourcePath, specifier);
    if (!resolvedImportPath) {
      continue;
    }

    const importerOutputPath = toOutputPath(projectRoot, outputRoot, sourcePath);
    let compiledImportPath = null;

    if (shouldCompileModule(resolvedImportPath)) {
      compiledImportPath = await compileModule(resolvedImportPath);
    } else if (isStaticAssetPath(resolvedImportPath)) {
      const relativeAssetPath = path.relative(projectRoot, resolvedImportPath);
      const assetOutputPath = path.join(outputRoot, relativeAssetPath);
      const stubOutputPath = `${assetOutputPath}.mjs`;

      await ensureDirectory(path.dirname(stubOutputPath));
      await fs.writeFile(stubOutputPath, "export default {};\n", "utf8");

      if (target === "client") {
        await ensureDirectory(path.dirname(assetOutputPath));
        await fs.copyFile(resolvedImportPath, assetOutputPath);
        const sourceMetadata = moduleMetadata.get(sourcePath) ?? {
          styleImports: new Set(),
        };
        sourceMetadata.styleImports.add(relativeAssetPath.split(path.sep).join("/"));
        moduleMetadata.set(sourcePath, sourceMetadata);
      }

      compiledImportPath = stubOutputPath;
    } else {
      continue;
    }

    const replacementPath = path.relative(
      path.dirname(importerOutputPath),
      compiledImportPath,
    );
    const normalizedReplacement = replacementPath.startsWith(".")
      ? replacementPath
      : `./${replacementPath}`;
    const quotedSpecifierIndex = match.index + match[0].indexOf(specifier);

    rewrittenCode += code.slice(previousIndex, quotedSpecifierIndex);
    rewrittenCode += normalizedReplacement.split(path.sep).join("/");
    previousIndex = quotedSpecifierIndex + specifier.length;
  }

  rewrittenCode += code.slice(previousIndex);
  return rewrittenCode;
}

export async function compileModuleGraph(entryPath, options = {}) {
  const {
    projectRoot,
    mode = "development",
    sourceMaps = mode === "development",
    ssr = false,
    target = "server",
  } = options;

  const outputRoot = getTypedOutputRoot(projectRoot, mode, target);
  const visited = new Map();
  const moduleMetadata = new Map();

  async function compileModule(sourcePath) {
    if (visited.has(sourcePath)) {
      return visited.get(sourcePath);
    }

    const outputPath = toOutputPath(projectRoot, outputRoot, sourcePath);
    visited.set(sourcePath, outputPath);

    await ensureDirectory(path.dirname(outputPath));
    const source = await fs.readFile(sourcePath, "utf8");
    const transformed = await transformLitsx(source, {
      filename: sourcePath,
      sourceMaps,
      ssr,
    });
    const rewrittenCode = await rewriteRelativeSpecifiers({
      projectRoot,
      outputRoot,
      sourcePath,
      code: transformed.code,
      compileModule,
      moduleMetadata,
      target,
    });

    await fs.writeFile(outputPath, rewrittenCode, "utf8");
    if (target === "client") {
      const metadata = moduleMetadata.get(sourcePath);
      if (metadata) {
        await fs.writeFile(
          `${outputPath}.meta.json`,
          `${JSON.stringify({
            styleImports: [...metadata.styleImports].sort(),
          }, null, 2)}\n`,
          "utf8",
        );
      }
    }
    if (transformed.map && sourceMaps) {
      await fs.writeFile(`${outputPath}.map`, JSON.stringify(transformed.map), "utf8");
    }

    return outputPath;
  }

  return {
    entrypoint: await compileModule(entryPath),
    outputRoot,
  };
}

export async function importCompiledModule(entryPath, options = {}) {
  const { entrypoint } = await compileModuleGraph(entryPath, options);
  const moduleUrl = new URL(pathToFileURL(entrypoint).href);

  if (options.mode === "development") {
    moduleUrl.searchParams.set("t", String(Date.now()));
  }

  return import(moduleUrl.href);
}
