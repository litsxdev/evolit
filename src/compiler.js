import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { transformLitsx } from "@litsx/compiler";
import MagicString from "magic-string";
import remapping from "@jridgewell/remapping";
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

const MODULE_SPECIFIER_PATTERN =
  /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const RESOLVABLE_IMPORT_EXTENSIONS = [
  ...MODULE_EXTENSIONS,
  ...STATIC_ASSET_EXTENSIONS,
];
const developmentGraphCache = new Map();
const developmentGraphDependencies = new Map();
const developmentModuleNamespaceCache = new Map();
const developmentGraphVersions = new Map();

function isRelativeSpecifier(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function isBareSpecifier(specifier) {
  return (
    typeof specifier === "string" &&
    specifier.length > 0 &&
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("file:") &&
    !specifier.startsWith("node:") &&
    !specifier.startsWith("data:") &&
    !specifier.startsWith("http:") &&
    !specifier.startsWith("https:")
  );
}

function shouldCompileModule(filePath) {
  return MODULE_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}

function isStaticAssetPath(filePath) {
  return STATIC_ASSET_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}

function hasResolvableImportExtension(filePath) {
  return RESOLVABLE_IMPORT_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}

function isStyleAssetPath(filePath) {
  return filePath.endsWith(".css");
}

function createStaticAssetStubSource(relativeAssetPath, mode, target = "server", staticAssetPublicUrls = null) {
  const normalizedAssetPath = relativeAssetPath.split(path.sep).join("/");
  if (normalizedAssetPath.endsWith(".css")) {
    return "export default {};\n";
  }

  if (target === "server" && staticAssetPublicUrls?.has(normalizedAssetPath)) {
    return `export default ${JSON.stringify(staticAssetPublicUrls.get(normalizedAssetPath))};\n`;
  }

  return `export default "__EVOLIT_ASSET_URL__:${normalizedAssetPath}";\n`;
}

async function resolveImportPath(importerPath, specifier) {
  const basePath = path.resolve(path.dirname(importerPath), specifier);
  const candidates = [basePath];

  if (!hasResolvableImportExtension(basePath)) {
    for (const extension of RESOLVABLE_IMPORT_EXTENSIONS) {
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
  mode,
  target,
  staticAssetPublicUrls,
  serverImportQuery,
  sourceMaps,
  outputPath,
  inputSourceMap,
}) {
  const magicSource = new MagicString(code);
  let didRewrite = false;

  for (const match of code.matchAll(MODULE_SPECIFIER_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? null;
    if (!specifier) {
      continue;
    }

    if (target === "client" && isBareSpecifier(specifier)) {
      const sourceMetadata = moduleMetadata.get(sourcePath) ?? {
        moduleImports: new Set(),
        vendorImports: new Set(),
        styleImports: new Set(),
        assetImports: new Set(),
      };
      sourceMetadata.vendorImports.add(specifier);
      moduleMetadata.set(sourcePath, sourceMetadata);
      continue;
    }

    if (!isRelativeSpecifier(specifier)) {
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
      await fs.writeFile(
        stubOutputPath,
        createStaticAssetStubSource(relativeAssetPath, mode, target, staticAssetPublicUrls),
        "utf8",
      );

      if (target === "client") {
        await ensureDirectory(path.dirname(assetOutputPath));
        await fs.copyFile(resolvedImportPath, assetOutputPath);
        const sourceMetadata = moduleMetadata.get(sourcePath) ?? {
          moduleImports: new Set(),
          vendorImports: new Set(),
          styleImports: new Set(),
          assetImports: new Set(),
        };
        if (isStyleAssetPath(resolvedImportPath)) {
          sourceMetadata.styleImports.add(relativeAssetPath.split(path.sep).join("/"));
        } else {
          sourceMetadata.assetImports.add(relativeAssetPath.split(path.sep).join("/"));
        }
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
    if (target === "client" && shouldCompileModule(resolvedImportPath)) {
      const sourceMetadata = moduleMetadata.get(sourcePath) ?? {
        moduleImports: new Set(),
        vendorImports: new Set(),
        styleImports: new Set(),
        assetImports: new Set(),
      };
      sourceMetadata.moduleImports.add(
        path.relative(outputRoot, compiledImportPath).split(path.sep).join("/"),
      );
      moduleMetadata.set(sourcePath, sourceMetadata);
    }
    let normalizedReplacement = replacementPath.startsWith(".")
      ? replacementPath
      : `./${replacementPath}`;
    if (
      target === "server"
      && mode === "development"
      && typeof serverImportQuery === "string"
      && serverImportQuery.length > 0
    ) {
      normalizedReplacement = `${normalizedReplacement}?${serverImportQuery}`;
    }
    const quotedSpecifierIndex = match.index + match[0].indexOf(specifier);
    const replacementValue = normalizedReplacement.split(path.sep).join("/");
    if (replacementValue !== specifier) {
      didRewrite = true;
      magicSource.update(
        quotedSpecifierIndex,
        quotedSpecifierIndex + specifier.length,
        replacementValue,
      );
    }
  }

  const rewrittenCode = magicSource.toString();
  if (!sourceMaps || !didRewrite) {
    return {
      code: rewrittenCode,
      map: sourceMaps ? inputSourceMap ?? null : null,
    };
  }

  const intermediateSourceId = `${sourcePath.split(path.sep).join("/")}#evolit-transform`;
  const rewrittenMap = magicSource.generateMap({
    hires: true,
    includeContent: false,
    source: intermediateSourceId,
    file: outputPath.split(path.sep).join("/"),
  });
  const composedMap = inputSourceMap
    ? remapping(rewrittenMap.toString(), (source) => (
      // MagicString serializes the source relative to `file`, so compare the
      // stable suffix rather than the absolute path we supplied above.
      source.endsWith("#evolit-transform") ? inputSourceMap : null
    ))
    : rewrittenMap;

  return {
    code: rewrittenCode,
    map: composedMap,
  };
}

function getDevelopmentGraphCacheKey(entryPath, options) {
  return [
    options.projectRoot,
    entryPath,
    options.target ?? "server",
    options.ssr === true ? "ssr" : "client",
    options.sourceMaps === false ? "without-maps" : "with-maps",
  ].join("::");
}

export function invalidateDevelopmentCompilationCache(projectRoot, changedPaths = null) {
  const prefix = `${path.resolve(projectRoot)}::`;
  const normalizedChangedPaths = Array.isArray(changedPaths) && changedPaths.length > 0
    ? new Set(changedPaths.map((changedPath) => path.resolve(changedPath)))
    : null;
  let invalidated = false;

  for (const key of developmentGraphCache.keys()) {
    if (!key.startsWith(prefix)) {
      continue;
    }

    const dependencies = developmentGraphDependencies.get(key);
    const shouldInvalidate =
      normalizedChangedPaths == null ||
      !dependencies ||
      [...dependencies].some((dependency) => normalizedChangedPaths.has(dependency));
    if (shouldInvalidate) {
      developmentGraphCache.delete(key);
      developmentGraphDependencies.delete(key);
      developmentModuleNamespaceCache.delete(key);
      developmentGraphVersions.set(key, (developmentGraphVersions.get(key) ?? 0) + 1);
      invalidated = true;
    }
  }

  return invalidated;
}

async function compileModuleGraphUncached(entryPath, options = {}) {
  const {
    projectRoot,
    mode = "development",
    sourceMaps = mode === "development",
    ssr = false,
    target = "server",
    staticAssetPublicUrls = null,
  } = options;

  const outputRoot = getTypedOutputRoot(projectRoot, mode, target);
  const visited = new Map();
  const moduleMetadata = new Map();
  const serverImportQuery = target === "server" && mode === "development"
    ? `t=${Date.now()}`
    : null;

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
    const rewritten = await rewriteRelativeSpecifiers({
      projectRoot,
      outputRoot,
      sourcePath,
      code: transformed.code,
      compileModule,
      moduleMetadata,
      mode,
      target,
      staticAssetPublicUrls,
      serverImportQuery,
      sourceMaps,
      outputPath,
      inputSourceMap: transformed.map ?? null,
    });

    await fs.writeFile(outputPath, rewritten.code, "utf8");
    if (target === "client") {
      const metadata = moduleMetadata.get(sourcePath);
      if (metadata) {
        await fs.writeFile(
          `${outputPath}.meta.json`,
          `${JSON.stringify({
            moduleImports: [...(metadata.moduleImports ?? [])].sort(),
            vendorImports: [...(metadata.vendorImports ?? [])].sort(),
            styleImports: [...(metadata.styleImports ?? [])].sort(),
            assetImports: [...(metadata.assetImports ?? [])].sort(),
          }, null, 2)}\n`,
          "utf8",
        );
      }
    }
    if (rewritten.map && sourceMaps) {
      await fs.writeFile(`${outputPath}.map`, JSON.stringify(rewritten.map), "utf8");
    }

    return outputPath;
  }

  return {
    entrypoint: await compileModule(entryPath),
    outputRoot,
    sourceFiles: [...visited.keys()],
  };
}

export async function compileModuleGraph(entryPath, options = {}) {
  const mode = options.mode ?? "development";
  if (mode !== "development") {
    return compileModuleGraphUncached(entryPath, options);
  }

  const normalizedOptions = {
    ...options,
    projectRoot: path.resolve(options.projectRoot ?? process.cwd()),
  };
  const cacheKey = getDevelopmentGraphCacheKey(
    path.resolve(entryPath),
    normalizedOptions,
  );
  let pendingCompile = developmentGraphCache.get(cacheKey);
  if (!pendingCompile) {
    pendingCompile = compileModuleGraphUncached(entryPath, normalizedOptions);
    developmentGraphCache.set(cacheKey, pendingCompile);
    pendingCompile.then((result) => {
      if (developmentGraphCache.get(cacheKey) === pendingCompile) {
        developmentGraphDependencies.set(cacheKey, new Set(result.sourceFiles));
      }
    }, () => {});
  }

  try {
    return await pendingCompile;
  } catch (error) {
    if (developmentGraphCache.get(cacheKey) === pendingCompile) {
      developmentGraphCache.delete(cacheKey);
      developmentGraphDependencies.delete(cacheKey);
    }
    throw error;
  }
}

export async function importCompiledModule(entryPath, options = {}) {
  const mode = options.mode ?? "development";
  const normalizedOptions = mode === "development"
    ? { ...options, projectRoot: path.resolve(options.projectRoot ?? process.cwd()) }
    : options;
  const cacheKey = mode === "development"
    ? getDevelopmentGraphCacheKey(path.resolve(entryPath), normalizedOptions)
    : null;
  const cachedModule = cacheKey ? developmentModuleNamespaceCache.get(cacheKey) : null;
  if (cachedModule) {
    return cachedModule;
  }

  const { entrypoint } = await compileModuleGraph(entryPath, normalizedOptions);
  const moduleUrl = new URL(pathToFileURL(entrypoint).href);

  if (mode === "development") {
    moduleUrl.searchParams.set("t", String(developmentGraphVersions.get(cacheKey) ?? 0));
  }

  const pendingModule = import(moduleUrl.href);
  if (cacheKey) {
    developmentModuleNamespaceCache.set(cacheKey, pendingModule);
  }

  try {
    return await pendingModule;
  } catch (error) {
    if (developmentModuleNamespaceCache.get(cacheKey) === pendingModule) {
      developmentModuleNamespaceCache.delete(cacheKey);
    }
    throw error;
  }
}
