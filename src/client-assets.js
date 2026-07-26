import fs from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import MagicString from "magic-string";
import { rollup } from "rollup";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import {
  BUILD_DIRECTORY,
  CLIENT_DIRECTORY,
  CLIENT_ASSET_MANIFEST_VERSION,
  DEV_DIRECTORY,
  INTERNAL_DIRECTORY,
  MODULE_EXTENSIONS,
  SERVER_DIRECTORY,
  SHARED_DIRECTORY,
  STATIC_ASSET_EXTENSIONS,
  STATIC_DIRECTORY,
} from "./constants.js";
import { ensureDirectory, walkFiles, writeJson } from "./fs-utils.js";

const MODULE_SPECIFIER_PATTERN =
  /\b(?:import|export)\s*[^"']*?from\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

const requireFromHere = createRequire(import.meta.url);
const SHARED_VENDOR_SPECIFIERS = [
  "@litsx/core",
  "@litsx/core/elements",
  "@litsx/ssr/hydration",
  "lit",
];
const browserSpecifierFilePathCache = new Map();
const packageRootCache = new Map();
const sharedRuntimeBuildCache = new Map();
const clientVendorSpecifierCache = new Map();
const clientModuleMetadataCache = new Map();

function isBareSpecifier(specifier) {
  return (
    typeof specifier === "string" &&
    specifier.length > 0 &&
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("file:")
    && !specifier.startsWith("node:")
    && !specifier.startsWith("data:")
    && !specifier.startsWith("http:")
    && !specifier.startsWith("https:")
  );
}

function isRelativeSpecifier(specifier) {
  return (
    typeof specifier === "string" &&
    (specifier.startsWith("./") || specifier.startsWith("../"))
  );
}

function parsePackageSpecifier(specifier) {
  if (!isBareSpecifier(specifier)) {
    return null;
  }

  const segments = specifier.split("/");
  if (specifier.startsWith("@")) {
    if (segments.length < 2) {
      return null;
    }

    return {
      packageName: `${segments[0]}/${segments[1]}`,
      subpath: segments.slice(2).join("/"),
    };
  }

  return {
    packageName: segments[0],
    subpath: segments.slice(1).join("/"),
  };
}

export async function resolvePackageRoot(packageName) {
  if (packageRootCache.has(packageName)) {
    return packageRootCache.get(packageName);
  }

  const pendingResolution = (async () => {
    const packageEntryPath = requireFromHere.resolve(packageName);
    let currentPath = path.dirname(packageEntryPath);

    while (true) {
      const packageJsonPath = path.join(currentPath, "package.json");

      try {
        const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
        if (packageJson?.name === packageName) {
          return { packageRoot: currentPath, packageJson };
        }
      } catch {
        // Keep walking up until we find the owning package root.
      }

      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        break;
      }

      currentPath = parentPath;
    }

    throw new Error(`Unable to resolve package root for ${packageName}`);
  })();

  packageRootCache.set(packageName, pendingResolution);

  try {
    return await pendingResolution;
  } catch (error) {
    packageRootCache.delete(packageName);
    throw error;
  }
}

function pickBrowserExportTarget(target) {
  if (typeof target === "string") {
    return target;
  }

  if (!target || typeof target !== "object") {
    return null;
  }

  return pickBrowserExportTarget(target.browser)
    ?? pickBrowserExportTarget(target.import)
    ?? pickBrowserExportTarget(target.default)
    ?? pickBrowserExportTarget(target.module)
    ?? pickBrowserExportTarget(target.require)
    ?? null;
}

export async function resolveBrowserSpecifierFilePath(specifier) {
  if (!isBareSpecifier(specifier)) {
    return null;
  }

  if (browserSpecifierFilePathCache.has(specifier)) {
    return browserSpecifierFilePathCache.get(specifier);
  }

  const pendingResolution = (async () => {
    const parsedSpecifier = parsePackageSpecifier(specifier);
    if (!parsedSpecifier) {
      throw new Error(`Unsupported specifier: ${specifier}`);
    }

    const { packageName, subpath } = parsedSpecifier;
    const { packageRoot, packageJson } = await resolvePackageRoot(packageName);
    const exportKey = subpath.length > 0 ? `./${subpath}` : ".";
    const exportTarget = pickBrowserExportTarget(packageJson.exports?.[exportKey]);
    const fallbackTarget = subpath.length > 0
      ? `./${subpath}`
      : packageJson.module ?? packageJson.main ?? null;
    const resolvedTarget = exportTarget ?? fallbackTarget;

    if (typeof resolvedTarget !== "string" || resolvedTarget.length === 0) {
      throw new Error(`Unable to resolve browser entry for ${specifier}`);
    }

    return path.resolve(packageRoot, resolvedTarget);
  })();

  browserSpecifierFilePathCache.set(specifier, pendingResolution);

  try {
    return await pendingResolution;
  } catch (error) {
    browserSpecifierFilePathCache.delete(specifier);
    throw error;
  }
}

export function getSharedOutputRoot(projectRoot, mode) {
  return path.join(
    projectRoot,
    INTERNAL_DIRECTORY,
    mode === "development" ? DEV_DIRECTORY : BUILD_DIRECTORY,
    SHARED_DIRECTORY,
  );
}

function createSharedEntryName(specifier) {
  return specifier
    .replaceAll("@", "")
    .replaceAll("/", "__")
    .replaceAll(".", "_");
}

function createClientEntryName(clientModule) {
  return clientModule.endsWith(".mjs")
    ? clientModule.slice(0, -".mjs".length)
    : clientModule;
}

function createSharedEntrySource(specifier) {
  if (specifier === "@litsx/ssr/hydration") {
    return [
      'import "@lit-labs/ssr-client/lit-element-hydrate-support.js";',
      `export * from ${JSON.stringify(specifier)};`,
      "",
    ].join("\n");
  }

  return [
    `export * from ${JSON.stringify(specifier)};`,
    "",
  ].join("\n");
}

export async function collectSharedVendorSpecifiers(additionalEntrySpecifiers = []) {
  return [...new Set([
    ...SHARED_VENDOR_SPECIFIERS,
    ...additionalEntrySpecifiers.filter((specifier) => isBareSpecifier(specifier)),
  ])].sort();
}

async function writeSharedRuntimeEntrySources(entriesRoot, specifiers) {
  await fs.rm(entriesRoot, { recursive: true, force: true });
  await ensureDirectory(entriesRoot);

  const inputEntries = {};
  for (const specifier of specifiers) {
    const entryName = createSharedEntryName(specifier);
    const entryPath = path.join(entriesRoot, `${entryName}.mjs`);
    await fs.writeFile(entryPath, createSharedEntrySource(specifier), "utf8");
    inputEntries[entryName] = entryPath;
  }

  return inputEntries;
}

function createSharedChunkGroup(id) {
  const normalizedId = String(id).split(path.sep).join("/");

  if (!normalizedId.includes("/node_modules/")) {
    return undefined;
  }

  if (normalizedId.includes("/node_modules/@lit-labs/ssr-client/")) {
    return "vendor-hydration-support";
  }

  if (
    normalizedId.includes("/node_modules/lit-html/")
    || normalizedId.includes("/node_modules/lit/directive")
    || normalizedId.includes("/node_modules/lit/html.js")
  ) {
    return "vendor-lit-html";
  }

  if (
    normalizedId.includes("/node_modules/lit/index.js")
    || normalizedId.includes("/node_modules/lit-element/")
    || normalizedId.includes("/node_modules/@lit/")
  ) {
    return "vendor-lit";
  }

  if (
    normalizedId.includes("/node_modules/@litsx/")
  ) {
    return "vendor-litsx";
  }

  return "vendor-misc";
}

