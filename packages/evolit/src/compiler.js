import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transformLitsx } from "@litsx/compiler";
import MagicString from "magic-string";
import remapping from "@jridgewell/remapping";
import ts from "typescript";
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
const CSS_DEPENDENCY_PATTERN = /(?:@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?|url\(\s*["']?([^"')]+)["']?\s*\))/g;
const RESOLVABLE_IMPORT_EXTENSIONS = [
  ...MODULE_EXTENSIONS,
  ...STATIC_ASSET_EXTENSIONS,
];
const developmentGraphCache = new Map();
const developmentGraphDependencies = new Map();
const developmentModuleNamespaceCache = new Map();
const developmentGraphVersions = new Map();
const developmentUnmanagedImportWarnings = new Set();
const projectPathAliasesCache = new Map();

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

function containsJsxSyntax(source, filePath) {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let containsJsx = false;

  function visit(node) {
    if (
      ts.isJsxElement(node)
      || ts.isJsxSelfClosingElement(node)
      || ts.isJsxFragment(node)
    ) {
      containsJsx = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return containsJsx;
}

function containsLitsxComponentMetadata(source, filePath) {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let containsMetadata = false;

  function visit(node) {
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left)
      && ts.isIdentifier(node.left.expression)
      && /^[A-Z]/.test(node.left.expression.text)
      && ["elements", "styles", "properties", "shadowRootOptions", "expose", "lightDom"].includes(node.left.name.text)
    ) {
      containsMetadata = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return containsMetadata;
}

function isLitsxAuthoredModule(filePath, source) {
  return (
    filePath.endsWith(".jsx")
    || filePath.endsWith(".tsx")
    || containsJsxSyntax(source, filePath)
    || containsLitsxComponentMetadata(source, filePath)
  );
}

function createIdentitySourceMap(source, sourcePath) {
  return JSON.parse(new MagicString(source).generateMap({
    hires: true,
    includeContent: true,
    source: sourcePath.split(path.sep).join("/"),
  }).toString());
}

function collectSideEffectImports(source, sourcePath) {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  return sourceFile.statements
    .filter((statement) => ts.isImportDeclaration(statement) && statement.importClause == null)
    .map((statement) => ({
      source: statement.moduleSpecifier.text,
      statement: source.slice(statement.getStart(sourceFile), statement.end),
    }));
}

function restoreSideEffectImports(source, sourcePath, transformed, sourceMaps) {
  const transformedSpecifiers = new Set(
    [...transformed.code.matchAll(MODULE_SPECIFIER_PATTERN)]
      .map((match) => match[1] ?? match[2])
      .filter(Boolean),
  );
  const missingImports = collectSideEffectImports(source, sourcePath)
    .filter((entry) => !transformedSpecifiers.has(entry.source));
  if (missingImports.length === 0) {
    return transformed;
  }

  const magicSource = new MagicString(transformed.code);
  magicSource.prepend(`${missingImports.map((entry) => entry.statement).join("\n")}\n`);
  let map = transformed.map ?? null;

  if (sourceMaps && map) {
    const intermediateSourceId = `${sourcePath.split(path.sep).join("/")}#evolit-side-effects`;
    const restoredMap = magicSource.generateMap({
      hires: true,
      includeContent: false,
      source: intermediateSourceId,
    });
    map = remapping(restoredMap.toString(), (mappedSource) => (
      mappedSource.endsWith("#evolit-side-effects") ? transformed.map : null
    ));
  }

  return {
    ...transformed,
    code: magicSource.toString(),
    map,
  };
}

async function transformModuleSource(source, {
  sourcePath,
  sourceMaps,
  ssr = false,
}) {
  if (isLitsxAuthoredModule(sourcePath, source)) {
    const transformed = await transformLitsx(source, {
      filename: sourcePath,
      sourceMaps,
      ssr,
    });
    return restoreSideEffectImports(source, sourcePath, transformed, sourceMaps);
  }

  if (sourcePath.endsWith(".ts")) {
    const result = ts.transpileModule(source, {
      fileName: sourcePath,
      compilerOptions: {
        inlineSources: sourceMaps,
        module: ts.ModuleKind.ESNext,
        sourceMap: sourceMaps,
        target: ts.ScriptTarget.ESNext,
      },
    });
    const map = sourceMaps && result.sourceMapText
      ? JSON.parse(result.sourceMapText)
      : null;
    if (map) {
      map.sources = [sourcePath.split(path.sep).join("/")];
      map.sourcesContent = [source];
    }
    return {
      code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, ""),
      map,
      metadata: {},
    };
  }

  return {
    code: source,
    map: sourceMaps ? createIdentitySourceMap(source, sourcePath) : null,
    metadata: {},
  };
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

// This is emitted by the LitSX compiler for every async LitSX server
// component. Inspecting the generated semantic marker keeps the boundary
// independent from route filenames, directory names, or import conventions.
function isCompiledServerComponentModule(code) {
  return /\[\s*LITSX_SERVER_COMPONENT\s*\]\s*=\s*true\b/.test(code);
}

function isCompiledClientBoundaryModule(code) {
  return (
    /Symbol\.for\("litsx\.component"\)/.test(code)
    || /\bclass(?:\s+[A-Za-z_$][\w$]*)?\s+extends\s+(?:LitElement|HTMLElement)\b/.test(code)
    || /\bcustomElements\.define\s*\(/.test(code)
  );
}

function createMixedModuleClientProjection(code, sourcePath) {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const serverExports = new Set();
  for (const statement of sourceFile.statements) {
    if (
      ts.isExpressionStatement(statement)
      && ts.isBinaryExpression(statement.expression)
      && ts.isElementAccessExpression(statement.expression.left)
      && ts.isIdentifier(statement.expression.left.expression)
      && ts.isIdentifier(statement.expression.left.argumentExpression)
      && statement.expression.left.argumentExpression.text === "LITSX_SERVER_COMPONENT"
    ) {
      serverExports.add(statement.expression.left.expression.text);
    }
  }
  if (serverExports.size === 0) return code;

  const transformer = (context) => {
    const visit = (node) => {
      if (
        (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
        && node.name
        && serverExports.has(node.name.text)
      ) return undefined;
      if (
        ts.isVariableStatement(node)
        && node.declarationList.declarations.some((declaration) =>
          ts.isIdentifier(declaration.name) && serverExports.has(declaration.name.text)
        )
      ) return undefined;
      if (
        ts.isExpressionStatement(node)
        && ts.isBinaryExpression(node.expression)
        && ts.isElementAccessExpression(node.expression.left)
        && ts.isIdentifier(node.expression.left.expression)
        && serverExports.has(node.expression.left.expression.text)
      ) return undefined;
      return ts.visitEachChild(node, visit, context);
    };
    return (root) => ts.visitNode(root, visit);
  };
  const transformed = ts.transform(sourceFile, [transformer]);
  try {
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    const projectedCode = printer.printFile(transformed.transformed[0]);
    const projectedFile = ts.createSourceFile(
      sourcePath,
      projectedCode,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const referencedNames = new Set();
    const collectReferences = (node) => {
      if (ts.isIdentifier(node)) referencedNames.add(node.text);
      ts.forEachChild(node, collectReferences);
    };
    for (const statement of projectedFile.statements) {
      if (!ts.isImportDeclaration(statement)) collectReferences(statement);
    }
    const pruneImports = (context) => {
      const visit = (node) => {
        if (!ts.isImportDeclaration(node) || !node.importClause) {
          return ts.visitEachChild(node, visit, context);
        }
        const defaultImport = node.importClause.name && referencedNames.has(node.importClause.name.text)
          ? node.importClause.name
          : undefined;
        let namedBindings;
        if (node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
          const elements = node.importClause.namedBindings.elements
            .filter((element) => referencedNames.has(element.name.text));
          if (elements.length > 0) namedBindings = ts.factory.updateNamedImports(
            node.importClause.namedBindings,
            elements,
          );
        } else if (
          node.importClause.namedBindings
          && referencedNames.has(node.importClause.namedBindings.name.text)
        ) {
          namedBindings = node.importClause.namedBindings;
        }
        if (!defaultImport && !namedBindings) return undefined;
        return ts.factory.updateImportDeclaration(
          node,
          node.modifiers,
          ts.factory.updateImportClause(
            node.importClause,
            node.importClause.isTypeOnly,
            defaultImport,
            namedBindings,
          ),
          node.moduleSpecifier,
          node.attributes,
        );
      };
      return (root) => ts.visitNode(root, visit);
    };
    const pruned = ts.transform(projectedFile, [pruneImports]);
    try {
      return printer.printFile(pruned.transformed[0]);
    } finally {
      pruned.dispose();
    }
  } finally {
    transformed.dispose();
  }
}

function getCompiledServerComponentExports(code, sourcePath) {
  if (!isCompiledServerComponentModule(code)) return new Set();
  const sourceFile = ts.createSourceFile(sourcePath, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const markedNames = new Set();
  for (const statement of sourceFile.statements) {
    if (
      ts.isExpressionStatement(statement)
      && ts.isBinaryExpression(statement.expression)
      && ts.isElementAccessExpression(statement.expression.left)
      && ts.isIdentifier(statement.expression.left.expression)
      && ts.isIdentifier(statement.expression.left.argumentExpression)
      && statement.expression.left.argumentExpression.text === "LITSX_SERVER_COMPONENT"
    ) markedNames.add(statement.expression.left.expression.text);
  }
  const exports = new Set();
  for (const statement of sourceFile.statements) {
    if (!statement.name || !ts.isIdentifier(statement.name) || !markedNames.has(statement.name.text)) continue;
    const modifiers = statement.modifiers ?? [];
    if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) exports.add("default");
    else if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) exports.add(statement.name.text);
  }
  return exports;
}

function collectImportedNamesBySpecifier(code, sourcePath) {
  const sourceFile = ts.createSourceFile(sourcePath, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const bySpecifier = new Map();
  const add = (specifier, name) => {
    const names = bySpecifier.get(specifier) ?? new Set();
    names.add(name);
    bySpecifier.set(specifier, names);
  };
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      if (statement.importClause?.name) add(specifier, "default");
      if (statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
        for (const element of statement.importClause.namedBindings.elements) {
          add(specifier, element.propertyName?.text ?? element.name.text);
        }
      } else if (statement.importClause?.namedBindings) add(specifier, "*");
    } else if (
      ts.isExportDeclaration(statement)
      && statement.moduleSpecifier
      && ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const specifier = statement.moduleSpecifier.text;
      if (!statement.exportClause) add(specifier, "*");
      else if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) add(specifier, element.propertyName?.text ?? element.name.text);
      }
    }
  }
  const visit = (node) => {
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
    ) add(node.arguments[0].text, "*");
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bySpecifier;
}

function createClientServerComponentImportError(entryPath, sourcePath, parents) {
  const chain = [sourcePath];
  let current = sourcePath;
  const seen = new Set([current]);

  while (parents.has(current)) {
    current = parents.get(current);
    if (seen.has(current)) break;
    seen.add(current);
    chain.unshift(current);
  }

  if (chain[0] !== entryPath) {
    chain.unshift(entryPath);
  }

  return new Error(
    [
      "A client/hydratable module cannot import a LitSX Server Component.",
      `Import chain: ${chain.join(" -> ")}`,
      `"${sourcePath}" is marked with LITSX_SERVER_COMPONENT and can only execute on the server.`,
      "Pass serializable data from a Server Component to a client component instead.",
    ].join(" "),
  );
}

function isPathOutsideProject(projectRoot, filePath) {
  const relativePath = path.relative(projectRoot, filePath);
  return (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  );
}

function isPathOutsideManagedRoots(projectRoot, managedSourceRoots, filePath) {
  const roots = managedSourceRoots?.length > 0 ? managedSourceRoots : [projectRoot];
  return roots.every((sourceRoot) => isPathOutsideProject(path.resolve(sourceRoot), filePath));
}

function reportDevelopmentUnmanagedImport(projectRoot, sourcePath, resolvedImportPath, onDevelopmentEvent) {
  const warningKey = `${path.resolve(projectRoot)}::${sourcePath}::${resolvedImportPath}`;
  if (developmentUnmanagedImportWarnings.has(warningKey)) {
    return;
  }

  developmentUnmanagedImportWarnings.add(warningKey);
  onDevelopmentEvent?.({
    type: "unmanaged-import",
    sourcePath,
    resolvedImportPath,
  });
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
  const cleanSpecifier = String(specifier).split("?")[0].split("#")[0];
  const basePath = path.resolve(path.dirname(importerPath), cleanSpecifier);
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

async function collectStaticAssetGraph(entryPath, collected = new Set()) {
  const normalizedEntryPath = path.resolve(entryPath);
  if (collected.has(normalizedEntryPath) || !isStaticAssetPath(normalizedEntryPath)) {
    return collected;
  }

  collected.add(normalizedEntryPath);
  if (!isStyleAssetPath(normalizedEntryPath)) {
    return collected;
  }

  const source = await fs.readFile(normalizedEntryPath, "utf8");
  for (const match of source.matchAll(CSS_DEPENDENCY_PATTERN)) {
    const specifier = match[1] ?? match[2];
    if (!specifier || !isRelativeSpecifier(specifier)) continue;
    const resolvedPath = await resolveImportPath(normalizedEntryPath, specifier);
    if (resolvedPath && isStaticAssetPath(resolvedPath)) {
      await collectStaticAssetGraph(resolvedPath, collected);
    }
  }
  return collected;
}

async function loadProjectPathAliases(projectRoot) {
  if (projectPathAliasesCache.has(projectRoot)) return projectPathAliasesCache.get(projectRoot);
  const pending = (async () => {
    for (const configName of ["tsconfig.json", "jsconfig.json"]) {
      const configPath = path.join(projectRoot, configName);
      try {
        await fs.access(configPath);
        let unrecoverableError = null;
        const parsed = ts.getParsedCommandLineOfConfigFile(
          configPath,
          {},
          {
            ...ts.sys,
            onUnRecoverableConfigFileDiagnostic(diagnostic) {
              unrecoverableError = new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
            },
          },
        );
        if (unrecoverableError) throw unrecoverableError;
        const compilerOptions = parsed?.options ?? {};
        const baseUrl = path.resolve(
          compilerOptions.pathsBasePath
            ?? compilerOptions.baseUrl
            ?? path.dirname(configPath),
        );
        return Object.entries(compilerOptions.paths ?? {}).map(([pattern, replacements]) => ({
          pattern,
          replacements: Array.isArray(replacements) ? replacements : [],
          baseUrl,
        }));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return [];
  })();
  projectPathAliasesCache.set(projectRoot, pending);
  return pending;
}

async function findNearestPackageScope(startPath) {
  let currentPath = path.dirname(startPath);
  const visited = new Set();
  while (!visited.has(currentPath)) {
    visited.add(currentPath);
    const packagePath = path.join(currentPath, "package.json");
    try {
      return {
        packageRoot: currentPath,
        packageJson: JSON.parse(await fs.readFile(packagePath, "utf8")),
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) break;
    currentPath = parentPath;
  }
  return null;
}

function matchPathAlias(pattern, specifier) {
  const wildcardIndex = pattern.indexOf("*");
  if (wildcardIndex < 0) return pattern === specifier ? "" : null;
  const prefix = pattern.slice(0, wildcardIndex);
  const suffix = pattern.slice(wildcardIndex + 1);
  return specifier.startsWith(prefix) && specifier.endsWith(suffix)
    ? specifier.slice(prefix.length, specifier.length - suffix.length)
    : null;
}

function parsePackageSpecifier(specifier) {
  const segments = specifier.split("/");
  if (specifier.startsWith("@")) {
    if (segments.length < 2) return null;
    return { packageName: `${segments[0]}/${segments[1]}`, subpath: segments.slice(2).join("/") };
  }
  return { packageName: segments[0], subpath: segments.slice(1).join("/") };
}

function pickPackageExportTarget(target, wildcard = "") {
  if (typeof target === "string") return target.replace("*", wildcard);
  if (Array.isArray(target)) {
    for (const candidate of target) {
      const resolved = pickPackageExportTarget(candidate, wildcard);
      if (resolved) return resolved;
    }
    return null;
  }
  if (!target || typeof target !== "object") return null;
  for (const condition of ["browser", "import", "default", "module", "require"]) {
    const resolved = pickPackageExportTarget(target[condition], wildcard);
    if (resolved) return resolved;
  }
  return null;
}

function resolvePackageExports(exportsField, exportKey) {
  if (typeof exportsField === "string" || Array.isArray(exportsField)) {
    return exportKey === "." ? pickPackageExportTarget(exportsField) : null;
  }
  if (!exportsField || typeof exportsField !== "object") return null;
  if (!Object.keys(exportsField).some((key) => key.startsWith(".") || key.startsWith("#"))) {
    return exportKey === "." ? pickPackageExportTarget(exportsField) : null;
  }
  if (exportsField[exportKey] != null) return pickPackageExportTarget(exportsField[exportKey]);
  for (const [pattern, target] of Object.entries(exportsField)) {
    const wildcard = matchPathAlias(pattern, exportKey);
    if (wildcard != null && pattern.includes("*")) {
      return pickPackageExportTarget(target, wildcard);
    }
  }
  return null;
}

async function resolveProjectPackageImportMap(importerPath, specifier) {
  if (!specifier.startsWith("#")) return null;
  const packageScope = await findNearestPackageScope(importerPath);
  if (!packageScope?.packageJson?.imports) return null;
  const target = resolvePackageExports(packageScope.packageJson.imports, specifier);
  if (typeof target !== "string") return null;
  if (target.startsWith(".")) {
    return resolveImportPath(path.join(packageScope.packageRoot, "__package__.js"), target);
  }
  return resolveProjectPackageImport(packageScope.packageRoot, importerPath, target);
}

async function resolveProjectPackageImport(projectRoot, importerPath, specifier) {
  const parsed = parsePackageSpecifier(specifier);
  if (!parsed) return null;
  let currentPath = path.dirname(importerPath);
  const visited = new Set();

  while (!visited.has(currentPath)) {
    visited.add(currentPath);
    const packageRoot = path.join(currentPath, "node_modules", ...parsed.packageName.split("/"));
    try {
      const packageJson = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
      const exportKey = parsed.subpath ? `./${parsed.subpath}` : ".";
      const hasExports = packageJson.exports != null;
      let target = resolvePackageExports(packageJson.exports, exportKey)
        ?? (hasExports
          ? null
          : parsed.subpath
            ? `./${parsed.subpath}`
            : typeof packageJson.browser === "string"
              ? packageJson.browser
              : packageJson.module ?? packageJson.main);
      if (target && packageJson.browser && typeof packageJson.browser === "object") {
        const normalizedTarget = target.startsWith("./") ? target : `./${target}`;
        const browserTarget = packageJson.browser[normalizedTarget]
          ?? packageJson.browser[target]
          ?? packageJson.browser[exportKey];
        if (browserTarget === false) return null;
        if (typeof browserTarget === "string") target = browserTarget;
      }
      if (typeof target === "string") {
        const resolved = await resolveImportPath(path.join(packageRoot, "__package__.js"), target);
        if (resolved) return resolved;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) break;
    currentPath = parentPath;
  }

  if (!path.resolve(importerPath).startsWith(`${path.resolve(projectRoot)}${path.sep}`)) {
    return resolveProjectPackageImport(projectRoot, path.join(projectRoot, "__entry__.js"), specifier);
  }
  return null;
}

async function resolveProjectPathAlias(projectRoot, specifier) {
  for (const alias of await loadProjectPathAliases(path.resolve(projectRoot))) {
    const wildcard = matchPathAlias(alias.pattern, specifier);
    if (wildcard == null) continue;
    for (const replacement of alias.replacements) {
      const candidate = replacement.replace("*", wildcard);
      const candidatePath = path.isAbsolute(candidate) ? candidate : path.resolve(alias.baseUrl, candidate);
      const resolved = await resolveImportPath(path.join(alias.baseUrl, "__alias__.js"), candidatePath);
      if (resolved) return resolved;
    }
  }
  return null;
}

async function resolveProjectRootAlias(projectRoot, specifier) {
  if (!specifier.startsWith("@/") || specifier.length === 2) return null;

  const normalizedProjectRoot = path.resolve(projectRoot);
  const candidatePath = path.resolve(normalizedProjectRoot, specifier.slice(2));
  const relativePath = path.relative(normalizedProjectRoot, candidatePath);
  const isOutsideProject =
    relativePath === ".."
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath);
  if (isOutsideProject) return null;

  return resolveImportPath(path.join(normalizedProjectRoot, "__alias__.js"), candidatePath);
}

async function resolveProjectMappedImport(projectRoot, importerPath, specifier) {
  return await resolveProjectPathAlias(projectRoot, specifier)
    ?? await resolveProjectRootAlias(projectRoot, specifier)
    ?? await resolveProjectPackageImportMap(importerPath, specifier);
}

export async function resolveProjectModuleSpecifier(projectRoot, importerPath, specifier) {
  if (isRelativeSpecifier(specifier)) return resolveImportPath(importerPath, specifier);
  if (!isBareSpecifier(specifier)) return null;

  const aliasedPath = await resolveProjectMappedImport(projectRoot, importerPath, specifier);
  if (aliasedPath) return aliasedPath;

  const packagePath = await resolveProjectPackageImport(projectRoot, importerPath, specifier);
  if (packagePath) return packagePath;

  try {
    let resolvedPath;
    try {
      resolvedPath = createRequire(pathToFileURL(path.join(projectRoot, "package.json"))).resolve(specifier);
    } catch {
      const resolvedUrl = import.meta.resolve(specifier, pathToFileURL(importerPath).href);
      if (!resolvedUrl.startsWith("file:")) return null;
      resolvedPath = fileURLToPath(resolvedUrl);
    }
    return shouldCompileModule(resolvedPath) ? resolvedPath : null;
  } catch {
    return null;
  }
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
  const relativePath = toOutputRelativePath(projectRoot, sourcePath);
  const extension = path.extname(relativePath);
  if (!extension) {
    return path.join(outputRoot, `${relativePath}.mjs`);
  }

  return path.join(
    outputRoot,
    `${relativePath.slice(0, -extension.length)}.mjs`,
  );
}

function toOutputRelativePath(projectRoot, sourcePath) {
  const relativePath = path.relative(projectRoot, sourcePath);
  const isOutsideProject =
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath);
  if (!isOutsideProject) {
    return relativePath;
  }

  return path.join(
    "__unmanaged__",
    ...relativePath.split(path.sep).map((segment) => segment === ".." ? "__up__" : segment),
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
  onDevelopmentEvent,
  staticAssetFiles,
  managedSourceRoots,
  serverExportsByModule,
  packageImports,
}) {
  const magicSource = new MagicString(code);
  let didRewrite = false;
  const importedNamesBySpecifier = target === "client"
    ? collectImportedNamesBySpecifier(code, sourcePath)
    : new Map();

  for (const match of code.matchAll(MODULE_SPECIFIER_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? null;
    if (!specifier) {
      continue;
    }

    const aliasedImportPath = isBareSpecifier(specifier)
      ? await resolveProjectMappedImport(projectRoot, sourcePath, specifier)
      : null;
    const packageImportPath = isBareSpecifier(specifier) && !aliasedImportPath
      ? await resolveProjectPackageImport(projectRoot, sourcePath, specifier)
      : null;
    const packageAssetPath = packageImportPath && isStaticAssetPath(packageImportPath)
      ? packageImportPath
      : null;

    if (
      target === "server"
      && isBareSpecifier(specifier)
      && !aliasedImportPath
      && !packageAssetPath
    ) {
      packageImports?.add(specifier);
    }

    if (
      target === "client"
      && isBareSpecifier(specifier)
      && !aliasedImportPath
      && !packageAssetPath
    ) {
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

    if (!isRelativeSpecifier(specifier) && !aliasedImportPath && !packageAssetPath) {
      continue;
    }

    const resolvedImportPath = packageAssetPath
      ?? aliasedImportPath
      ?? await resolveImportPath(sourcePath, specifier);
    if (!resolvedImportPath) {
      continue;
    }

    if (
      mode === "development"
      && isPathOutsideManagedRoots(projectRoot, managedSourceRoots, resolvedImportPath)
    ) {
      reportDevelopmentUnmanagedImport(projectRoot, sourcePath, resolvedImportPath, onDevelopmentEvent);
    }

    const importerOutputPath = toOutputPath(projectRoot, outputRoot, sourcePath);
    let compiledImportPath = null;

    if (shouldCompileModule(resolvedImportPath)) {
      compiledImportPath = await compileModule(resolvedImportPath);
      const serverExports = serverExportsByModule?.get(resolvedImportPath) ?? new Set();
      const importedNames = importedNamesBySpecifier.get(specifier) ?? new Set();
      if (
        target === "client"
        && serverExports.size > 0
        && ([...importedNames].some((name) => name === "*" || serverExports.has(name)))
      ) {
        throw new Error(
          `Client module ${sourcePath} imports Server Component export(s) from ${resolvedImportPath}: `
          + `${[...serverExports].join(", ")}. Import only that module's client exports or split the exports into separate files.`,
        );
      }
    } else if (isStaticAssetPath(resolvedImportPath)) {
      const staticAssetGraph = await collectStaticAssetGraph(resolvedImportPath);
      for (const staticAssetPath of staticAssetGraph) {
        staticAssetFiles?.add(staticAssetPath);
      }
      const relativeAssetPath = toOutputRelativePath(projectRoot, resolvedImportPath);
      const assetOutputPath = path.join(outputRoot, relativeAssetPath);
      const stubOutputPath = `${assetOutputPath}.mjs`;

      await ensureDirectory(path.dirname(stubOutputPath));
      await fs.writeFile(
        stubOutputPath,
        createStaticAssetStubSource(relativeAssetPath, mode, target, staticAssetPublicUrls),
        "utf8",
      );

      if (target === "client") {
        for (const staticAssetPath of staticAssetGraph) {
          const staticAssetOutputPath = path.join(
            outputRoot,
            toOutputRelativePath(projectRoot, staticAssetPath),
          );
          await ensureDirectory(path.dirname(staticAssetOutputPath));
          await fs.copyFile(staticAssetPath, staticAssetOutputPath);
        }
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

function wrapDevelopmentHydratableExports(code, moduleId, inputSourceMap = null) {
  const sourcePath = moduleId;
  const sourceFile = ts.createSourceFile(sourcePath, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const magicSource = new MagicString(code);
  const exports = [];
  let index = 0;
  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.name) continue;
    const isHydratable = statement.members.some((member) =>
      member.name?.getText(sourceFile).includes('Symbol.for("litsx.hydratableTag")')
    );
    if (!isHydratable) continue;
    const modifiers = statement.modifiers ?? [];
    const isExported = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!isExported) continue;
    const isDefault = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
    for (const modifier of modifiers) {
      if (modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword) {
        magicSource.remove(modifier.getStart(sourceFile), modifier.end);
      }
    }
    const className = statement.name.text;
    const proxyName = `__evolit_hot_${className}_${index++}`;
    exports.push(
      `const ${proxyName} = __evolitHotComponent(${JSON.stringify(moduleId)}, ${className});`,
      isDefault ? `export default ${proxyName};` : `export { ${proxyName} as ${className} };`,
    );
  }
  if (exports.length === 0) return { code, map: inputSourceMap };
  magicSource.append(
    '\nimport { hotComponent as __evolitHotComponent } from "evolit/internal/development-hot";\n'
      + `${exports.join("\n")}\n`,
  );
  const hotTransformSource = `${moduleId}#evolit-hot`;
  const hotTransformMap = magicSource.generateMap({
    hires: true,
    includeContent: false,
    source: hotTransformSource,
    file: moduleId,
  });
  return {
    code: magicSource.toString(),
    map: inputSourceMap
      ? remapping(hotTransformMap.toString(), (source) => (
        source.endsWith("#evolit-hot") ? inputSourceMap : null
      ))
      : null,
  };
}

export function invalidateDevelopmentCompilationCache(projectRoot, changedPaths = null) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const prefix = `${resolvedProjectRoot}::`;
  const normalizedChangedPaths = Array.isArray(changedPaths) && changedPaths.length > 0
    ? new Set(changedPaths.map((changedPath) => path.resolve(changedPath)))
    : null;
  let invalidated = false;

  if (
    normalizedChangedPaths == null
    || [...normalizedChangedPaths].some((changedPath) =>
      /^(?:tsconfig|jsconfig)(?:\..+)?\.json$/.test(path.basename(changedPath))
    )
  ) {
    projectPathAliasesCache.delete(resolvedProjectRoot);
  }

  if (normalizedChangedPaths == null) {
    for (const warningKey of developmentUnmanagedImportWarnings) {
      if (warningKey.startsWith(prefix)) {
        developmentUnmanagedImportWarnings.delete(warningKey);
      }
    }
  }

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
    onDevelopmentEvent,
    managedSourceRoots,
  } = options;

  const outputRoot = getTypedOutputRoot(projectRoot, mode, target);
  const visited = new Map();
  const clientImportParents = new Map();
  const staticAssetFiles = new Set();
  const moduleMetadata = new Map();
  const serverExportsByModule = new Map();
  const packageImports = new Set();
  const serverImportQuery = target === "server" && mode === "development"
    ? `t=${Date.now()}`
    : null;

  async function compileModule(sourcePath, importerPath = null) {
    if (
      target === "client" &&
      importerPath &&
      !clientImportParents.has(sourcePath)
    ) {
      clientImportParents.set(sourcePath, importerPath);
    }
    if (visited.has(sourcePath)) {
      return visited.get(sourcePath);
    }

    const outputPath = toOutputPath(projectRoot, outputRoot, sourcePath);
    visited.set(sourcePath, outputPath);

    await ensureDirectory(path.dirname(outputPath));
    const source = await fs.readFile(sourcePath, "utf8");
    const transformed = await transformModuleSource(source, {
      projectRoot,
      sourcePath,
      sourceMaps,
      ssr,
    });
    const isServerComponentModule = isCompiledServerComponentModule(transformed.code);
    const isMixedComponentModule = isServerComponentModule
      && isCompiledClientBoundaryModule(transformed.code);
    serverExportsByModule.set(sourcePath, getCompiledServerComponentExports(transformed.code, sourcePath));
    if (target === "client" && isServerComponentModule && !isMixedComponentModule) {
      throw createClientServerComponentImportError(
        entryPath,
        sourcePath,
        clientImportParents,
      );
    }
    const projectedCode = target === "client" && isMixedComponentModule
      ? createMixedModuleClientProjection(transformed.code, sourcePath)
      : transformed.code;
    const targetTransform = target === "client" && mode === "development"
      ? wrapDevelopmentHydratableExports(
        projectedCode,
        path.relative(projectRoot, sourcePath).split(path.sep).join("/"),
        projectedCode === transformed.code ? transformed.map ?? null : null,
      )
      : {
        code: projectedCode,
        map: projectedCode === transformed.code ? transformed.map ?? null : null,
      };
    const rewritten = await rewriteRelativeSpecifiers({
      projectRoot,
      outputRoot,
      sourcePath,
      code: targetTransform.code,
      compileModule: (resolvedImportPath) => compileModule(resolvedImportPath, sourcePath),
      moduleMetadata,
      mode,
      target,
      staticAssetPublicUrls,
      serverImportQuery,
      sourceMaps,
      outputPath,
      inputSourceMap: targetTransform.map,
      onDevelopmentEvent,
      staticAssetFiles,
      managedSourceRoots,
      serverExportsByModule,
      packageImports,
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
    sourceFiles: [...new Set([...visited.keys(), ...staticAssetFiles])],
    packageImports: [...packageImports].sort(),
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

function normalizeProjectRelativePath(projectRoot, filePath) {
  return toOutputRelativePath(projectRoot, filePath).split(path.sep).join("/");
}

export function getClientStaticAssetModule(projectRoot, filePath) {
  return normalizeProjectRelativePath(path.resolve(projectRoot), filePath);
}

export function getCompiledClientModule(projectRoot, filePath) {
  const relativePath = getClientStaticAssetModule(projectRoot, filePath);
  const extension = path.extname(relativePath);
  return extension ? `${relativePath.slice(0, -extension.length)}.mjs` : `${relativePath}.mjs`;
}

/**
 * Classify a server render graph without relying on route or filename
 * conventions. Synchronous LitSX components are client boundaries; async
 * components carrying LITSX_SERVER_COMPONENT remain server-only. Static
 * assets reached before a client boundary are returned separately so callers
 * can publish them without promoting the importing server module to client JS.
 */
export async function collectClientGraphInventory(entryPaths, options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const visited = new Set();
  const boundaries = new Set();
  const packageBoundaries = new Map();
  const styles = new Set();
  const assets = new Set();

  function collectComponentImportSpecifiers(source, sourcePath) {
    const sourceFile = ts.createSourceFile(
      sourcePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const importsByLocalName = new Map();
    const componentNames = new Set();

    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name) importsByLocalName.set(clause.name.text, statement.moduleSpecifier.text);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          importsByLocalName.set(element.name.text, statement.moduleSpecifier.text);
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        importsByLocalName.set(bindings.name.text, statement.moduleSpecifier.text);
      }
    }

    function recordTagName(tagName) {
      if (ts.isIdentifier(tagName)) componentNames.add(tagName.text);
      else if (ts.isPropertyAccessExpression(tagName)) {
        let expression = tagName.expression;
        while (ts.isPropertyAccessExpression(expression)) expression = expression.expression;
        if (ts.isIdentifier(expression)) componentNames.add(expression.text);
      }
    }

    function visit(node, insideElements = false) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        recordTagName(node.tagName);
      }
      const isElementsAssignment = ts.isBinaryExpression(node)
        && ts.isPropertyAccessExpression(node.left)
        && node.left.name.text === "elements";
      const nextInsideElements = insideElements || isElementsAssignment;
      if (nextInsideElements && ts.isIdentifier(node) && importsByLocalName.has(node.text)) {
        componentNames.add(node.text);
      }
      ts.forEachChild(node, (child) => visit(child, nextInsideElements));
    }
    visit(sourceFile);

    return new Set(
      [...componentNames]
        .map((name) => importsByLocalName.get(name))
        .filter((specifier) => typeof specifier === "string"),
    );
  }

  async function visitStyle(stylePath) {
    if (visited.has(stylePath)) return;
    visited.add(stylePath);
    styles.add(stylePath);

    const source = await fs.readFile(stylePath, "utf8");
    for (const match of source.matchAll(CSS_DEPENDENCY_PATTERN)) {
      const specifier = match[1] ?? match[2];
      if (!specifier || !isRelativeSpecifier(specifier)) continue;
      const resolved = await resolveImportPath(stylePath, specifier);
      if (!resolved || !isStaticAssetPath(resolved)) continue;
      if (isStyleAssetPath(resolved)) await visitStyle(resolved);
      else {
        visited.add(resolved);
        assets.add(resolved);
      }
    }
  }

  async function visit(sourcePath, traverseNonBoundary = true) {
    if (visited.has(sourcePath)) return;
    visited.add(sourcePath);
    const source = await fs.readFile(sourcePath, "utf8");
    const transformed = await transformModuleSource(source, {
      projectRoot,
      sourcePath,
      sourceMaps: false,
    });
    const isServer = isCompiledServerComponentModule(transformed.code);
    const isComponent = isCompiledClientBoundaryModule(transformed.code);
    if (isComponent && !isServer) {
      boundaries.add(sourcePath);
      return;
    }
    if (isComponent && isServer) boundaries.add(sourcePath);
    if (!traverseNonBoundary) return;
    const componentImportSpecifiers = collectComponentImportSpecifiers(source, sourcePath);
    for (const match of source.matchAll(MODULE_SPECIFIER_PATTERN)) {
      const specifier = match[1] ?? match[2];
      if (!specifier) continue;
      const aliasResolved = isBareSpecifier(specifier)
        ? await resolveProjectMappedImport(projectRoot, sourcePath, specifier)
        : null;
      const resolved = aliasResolved
        ?? await resolveProjectModuleSpecifier(projectRoot, sourcePath, specifier);
      if (!resolved) continue;
      if (shouldCompileModule(resolved)) {
        if (isBareSpecifier(specifier) && aliasResolved == null) {
          if (componentImportSpecifiers.has(specifier)) {
            boundaries.add(resolved);
            packageBoundaries.set(specifier, resolved);
          }
        } else {
          await visit(resolved, true);
        }
      }
      else if (isStyleAssetPath(resolved)) await visitStyle(resolved);
      else if (isStaticAssetPath(resolved)) {
        visited.add(resolved);
        assets.add(resolved);
      }
    }
  }

  for (const entryPath of entryPaths) await visit(entryPath);
  return {
    clientBoundaries: [...boundaries].sort(),
    packageClientBoundaries: [...packageBoundaries]
      .map(([specifier, sourcePath]) => ({ specifier, sourcePath }))
      .sort((left, right) => left.specifier.localeCompare(right.specifier)),
    styles: [...styles].sort(),
    assets: [...assets].sort(),
    sourceFiles: [...visited].sort(),
  };
}

export async function collectClientBoundaryModules(entryPaths, options = {}) {
  return (await collectClientGraphInventory(entryPaths, options)).clientBoundaries;
}

export async function emitClientStaticAssets(assetPaths, options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const mode = options.mode ?? "development";
  const outputRoot = getTypedOutputRoot(projectRoot, mode, "client");
  const emitted = [];

  const expandedAssetPaths = new Set();
  for (const assetPath of new Set(assetPaths ?? [])) {
    if (!isStaticAssetPath(assetPath)) continue;
    await collectStaticAssetGraph(assetPath, expandedAssetPaths);
  }

  for (const assetPath of expandedAssetPaths) {
    const relativePath = normalizeProjectRelativePath(projectRoot, assetPath);
    const outputPath = path.join(outputRoot, relativePath.split("/").join(path.sep));
    await ensureDirectory(path.dirname(outputPath));
    await fs.copyFile(assetPath, outputPath);
    emitted.push(relativePath);
  }

  return emitted.sort();
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
