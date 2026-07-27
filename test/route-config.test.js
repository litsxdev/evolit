import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_REVALIDATE_SECONDS,
  normalizeRouteCachePolicy,
} from "../src/route-config.js";

test("page routes default to URL-keyed revalidation", () => {
  assert.deepEqual(normalizeRouteCachePolicy(), {
    mode: "revalidate",
    ttlSeconds: DEFAULT_REVALIDATE_SECONDS,
  });
});

test("explicit static and dynamic policies keep their opt-in semantics", () => {
  assert.deepEqual(normalizeRouteCachePolicy({ cache: "static" }), { mode: "static" });
  assert.deepEqual(normalizeRouteCachePolicy({ cache: "dynamic" }), { mode: "dynamic" });
});
