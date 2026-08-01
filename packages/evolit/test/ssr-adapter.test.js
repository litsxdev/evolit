import test from "node:test";
import assert from "node:assert/strict";
import { html } from "lit";
import { createSsrAdapter } from "../src/ssr-adapter.js";

test("SSR adapter injects generated bootstrap only when resolveBootstrap returns content", async () => {
  const adapter = createSsrAdapter({
    resolveBootstrap() {
      return [
        'import { hydratePage, registerHydrationModules } from "@litsx/ssr/hydration";',
        'await registerHydrationModules([() => import("/_evolit/static/app/components/feature-card.mjs")]);',
        "await hydratePage();",
      ].join("\n");
    },
  });

  const response = await adapter.renderRouteTree({
    type: "route",
    status: 200,
    tree: html`<section>hello</section>`,
    metadata: {},
  });

  assert.equal(response.status, 200);
  assert.match(response.body, /registerHydrationModules/);
  assert.match(response.body, /hydratePage\(\)/);
  assert.match(response.body, /feature-card\.mjs/);
});

test("SSR adapter does not inject generated bootstrap when resolveBootstrap returns empty content", async () => {
  const adapter = createSsrAdapter({
    resolveBootstrap() {
      return "";
    },
  });

  const response = await adapter.renderRouteTree({
    type: "route",
    status: 200,
    tree: html`<section>hello</section>`,
    metadata: {},
  });

  assert.equal(response.status, 200);
  assert.doesNotMatch(response.body, /registerHydrationModules/);
  assert.doesNotMatch(response.body, /hydratePage\(\)/);
});

test("SSR adapter respects explicit framework bootstrap options over generated bootstrap", async () => {
  const adapter = createSsrAdapter({
    bootstrap: "/framework-bootstrap.js",
    resolveBootstrap() {
      return 'await registerHydrationModules([() => import("/_evolit/static/app/components/feature-card.mjs")]);';
    },
  });

  const response = await adapter.renderRouteTree({
    type: "route",
    status: 200,
    tree: html`<section>hello</section>`,
    metadata: {},
  });

  assert.match(response.body, /framework-bootstrap\.js/);
  assert.doesNotMatch(response.body, /registerHydrationModules/);
});

test("SSR adapter reconciles rendered client roots before resolving head and bootstrap assets", async () => {
  const calls = [];
  const adapter = createSsrAdapter({
    async onSsrResult({ result }) {
      calls.push("reconcile");
      result.clientImports = ["/_evolit/static/reconciled.mjs"];
    },
    resolveAdditionalHead({ result }) {
      calls.push("head");
      assert.deepEqual(result.clientImports, ["/_evolit/static/reconciled.mjs"]);
      return "";
    },
    resolveBootstrap({ result }) {
      calls.push("bootstrap");
      assert.deepEqual(result.clientImports, ["/_evolit/static/reconciled.mjs"]);
      return "";
    },
  });

  await adapter.renderRouteTree({
    type: "route",
    status: 200,
    tree: "<main>pre-rendered</main>",
    metadata: {},
    ssrArtifacts: { clientImports: [], hydrationData: null, headTags: [] },
  });

  assert.deepEqual(calls, ["reconcile", "bootstrap", "head"]);
});
