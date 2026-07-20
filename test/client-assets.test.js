import test from "node:test";
import assert from "node:assert/strict";
import {
  createHydrationBootstrap,
  getAssetByClientModule,
  getAssetByPublicUrl,
  getAssetsByKind,
  getClientAssetUrl,
  normalizeClientAssetManifest,
} from "../src/client-assets.js";

test("createHydrationBootstrap returns an empty string when no hydratable roots exist", () => {
  const bootstrap = createHydrationBootstrap({
    hydrationData: {
      roots: [],
    },
    assetResolver(moduleId) {
      return `/_nextsx/client/${moduleId}`;
    },
  });

  assert.equal(bootstrap, "");
});

test("createHydrationBootstrap deduplicates module imports by moduleId", () => {
  const bootstrap = createHydrationBootstrap({
    hydrationData: {
      roots: [
        { id: "root-0", moduleId: "/app/components/feature-card.litsx" },
        { id: "root-1", moduleId: "/app/components/feature-card.litsx" },
        { id: "root-2", moduleId: "/app/components/hero-banner.litsx" },
        { id: "root-3", moduleId: "" },
        { id: "root-4" },
      ],
    },
    assetResolver(moduleId) {
      return getClientAssetUrl("/app", moduleId);
    },
  });

  assert.match(bootstrap, /registerHydrationModules/);
  assert.match(bootstrap, /hydratePage\(\)/);
  assert.equal(
    bootstrap.includes("/_nextsx/client/components/feature-card.mjs"),
    true,
  );
  assert.equal(
    bootstrap.includes("/_nextsx/client/components/hero-banner.mjs"),
    true,
  );
  assert.equal(
    bootstrap.match(/feature-card\.mjs/g)?.length ?? 0,
    1,
  );
  assert.equal(
    bootstrap.includes("__nextsx/hydration"),
    false,
  );
  assert.equal(
    bootstrap.includes("customElements.define"),
    false,
  );
});

test("createHydrationBootstrap ignores unresolved module ids", () => {
  const bootstrap = createHydrationBootstrap({
    hydrationData: {
      roots: [
        { id: "root-0", moduleId: "/outside/project/component-a.litsx" },
      ],
    },
    assetResolver() {
      return null;
    },
  });

  assert.equal(bootstrap, "");
});

test("client asset manifest helpers normalize and query structured asset entries", () => {
  const manifest = normalizeClientAssetManifest({
    resources: ["app/components/card-accent.svg"],
    assets: [
      {
        clientModule: "app/page.mjs",
        kind: "entry",
        publicUrl: "/_nextsx/static/app/page.hash.mjs",
      },
      {
        clientModule: "app/components/card-accent.css",
        kind: "style",
        publicUrl: "/_nextsx/static/app/components/card-accent.hash.css",
      },
    ],
  });

  assert.equal(manifest.version, 1);
  assert.equal(manifest.publicPathPrefix, "/_nextsx/static/");
  assert.deepEqual(manifest.resources, ["app/components/card-accent.svg"]);
  assert.equal(
    getAssetByClientModule(manifest, "app/page.mjs")?.publicUrl,
    "/_nextsx/static/app/page.hash.mjs",
  );
  assert.equal(
    getAssetByPublicUrl(manifest, "/_nextsx/static/app/components/card-accent.hash.css")?.clientModule,
    "app/components/card-accent.css",
  );
  assert.deepEqual(
    getAssetsByKind(manifest, "style").map((asset) => asset.clientModule),
    ["app/components/card-accent.css"],
  );
});