function isClientAssetStubModule(relativePath) {
  if (!relativePath.endsWith(".mjs")) {
    return false;
  }

  const originalPath = relativePath.slice(0, -".mjs".length);
  return STATIC_ASSET_EXTENSIONS.some((extension) => originalPath.endsWith(extension));
}

function resolveOriginalSourcePath(projectRoot, compiledClientRelativePath) {
  if (typeof compiledClientRelativePath !== "string" || !compiledClientRelativePath.endsWith(".mjs")) {
    return null;
  }

  const sourceBaseRelativePath = compiledClientRelativePath.slice(0, -".mjs".length);
  for (const extension of [...MODULE_EXTENSIONS, ...STATIC_ASSET_EXTENSIONS]) {
    const candidateRelativePath = `${sourceBaseRelativePath}${extension}`;
    const candidatePath = path.join(projectRoot, candidateRelativePath);
    if (existsSync(candidatePath)) {
      return `/${candidateRelativePath.split(path.sep).join("/")}`;
    }
  }

  return `/${compiledClientRelativePath.split(path.sep).join("/")}`;
}

function createStaticSourceMapPathTransform(projectRoot, clientRoot) {
  const normalizedProjectRoot = existsSync(projectRoot)
    ? realpathSync(projectRoot)
    : projectRoot;
  const normalizedClientRoot = existsSync(clientRoot)
    ? realpathSync(clientRoot)
    : clientRoot;

  return function sourcemapPathTransform(relativeSourcePath, sourcemapPath) {
    const absoluteSourcePath = path.resolve(path.dirname(sourcemapPath), relativeSourcePath);
    const normalizedAbsoluteSourcePath = existsSync(absoluteSourcePath)
      ? realpathSync(absoluteSourcePath)
      : absoluteSourcePath;
    const clientRelativePath = path.relative(normalizedClientRoot, normalizedAbsoluteSourcePath);
    const isCompiledClientModule = clientRelativePath.length === 0 || (
      !clientRelativePath.startsWith(`..${path.sep}`)
      && clientRelativePath !== ".."
      && !path.isAbsolute(clientRelativePath)
    );
    if (isCompiledClientModule) {
      const compiledClientRelativePath = clientRelativePath.split(path.sep).join("/");
      if (isClientAssetStubModule(compiledClientRelativePath)) {
        return `/${compiledClientRelativePath.slice(0, -".mjs".length)}`;
      }

      return resolveOriginalSourcePath(projectRoot, compiledClientRelativePath) ?? relativeSourcePath;
    }

    const projectRelativePath = path.relative(normalizedProjectRoot, normalizedAbsoluteSourcePath);
    const isProjectSource = projectRelativePath.length > 0
      && !projectRelativePath.startsWith(`..${path.sep}`)
      && projectRelativePath !== ".."
      && !path.isAbsolute(projectRelativePath);
    if (isProjectSource) {
      return `/${projectRelativePath.split(path.sep).join("/")}`;
    }

    return relativeSourcePath;
  };
}

function resolveProjectSourcePath(projectRoot, sourcePath) {
  if (typeof sourcePath !== "string" || !sourcePath.startsWith("/")) {
    return null;
  }

  const relativeSourcePath = sourcePath.slice(1).split("/").join(path.sep);
  const absoluteSourcePath = path.join(projectRoot, relativeSourcePath);

  return existsSync(absoluteSourcePath) ? absoluteSourcePath : null;
}

