import test from "node:test";
import assert from "node:assert/strict";
import { html } from "lit";
import { createSsrAdapter } from "../src/ssr-adapter.js";

test("SSR adapter injects generated bootstrap only when resolveBootstrap returns content", async () => {
  const adapter = createSsrAdapter({
    resolveBootstrap() {
      return [
        'import { hydratePage, registerHydrationModules } from "@litsx/ssr/hydration";',
        'await registerHydrationModules([() => import("/_nextsx/static/app/components/feature-card.mjs")]);',
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
      return 'await registerHydrationModules([() => import("/_nextsx/static/app/components/feature-card.mjs")]);';
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
