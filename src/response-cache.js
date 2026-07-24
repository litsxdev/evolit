import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { BUILD_DIRECTORY, INTERNAL_DIRECTORY, ROUTE_CACHE_DIRECTORY } from "./constants.js";
import { ensureDirectory, pathExists, readJson, writeJson } from "./fs-utils.js";

function createCacheFileName(cacheKey) {
  return `${crypto.createHash("sha1").update(cacheKey).digest("hex")}.json`;
}

function createCacheObjectKey(cacheKey, prefix = "") {
  const normalizedPrefix = typeof prefix === "string" ? prefix.replace(/\/+$/g, "") : "";
  const fileName = createCacheFileName(cacheKey);
  return normalizedPrefix ? `${normalizedPrefix}/${fileName}` : fileName;
}

export function createCachedRouteResponse(response, cachePolicy, now = new Date()) {
  const ttlSeconds = cachePolicy?.mode === "revalidate" ? cachePolicy.ttlSeconds : null;
  const createdAt = now.toISOString();
  const expiresAt = ttlSeconds == null
    ? null
    : new Date(now.getTime() + (ttlSeconds * 1000)).toISOString();

  return {
    status: response.status,
    headers: { ...(response.headers ?? {}) },
    body: String(response.body ?? ""),
    createdAt,
    expiresAt,
  };
}

export function isCachedRouteResponseFresh(entry, now = new Date()) {
  if (!entry || typeof entry !== "object") {
    return false;
  }

  if (!entry.expiresAt) {
    return true;
  }

  return new Date(entry.expiresAt).getTime() > now.getTime();
}

export class MemoryResponseCacheStore {
  #entries = new Map();

  async get(cacheKey) {
    return this.#entries.get(cacheKey) ?? null;
  }

  async put(cacheKey, entry) {
    this.#entries.set(cacheKey, entry);
  }

  async delete(cacheKey) {
    this.#entries.delete(cacheKey);
  }

  async clear() {
    this.#entries.clear();
  }
}

export class FileSystemResponseCacheStore {
  #rootDirectory;

  constructor(rootDirectory) {
    this.#rootDirectory = rootDirectory;
  }

  getRootDirectory() {
    return this.#rootDirectory;
  }

  getFilePath(cacheKey) {
    return path.join(this.#rootDirectory, createCacheFileName(cacheKey));
  }

  async get(cacheKey) {
    const filePath = this.getFilePath(cacheKey);
    if (!(await pathExists(filePath))) {
      return null;
    }

    const entry = await readJson(filePath);
    return entry?.key === cacheKey ? entry.value ?? null : null;
  }

  async put(cacheKey, entry) {
    const filePath = this.getFilePath(cacheKey);
    await ensureDirectory(path.dirname(filePath));
    await writeJson(filePath, {
      key: cacheKey,
      value: entry,
    });
  }

  async delete(cacheKey) {
    const filePath = this.getFilePath(cacheKey);
    if (await pathExists(filePath)) {
      await fs.unlink(filePath);
    }
  }
}

export class ObjectStorageResponseCacheStore {
  #prefix;
  #getObject;
  #putObject;
  #deleteObject;

  constructor(options = {}) {
    this.#prefix = options.prefix ?? "";
    this.#getObject = options.getObject;
    this.#putObject = options.putObject;
    this.#deleteObject = options.deleteObject ?? null;

    if (typeof this.#getObject !== "function") {
      throw new Error("Expected ObjectStorageResponseCacheStore options.getObject to be a function.");
    }

    if (typeof this.#putObject !== "function") {
      throw new Error("Expected ObjectStorageResponseCacheStore options.putObject to be a function.");
    }
  }

  getObjectKey(cacheKey) {
    return createCacheObjectKey(cacheKey, this.#prefix);
  }

  async get(cacheKey) {
    const serializedEntry = await this.#getObject(this.getObjectKey(cacheKey));
    if (typeof serializedEntry !== "string" || serializedEntry.length === 0) {
      return null;
    }

    const entry = JSON.parse(serializedEntry);
    return entry?.key === cacheKey ? entry.value ?? null : null;
  }

  async put(cacheKey, entry) {
    await this.#putObject(
      this.getObjectKey(cacheKey),
      `${JSON.stringify({
        key: cacheKey,
        value: entry,
      }, null, 2)}\n`,
    );
  }

  async delete(cacheKey) {
    if (typeof this.#deleteObject !== "function") {
      return;
    }

    await this.#deleteObject(this.getObjectKey(cacheKey));
  }
}

export function createDefaultRouteCacheKey(request) {
  return new URL(request.url).pathname;
}

export function getRouteCacheArtifactFileName(cacheKey) {
  return createCacheFileName(cacheKey);
}

export function createDefaultResponseCacheStore(projectRoot, mode) {
  if (mode === "development") {
    return new MemoryResponseCacheStore();
  }

  return new FileSystemResponseCacheStore(
    path.join(projectRoot, INTERNAL_DIRECTORY, BUILD_DIRECTORY, ROUTE_CACHE_DIRECTORY),
  );
}

function isResponseCacheStore(value) {
  return (
    value != null &&
    typeof value === "object" &&
    typeof value.get === "function" &&
    typeof value.put === "function"
  );
}

export async function resolveResponseCacheRuntime(projectRoot, mode, nextsxConfig = {}) {
  const defaultStore = createDefaultResponseCacheStore(projectRoot, mode);
  const responseCacheConfig = nextsxConfig?.responseCache ?? {};

  let store = defaultStore;
  if (typeof responseCacheConfig?.createStore === "function") {
    store = await responseCacheConfig.createStore({
      projectRoot,
      mode,
      defaultStore,
    });
  }

  if (!isResponseCacheStore(store)) {
    throw new Error("Expected responseCache.createStore() to return an object with get() and put() methods.");
  }

  const createKey = typeof responseCacheConfig?.createKey === "function"
    ? responseCacheConfig.createKey
    : ({ request }) => createDefaultRouteCacheKey(request);

  return {
    store,
    createKey,
  };
}
