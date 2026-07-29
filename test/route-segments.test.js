import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  createRouteSegmentPayload,
  createRouteSegmentPlan,
  createNavigationResponseFromDocument,
  extractDocumentState,
  extractRouteHeadMarkup,
  extractRouteHeadAssets,
  extractRouteSegmentArtifacts,
  renderRouteSegmentPayload,
  wrapRouteSegment,
} from "../src/route-segments.js";

test("route segment plans are stable and distinguish layouts from the page", () => {
  const projectRoot = "/workspace/site";
  const route = {
    layouts: [
      path.join(projectRoot, "app", "layout.litsx"),
      path.join(projectRoot, "app", "explore", "layout.litsx"),
    ],
    page: path.join(projectRoot, "app", "explore", "[...slug]", "page.litsx"),
  };

  const firstPlan = createRouteSegmentPlan(route, projectRoot);
  const secondPlan = createRouteSegmentPlan(route, projectRoot);

  assert.deepEqual(firstPlan, secondPlan);
  assert.deepEqual(firstPlan.map((segment) => segment.kind), ["layout", "layout", "page"]);
  assert.equal(firstPlan.at(-1).modulePath, "app/explore/[...slug]/page.litsx");
  assert.equal(new Set(firstPlan.map((segment) => segment.id)).size, firstPlan.length);
});

test("route segment markers preserve string children for string layouts", () => {
  const segment = { id: "page-example" };
  const value = wrapRouteSegment(segment, "<main>content</main>");

  assert.equal(
    value,
    "<!--evolit:segment:start:page-example--><main>content</main><!--evolit:segment:end:page-example-->",
  );
});

test("route segment payload does not expose absolute project paths", () => {
  const payload = createRouteSegmentPayload({
    cacheKey: "/explore/home-garden?sort=price",
    segments: [{
      id: "page-example",
      kind: "page",
      depth: 1,
      modulePath: "app/explore/[...slug]/page.litsx",
    }],
  });

  assert.deepEqual(payload, {
    version: 1,
    url: "/explore/home-garden?sort=price",
    pathname: "/explore/home-garden",
    cachePolicy: null,
    segments: [{
      id: "page-example",
      kind: "page",
      depth: 1,
      modulePath: "app/explore/[...slug]/page.litsx",
    }],
  });
  assert.match(renderRouteSegmentPayload(payload), /id="__EVOLIT_ROUTE__"/);
});

test("route segment artifacts retain every projection of repeated children", () => {
  const artifacts = extractRouteSegmentArtifacts([
    "<!--evolit:segment:start:layout-root-->",
    "<main>",
    "<!--evolit:segment:start:page-catalog--><article>first</article><!--evolit:segment:end:page-catalog-->",
    "<!--evolit:segment:start:page-catalog--><article>second</article><!--evolit:segment:end:page-catalog-->",
    "</main>",
    "<!--evolit:segment:end:layout-root-->",
  ].join(""));

  assert.deepEqual(artifacts.get("page-catalog"), [
    { projectionId: "page-catalog:0", html: "<article>first</article>" },
    { projectionId: "page-catalog:1", html: "<article>second</article>" },
  ]);
  assert.match(artifacts.get("layout-root")[0].html, /<main>/);
});

test("navigation representation carries redirects without requiring an HTML route document", () => {
  const response = createNavigationResponseFromDocument({
    status: 307,
    headers: { location: "/sign-in?next=%2Faccount" },
    body: "<!doctype html><p>Redirecting</p>",
  });

  assert.match(response.headers["content-type"], /application\/vnd\.evolit\.navigation\+json/);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(response.headers.vary, /accept/i);
  assert.deepEqual(JSON.parse(response.body), {
    version: 1,
    type: "redirect",
    location: "/sign-in?next=%2Faccount",
  });
});

test("navigation representations are never confused with a cached HTML document", () => {
  const response = createNavigationResponseFromDocument({
    status: 200,
    headers: { vary: "origin" },
    body: [
      '<script type="application/json" id="__EVOLIT_ROUTE__">{"url":"/","segments":[]}</script>',
    ].join(""),
  });

  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers.vary, "origin, accept");
});

test("navigation representations retain managed route styles and preloads", () => {
  const assets = extractRouteHeadAssets([
    '<link rel="stylesheet" href="/_evolit/static/app/catalog.css" data-evolit-route-asset="style">',
    '<link rel="modulepreload" href="/_evolit/static/app/catalog.mjs" data-evolit-route-asset="preload">',
  ].join("\n"));

  assert.deepEqual(assets, {
    styles: ["/_evolit/static/app/catalog.css"],
    preloads: ["/_evolit/static/app/catalog.mjs"],
  });
});

test("navigation representations retain route-specific head markup", () => {
  const document = '<!doctype html><head><title>Explore</title><!--evolit:route-head:start--><meta name="description" content="Explore products"><meta name="robots" content="noindex"><!--evolit:route-head:end--></head><body><!--evolit:segment:start:page-1--><main>Explore</main><!--evolit:segment:end:page-1--><script type="application/json" id="__EVOLIT_ROUTE__">{"segments":[{"id":"page-1"}]}</script></body>';
  const response = createNavigationResponseFromDocument({ status: 200, headers: {}, body: document });
  const delta = JSON.parse(response.body);

  assert.equal(delta.head, '<meta name="description" content="Explore products"><meta name="robots" content="noindex">');
  assert.equal(extractRouteHeadMarkup(document), delta.head);
});

test("navigation representations retain managed document attributes", () => {
  const document = '<!doctype html><html lang="es" dir="rtl"><body data-route="catalog"><script type="application/json" id="__EVOLIT_DOCUMENT__">{"lang":"es","htmlAttributes":{"dir":"rtl"},"bodyAttributes":{"data-route":"catalog"}}</script><!--evolit:segment:start:page-1--><main>Catalog</main><!--evolit:segment:end:page-1--><script type="application/json" id="__EVOLIT_ROUTE__">{"segments":[{"id":"page-1"}]}</script></body>';
  const response = createNavigationResponseFromDocument({ status: 200, headers: {}, body: document });
  const delta = JSON.parse(response.body);

  assert.deepEqual(delta.document, {
    lang: "es",
    htmlAttributes: { dir: "rtl" },
    bodyAttributes: { "data-route": "catalog" },
  });
  assert.deepEqual(extractDocumentState(document), delta.document);
});
