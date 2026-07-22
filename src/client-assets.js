import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import {
  BUILD_DIRECTORY,
  CLIENT_DIRECTORY,
  CLIENT_ASSET_MANIFEST_VERSION,
  DEV_DIRECTORY,
  INTERNAL_DIRECTORY,
  SERVER_DIRECTORY,
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

  return `/_nextsx/client/${encodePathForUrl(compiledPath)}`;
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
    if (!path.isAbsolute(moduleId)) {
      return null;
    }

    if (!moduleId.startsWith(projectRoot)) {
      return null;
    }

    if (assetManifest) {
      return getAssetByClientModule(
        assetManifest,
        toClientModuleRelativePath(projectRoot, moduleId),
      )?.publicUrl ?? null;
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
  return source.replaceAll(/__NEXTSX_ASSET_URL__:([^"]+)/g, (match, encodedRelativeAssetPath) => {
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
  return `/_nextsx/static/${encodePathForUrl(relativePath)}`;
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
        if (typeof value === "string" && value.startsWith("/_nextsx/")) {
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
    publicPathPrefix: "/_nextsx/static/",
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
    const rewritten = source.replaceAll(/__NEXTSX_ASSET_URL__:([A-Za-z0-9._/-]+)/g, (match, relativeAssetPath) => {
      return assetUrlByClientModule.get(relativeAssetPath) ?? match;
    }).replaceAll(/__NEXTSX_ASSET_URL__:([^"]+)/g, (match, encodedRelativeAssetPath) => {
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

function getClientRelativePathFromPublicUrl(publicUrl) {
  if (typeof publicUrl !== "string" || !publicUrl.startsWith("/_nextsx/client/")) {
    return null;
  }

  return publicUrl.slice("/_nextsx/client/".length);
}

function resolveRelativeClientImportPath(fromRelativePath, specifier) {
  return path.normalize(
    path.join(path.dirname(fromRelativePath), specifier),
  ).split(path.sep).join("/");
}

export async function collectDevStyleUrls(projectRoot, publicUrls, mode = "development") {
  const clientRoot = getClientOutputRoot(projectRoot, mode);
  const visitedModules = new Set();
  const pendingModules = publicUrls
    .map((publicUrl) => getClientRelativePathFromPublicUrl(publicUrl))
    .filter((relativePath) => typeof relativePath === "string");
  const collectedStyleUrls = new Set();

  while (pendingModules.length > 0) {
    const currentModule = pendingModules.shift();
    if (!currentModule || visitedModules.has(currentModule)) {
      continue;
    }

    visitedModules.add(currentModule);

    const modulePath = path.join(clientRoot, currentModule);
    let source = "";
    try {
      source = await fs.readFile(modulePath, "utf8");
    } catch {
      continue;
    }

    try {
      const metadata = JSON.parse(await fs.readFile(`${modulePath}.meta.json`, "utf8"));
      for (const styleImport of Array.isArray(metadata?.styleImports) ? metadata.styleImports : []) {
        collectedStyleUrls.add(`/_nextsx/client/${styleImport}`);
      }
    } catch {
      // Ignore missing metadata; not every module imports styles.
    }

    for (const match of source.matchAll(BARE_SPECIFIER_PATTERN)) {
      const specifier = match[1] ?? match[2] ?? null;
      if (
        !specifier ||
        (!specifier.startsWith("./") && !specifier.startsWith("../")) ||
        !specifier.endsWith(".mjs")
      ) {
        continue;
      }

      pendingModules.push(resolveRelativeClientImportPath(currentModule, specifier));
    }
  }

  return [...collectedStyleUrls].sort();
}

export function normalizeClientAssetManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.assets)) {
    return null;
  }

  return {
    version: manifest.version ?? CLIENT_ASSET_MANIFEST_VERSION,
    publicPathPrefix: manifest.publicPathPrefix ?? "/_nextsx/static/",
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
