import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { BUILD_DIRECTORY, DEV_DIRECTORY, INTERNAL_DIRECTORY } from "./constants.js";
import { ensureDirectory } from "./fs-utils.js";

const OUTPUT_KINDS = new Set(["asset", "module", "style"]);

function contextualError(error, context) {
  const original = error instanceof Error ? error : new Error(String(error));
  const details = Object.entries(context)
    .filter(([, value]) => value != null)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  return new Error(`LitSX integration failed (${details}): ${original.message}`, { cause: original });
}

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Expected ${label} to be an object.`);
  }
}

function normalizeCompilerOptions(value, label) {
  if (value == null) return {};
  assertRecord(value, label);
  return { ...value };
}

function mergeCompilerOptions(base, contribution) {
  const next = { ...base, ...contribution };
  for (const key of ["parserPlugins", "authoringPlugins", "outputPlugins"]) {
    const values = [...(base[key] ?? []), ...(contribution[key] ?? [])];
    if (values.length > 0) next[key] = values;
  }
  return next;
}

function normalizeOutput(output, integrationName) {
  assertRecord(output, `output from LitSX integration ${JSON.stringify(integrationName)}`);
  const { id, kind, content } = output;
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError(`Expected output.id from LitSX integration ${JSON.stringify(integrationName)} to be non-empty.`);
  }
  if (
    path.isAbsolute(id)
    || id.includes("\\")
    || id.split("/").some((segment) => segment === ".." || segment === "")
    || /^[a-z][a-z\d+.-]*:/iu.test(id)
  ) {
    throw new TypeError(`Unsafe LitSX integration output id ${JSON.stringify(id)} from ${JSON.stringify(integrationName)}.`);
  }
  if (!OUTPUT_KINDS.has(kind)) {
    throw new TypeError(`Unsupported LitSX integration output kind ${JSON.stringify(kind)} from ${JSON.stringify(integrationName)}.`);
  }
  if (typeof content !== "string" && !(content instanceof Uint8Array)) {
    throw new TypeError(`Expected output.content for ${JSON.stringify(id)} to be a string or Uint8Array.`);
  }
  if (kind === "style" && /<\/?(?:html|head|body|style|script)\b/iu.test(String(content))) {
    throw new TypeError(`LitSX integration style output ${JSON.stringify(id)} must contain CSS, not HTML.`);
  }
  const specifier = output.specifier;
  if (specifier != null) {
    if (
      kind !== "module"
      || typeof specifier !== "string"
      || !/^virtual:[@a-z\d][@a-z\d/._-]*$/iu.test(specifier)
      || specifier.split("/").some((segment) => segment === "..")
    ) {
      throw new TypeError(
        `Expected output.specifier for ${JSON.stringify(id)} to be a safe virtual: module identifier.`,
      );
    }
  }
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  return Object.freeze({
    id,
    kind,
    content,
    document: output.document === true,
    ...(specifier == null ? {} : { specifier }),
    hash: createHash("sha256").update(bytes).digest("hex").slice(0, 8),
    size: bytes.byteLength,
  });
}

function integrationPublicUrl(record) {
  const extension = path.posix.extname(record.id);
  const stem = extension ? record.id.slice(0, -extension.length) : record.id;
  const hashedId = `${stem}.${record.hash}${extension}`;
  return `/_evolit/static/integrations/${[
    record.integration,
    ...hashedId.split("/"),
  ].map((segment) => encodeURIComponent(segment)).join("/")}`;
}

/** Add a finalized integration generation to an Evolit client asset manifest. */
export function mergeLitsxAssetsIntoManifest(manifest, integrationManifest) {
  if (!manifest || !integrationManifest) return manifest;
  const integrationAssets = integrationManifest.assets.map((record) => ({
    clientModule: null,
    type: record.kind === "style" ? "style" : record.kind === "module" ? "script" : "asset",
    kind: `integration-${record.kind}`,
    publicUrl: integrationPublicUrl(record),
    outputPath: record.outputPath,
    hash: record.hash,
    size: record.size,
    imports: [],
    importUrls: [],
    styleImports: [],
    styleUrls: [],
    assetImports: [],
    assetUrls: [],
    integration: record.integration,
    integrationOutputId: record.id,
  }));
  const integrationUrls = new Map(
    integrationAssets.map((asset) => [`${asset.integration}:${asset.integrationOutputId}`, asset.publicUrl]),
  );
  const documentStyles = integrationManifest.documentStyles
    .map((record) => integrationUrls.get(`${record.integration}:${record.id}`))
    .filter(Boolean);
  return {
    ...manifest,
    byPublicPath: {
      ...(manifest.byPublicPath ?? {}),
      ...Object.fromEntries(integrationAssets.map((asset) => [asset.publicUrl, asset.outputPath])),
    },
    assets: [
      ...(manifest.assets ?? []).filter((asset) => !asset.integration),
      ...integrationAssets,
    ],
    documentStyles: [...new Set(documentStyles)].sort(),
  };
}

function canonicalDependency(projectRoot, dependency) {
  if (typeof dependency !== "string" || dependency.length === 0) {
    throw new TypeError("Expected every LitSX integration dependency to be a non-empty path.");
  }
  if (/^[a-z][a-z\d+.-]*:/iu.test(dependency)) {
    throw new TypeError(`LitSX integration dependency must be a filesystem path: ${JSON.stringify(dependency)}.`);
  }
  return path.resolve(projectRoot, dependency);
}

function normalizeContribution(value, integrationName, projectRoot) {
  if (value == null) return { result: null, dependencies: [], outputs: [] };
  assertRecord(value, `result from LitSX integration ${JSON.stringify(integrationName)}`);
  const dependencies = (value.dependencies ?? []).map((entry) => canonicalDependency(projectRoot, entry));
  const outputs = (value.outputs ?? []).map((entry) => normalizeOutput(entry, integrationName));
  const hasTransform = value.code != null || value.map !== undefined || value.metadata != null;
  return {
    result: hasTransform ? {
      code: value.code,
      map: value.map,
      metadata: value.metadata,
    } : null,
    dependencies,
    outputs,
  };
}

function integrationOutputRoot(projectRoot, mode, integrationName) {
  const safeName = integrationName.replace(/[^a-z\d._-]+/giu, "-");
  return path.join(
    projectRoot,
    INTERNAL_DIRECTORY,
    mode === "development" ? DEV_DIRECTORY : BUILD_DIRECTORY,
    "integrations",
    safeName,
  );
}

function virtualModuleRoot(projectRoot, mode, identity) {
  return path.join(
    projectRoot,
    INTERNAL_DIRECTORY,
    mode === "development" ? DEV_DIRECTORY : BUILD_DIRECTORY,
    "virtual",
    identity.id,
  );
}

async function removePath(candidate) {
  await fs.rm(candidate, { recursive: true, force: true });
}

/**
 * Creates an isolated LitSX compilation pipeline for one server, build, or runtime.
 * Integration descriptors are immutable configuration; all mutable state belongs to
 * the instances returned by their create() methods.
 */
export async function createLitsxPipeline({ projectRoot, mode, config } = {}) {
  const litsx = config?.litsx;
  if (litsx == null) return null;
  assertRecord(litsx, "litsx in evolit.config.js");
  const compiler = normalizeCompilerOptions(litsx.compiler, "litsx.compiler");
  const descriptors = litsx.integrations ?? [];
  if (!Array.isArray(descriptors)) {
    throw new TypeError("Expected litsx.integrations in evolit.config.js to be an array.");
  }

  const resolvedProjectRoot = path.resolve(projectRoot ?? process.cwd());
  const identity = Object.freeze({ id: randomUUID() });
  const instances = [];
  const names = new Set();
  let disposed = false;
  let generation = 0;
  let finalizedGeneration = -1;
  const dependencies = new Set();
  const processedModules = new Set();
  const moduleDependencies = new Map();
  const pendingOutputs = new Map();
  const pendingSpecifiers = new Map();
  const publishedRoots = new Map();
  const virtualRoot = virtualModuleRoot(resolvedProjectRoot, mode, identity);
  const virtualModulesByImporter = new Map();
  const virtualTargetsBySpecifier = new Map();
  const virtualOutputRelativePaths = new Map();

  function rebuildDependencies() {
    dependencies.clear();
    for (const owned of moduleDependencies.values()) {
      for (const dependency of owned) dependencies.add(dependency);
    }
  }

  function rebuildPendingSpecifiers() {
    pendingSpecifiers.clear();
    for (const entry of pendingOutputs.values()) {
      if (entry.output.specifier) pendingSpecifiers.set(entry.output.specifier, entry);
    }
  }

  function removeOwnedContributions(owner) {
    for (const [key, entry] of pendingOutputs) {
      if (entry.owner === owner) pendingOutputs.delete(key);
    }
    rebuildPendingSpecifiers();
  }

  try {
    for (const descriptor of descriptors) {
      assertRecord(descriptor, "every litsx.integrations entry");
      if (typeof descriptor.name !== "string" || descriptor.name.length === 0) {
        throw new TypeError("Expected every LitSX integration to have a non-empty name.");
      }
      if (
        !/^[a-z\d][a-z\d._-]*$/iu.test(descriptor.name)
        || descriptor.name === "."
        || descriptor.name === ".."
      ) {
        throw new TypeError(
          `LitSX integration name ${JSON.stringify(descriptor.name)} must be a safe identifier `
          + "containing only letters, digits, dots, underscores, and hyphens.",
        );
      }
      if (names.has(descriptor.name)) {
        throw new TypeError(`Duplicate LitSX integration name ${JSON.stringify(descriptor.name)}.`);
      }
      if (typeof descriptor.create !== "function") {
        throw new TypeError(`Expected LitSX integration ${JSON.stringify(descriptor.name)} to expose create(context).`);
      }
      names.add(descriptor.name);
      let instance;
      try {
        instance = await descriptor.create(Object.freeze({
          projectRoot: resolvedProjectRoot,
          mode,
          identity,
        }));
        assertRecord(instance, `instance created by LitSX integration ${JSON.stringify(descriptor.name)}`);
      } catch (error) {
        throw contextualError(error, { integration: descriptor.name, phase: "create", mode });
      }
      instances.push({ descriptor, instance });
    }
  } catch (error) {
    for (const { descriptor, instance } of [...instances].reverse()) {
      try {
        await instance.dispose?.();
      } catch {
        // Preserve the primary initialization error.
      }
    }
    throw error;
  }

  function assertActive() {
    if (disposed) throw new Error("This LitSX pipeline has already been disposed.");
  }

  function recordContribution(integrationName, moduleId, contribution) {
    if (contribution.dependencies.length > 0) {
      let owned = moduleDependencies.get(moduleId);
      if (!owned) {
        owned = new Set();
        moduleDependencies.set(moduleId, owned);
      }
      for (const dependency of contribution.dependencies) {
        dependencies.add(dependency);
        owned.add(dependency);
      }
    }
    for (const output of contribution.outputs) {
      const collisionKey = output.id;
      const previous = pendingOutputs.get(collisionKey);
      if (previous && (
        previous.integrationName !== integrationName
        || previous.output.kind !== output.kind
        || previous.owner !== moduleId
      )) {
        throw new Error(
          `LitSX integration output collision for ${JSON.stringify(output.id)} between `
          + `${JSON.stringify(previous.integrationName)} and ${JSON.stringify(integrationName)}.`,
        );
      }
      pendingOutputs.set(collisionKey, { integrationName, owner: moduleId, output });
      if (output.specifier) {
        const previousSpecifier = pendingSpecifiers.get(output.specifier);
        if (previousSpecifier && previousSpecifier.integrationName !== integrationName) {
          throw new Error(
            `LitSX integration virtual module collision for ${JSON.stringify(output.specifier)} between `
            + `${JSON.stringify(previousSpecifier.integrationName)} and ${JSON.stringify(integrationName)}.`,
          );
        }
        pendingSpecifiers.set(output.specifier, { integrationName, owner: moduleId, output });
      }
    }
  }

  const pipeline = {
    identity,
    get generation() {
      return generation;
    },
    get dependencies() {
      return [...dependencies].sort();
    },
    getOutputRelativePath(sourcePath) {
      return virtualOutputRelativePaths.get(path.resolve(sourcePath)) ?? null;
    },
    getCompilerOptions({ filename, ssr, sourceMaps }) {
      assertActive();
      let options = { ...compiler };
      for (const { descriptor, instance } of instances) {
        try {
          const contribution = typeof instance.compiler === "function"
            ? instance.compiler({ filename, ssr, sourceMaps, mode })
            : instance.compiler;
          options = mergeCompilerOptions(
            options,
            normalizeCompilerOptions(contribution, `compiler contribution from ${JSON.stringify(descriptor.name)}`),
          );
        } catch (error) {
          throw contextualError(error, {
            integration: descriptor.name,
            phase: "compiler",
            mode,
            module: filename,
          });
        }
      }
      return {
        ...options,
        filename,
        ssr: ssr === true,
        sourceMaps: options.sourceMaps ?? (sourceMaps === true),
        reactCompat: false,
      };
    },
    async resolveModule(specifier, context) {
      assertActive();
      const declaredOutput = pendingSpecifiers.get(specifier);
      let resolved = null;
      if (declaredOutput) {
        resolved = {
          integrationName: declaredOutput.integrationName,
          code: String(declaredOutput.output.content),
          dependencies: [],
        };
      }
      for (const { descriptor, instance } of instances) {
        if (typeof instance.resolveModule !== "function") continue;
        if (declaredOutput?.integrationName === descriptor.name) continue;
        try {
          const value = await instance.resolveModule(Object.freeze({
            ...context,
            specifier,
            generation,
            mode,
          }));
          if (value == null) continue;
          if (resolved) {
            throw new Error(
              `Virtual module ${JSON.stringify(specifier)} was resolved by both `
              + `${JSON.stringify(resolved.integrationName)} and ${JSON.stringify(descriptor.name)}.`,
            );
          }
          assertRecord(value, `virtual module ${JSON.stringify(specifier)} from ${JSON.stringify(descriptor.name)}`);
          if (typeof value.code !== "string") {
            throw new TypeError(`Expected virtual module ${JSON.stringify(specifier)} to provide string code.`);
          }
          const dependencies = (value.dependencies ?? [])
            .map((entry) => canonicalDependency(resolvedProjectRoot, entry));
          resolved = { integrationName: descriptor.name, code: value.code, dependencies };
        } catch (error) {
          throw contextualError(error, {
            integration: descriptor.name,
            phase: "resolveModule",
            mode,
            target: context.target,
            module: context.importer,
            specifier,
          });
        }
      }
      if (!resolved) return null;
      const moduleKey = createHash("sha256")
        .update(JSON.stringify([specifier, context.importer, context.target]))
        .digest("hex");
      const integrationName = resolved.integrationName.replace(/[^a-z\d._-]+/giu, "-");
      resolved.sourcePath = path.join(virtualRoot, integrationName, `${moduleKey}.mjs`);
      virtualOutputRelativePaths.set(
        path.resolve(resolved.sourcePath),
        path.join("__litsx_virtual__", integrationName, `${moduleKey}.mjs`),
      );
      await ensureDirectory(path.dirname(resolved.sourcePath));
      await fs.writeFile(resolved.sourcePath, resolved.code, "utf8");
      const targets = virtualTargetsBySpecifier.get(specifier) ?? new Set();
      targets.add(resolved.sourcePath);
      virtualTargetsBySpecifier.set(specifier, targets);
      const importer = path.resolve(context.importer);
      const importerVirtualModules = virtualModulesByImporter.get(importer) ?? new Set();
      importerVirtualModules.add(resolved.sourcePath);
      virtualModulesByImporter.set(importer, importerVirtualModules);
      recordContribution(resolved.integrationName, resolved.sourcePath, {
        result: null,
        dependencies: resolved.dependencies,
        outputs: [],
      });
      return resolved.sourcePath;
    },
    registerResolvedModule(specifier, sourcePath, outputPath) {
      assertActive();
      const targets = virtualTargetsBySpecifier.get(specifier) ?? new Set();
      targets.add(path.resolve(sourcePath));
      targets.add(path.resolve(outputPath));
      virtualTargetsBySpecifier.set(specifier, targets);
    },
    async processModule(result, context) {
      assertActive();
      if (finalizedGeneration === generation) {
        generation += 1;
        finalizedGeneration = -1;
      }
      const moduleId = path.resolve(context.sourcePath);
      processedModules.add(moduleId);
      if (moduleDependencies.delete(moduleId)) rebuildDependencies();
      removeOwnedContributions(moduleId);
      let current = result;
      for (const { descriptor, instance } of instances) {
        if (typeof instance.processModule !== "function") continue;
        try {
          const value = await instance.processModule(Object.freeze({
            ...context,
            sourcePath: moduleId,
            result: current,
            generation,
          }));
          const contribution = normalizeContribution(value, descriptor.name, resolvedProjectRoot);
          recordContribution(descriptor.name, moduleId, contribution);
          if (contribution.result) {
            current = {
              ...current,
              ...(contribution.result.code == null ? {} : { code: contribution.result.code }),
              ...(contribution.result.map === undefined ? {} : { map: contribution.result.map }),
              ...(contribution.result.metadata == null ? {} : {
                metadata: { ...(current.metadata ?? {}), ...contribution.result.metadata },
              }),
            };
          }
        } catch (error) {
          throw contextualError(error, {
            integration: descriptor.name,
            phase: "processModule",
            mode,
            target: context.target,
            module: moduleId,
          });
        }
      }
      return {
        ...current,
        evolitDependencies: [...(moduleDependencies.get(moduleId) ?? [])].sort(),
      };
    },
    async finalize(context = {}) {
      assertActive();
      if (finalizedGeneration === generation) return null;
      if (moduleDependencies.delete("<graph>")) rebuildDependencies();
      removeOwnedContributions("<graph>");
      for (const { descriptor, instance } of instances) {
        if (typeof instance.finalize !== "function") continue;
        try {
          const contribution = normalizeContribution(
            await instance.finalize(Object.freeze({ ...context, generation, mode })),
            descriptor.name,
            resolvedProjectRoot,
          );
          recordContribution(descriptor.name, "<graph>", contribution);
        } catch (error) {
          throw contextualError(error, { integration: descriptor.name, phase: "finalize", mode });
        }
      }

      const outputsByIntegration = new Map();
      for (const { integrationName, output } of pendingOutputs.values()) {
        const list = outputsByIntegration.get(integrationName) ?? [];
        list.push(output);
        outputsByIntegration.set(integrationName, list);
      }
      const manifest = { assets: [], documentStyles: [] };
      const rootOperations = [];
      const patchOperations = [];
      let activeIntegration = null;
      try {
        for (const { descriptor } of instances) {
          activeIntegration = descriptor.name;
          const outputs = outputsByIntegration.get(descriptor.name) ?? [];
          const root = publishedRoots.get(descriptor.name)
            ?? integrationOutputRoot(resolvedProjectRoot, mode, descriptor.name);
          const operation = {
            integrationName: descriptor.name,
            root,
            stagingRoot: null,
            previousRoot: `${root}.previous-${randomUUID()}`,
            hadPreviousRoot: false,
            installed: false,
          };
          if (outputs.length > 0) {
            operation.stagingRoot = `${root}.staging-${randomUUID()}`;
            await ensureDirectory(operation.stagingRoot);
            for (const output of outputs.sort((left, right) => left.id.localeCompare(right.id))) {
              const outputPath = path.join(operation.stagingRoot, ...output.id.split("/"));
              await ensureDirectory(path.dirname(outputPath));
              await fs.writeFile(outputPath, output.content);
              const record = {
                integration: descriptor.name,
                id: output.id,
                kind: output.kind,
                outputPath: path.join(root, ...output.id.split("/")),
                hash: output.hash,
                size: output.size,
              };
              manifest.assets.push(record);
              if (output.kind === "style" && output.document) manifest.documentStyles.push(record);
            }
          }
          rootOperations.push(operation);
        }

        for (const { output, integrationName } of pendingOutputs.values()) {
          if (!output.specifier) continue;
          activeIntegration = integrationName;
          for (const targetPath of virtualTargetsBySpecifier.get(output.specifier) ?? []) {
            const temporaryPath = `${targetPath}.staging-${randomUUID()}`;
            await ensureDirectory(path.dirname(targetPath));
            await fs.writeFile(temporaryPath, output.content);
            patchOperations.push({
              integrationName,
              targetPath,
              temporaryPath,
              previousPath: `${targetPath}.previous-${randomUUID()}`,
              hadPrevious: false,
              installed: false,
            });
          }
        }
      } catch (error) {
        await Promise.allSettled([
          ...rootOperations.map((operation) => operation.stagingRoot && removePath(operation.stagingRoot)),
          ...patchOperations.map((operation) => removePath(operation.temporaryPath)),
        ]);
        throw contextualError(error, { integration: activeIntegration, phase: "publish", mode });
      }

      try {
        for (const operation of rootOperations) {
          try {
            await fs.rename(operation.root, operation.previousRoot);
            operation.hadPreviousRoot = true;
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
        }
        for (const operation of patchOperations) {
          try {
            await fs.rename(operation.targetPath, operation.previousPath);
            operation.hadPrevious = true;
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
        }
        for (const operation of rootOperations) {
          if (!operation.stagingRoot) continue;
          await fs.rename(operation.stagingRoot, operation.root);
          operation.installed = true;
        }
        for (const operation of patchOperations) {
          await fs.rename(operation.temporaryPath, operation.targetPath);
          operation.installed = true;
        }
      } catch (error) {
        for (const operation of [...patchOperations].reverse()) {
          if (operation.installed) await removePath(operation.targetPath);
          if (operation.hadPrevious) await fs.rename(operation.previousPath, operation.targetPath);
          else await removePath(operation.temporaryPath);
        }
        for (const operation of [...rootOperations].reverse()) {
          if (operation.installed) await removePath(operation.root);
          if (operation.hadPreviousRoot) await fs.rename(operation.previousRoot, operation.root);
          if (operation.stagingRoot) await removePath(operation.stagingRoot);
        }
        throw contextualError(error, { integration: activeIntegration, phase: "publish", mode });
      }

      await Promise.all([
        ...rootOperations.map((operation) => operation.hadPreviousRoot && removePath(operation.previousRoot)),
        ...patchOperations.map((operation) => operation.hadPrevious && removePath(operation.previousPath)),
      ]);
      for (const operation of rootOperations) {
        if (operation.stagingRoot) publishedRoots.set(operation.integrationName, operation.root);
        else publishedRoots.delete(operation.integrationName);
      }
      finalizedGeneration = generation;
      return manifest;
    },
    async invalidate(changedPaths = null) {
      assertActive();
      const paths = Array.isArray(changedPaths)
        ? changedPaths.map((entry) => canonicalDependency(resolvedProjectRoot, entry))
        : null;
      const affected = paths == null || paths.some((entry) => (
        dependencies.has(entry) || processedModules.has(entry)
      ));
      for (const { descriptor, instance } of instances) {
        if (typeof instance.invalidate !== "function") continue;
        try {
          await instance.invalidate(Object.freeze({ paths, affected, generation, mode }));
        } catch (error) {
          throw contextualError(error, { integration: descriptor.name, phase: "invalidate", mode });
        }
      }
      if (affected) {
        generation += 1;
        finalizedGeneration = -1;
        for (const changedPath of paths ?? []) {
          if (processedModules.has(changedPath)) await pipeline.forget(changedPath);
        }
      }
      return affected;
    },
    async forget(moduleId) {
      assertActive();
      const resolvedModuleId = path.resolve(moduleId);
      const ownedVirtualModules = [...(virtualModulesByImporter.get(resolvedModuleId) ?? [])];
      virtualModulesByImporter.delete(resolvedModuleId);
      for (const { descriptor, instance } of instances) {
        try {
          await instance.forget?.(Object.freeze({ moduleId: resolvedModuleId, generation, mode }));
        } catch (error) {
          throw contextualError(error, { integration: descriptor.name, phase: "forget", mode, module: resolvedModuleId });
        }
      }
      moduleDependencies.delete(resolvedModuleId);
      rebuildDependencies();
      processedModules.delete(resolvedModuleId);
      removeOwnedContributions(resolvedModuleId);
      for (const virtualModule of ownedVirtualModules) {
        await pipeline.forget(virtualModule);
        await removePath(virtualModule);
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      let firstError = null;
      for (const { descriptor, instance } of [...instances].reverse()) {
        try {
          await instance.dispose?.();
        } catch (error) {
          firstError ??= contextualError(error, { integration: descriptor.name, phase: "dispose", mode });
        }
      }
      await removePath(virtualRoot);
      if (firstError) throw firstError;
    },
  };

  return pipeline;
}

/** Identity helper for typed evolit.config.js files. */
export function defineEvolitConfig(config) {
  return config;
}

/** Identity helper for stateless LitSX integration descriptors. */
export function defineLitsxIntegration(integration) {
  return integration;
}
