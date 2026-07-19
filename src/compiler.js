import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { transformLitsx } from "@litsx/compiler";
import {
  BUILD_DIRECTORY,
  DEV_DIRECTORY,
  INTERNAL_DIRECTORY,
  MODULE_EXTENSIONS,
  SERVER_DIRECTORY,
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

async function resolveImportPath(importerPath, specifier) {
  const basePath = path.resolve(path.dirname(importerPath), specifier);
  const candidates = [basePath];

  if (!path.extname(basePath)) {
    for (const extension of MODULE_EXTENSIONS) {
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
  return path.join(
    projectRoot,
    INTERNAL_DIRECTORY,
    mode === "development" ? DEV_DIRECTORY : BUILD_DIRECTORY,
    SERVER_DIRECTORY,
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
}) {
  let rewrittenCode = "";
  let previousIndex = 0;

  for (const match of code.matchAll(RELATIVE_IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? null;
    if (!specifier || !isRelativeSpecifier(specifier)) {
      continue;
    }

    const resolvedImportPath = await resolveImportPath(sourcePath, specifier);
    if (!resolvedImportPath || !shouldCompileModule(resolvedImportPath)) {
      continue;
    }

    const compiledImportPath = await compileModule(resolvedImportPath);
    const importerOutputPath = toOutputPath(projectRoot, outputRoot, sourcePath);
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
  } = options;

  const outputRoot = getOutputRoot(projectRoot, mode);
  const visited = new Map();

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
    });
    const rewrittenCode = await rewriteRelativeSpecifiers({
      projectRoot,
      outputRoot,
      sourcePath,
      code: transformed.code,
      compileModule,
    });

    await fs.writeFile(outputPath, rewrittenCode, "utf8");
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
