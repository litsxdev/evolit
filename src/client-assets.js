import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import {
  BUILD_DIRECTORY,
  CLIENT_DIRECTORY,
  DEV_DIRECTORY,
  INTERNAL_DIRECTORY,
  STATIC_DIRECTORY,
} from "./constants.js";
import { ensureDirectory, walkFiles, writeJson } from "./fs-utils.js";

const BARE_SPECIFIER_PATTERN =
  /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

const requireFromHere = createRequire(import.meta.url);
const PACKAGE_SPECIFIERS = [
  "@litsx/core",
  "@litsx/ssr/hydration",
  "lit",
];

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

async function collectBareImports(entrySpecifier, specifiers, visitedFiles) {
  if (!isBareSpecifier(entrySpecifier)) {
    return;
  }

  if (specifiers.has(entrySpecifier)) {
    return;
  }

  specifiers.set(
    entrySpecifier,
    path.resolve(requireFromHere.resolve(entrySpecifier)),
  );

  const resolvedFile = specifiers.get(entrySpecifier);
  if (visitedFiles.has(resolvedFile)) {
    return;
  }

  visitedFiles.add(resolvedFile);

  let source = "";
  try {
    source = await fs.readFile(resolvedFile, "utf8");
  } catch {
    return;
  }

  for (const match of source.matchAll(BARE_SPECIFIER_PATTERN)) {
    const candidate = match[1] ?? match[2] ?? null;
    if (!isBareSpecifier(candidate)) {
      continue;
    }

    await collectBareImports(candidate, specifiers, visitedFiles);
  }
}

export async function createFrameworkImportMap() {
  const specifiers = new Map();
  const visitedFiles = new Set();

  for (const entrySpecifier of PACKAGE_SPECIFIERS) {
    await collectBareImports(entrySpecifier, specifiers, visitedFiles);
  }

  return {
    imports: Object.fromEntries(
      [...specifiers.keys()].sort().map((specifier) => [
        specifier,
        `/_nextsx/pkg/${encodeURIComponent(specifier)}`,
      ]),
    ),
  };
}

export function getClientOutputRoot(projectRoot, mode) {
  return path.join(
    projectRoot,
    INTERNAL_DIRECTORY,
    mode === "development" ? DEV_DIRECTORY : BUILD_DIRECTORY,
    CLIENT_DIRECTORY,
  );
}

export function getClientAssetUrl(projectRoot, sourcePath) {
  const relativePath = path.relative(projectRoot, sourcePath);
  const extension = path.extname(relativePath);
  const compiledPath = extension
    ? `${relativePath.slice(0, -extension.length)}.mjs`
    : `${relativePath}.mjs`;

  return `/_nextsx/client/${compiledPath.split(path.sep).join("/")}`;
}

function toClientModuleRelativePath(projectRoot, sourcePath) {
  const relativePath = path.relative(projectRoot, sourcePath);
  const extension = path.extname(relativePath);
  return extension
    ? `${relativePath.slice(0, -extension.length)}.mjs`
    : `${relativePath}.mjs`;
}

export function getStaticOutputRoot(projectRoot) {
  return path.join(
    projectRoot,
    INTERNAL_DIRECTORY,
    BUILD_DIRECTORY,
    STATIC_DIRECTORY,
  );
}

export function createAssetResolver(projectRoot, options = {}) {
  const assetManifest = options.assetManifest ?? null;

  return function assetResolver(moduleId) {
    if (!path.isAbsolute(moduleId)) {
      return null;
    }

    if (!moduleId.startsWith(projectRoot)) {
      return null;
    }

    if (assetManifest) {
      return assetManifest.byClientModule?.[toClientModuleRelativePath(projectRoot, moduleId)] ?? null;
    }

    return getClientAssetUrl(projectRoot, moduleId);
  };
}

function escapeInlineScriptText(value) {
  return String(value)
    .replaceAll("<", "\\u003C")
    .replaceAll(">", "\\u003E")
    .replaceAll("&", "\\u0026");
}

