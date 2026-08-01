import test from "node:test";
import assert from "node:assert/strict";
import { combineSegmentSsrArtifacts } from "../src/render.js";

test("combineSegmentSsrArtifacts combines opaque resources in render order", () => {
  const result = combineSegmentSsrArtifacts([
    {
      clientImports: ["/layout.mjs"],
      hydrationData: {
        version: 1,
        roots: [{ id: "layout-root", tagName: "app-layout" }],
        payload: {
          roots: { "layout-root": { props: { locale: "en" } } },
          instances: {},
          resources: {
            "library:i18n": { locale: "en", messages: { title: "Home" } },
            "library:flags": { checkout: false },
          },
        },
      },
    },
    {
      clientImports: ["/page.mjs"],
      hydrationData: {
        version: 1,
        roots: [{ id: "page-root", tagName: "app-page" }],
        payload: {
          roots: { "page-root": { props: { slug: "product" } } },
          instances: {},
          resources: {
            "library:i18n": { locale: "es", messages: { title: "Producto" } },
          },
        },
      },
    },
  ]);

  assert.deepEqual(result.hydrationData.payload.resources, {
    "library:i18n": { locale: "es", messages: { title: "Producto" } },
    "library:flags": { checkout: false },
  });
});

test("combineSegmentSsrArtifacts remains compatible with payloads without resources", () => {
  const result = combineSegmentSsrArtifacts([{
    hydrationData: {
      version: 1,
      roots: [{ id: "legacy-root", tagName: "legacy-card" }],
      payload: {
        roots: { "legacy-root": { props: { title: "Legacy" } } },
        instances: {},
      },
    },
  }]);

  assert.deepEqual(result.hydrationData.payload, {
    roots: { "legacy-root": { props: { title: "Legacy" } } },
    instances: {},
    resources: {},
  });
});