async function rewriteEmittedStaticSourceMaps(projectRoot, clientRoot, staticRoot) {
  const transformSourcePath = createStaticSourceMapPathTransform(projectRoot, clientRoot);
  const staticFiles = await walkFiles(staticRoot);

  for (const filePath of staticFiles) {
    if (!filePath.endsWith(".map")) {
      continue;
    }

    let sourceMap;
    try {
      sourceMap = JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch {
      continue;
    }

    if (!Array.isArray(sourceMap.sources) || sourceMap.sources.length === 0) {
      continue;
    }

    const rewrittenSources = sourceMap.sources.map((sourcePath) => transformSourcePath(sourcePath, filePath));
    const rewrittenSourcesContent = await Promise.all(
      rewrittenSources.map(async (sourcePath, index) => {
        const resolvedSourcePath = resolveProjectSourcePath(projectRoot, sourcePath);
        if (!resolvedSourcePath) {
          return Array.isArray(sourceMap.sourcesContent) ? sourceMap.sourcesContent[index] ?? null : null;
        }

        try {
          return await fs.readFile(resolvedSourcePath, "utf8");
        } catch {
          return Array.isArray(sourceMap.sourcesContent) ? sourceMap.sourcesContent[index] ?? null : null;
        }
      }),
    );
    const didChangeSources = rewrittenSources.some((sourcePath, index) => sourcePath !== sourceMap.sources[index]);
    const existingSourcesContent = Array.isArray(sourceMap.sourcesContent) ? sourceMap.sourcesContent : [];
    const didChangeSourcesContent = rewrittenSourcesContent.some(
      (sourceContent, index) => sourceContent !== (existingSourcesContent[index] ?? null),
    );

    if (!didChangeSources && !didChangeSourcesContent) {
      continue;
    }

    sourceMap.sources = rewrittenSources;
    sourceMap.sourcesContent = rewrittenSourcesContent;
    await fs.writeFile(filePath, `${JSON.stringify(sourceMap)}\n`, "utf8");
  }
}

export async function buildSharedVendorRuntime(
  projectRoot = process.cwd(),
  mode = "development",
  options = {},
) {
  const additionalEntrySpecifiers = [...new Set(
    Array.isArray(options.additionalEntrySpecifiers)
      ? options.additionalEntrySpecifiers.filter((specifier) => isBareSpecifier(specifier))
      : [],
  )].sort();
  const cacheKey = `${projectRoot}::${mode}::${additionalEntrySpecifiers.join("|")}`;
  if (sharedRuntimeBuildCache.has(cacheKey)) {
    return sharedRuntimeBuildCache.get(cacheKey);
  }

  const pendingBuild = (async () => {
    const sharedRoot = getSharedOutputRoot(projectRoot, mode);
    const entriesRoot = path.join(
      projectRoot,
      INTERNAL_DIRECTORY,
      mode === "development" ? DEV_DIRECTORY : BUILD_DIRECTORY,
      "__shared_entries__",
    );
    const specifiers = await collectSharedVendorSpecifiers(additionalEntrySpecifiers);
    const inputEntries = await writeSharedRuntimeEntrySources(entriesRoot, specifiers);

    await fs.rm(sharedRoot, { recursive: true, force: true });
    await ensureDirectory(sharedRoot);

    const specifierByEntryName = new Map(
      specifiers.map((specifier) => [createSharedEntryName(specifier), specifier]),
    );
    const bundle = await rollup({
      input: inputEntries,
      plugins: [
        nodeResolve({
          browser: true,
          exportConditions: ["browser", "import", "default"],
          extensions: [".mjs", ".js", ".json"],
          preferBuiltins: false,
        }),
      ],
      onwarn(warning, warn) {
        if (warning.code === "CIRCULAR_DEPENDENCY") {
          return;
        }

        warn(warning);
      },
    });

    try {
      const output = await bundle.write({
        dir: sharedRoot,
        format: "esm",
        sourcemap: mode === "development",
        entryFileNames: mode === "development"
          ? "[name].mjs"
          : "[name]-[hash].mjs",
        chunkFileNames: mode === "development"
          ? "chunks/[name].mjs"
          : "chunks/[name]-[hash].mjs",
        manualChunks(id) {
          return createSharedChunkGroup(id);
        },
      });

      const imports = {};
      for (const chunk of output.output) {
        if (chunk.type !== "chunk" || !chunk.isEntry) {
          continue;
        }

        const specifier = specifierByEntryName.get(chunk.name);
        if (!specifier) {
          continue;
        }

        imports[specifier] = `/_nexel/shared/${chunk.fileName}`;
      }

      return {
        imports,
        outputRoot: sharedRoot,
      };
    } finally {
      await bundle.close();
    }
  })();

  sharedRuntimeBuildCache.set(cacheKey, pendingBuild);

  try {
    return await pendingBuild;
  } catch (error) {
    sharedRuntimeBuildCache.delete(cacheKey);
    throw error;
  }
}

export async function createBrowserSpecifierPublicUrl(specifier) {
  const parsedSpecifier = parsePackageSpecifier(specifier);
  if (!parsedSpecifier) {
    return null;
  }

  const [{ packageRoot }, filePath] = await Promise.all([
    resolvePackageRoot(parsedSpecifier.packageName),
    resolveBrowserSpecifierFilePath(specifier),
  ]);
  const relativeFilePath = path.relative(packageRoot, filePath).split(path.sep).join("/");

  return `/_nexel/pkg/${encodePathForUrl(parsedSpecifier.packageName)}/${encodePathForUrl(relativeFilePath)}`;
}

export function createBrowserPackageBaseUrl(packageName) {
  return `/_nexel/pkg/${encodePathForUrl(packageName)}/`;
}

export async function resolveBrowserPackageAssetFilePath(pathname) {
  if (!pathname.startsWith("/_nexel/pkg/")) {
    return null;
  }

  const decodedPath = decodeURIComponent(pathname.slice("/_nexel/pkg/".length));
  const segments = decodedPath.split("/").filter(Boolean);
  if (segments.length < 2) {
    return null;
  }

  const packageName = decodedPath.startsWith("@")
    ? `${segments[0]}/${segments[1]}`
    : segments[0];
  const relativeFilePath = decodedPath.startsWith("@")
    ? segments.slice(2).join("/")
    : segments.slice(1).join("/");

  if (relativeFilePath.length === 0) {
    return resolveBrowserSpecifierFilePath(packageName);
  }

  const packageSubpathSpecifier = `${packageName}/${relativeFilePath}`;
  try {
    return await resolveBrowserSpecifierFilePath(packageSubpathSpecifier);
  } catch {
    // Fall back to direct package-relative files for explicit asset paths.
  }

  const { packageRoot } = await resolvePackageRoot(packageName);
  return path.resolve(packageRoot, relativeFilePath);
}

async function resolveRelativeImportFilePath(fromFilePath, specifier) {
  if (!isRelativeSpecifier(specifier)) {
    return null;
  }

  const candidatePath = path.resolve(path.dirname(fromFilePath), specifier);
  const candidatePaths = [
    candidatePath,
    `${candidatePath}.js`,
    `${candidatePath}.mjs`,
    path.join(candidatePath, "index.js"),
    path.join(candidatePath, "index.mjs"),
  ];

  for (const nextPath of candidatePaths) {
    try {
      const stats = await fs.stat(nextPath);
      if (stats.isFile()) {
        return nextPath;
      }
    } catch {
      // Keep probing plausible ESM file variants.
    }
  }

  return null;
}

async function collectImportsFromFile(filePath, specifiers, visitedFiles) {
  if (visitedFiles.has(filePath)) {
    return;
  }

  visitedFiles.add(filePath);

  let source = "";
  try {
    source = await fs.readFile(filePath, "utf8");
  } catch {
    return;
  }

  for (const match of source.matchAll(MODULE_SPECIFIER_PATTERN)) {
    const candidate = match[1] ?? match[2] ?? match[3] ?? null;
    if (isBareSpecifier(candidate)) {
      await collectBareImports(candidate, specifiers, visitedFiles);
      continue;
    }

    if (isRelativeSpecifier(candidate)) {
      const relativeImportFilePath = await resolveRelativeImportFilePath(filePath, candidate);
      if (relativeImportFilePath) {
        await collectImportsFromFile(relativeImportFilePath, specifiers, visitedFiles);
      }
    }
  }
}

async function collectBareImports(entrySpecifier, specifiers, visitedFiles) {
  if (!isBareSpecifier(entrySpecifier)) {
    return;
  }

  if (specifiers.has(entrySpecifier)) {
    return;
  }

  specifiers.set(
    entrySpecifier,
    await resolveBrowserSpecifierFilePath(entrySpecifier),
  );

  const resolvedFile = specifiers.get(entrySpecifier);
  await collectImportsFromFile(resolvedFile, specifiers, visitedFiles);
}

export function getClientModuleFilePath(projectRoot, mode, clientModule) {
  return path.join(
    getClientOutputRoot(projectRoot, mode),
    clientModule.split("/").join(path.sep),
  );
}

async function readClientModuleMetadata(projectRoot, mode, clientModule) {
  const cacheKey = `${projectRoot}::${mode}::${clientModule}`;
  if (clientModuleMetadataCache.has(cacheKey)) {
    return clientModuleMetadataCache.get(cacheKey);
  }

  const pendingRead = (async () => {
    const filePath = getClientModuleFilePath(projectRoot, mode, clientModule);
    const metadata = JSON.parse(await fs.readFile(`${filePath}.meta.json`, "utf8"));
    return {
      moduleImports: Array.isArray(metadata?.moduleImports) ? metadata.moduleImports : [],
      vendorImports: Array.isArray(metadata?.vendorImports) ? metadata.vendorImports : [],
      styleImports: Array.isArray(metadata?.styleImports) ? metadata.styleImports : [],
      assetImports: Array.isArray(metadata?.assetImports) ? metadata.assetImports : [],
    };
  })();

  clientModuleMetadataCache.set(cacheKey, pendingRead);

  try {
    return await pendingRead;
  } catch (error) {
    clientModuleMetadataCache.delete(cacheKey);
    throw error;
  }
}

async function collectTransitiveClientModuleMetadata(projectRoot, mode, clientModule) {
  const visitedModules = new Set();
  const pendingModules = [clientModule];
  const styleImports = new Set();
  const assetImports = new Set();

  while (pendingModules.length > 0) {
    const currentModule = pendingModules.shift();
    if (!currentModule || visitedModules.has(currentModule)) {
      continue;
    }

    visitedModules.add(currentModule);

    let metadata;
    try {
      metadata = await readClientModuleMetadata(projectRoot, mode, currentModule);
    } catch {
      continue;
    }

    for (const styleImport of metadata.styleImports) {
      styleImports.add(styleImport);
    }
    for (const assetImport of metadata.assetImports) {
      assetImports.add(assetImport);
    }
    for (const importedModule of metadata.moduleImports) {
      pendingModules.push(importedModule);
    }
  }

  return {
    styleImports: [...styleImports].sort(),
    assetImports: [...assetImports].sort(),
  };
}

function getClientModuleRelativePathFromPublicUrl(publicUrl, assetManifest) {
  if (typeof publicUrl !== "string") {
    return null;
  }

  const manifestAsset = getAssetByPublicUrl(assetManifest, publicUrl);
  return manifestAsset?.clientModule ?? null;
}

export function resolveClientEntryModules(clientPublicUrls, assetManifest) {
  return [...new Set(
    (Array.isArray(clientPublicUrls) ? clientPublicUrls : [])
      .map((publicUrl) => getClientModuleRelativePathFromPublicUrl(publicUrl, assetManifest))
      .filter((clientModule) => typeof clientModule === "string" && clientModule.length > 0),
  )].sort();
}

export async function collectClientVendorSpecifiers(
  projectRoot,
  clientPublicUrls,
  options = {},
) {
  const mode = options.mode ?? "development";
  const assetManifest = normalizeClientAssetManifest(options.assetManifest);
  const entryClientModules = Array.isArray(options.entryClientModules)
    ? [...new Set(options.entryClientModules)].sort()
    : resolveClientEntryModules(clientPublicUrls, assetManifest);
  const cacheKey = `${projectRoot}::${mode}::${entryClientModules.join("|")}`;
  if (clientVendorSpecifierCache.has(cacheKey)) {
    return clientVendorSpecifierCache.get(cacheKey);
  }

  const pendingCollection = (async () => {
    const visitedClientModules = new Set();
    const pendingClientModules = [...entryClientModules];
    const vendorSpecifiers = new Set();

    while (pendingClientModules.length > 0) {
      const currentClientModule = pendingClientModules.shift();
      if (!currentClientModule || visitedClientModules.has(currentClientModule)) {
        continue;
      }

      visitedClientModules.add(currentClientModule);
      const filePath = getClientModuleFilePath(projectRoot, mode, currentClientModule);

      try {
        const metadata = JSON.parse(await fs.readFile(`${filePath}.meta.json`, "utf8"));
        for (const vendorImport of Array.isArray(metadata?.vendorImports) ? metadata.vendorImports : []) {
          if (isBareSpecifier(vendorImport)) {
            vendorSpecifiers.add(vendorImport);
          }
        }
        for (const importedModule of Array.isArray(metadata?.moduleImports) ? metadata.moduleImports : []) {
          if (typeof importedModule === "string" && importedModule.length > 0) {
            pendingClientModules.push(importedModule);
          }
        }
        continue;
      } catch {
        // Fall back to parsing the compiled module when metadata is missing.
      }

      let source = "";
      try {
        source = await fs.readFile(filePath, "utf8");
      } catch {
        continue;
      }

      for (const match of source.matchAll(MODULE_SPECIFIER_PATTERN)) {
        const specifier = match[1] ?? match[2] ?? match[3] ?? null;
        if (isBareSpecifier(specifier)) {
          vendorSpecifiers.add(specifier);
          continue;
        }

        if (!isRelativeSpecifier(specifier)) {
          continue;
        }

        const resolvedRelativePath = resolveRelativeClientImportPath(currentClientModule, specifier);
        pendingClientModules.push(resolvedRelativePath);
      }
    }

    return [...vendorSpecifiers].sort();
  })();

  clientVendorSpecifierCache.set(cacheKey, pendingCollection);

  try {
    return await pendingCollection;
  } catch (error) {
    clientVendorSpecifierCache.delete(cacheKey);
    throw error;
  }
}

export async function resolveSharedVendorModuleUrl(
  projectRoot = process.cwd(),
  mode = "development",
  specifier,
  options = {},
) {
  const assetManifest = normalizeClientAssetManifest(options.assetManifest);
  const entryClientModules = Array.isArray(options.entryClientModules)
    ? [...new Set(options.entryClientModules)].sort()
    : resolveClientEntryModules(options.clientPublicUrls, assetManifest);
  const additionalEntrySpecifiers = [
    ...(Array.isArray(options.additionalEntrySpecifiers) ? options.additionalEntrySpecifiers : []),
    ...await collectClientVendorSpecifiers(projectRoot, options.clientPublicUrls, {
      mode,
      assetManifest,
      entryClientModules,
    }),
  ];
  const sharedRuntime = await buildSharedVendorRuntime(projectRoot, mode, {
    additionalEntrySpecifiers,
  });
  return sharedRuntime.imports[specifier] ?? null;
}

export function getClientOutputRoot(projectRoot, mode) {
  return path.join(
    projectRoot,
    INTERNAL_DIRECTORY,
    mode === "development" ? DEV_DIRECTORY : BUILD_DIRECTORY,
    CLIENT_DIRECTORY,
  );
}

export function toClientModuleRelativePath(projectRoot, sourcePath) {
  const relativePath = path.relative(projectRoot, sourcePath);
  return toCompiledClientModuleRelativePath(relativePath);
}

function toCompiledClientModuleRelativePath(relativePath) {
  const extension = path.extname(relativePath);
  return extension
    ? `${relativePath.slice(0, -extension.length)}.mjs`
    : `${relativePath}.mjs`;
}

function toPublicHydrationModuleId(projectRoot, moduleId) {
  if (typeof moduleId !== "string" || moduleId.length === 0) {
    return null;
  }

  if (path.isAbsolute(moduleId)) {
    if (!moduleId.startsWith(projectRoot)) {
      return null;
    }

    const relativePath = path.relative(projectRoot, moduleId).split(path.sep).join("/");
    return `/${relativePath}`;
  }

  if (moduleId.startsWith("/")) {
    return moduleId;
  }

  return `/${moduleId}`;
}

export function getStaticOutputRoot(projectRoot) {
  return getModeStaticOutputRoot(projectRoot, "production");
}

export function getModeStaticOutputRoot(projectRoot, mode = "production") {
  return path.join(
    projectRoot,
    INTERNAL_DIRECTORY,
    mode === "development" ? DEV_DIRECTORY : BUILD_DIRECTORY,
    STATIC_DIRECTORY,
  );
}

function getServerOutputRoot(projectRoot) {
  return path.join(
    projectRoot,
    INTERNAL_DIRECTORY,
    BUILD_DIRECTORY,
    SERVER_DIRECTORY,
  );
}

export function createAssetResolver(projectRoot, options = {}) {
  const assetManifest = normalizeClientAssetManifest(options.assetManifest);

  return function assetResolver(moduleId) {
    if (typeof moduleId !== "string" || moduleId.length === 0) {
      return null;
    }

    let relativeClientModule = null;
    if (moduleId.startsWith("/") && !moduleId.startsWith(projectRoot)) {
      relativeClientModule = toCompiledClientModuleRelativePath(moduleId.slice(1));
    } else if (path.isAbsolute(moduleId)) {
      if (!moduleId.startsWith(projectRoot)) {
        return null;
      }

      relativeClientModule = toClientModuleRelativePath(projectRoot, moduleId);
    }

    if (!relativeClientModule) {
      return null;
    }

    if (assetManifest) {
      return getAssetByClientModule(
        assetManifest,
        relativeClientModule,
      )?.publicUrl ?? null;
    }

    return null;
  };
}

function escapeInlineScriptText(value) {
  return String(value)
    .replaceAll("<", "\\u003C");
}

function escapeJsonScriptText(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003C")
    .replaceAll(">", "\\u003E")
    .replaceAll("&", "\\u0026");
}

export function createHydrationBootstrap({
  hydrationData,
  assetResolver,
  hydrationModuleUrl = "@litsx/ssr/hydration",
}) {
  const normalizedHydrationData = normalizeHydrationDataForClient(hydrationData);
  const moduleUrls = [...new Set(
    (normalizedHydrationData?.roots ?? [])
      .map((root) => {
        if (typeof root?.moduleId !== "string" || root.moduleId.length === 0) {
          return null;
        }

        return assetResolver?.(root.moduleId) ?? null;
      })
      .filter((moduleUrl) => typeof moduleUrl === "string" && moduleUrl.length > 0),
  )];

  if (moduleUrls.length === 0) {
    return "";
  }

  const moduleLoaders = moduleUrls
    .map((moduleUrl) => `  () => import(${JSON.stringify(moduleUrl)})`)
    .join(",\n");

  const source = `
import { hydratePage, registerHydrationModules } from ${JSON.stringify(hydrationModuleUrl)};

await hydratePage({
  clientImports: [],
  register: () => registerHydrationModules([
${moduleLoaders}
  ])
});
`;

  return escapeInlineScriptText(source);
}

export function normalizeHydrationDataForClient(hydrationData, projectRoot = null) {
  if (!hydrationData || typeof hydrationData !== "object") {
    return hydrationData ?? null;
  }

  const roots = Array.isArray(hydrationData.roots)
    ? hydrationData.roots.map((root) => {
      if (!root || typeof root !== "object") {
        return root;
      }

      const nextRoot = { ...root };
      if (typeof nextRoot.moduleId === "string") {
        const normalizedModuleId = projectRoot
          ? toPublicHydrationModuleId(projectRoot, nextRoot.moduleId)
          : nextRoot.moduleId;

        if (typeof normalizedModuleId === "string" && normalizedModuleId.length > 0) {
          nextRoot.moduleId = normalizedModuleId;
        } else {
          delete nextRoot.moduleId;
        }
      }

      return nextRoot;
    })
    : hydrationData.roots;

  const normalizedHydrationData = {
    version: hydrationData.version,
    roots,
  };
  const payload = hydrationData.payload;
  const clientImports = hydrationData.clientImports;

  Object.defineProperties(normalizedHydrationData, {
    payload: {
      enumerable: false,
      value: payload,
    },
    clientImports: {
      enumerable: false,
      value: clientImports,
    },
    toJSON: {
      enumerable: false,
      value() {
        return {
          version: normalizedHydrationData.version,
          roots: normalizedHydrationData.roots,
          ...(payload !== undefined ? { payload } : {}),
          ...(clientImports !== undefined ? { clientImports } : {}),
        };
      },
    },
  });

  return normalizedHydrationData;
}

export function rewriteHydrationDataScript(documentHtml, hydrationData) {
  if (typeof documentHtml !== "string" || documentHtml.length === 0 || !hydrationData) {
    return documentHtml;
  }

  return documentHtml.replace(
    /(<script type="application\/json" id="__LITSX_HYDRATION__">)([\s\S]*?)(<\/script>)/,
    (_, prefix, __content, suffix) => `${prefix}${escapeJsonScriptText(hydrationData)}${suffix}`,
  );
}

function createHashedModulePath(relativePath, hash) {
  const extension = path.extname(relativePath);
  if (!extension) {
    return `${relativePath}.${hash}`;
  }

  return path.join(
    path.dirname(relativePath),
    `${path.basename(relativePath, extension)}.${hash}${extension}`,
  );
}

function getAssetType(relativePath) {
  if (relativePath.endsWith(".css")) {
    return "style";
  }

  if (relativePath.endsWith(".mjs")) {
    return "script";
  }

  return "asset";
}

function replaceStaticAssetPlaceholders(source, publicPathByRelativePath) {
  return source.replaceAll(/__NEXEL_ASSET_URL__:([^"]+)/g, (match, encodedRelativeAssetPath) => {
    const relativeAssetPath = encodedRelativeAssetPath
      .replaceAll("\\\\", "\\")
      .replaceAll('\\"', '"');
    const rewrittenTarget = publicPathByRelativePath.get(relativeAssetPath);
    if (!rewrittenTarget) {
      return match;
    }

    return toStaticPublicUrl(rewrittenTarget);
  });
}

function rewriteStaticAssetPlaceholdersWithMap(source, publicPathByRelativePath) {
  const magicSource = new MagicString(source);
  let didRewrite = false;

  for (const match of source.matchAll(/__NEXEL_ASSET_URL__:([^"]+)/g)) {
    const encodedRelativeAssetPath = match[1];
    const relativeAssetPath = encodedRelativeAssetPath
      .replaceAll("\\\\", "\\")
      .replaceAll('\\"', '"');
    const rewrittenTarget = publicPathByRelativePath.get(relativeAssetPath);
    if (!rewrittenTarget || typeof match.index !== "number") {
      continue;
    }

    didRewrite = true;
    magicSource.update(
      match.index,
      match.index + match[0].length,
      toStaticPublicUrl(rewrittenTarget),
    );
  }

  if (!didRewrite) {
    return null;
  }

  return {
    code: magicSource.toString(),
    map: magicSource.generateMap({ hires: true }),
  };
}

function rewriteRelativeCssAssetUrls(source, fileRelativePath, publicPathByRelativePath) {
  return source.replaceAll(
    /url\(\s*(['"]?)([^"'()]+)\1\s*\)/g,
    (match, quote = "", rawSpecifier) => {
      const specifier = String(rawSpecifier).trim();
      if (
        specifier.length === 0 ||
        specifier.startsWith("/") ||
        specifier.startsWith("data:") ||
        specifier.startsWith("http:") ||
        specifier.startsWith("https:")
      ) {
        return match;
      }

      const [assetPath, hashFragment] = specifier.split("#", 2);
      const [cleanAssetPath, searchFragment] = assetPath.split("?", 2);
      const resolvedRelativePath = path.normalize(
        path.join(path.dirname(fileRelativePath), cleanAssetPath),
      );
      const rewrittenTarget = publicPathByRelativePath.get(resolvedRelativePath);
      if (!rewrittenTarget) {
        return match;
      }

      let rewrittenSpecifier = normalizeRelativeImportPath(
        path.relative(
          path.dirname(publicPathByRelativePath.get(fileRelativePath)),
          rewrittenTarget,
        ),
      );
      if (typeof searchFragment === "string") {
        rewrittenSpecifier += `?${searchFragment}`;
      }
      if (typeof hashFragment === "string") {
        rewrittenSpecifier += `#${hashFragment}`;
      }

      return `url(${quote}${rewrittenSpecifier}${quote})`;
    },
  );
}

function normalizeRelativeImportPath(value) {
  const normalized = value.split(path.sep).join("/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

function encodePathForUrl(value) {
  return value
    .split(path.sep)
    .join("/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function toStaticPublicUrl(relativePath) {
  return `/_nexel/static/${encodePathForUrl(relativePath)}`;
}

function collectRelativeClientImportPaths(source, fileRelativePath, publicPathByRelativePath) {
  const imports = [];

  for (const match of source.matchAll(MODULE_SPECIFIER_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? null;
    if (
      !specifier ||
      (!specifier.startsWith("./") && !specifier.startsWith("../"))
    ) {
      continue;
    }

    const resolvedRelativePath = path.normalize(
      path.join(path.dirname(fileRelativePath), specifier),
    );
    if (!publicPathByRelativePath.has(resolvedRelativePath)) {
      continue;
    }

    imports.push(resolvedRelativePath.split(path.sep).join("/"));
  }

  return [...new Set(imports)].sort();
}

function rewriteRelativeClientImports(source, fileRelativePath, publicPathByRelativePath) {
  let rewrittenCode = "";
  let previousIndex = 0;

  for (const match of source.matchAll(MODULE_SPECIFIER_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? null;
    if (
      !specifier ||
      (!specifier.startsWith("./") && !specifier.startsWith("../"))
    ) {
      continue;
    }

    const resolvedRelativePath = path.normalize(
      path.join(path.dirname(fileRelativePath), specifier),
    );
    const rewrittenTarget = publicPathByRelativePath.get(resolvedRelativePath);
    if (!rewrittenTarget) {
      continue;
    }

    const replacementPath = path.relative(
      path.dirname(publicPathByRelativePath.get(fileRelativePath)),
      rewrittenTarget,
    );
    const quotedSpecifierIndex = match.index + match[0].indexOf(specifier);

    rewrittenCode += source.slice(previousIndex, quotedSpecifierIndex);
    rewrittenCode += normalizeRelativeImportPath(replacementPath);
    previousIndex = quotedSpecifierIndex + specifier.length;
  }

  rewrittenCode += source.slice(previousIndex);
  return rewrittenCode;
}

export async function emitHashedClientAssets(projectRoot, options = {}) {
  const clientRoot = getClientOutputRoot(projectRoot, "production");
  const staticRoot = getStaticOutputRoot(projectRoot);
  const files = await walkFiles(clientRoot);
  const entryClientModules = new Set(options.entryClientModules ?? []);
  const assetEntries = [];
  const publicPathByRelativePath = new Map();

  for (const filePath of files) {
    if (filePath.endsWith(".meta.json") || filePath.endsWith(".map")) {
      continue;
    }
    const relativePath = path.relative(clientRoot, filePath);
    const buffer = await fs.readFile(filePath);
    const type = getAssetType(relativePath);
    assetEntries.push({
      filePath,
      relativePath,
      buffer,
      type,
      source: type === "script" ? buffer.toString("utf8") : null,
    });
  }

  for (const entry of assetEntries) {
    const hash = crypto
      .createHash("sha1")
      .update(entry.buffer)
      .digest("hex")
      .slice(0, 8);
    const hashedRelativePath = createHashedModulePath(entry.relativePath, hash);
    publicPathByRelativePath.set(entry.relativePath, hashedRelativePath);
  }

  const byClientModule = {};
  const byPublicPath = {};
  const assets = [];

  for (const entry of assetEntries) {
    const rewrittenSource = entry.type === "script"
      ? replaceStaticAssetPlaceholders(
        rewriteRelativeClientImports(
        entry.source,
        entry.relativePath,
        publicPathByRelativePath,
        ),
        publicPathByRelativePath,
      )
      : entry.type === "style"
        ? rewriteRelativeCssAssetUrls(
          entry.buffer.toString("utf8"),
          entry.relativePath,
          publicPathByRelativePath,
        )
      : entry.source;
    const hashedRelativePath = publicPathByRelativePath.get(entry.relativePath);
    const outputPath = path.join(staticRoot, hashedRelativePath);
    const clientModule = entry.relativePath.split(path.sep).join("/");
    const importedClientModules = entry.type === "script"
      ? collectRelativeClientImportPaths(
        entry.source,
        entry.relativePath,
        publicPathByRelativePath,
      )
      : [];
    const importedPublicUrls = importedClientModules
      .map((importedModule) => byClientModule[importedModule] ?? publicPathByRelativePath.get(importedModule))
      .map((value) => {
        if (typeof value === "string" && value.startsWith("/_nexel/")) {
          return value;
        }
        if (typeof value !== "string") {
          return null;
        }
        return toStaticPublicUrl(value);
      })
      .filter((value) => typeof value === "string");
    let styleImports = [];
    let styleUrls = [];
    let assetImports = [];
    let assetUrls = [];
    if (entry.type === "script") {
      try {
        const metadata = JSON.parse(await fs.readFile(`${entry.filePath}.meta.json`, "utf8"));
        styleImports = Array.isArray(metadata?.styleImports) ? metadata.styleImports : [];
        assetImports = Array.isArray(metadata?.assetImports) ? metadata.assetImports : [];
      } catch {
        styleImports = [];
        assetImports = [];
      }
      styleUrls = styleImports
        .map((importedStyle) => publicPathByRelativePath.get(importedStyle))
        .filter((value) => typeof value === "string")
        .map((value) => toStaticPublicUrl(value));
      assetUrls = assetImports
        .map((importedAsset) => publicPathByRelativePath.get(importedAsset))
        .filter((value) => typeof value === "string")
        .map((value) => toStaticPublicUrl(value));
    }
    await ensureDirectory(path.dirname(outputPath));
    await fs.writeFile(
      outputPath,
      entry.type === "asset" ? entry.buffer : rewrittenSource,
      entry.type === "asset" ? undefined : "utf8",
    );

    const publicUrl = toStaticPublicUrl(hashedRelativePath);
    const hash = path.basename(hashedRelativePath).match(/\.([a-f0-9]{8})\.[^.]+$/)?.[1] ?? null;
    const kind = entry.type === "style"
      ? "style"
      : entry.type === "asset"
        ? "asset"
        : entryClientModules.has(clientModule) ? "entry" : "chunk";
    const size = entry.type === "asset"
      ? entry.buffer.byteLength
      : Buffer.byteLength(rewrittenSource, "utf8");

    byClientModule[clientModule] = publicUrl;
    byPublicPath[publicUrl] = outputPath;
    assets.push({
      clientModule,
      type: entry.type,
      kind,
      publicUrl,
      outputPath,
      hash,
      size,
      imports: importedClientModules,
      importUrls: importedPublicUrls,
      styleImports,
      styleUrls,
      assetImports,
      assetUrls,
    });
  }

  const entries = assets
    .filter((asset) => asset.kind === "entry")
    .map((asset) => asset.clientModule)
    .sort();
  const chunks = assets
    .filter((asset) => asset.kind === "chunk")
    .map((asset) => asset.clientModule)
    .sort();
  const styles = assets
    .filter((asset) => asset.type === "style")
    .map((asset) => asset.clientModule)
    .sort();
  const resources = assets
    .filter((asset) => asset.type === "asset")
    .map((asset) => asset.clientModule)
    .sort();

  const manifest = {
    version: CLIENT_ASSET_MANIFEST_VERSION,
    publicPathPrefix: "/_nexel/static/",
    byClientModule,
    byPublicPath,
    entries,
    chunks,
    styles,
    resources,
    assets: assets.sort((left, right) => left.clientModule.localeCompare(right.clientModule)),
  };

  await writeJson(path.join(projectRoot, INTERNAL_DIRECTORY, BUILD_DIRECTORY, "client-assets.json"), manifest);
  return manifest;
}

async function bundleClientAssets(projectRoot, options = {}) {
  const mode = options.mode ?? "production";
  const clientRoot = getClientOutputRoot(projectRoot, mode);
  const staticRoot = getModeStaticOutputRoot(projectRoot, mode);
  const files = await walkFiles(clientRoot);
  const entryClientModules = new Set(options.entryClientModules ?? []);
  const assetEntries = [];
  const publicPathByRelativePath = new Map();

  for (const filePath of files) {
    if (filePath.endsWith(".meta.json") || filePath.endsWith(".map")) {
      continue;
    }

    const relativePath = path.relative(clientRoot, filePath);
    if (isClientAssetStubModule(relativePath)) {
      continue;
    }

    const buffer = await fs.readFile(filePath);
    const type = getAssetType(relativePath);
    assetEntries.push({
      filePath,
      relativePath,
      buffer,
      type,
      source: type === "script" ? buffer.toString("utf8") : null,
    });
  }

  for (const entry of assetEntries.filter((asset) => asset.type !== "script")) {
    const hash = crypto
      .createHash("sha1")
      .update(entry.buffer)
      .digest("hex")
      .slice(0, 8);
    const hashedRelativePath = createHashedModulePath(entry.relativePath, hash);
    publicPathByRelativePath.set(entry.relativePath, hashedRelativePath);
  }

  await fs.rm(staticRoot, { recursive: true, force: true });
  await ensureDirectory(staticRoot);

  const nonScriptAssets = [];
  const byClientModule = {};
  const byPublicPath = {};

  for (const entry of assetEntries.filter((asset) => asset.type !== "script")) {
    const rewrittenSource = entry.type === "style"
      ? rewriteRelativeCssAssetUrls(
        entry.buffer.toString("utf8"),
        entry.relativePath,
        publicPathByRelativePath,
      )
      : entry.buffer;
    const hashedRelativePath = publicPathByRelativePath.get(entry.relativePath);
    const outputPath = path.join(staticRoot, hashedRelativePath);
    await ensureDirectory(path.dirname(outputPath));
    await fs.writeFile(
      outputPath,
      entry.type === "asset" ? rewrittenSource : rewrittenSource,
      entry.type === "asset" ? undefined : "utf8",
    );

    const publicUrl = toStaticPublicUrl(hashedRelativePath);
    const clientModule = entry.relativePath.split(path.sep).join("/");
    const hash = path.basename(hashedRelativePath).match(/\.([a-f0-9]{8})\.[^.]+$/)?.[1] ?? null;
    const size = entry.type === "asset"
      ? entry.buffer.byteLength
      : Buffer.byteLength(rewrittenSource, "utf8");

    byClientModule[clientModule] = publicUrl;
    byPublicPath[publicUrl] = outputPath;
    nonScriptAssets.push({
      clientModule,
      type: entry.type,
      kind: entry.type === "style" ? "style" : "asset",
      publicUrl,
      outputPath,
      hash,
      size,
      imports: [],
      importUrls: [],
      styleImports: [],
      styleUrls: [],
      assetImports: [],
      assetUrls: [],
    });
  }

  const inputEntries = {};
  const clientModuleByEntryName = new Map();
  for (const entry of assetEntries.filter((asset) => asset.type === "script")) {
    const clientModule = entry.relativePath.split(path.sep).join("/");
    const entryName = createClientEntryName(clientModule);
    inputEntries[entryName] = entry.filePath;
    clientModuleByEntryName.set(entryName, clientModule);
  }

  const scriptAssetRecords = [];
  let nextRollupCache = options.rollupCache ?? null;
  if (Object.keys(inputEntries).length > 0) {
    const sharedVendorSpecifiers = await collectClientVendorSpecifiers(projectRoot, [], {
      mode,
      entryClientModules: [...entryClientModules],
    });
    const sharedRuntime = await buildSharedVendorRuntime(projectRoot, mode, {
      additionalEntrySpecifiers: sharedVendorSpecifiers,
    });
    const sharedImportPaths = Object.fromEntries(
      Object.entries(sharedRuntime.imports).map(([specifier, publicUrl]) => [specifier, publicUrl]),
    );
    const bundle = await rollup({
      input: inputEntries,
      cache: options.rollupCache ?? undefined,
      external(id) {
        return isBareSpecifier(id);
      },
      plugins: [
        {
          name: "nexel-client-input-sourcemaps",
          async load(id) {
            if (!id.startsWith(clientRoot) || !id.endsWith(".mjs")) {
              return null;
            }

            try {
              const [code, map] = await Promise.all([
                fs.readFile(id, "utf8"),
                fs.readFile(`${id}.map`, "utf8"),
              ]);
              return { code, map: JSON.parse(map) };
            } catch {
              return null;
            }
          },
        },
        nodeResolve({
          browser: true,
          exportConditions: ["browser", "import", "default"],
          extensions: [".mjs", ".js", ".json"],
          preferBuiltins: false,
        }),
        {
          name: "nexel-client-asset-placeholders",
          renderChunk(code) {
            return rewriteStaticAssetPlaceholdersWithMap(code, publicPathByRelativePath);
          },
        },
      ],
      onwarn(warning, warn) {
        if (warning.code === "CIRCULAR_DEPENDENCY") {
          return;
        }

        warn(warning);
      },
    });

    try {
      const output = await bundle.write({
        dir: staticRoot,
        format: "esm",
        sourcemap: true,
        entryFileNames: mode === "development" ? "[name].mjs" : "[name]-[hash].mjs",
        chunkFileNames: mode === "development" ? "chunks/[name].mjs" : "chunks/[name]-[hash].mjs",
        paths(id) {
          return sharedImportPaths[id] ?? id;
        },
      });
      await rewriteEmittedStaticSourceMaps(projectRoot, clientRoot, staticRoot);

      const publicUrlByFileName = new Map();
      for (const chunk of output.output) {
        if (chunk.type !== "chunk") {
          continue;
        }
        publicUrlByFileName.set(chunk.fileName, toStaticPublicUrl(chunk.fileName));
      }

      for (const chunk of output.output) {
        if (chunk.type !== "chunk") {
          continue;
        }

        const outputPath = path.join(staticRoot, chunk.fileName);
        const publicUrl = toStaticPublicUrl(chunk.fileName);
        const isNamedEntry = chunk.isEntry && clientModuleByEntryName.has(chunk.name);
        const clientModule = isNamedEntry
          ? clientModuleByEntryName.get(chunk.name)
          : chunk.fileName;
        const transitiveMetadata = isNamedEntry
          ? await collectTransitiveClientModuleMetadata(projectRoot, mode, clientModule)
          : { styleImports: [], assetImports: [] };
        const styleUrls = transitiveMetadata.styleImports
          .map((importedStyle) => byClientModule[importedStyle])
          .filter((value) => typeof value === "string");
        const assetUrls = transitiveMetadata.assetImports
          .map((importedAsset) => byClientModule[importedAsset])
          .filter((value) => typeof value === "string");
        const hash = path.basename(chunk.fileName).match(/-([A-Za-z0-9_-]+)\.mjs$/)?.[1] ?? null;

        if (isNamedEntry) {
          byClientModule[clientModule] = publicUrl;
        }
        byPublicPath[publicUrl] = outputPath;
        scriptAssetRecords.push({
          clientModule,
          type: "script",
          kind: entryClientModules.has(clientModule) ? "entry" : "chunk",
          publicUrl,
          outputPath,
          hash,
          size: Buffer.byteLength(chunk.code, "utf8"),
          imports: chunk.imports,
          importUrls: chunk.imports
            .map((fileName) => publicUrlByFileName.get(fileName))
            .filter((value) => typeof value === "string"),
          styleImports: transitiveMetadata.styleImports,
          styleUrls,
          assetImports: transitiveMetadata.assetImports,
          assetUrls,
        });
      }
      nextRollupCache = bundle.cache;
    } finally {
      await bundle.close();
    }
  }

  const mapAssets = [];
  const staticFiles = await walkFiles(staticRoot);
  for (const filePath of staticFiles) {
    if (!filePath.endsWith(".map")) {
      continue;
    }

    const relativePath = path.relative(staticRoot, filePath).split(path.sep).join("/");
    const publicUrl = toStaticPublicUrl(relativePath);
    byPublicPath[publicUrl] = filePath;
    mapAssets.push({
      clientModule: relativePath,
      type: "asset",
      kind: "asset",
      publicUrl,
      outputPath: filePath,
      hash: null,
      size: (await fs.stat(filePath)).size,
      imports: [],
      importUrls: [],
      styleImports: [],
      styleUrls: [],
      assetImports: [],
      assetUrls: [],
    });
  }

  const assets = [...scriptAssetRecords, ...nonScriptAssets, ...mapAssets]
    .sort((left, right) => left.clientModule.localeCompare(right.clientModule));
  const manifest = {
    version: CLIENT_ASSET_MANIFEST_VERSION,
    publicPathPrefix: "/_nexel/static/",
    byClientModule,
    byPublicPath,
    entries: assets.filter((asset) => asset.kind === "entry").map((asset) => asset.clientModule).sort(),
    chunks: assets.filter((asset) => asset.kind === "chunk").map((asset) => asset.clientModule).sort(),
    styles: assets.filter((asset) => asset.type === "style").map((asset) => asset.clientModule).sort(),
    resources: assets
      .filter((asset) => asset.kind === "asset" && !asset.clientModule.endsWith(".map"))
      .map((asset) => asset.clientModule)
      .sort(),
    assets,
  };

  await writeJson(
    path.join(
      projectRoot,
      INTERNAL_DIRECTORY,
      mode === "development" ? DEV_DIRECTORY : BUILD_DIRECTORY,
      "client-assets.json",
    ),
    manifest,
  );
  return {
    manifest,
    rollupCache: nextRollupCache,
  };
}

export async function emitBundledClientAssets(projectRoot, options = {}) {
  const result = await bundleClientAssets(projectRoot, options);
  return result.manifest;
}

export async function emitBundledClientAssetsWithState(projectRoot, options = {}) {
  return bundleClientAssets(projectRoot, options);
}

export async function rewriteServerAssetPlaceholders(projectRoot, assetManifest) {
  const normalizedManifest = normalizeClientAssetManifest(assetManifest);
  if (!normalizedManifest) {
    return;
  }

  const serverRoot = getServerOutputRoot(projectRoot);
  const serverFiles = await walkFiles(serverRoot);
  const assetUrlByClientModule = new Map(
    normalizedManifest.assets.map((asset) => [asset.clientModule, asset.publicUrl]),
  );

  for (const filePath of serverFiles) {
    if (!filePath.endsWith(".mjs")) {
      continue;
    }

    const source = await fs.readFile(filePath, "utf8");
    const rewritten = source.replaceAll(/__NEXEL_ASSET_URL__:([A-Za-z0-9._/-]+)/g, (match, relativeAssetPath) => {
      return assetUrlByClientModule.get(relativeAssetPath) ?? match;
    }).replaceAll(/__NEXEL_ASSET_URL__:([^"]+)/g, (match, encodedRelativeAssetPath) => {
      const relativeAssetPath = encodedRelativeAssetPath
        .replaceAll("\\\\", "\\")
        .replaceAll('\\"', '"');
      return assetUrlByClientModule.get(relativeAssetPath) ?? match;
    });

    if (rewritten !== source) {
      await fs.writeFile(filePath, rewritten, "utf8");
    }
  }
}

export function collectTransitiveAssetPreloads(publicUrls, assetManifest) {
  const normalizedManifest = normalizeClientAssetManifest(assetManifest);
  if (!normalizedManifest) {
    return [];
  }

  const byPublicUrl = new Map(
    normalizedManifest.assets
      .filter((asset) => typeof asset?.publicUrl === "string")
      .map((asset) => [asset.publicUrl, asset]),
  );
  const visited = new Set(publicUrls);
  const queue = [...publicUrls];
  const discovered = [];

  while (queue.length > 0) {
    const currentUrl = queue.shift();
    const asset = byPublicUrl.get(currentUrl);
    if (!asset || !Array.isArray(asset.importUrls)) {
      continue;
    }

    for (const importedUrl of asset.importUrls) {
      if (typeof importedUrl !== "string" || visited.has(importedUrl)) {
        continue;
      }

      visited.add(importedUrl);
      discovered.push(importedUrl);
      queue.push(importedUrl);
    }
  }

  return discovered;
}

export function collectTransitiveStyleUrls(publicUrls, assetManifest) {
  const normalizedManifest = normalizeClientAssetManifest(assetManifest);
  if (!normalizedManifest) {
    return [];
  }

  const byPublicUrl = new Map(
    normalizedManifest.assets
      .filter((asset) => typeof asset?.publicUrl === "string")
      .map((asset) => [asset.publicUrl, asset]),
  );
  const visitedAssets = new Set(publicUrls);
  const queue = [...publicUrls];
  const styles = new Set();

  while (queue.length > 0) {
    const currentUrl = queue.shift();
    const asset = byPublicUrl.get(currentUrl);
    if (!asset) {
      continue;
    }

    for (const styleUrl of Array.isArray(asset.styleUrls) ? asset.styleUrls : []) {
      if (typeof styleUrl === "string") {
        styles.add(styleUrl);
      }
    }

    for (const importedUrl of Array.isArray(asset.importUrls) ? asset.importUrls : []) {
      if (typeof importedUrl !== "string" || visitedAssets.has(importedUrl)) {
        continue;
      }

      visitedAssets.add(importedUrl);
      queue.push(importedUrl);
    }
  }

  return [...styles].sort();
}

export function normalizeClientAssetManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.assets)) {
    return null;
  }

  return {
    version: manifest.version ?? CLIENT_ASSET_MANIFEST_VERSION,
    publicPathPrefix: manifest.publicPathPrefix ?? "/_nexel/static/",
    byClientModule: manifest.byClientModule ?? {},
    byPublicPath: manifest.byPublicPath ?? {},
    entries: Array.isArray(manifest.entries) ? manifest.entries : [],
    chunks: Array.isArray(manifest.chunks) ? manifest.chunks : [],
    styles: Array.isArray(manifest.styles) ? manifest.styles : [],
    resources: Array.isArray(manifest.resources) ? manifest.resources : [],
    assets: manifest.assets,
  };
}

export function createStaticAssetPublicUrlMap(manifest) {
  const normalizedManifest = normalizeClientAssetManifest(manifest);
  if (!normalizedManifest) {
    return null;
  }

  const entries = normalizedManifest.assets
    .filter(
      (asset) =>
        typeof asset?.clientModule === "string"
        && typeof asset?.publicUrl === "string"
        && asset.type === "asset",
    )
    .map((asset) => [asset.clientModule, asset.publicUrl]);

  return new Map(entries);
}

export function getAssetByClientModule(manifest, clientModule) {
  const normalizedManifest = normalizeClientAssetManifest(manifest);
  if (!normalizedManifest || typeof clientModule !== "string") {
    return null;
  }

  return normalizedManifest.assets.find((asset) => asset.clientModule === clientModule) ?? null;
}

export function getAssetByPublicUrl(manifest, publicUrl) {
  const normalizedManifest = normalizeClientAssetManifest(manifest);
  if (!normalizedManifest || typeof publicUrl !== "string") {
    return null;
  }

  return normalizedManifest.assets.find((asset) => asset.publicUrl === publicUrl) ?? null;
}

export function getAssetsByKind(manifest, kind) {
  const normalizedManifest = normalizeClientAssetManifest(manifest);
  if (!normalizedManifest || typeof kind !== "string") {
    return [];
  }

  return normalizedManifest.assets.filter((asset) => asset.kind === kind);
}
