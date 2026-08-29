import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeNavigationContext,
  encodeNavigationContext,
  normalizeNavigationContext,
} from "../src/navigation-context.js";

test("navigation context round-trips JSON-safe unicode values", () => {
  const context = {
    catalogFilters: {
      panelOpen: true,
      drawerOpen: false,
      disclosureState: { color: { open: true, showAll: true } },
    },
    label: "Catálogo español",
  };

  assert.deepEqual(decodeNavigationContext(encodeNavigationContext(context)), context);
  assert.notStrictEqual(normalizeNavigationContext(context), context);
});

test("navigation context rejects unsupported, cyclic, and oversized values", () => {
  const cyclic = {};
  cyclic.self = cyclic;

  assert.throws(() => normalizeNavigationContext({ value: undefined }), /JSON-safe/);
  assert.throws(() => normalizeNavigationContext({ value: Number.NaN }), /JSON-safe/);
  assert.throws(() => normalizeNavigationContext(cyclic), /JSON-safe/);
  assert.throws(
    () => normalizeNavigationContext({ value: "x".repeat(9_000) }),
    /8 KiB/,
  );
});

test("missing or malformed navigation context decodes to null", () => {
  assert.equal(decodeNavigationContext(null), null);
  assert.equal(decodeNavigationContext("not-base64"), null);
});
