import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { ensureDirectory, pathExists, readJson, writeJson } from "./fs-utils.js";

function createCacheFileName(cacheKey) {
  return `${crypto.createHash("sha1").update(cacheKey).digest("hex")}.json`;
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
