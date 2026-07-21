import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryResponseCacheStore,
  ObjectStorageResponseCacheStore,
  createDefaultRouteCacheKey,
  resolveResponseCacheRuntime,
} from "../src/response-cache.js";

test("resolveResponseCacheRuntime returns deployable hooks from nextsx config", async () => {
  const customStore = new MemoryResponseCacheStore();
  const runtime = await resolveResponseCacheRuntime("/tmp/nextsx-app", "production", {
    responseCache: {
      async createStore({ projectRoot, mode }) {
        assert.equal(projectRoot, "/tmp/nextsx-app");
        assert.equal(mode, "production");
        return customStore;
      },
      createKey({ request }) {
        const url = new URL(request.url);
        return `${url.pathname}?tenant=${url.searchParams.get("tenant") ?? "default"}`;
      },
    },
  });

  const request = new Request("https://example.com/products?tenant=acme");

  assert.equal(runtime.store, customStore);
  assert.equal(
    await runtime.createKey({ request, routeResult: { type: "route" } }),
    "/products?tenant=acme",
  );
});

test("createDefaultRouteCacheKey uses the request pathname", () => {
  const request = new Request("https://example.com/products?tenant=acme");
  assert.equal(createDefaultRouteCacheKey(request), "/products");
});

test("ObjectStorageResponseCacheStore persists cached entries through object-store hooks", async () => {
  const objects = new Map();
  const store = new ObjectStorageResponseCacheStore({
    prefix: "routes",
    async getObject(key) {
      return objects.get(key) ?? null;
    },
    async putObject(key, value) {
      objects.set(key, value);
    },
    async deleteObject(key) {
      objects.delete(key);
    },
  });

  await store.put("/products", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: "<main>cached</main>",
    createdAt: "2026-07-21T10:00:00.000Z",
    expiresAt: "2026-07-21T10:05:00.000Z",
  });

  assert.equal(typeof objects.get(store.getObjectKey("/products")), "string");
  assert.deepEqual(
    await store.get("/products"),
    {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: "<main>cached</main>",
      createdAt: "2026-07-21T10:00:00.000Z",
      expiresAt: "2026-07-21T10:05:00.000Z",
    },
  );

  await store.delete("/products");
  assert.equal(await store.get("/products"), null);
});
