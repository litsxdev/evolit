import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import {
  BUILD_DIRECTORY,
  CLIENT_DIRECTORY,
  DEV_DIRECTORY,
  INTERNAL_DIRECTORY,
} from "./constants.js";

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

export function createAssetResolver(projectRoot) {
  return function assetResolver(moduleId) {
    if (!path.isAbsolute(moduleId)) {
      return null;
    }

    if (!moduleId.startsWith(projectRoot)) {
      return null;
    }

    return getClientAssetUrl(projectRoot, moduleId);
  };
}

export function createHydrationBootstrap({ rootModuleUrls = {} } = {}) {
  return "";
}

function buildHydrationEntrySource(entries) {
  const imports = entries.map(
    ({ moduleUrl }, index) => `import Component${index} from ${JSON.stringify(moduleUrl)};`,
  );
  const registrations = entries.map(
    ({ tagName }, index) => `
if (!customElements.get(${JSON.stringify(tagName)})) {
  customElements.define(${JSON.stringify(tagName)}, Component${index});
}
`.trim(),
  );

  return `${imports.join("\n")}

${registrations.join("\n\n")}
`;
}

export async function ensureHydrationClientEntry({
  projectRoot,
  mode,
  hydrationData,
  assetResolver,
}) {
  const rootEntries = [...new Map(
    (hydrationData?.roots ?? [])
      .filter((root) => typeof root?.moduleId === "string" && typeof root?.tagName === "string")
      .map((root) => {
        const moduleUrl = assetResolver?.(root.moduleId) ?? null;
        return [`${root.tagName}::${moduleUrl}`, {
          tagName: root.tagName,
          moduleUrl,
        }];
      })
      .filter(([, entry]) => typeof entry.moduleUrl === "string" && entry.moduleUrl.length > 0),
  ).values()];

  if (rootEntries.length === 0) {
    return null;
  }

  const hash = crypto
    .createHash("sha1")
    .update(JSON.stringify(rootEntries))
    .digest("hex")
    .slice(0, 12);
  const clientRoot = getClientOutputRoot(projectRoot, mode);
  const relativePath = path.join("__nextsx", "hydration", `${hash}.mjs`);
  const absolutePath = path.join(clientRoot, relativePath);

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, buildHydrationEntrySource(rootEntries), "utf8");

  return `/_nextsx/client/${relativePath.split(path.sep).join("/")}`;
}
