import fs from "node:fs/promises";
import path from "node:path";
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
  return `
import { hydratePage, readHydrationData } from "@litsx/ssr/hydration";

const rootModuleUrls = ${JSON.stringify(rootModuleUrls, null, 2)};

await hydratePage({
  register: async () => {
    const hydration = readHydrationData(document);
    const roots = Array.isArray(hydration?.roots) ? hydration.roots : [];
    const seen = new Set();

    for (const root of roots) {
      if (!root || typeof root !== "object") {
        continue;
      }

      const tagName = typeof root.tagName === "string" ? root.tagName : null;
      const moduleId = typeof root.moduleId === "string" ? root.moduleId : null;
      if (!tagName || !moduleId) {
        continue;
      }

      const moduleUrl = rootModuleUrls[moduleId];
      if (!moduleUrl || seen.has(tagName) || customElements.get(tagName)) {
        continue;
      }

      const moduleRecord = await import(moduleUrl);
      const ctor = moduleRecord?.default;
      if (typeof ctor !== "function") {
        continue;
      }

      if (!customElements.get(tagName)) {
        customElements.define(tagName, ctor);
      }

      seen.add(tagName);
    }
  },
});
`.trim();
}
