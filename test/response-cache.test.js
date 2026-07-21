import test from "node:test";
import assert from "node:assert/strict";
import {
  MemoryResponseCacheStore,
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