export function createHydrationBootstrap({
  hydrationData,
  assetResolver,
}) {
  const moduleUrls = [...new Set(
    (hydrationData?.roots ?? [])
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
import { hydratePage, registerHydrationModules } from "@litsx/ssr/hydration";

await registerHydrationModules([
${moduleLoaders}
]);

await hydratePage();
`;

  return escapeInlineScriptText(source);
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

function normalizeRelativeImportPath(value) {
  const normalized = value.split(path.sep).join("/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

function collectRelativeClientImportPaths(source, fileRelativePath, publicPathByRelativePath) {
  const imports = [];

  for (const match of source.matchAll(BARE_SPECIFIER_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? null;
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

  for (const match of source.matchAll(BARE_SPECIFIER_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? null;
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

export async function emitHashedClientAssets(projectRoot) {
  const clientRoot = getClientOutputRoot(projectRoot, "production");
  const staticRoot = getStaticOutputRoot(projectRoot);
  const files = await walkFiles(clientRoot);
  const assetEntries = [];
  const publicPathByRelativePath = new Map();

  for (const filePath of files) {
    const relativePath = path.relative(clientRoot, filePath);
    const source = await fs.readFile(filePath, "utf8");
    assetEntries.push({ filePath, relativePath, source });
  }

  for (const entry of assetEntries) {
    const hash = crypto
      .createHash("sha1")
      .update(entry.source)
      .digest("hex")
      .slice(0, 8);
    const hashedRelativePath = createHashedModulePath(entry.relativePath, hash);
    publicPathByRelativePath.set(entry.relativePath, hashedRelativePath);
  }

  const byClientModule = {};
  const byPublicPath = {};
  const assets = [];

  for (const entry of assetEntries) {
    const rewrittenSource = rewriteRelativeClientImports(
      entry.source,
      entry.relativePath,
      publicPathByRelativePath,
    );
    const hashedRelativePath = publicPathByRelativePath.get(entry.relativePath);
    const outputPath = path.join(staticRoot, hashedRelativePath);
    const clientModule = entry.relativePath.split(path.sep).join("/");
    const importedClientModules = collectRelativeClientImportPaths(
      entry.source,
      entry.relativePath,
      publicPathByRelativePath,
    );
    const importedPublicUrls = importedClientModules
      .map((importedModule) => byClientModule[importedModule] ?? publicPathByRelativePath.get(importedModule))
      .map((value) => {
        if (typeof value === "string" && value.startsWith("/_nextsx/")) {
          return value;
        }
        if (typeof value !== "string") {
          return null;
        }
        return `/_nextsx/static/${value.split(path.sep).join("/")}`;
      })
      .filter((value) => typeof value === "string");
    await ensureDirectory(path.dirname(outputPath));
    await fs.writeFile(outputPath, rewrittenSource, "utf8");

    const publicUrl = `/_nextsx/static/${hashedRelativePath.split(path.sep).join("/")}`;
    const hash = path.basename(hashedRelativePath).match(/\.([a-f0-9]{8})\.mjs$/)?.[1] ?? null;

    byClientModule[clientModule] = publicUrl;
    byPublicPath[publicUrl] = outputPath;
    assets.push({
      clientModule,
      publicUrl,
      outputPath,
      hash,
      imports: importedClientModules,
      importUrls: importedPublicUrls,
    });
  }

  const manifest = {
    byClientModule,
    byPublicPath,
    assets: assets.sort((left, right) => left.clientModule.localeCompare(right.clientModule)),
  };

  await writeJson(path.join(projectRoot, INTERNAL_DIRECTORY, BUILD_DIRECTORY, "client-assets.json"), manifest);
  return manifest;
}

export function collectTransitiveAssetPreloads(publicUrls, assetManifest) {
  if (!assetManifest || !Array.isArray(assetManifest.assets)) {
    return [];
  }

  const byPublicUrl = new Map(
    assetManifest.assets
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
