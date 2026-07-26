import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { createDevServer } from "../src/server.js";
import { scaffoldSite } from "../src/scaffold.js";

const frameworkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let fixtureRoot;
let server;
let baseUrl;
const cardBadgePngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yF9sAAAAASUVORK5CYII=";
const cardBadgeSpecialPngFile = "card badge@2x.png";

async function readDevClientAssetsManifest() {
  return JSON.parse(
    await fs.readFile(
      path.join(fixtureRoot, ".nextsx", "dev", "client-assets.json"),
      "utf8",
    ),
  );
}

async function getDevAssetPublicUrl(clientModule) {
  const manifest = await readDevClientAssetsManifest();
  const asset = manifest.assets.find((entry) => entry.clientModule === clientModule);
  assert.ok(asset, `Expected dev asset manifest entry for ${clientModule}`);
  return asset.publicUrl;
}

function createCounterPageSource(cacheExport, counterKey, label) {
  return [
    cacheExport,
    "globalThis.__NEXTSX_ROUTE_CACHE_COUNTERS ??= { static: 0, dynamic: 0, revalidate: 0, dynamicRevalidate: 0 };",
    "",
    `export default async function ${label.replace(/[^A-Za-z]/g, "")}Page() {`,
    `  globalThis.__NEXTSX_ROUTE_CACHE_COUNTERS.${counterKey} += 1;`,
    `  const value = globalThis.__NEXTSX_ROUTE_CACHE_COUNTERS.${counterKey};`,
    `  return \`<main data-cache-label="${label}" data-cache-value="\${value}">${label}:\${value}</main>\`;`,
    "}",
    "",
  ].join("\n");
}

function createParamsPageSource(label, paramKey) {
  return [
    `export default async function ${label.replace(/[^A-Za-z]/g, "")}Page({ params }) {`,
    `  return \`<main data-route="${label}">${label}:\${JSON.stringify(params.${paramKey} ?? null)}</main>\`;`,
    "}",
    "",
  ].join("\n");
}

function createRevalidateParamsPageSource(label, counterKey, paramKey) {
  return [
    "globalThis.__NEXTSX_ROUTE_CACHE_COUNTERS ??= { static: 0, dynamic: 0, revalidate: 0, dynamicRevalidate: 0 };",
    'export const routeConfig = { cache: { revalidate: 1 } };',
    "",
    `export default async function ${label.replace(/[^A-Za-z]/g, "")}Page({ params }) {`,
    "  await new Promise((resolve) => {",
    "    setTimeout(resolve, 50);",
    "  });",
    `  globalThis.__NEXTSX_ROUTE_CACHE_COUNTERS.${counterKey} ??= 0;`,
    `  globalThis.__NEXTSX_ROUTE_CACHE_COUNTERS.${counterKey} += 1;`,
    `  const value = globalThis.__NEXTSX_ROUTE_CACHE_COUNTERS.${counterKey};`,
    `  return \`<main data-route="${label}">${label}:\${JSON.stringify(params.${paramKey} ?? null)}:\${value}</main>\`;`,
    "}",
    "",
  ].join("\n");
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.listen(0, () => {
      const address = socket.address();
      if (!address || typeof address === "string") {
        socket.close();
        reject(new Error("Failed to resolve an ephemeral port for the test server."));
        return;
      }

      const { port } = address;
      socket.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    socket.on("error", reject);
  });
}

async function waitForResponse(request, predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let lastResponse = null;

  while (Date.now() < deadline) {
    const response = await request();
    const body = await response.text();
    lastResponse = { response, body };
    if (predicate(lastResponse)) {
      return lastResponse;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }

  throw new Error(`Timed out waiting for development watcher update: ${lastResponse?.response.status ?? "no response"}`);
}

before(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nextsx-e2e-"));
  fixtureRoot = path.join(tempRoot, "app");

  await scaffoldSite(fixtureRoot);
  await fs.symlink(
    path.join(frameworkRoot, "node_modules"),
    path.join(fixtureRoot, "node_modules"),
    "dir",
  );
  await fs.writeFile(
    path.join(fixtureRoot, "app", "components", "card-accent.svg"),
    [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">',
      '  <circle cx="5" cy="5" r="5" fill="#ef9459" />',
      "</svg>",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(fixtureRoot, "app", "components", "card-badge.png"),
    Buffer.from(cardBadgePngBase64, "base64"),
  );
  await fs.writeFile(
    path.join(fixtureRoot, "app", "components", cardBadgeSpecialPngFile),
    Buffer.from(cardBadgePngBase64, "base64"),
  );
  await fs.writeFile(
    path.join(fixtureRoot, "app", "components", "card-accent.litsx"),
    [
      'import "./card-accent.css";',
      'import accentIcon from "./card-accent.svg";',
      'import badgeIcon from "./card-badge.png";',
      `import badgePoster from "./${cardBadgeSpecialPngFile}";`,
      "",
      "export default function CardAccent() {",
      "  return (",
      '    <span className="card-accent-wrap">',
      '      <img src={accentIcon} className="card-accent" alt="" />',
      '      <img src={badgeIcon} className="card-badge" alt="" />',
      '      <img src={badgePoster} className="card-badge-poster" alt="" />',
      "    </span>",
      "  );",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(fixtureRoot, "app", "components", "card-accent.css"),
    [
      ".card-accent {",
      "  display: inline-block;",
      "  width: 10px;",
      "  height: 10px;",
      "  background: #ef9459;",
      "}",
      "",
      ".card-badge {",
      "  width: 6px;",
      "  height: 6px;",
      `  background-image: url("./${cardBadgeSpecialPngFile}");`,
      "}",
      "",
      ".card-badge-poster {",
      "  width: 6px;",
      "  height: 6px;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.mkdir(path.join(fixtureRoot, "app", "cached-static"), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, "app", "cached-dynamic"), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, "app", "cached-revalidate"), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, "app", "cached-revalidate", "[slug]"), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, "app", "blog", "[slug]"), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, "app", "docs", "[...slug]"), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, "app", "optional", "[[...slug]]"), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, "app", "lit"), { recursive: true });
  await fs.writeFile(
    path.join(fixtureRoot, "app", "cached-static", "page.litsx"),
    createCounterPageSource(
      'export const routeConfig = { cache: "static" };',
      "static",
      "static",
    ),
    "utf8",
  );
  await fs.writeFile(
    path.join(fixtureRoot, "app", "cached-dynamic", "page.litsx"),
    createCounterPageSource(
      'export const routeConfig = { cache: "dynamic" };',
      "dynamic",
      "dynamic",
    ),
    "utf8",
  );
  await fs.writeFile(
    path.join(fixtureRoot, "app", "cached-revalidate", "page.litsx"),
    createCounterPageSource(
      "export const routeConfig = { cache: { revalidate: 1 } };",
      "revalidate",
      "revalidate",
    ),
    "utf8",
  );
  await fs.writeFile(
    path.join(fixtureRoot, "app", "cached-revalidate", "[slug]", "page.litsx"),
    createRevalidateParamsPageSource("dynamic-revalidate", "dynamicRevalidate", "slug"),
    "utf8",
  );
  await fs.writeFile(
    path.join(fixtureRoot, "app", "blog", "[slug]", "page.litsx"),
    createParamsPageSource("blog", "slug"),
    "utf8",
  );
  await fs.writeFile(
    path.join(fixtureRoot, "app", "docs", "[...slug]", "page.litsx"),
    createParamsPageSource("docs", "slug"),
    "utf8",
  );
  await fs.writeFile(
    path.join(fixtureRoot, "app", "optional", "[[...slug]]", "page.litsx"),
    createParamsPageSource("optional", "slug"),
    "utf8",
  );
  await fs.writeFile(
    path.join(fixtureRoot, "app", "lit", "layout.js"),
    [
      'import { html } from "lit";',
      "",
      "export default async function LitLayout({ children }) {",
      '  return html`<section data-route-layout="lit">${children}</section>`;',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(fixtureRoot, "app", "lit", "product-card.js"),
    [
      'import { LitElement, html } from "lit";',
      "",
      "export default class ProductCard extends LitElement {",
      "  static properties = { product: { attribute: false } };",
      "",
      "  render() {",
      '    return html`<article data-product-card>${this.product.name}</article>`;',
      "  }",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(fixtureRoot, "app", "lit", "page.js"),
    [
      'import { html } from "lit";',
      'import ProductCard from "./product-card.js";',
      "",
      'export const metadata = { title: "Native Lit Route" };',
      "",
      "export default async function LitPage() {",
      '  return html`<main data-route="lit"><h1>Native Lit route</h1><product-card .product=${{ name: "Field Guide" }}></product-card></main>`;',
      "}",
      "",
      "LitPage.elements = {",
      '  "product-card": ProductCard,',
      "};",
      "",
    ].join("\n"),
    "utf8",
  );
  const featureCardPath = path.join(fixtureRoot, "app", "components", "feature-card.litsx");
  const featureCardSource = await fs.readFile(featureCardPath, "utf8");
  await fs.writeFile(
    featureCardPath,
    [
      'import { nanoid } from "nanoid";',
      'import CardAccent from "./card-accent.litsx";',
      "",
      featureCardSource.replace(
        '      <h2 class="title">{title}</h2>',
        [
          "      <CardAccent />",
          '      <p data-vendor-ready={typeof nanoid === "function" ? "yes" : "no"}></p>',
          '      <h2 class="title">{title}</h2>',
        ].join("\n"),
      ),
    ].join("\n"),
    "utf8",
  );

  const port = await getAvailablePort();
  server = await createDevServer(fixtureRoot, { port });
  await server.listen();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) {
    await server.close();
  }

  if (fixtureRoot) {
    await fs.rm(path.dirname(fixtureRoot), { recursive: true, force: true });
  }
});

test("home route emits LitSX hydration bootstrap for hydratable roots", async () => {
  const response = await fetch(`${baseUrl}/`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.doesNotMatch(html, /<script type="importmap">/);
  assert.match(html, /import \{ hydratePage, registerHydrationModules \} from "\/_nextsx\/shared\/litsx__ssr__hydration(?:-[A-Za-z0-9_-]+)?\.mjs"/);
  assert.match(html, /registerHydrationModules/);
  assert.match(html, /await hydratePage\(\{/);
  assert.match(html, /clientImports: \[\]/);
  assert.match(html, /\/_nextsx\/static\/app\/components\/feature-card\.mjs/);
  assert.match(html, /<link rel="stylesheet" href="\/_nextsx\/static\/app\/components\/card-accent\.[a-f0-9]{8}\.css">/);
  assert.match(html, /id="__LITSX_HYDRATION__"/);
  assert.match(html, /data-litsx-root="litsx-root-0"/);
  assert.doesNotMatch(html, /__nextsx\/hydration/);
  assert.doesNotMatch(html, /customElements\.define/);
});

test("dev server renders native Lit page and layout modules", async () => {
  const response = await fetch(`${baseUrl}/lit`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /<title>Native Lit Route<\/title>/);
  assert.match(html, /data-route-layout="lit"/);
  assert.match(html, /data-route="lit"/);
  assert.match(html, /Native Lit route/);
  assert.match(html, /<product-card\b[^>]*data-litsx-root="litsx-root-0"/);
  assert.match(html, /data-product-card[\s\S]*?Field Guide/);
  assert.match(html, /"moduleId":"\/app\/lit\/product-card\.js"/);
  assert.match(html, /\/_nextsx\/static\/app\/lit\/product-card\.mjs/);
  assert.doesNotMatch(html, /customElements\.define/);
});

test("dev server serves imported client css assets", async () => {
  await fetch(`${baseUrl}/`);
  const publicUrl = await getDevAssetPublicUrl("app/components/card-accent.css");
  const response = await fetch(`${baseUrl}${publicUrl}`);
  const css = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/css; charset=utf-8");
  assert.match(css, /\.card-accent/);
  assert.match(css, /background: #ef9459/);
});

test("dev server serves imported static svg assets", async () => {
  await fetch(`${baseUrl}/`);
  const publicUrl = await getDevAssetPublicUrl("app/components/card-accent.svg");
  const response = await fetch(`${baseUrl}${publicUrl}`);
  const svg = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/svg+xml");
  assert.match(svg, /<svg/);
  assert.match(svg, /circle/);
});

test("dev server serves imported static png assets", async () => {
  await fetch(`${baseUrl}/`);
  const publicUrl = await getDevAssetPublicUrl("app/components/card-badge.png");
  const response = await fetch(`${baseUrl}${publicUrl}`);
  const pngBase64 = Buffer.from(await response.arrayBuffer()).toString("base64");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(pngBase64, cardBadgePngBase64);
});

test("dev server serves imported static png assets with special characters in the file name", async () => {
  await fetch(`${baseUrl}/`);
  const publicUrl = await getDevAssetPublicUrl(`app/components/${cardBadgeSpecialPngFile}`);
  const response = await fetch(`${baseUrl}${publicUrl}`);
  const pngBase64 = Buffer.from(await response.arrayBuffer()).toString("base64");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(pngBase64, cardBadgePngBase64);
});

test("non-hydrated route omits the generated hydration bootstrap", async () => {
  const response = await fetch(`${baseUrl}/about`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /<title>About \| nextsx<\/title>/);
  assert.doesNotMatch(html, /<script type="importmap">/);
  assert.doesNotMatch(html, /rel="stylesheet"/);
  assert.doesNotMatch(html, /registerHydrationModules/);
  assert.doesNotMatch(html, /await hydratePage\(\)/);
  assert.doesNotMatch(html, /id="__LITSX_HYDRATION__"/);
});

test("dev server caches static routes across requests", async () => {
  const firstResponse = await fetch(`${baseUrl}/cached-static`);
  const firstHtml = await firstResponse.text();
  const secondResponse = await fetch(`${baseUrl}/cached-static`);
  const secondHtml = await secondResponse.text();

  assert.equal(firstResponse.headers.get("x-nextsx-cache"), "MISS");
  assert.equal(secondResponse.headers.get("x-nextsx-cache"), "HIT");
  assert.match(firstHtml, /static:1/);
  assert.equal(secondHtml, firstHtml);
});

test("dev server keeps dynamic routes uncached", async () => {
  const firstResponse = await fetch(`${baseUrl}/cached-dynamic`);
  const firstHtml = await firstResponse.text();
  const secondResponse = await fetch(`${baseUrl}/cached-dynamic`);
  const secondHtml = await secondResponse.text();

  assert.equal(firstResponse.headers.get("x-nextsx-cache"), "SKIP");
  assert.equal(secondResponse.headers.get("x-nextsx-cache"), "SKIP");
  assert.match(firstHtml, /dynamic:1/);
  assert.match(secondHtml, /dynamic:2/);
});

test("dev server resolves single dynamic segments", async () => {
  const response = await fetch(`${baseUrl}/blog/hello-world`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /blog:&quot;hello-world&quot;/);
});

test("dev server resolves catch-all dynamic segments", async () => {
  const response = await fetch(`${baseUrl}/docs/guides/routing/dynamic`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /docs:\[&quot;guides&quot;,&quot;routing&quot;,&quot;dynamic&quot;\]/);
});

test("dev server resolves optional catch-all routes with and without trailing segments", async () => {
  const withoutSegmentsResponse = await fetch(`${baseUrl}/optional`);
  const withoutSegmentsHtml = await withoutSegmentsResponse.text();
  const withSegmentsResponse = await fetch(`${baseUrl}/optional/a/b`);
  const withSegmentsHtml = await withSegmentsResponse.text();

  assert.equal(withoutSegmentsResponse.status, 200);
  assert.match(withoutSegmentsHtml, /optional:null/);
  assert.equal(withSegmentsResponse.status, 200);
  assert.match(withSegmentsHtml, /optional:\[&quot;a&quot;,&quot;b&quot;\]/);
});

test("dev server revalidates cached routes after the configured ttl", async () => {
  const firstResponse = await fetch(`${baseUrl}/cached-revalidate`);
  const firstHtml = await firstResponse.text();
  const secondResponse = await fetch(`${baseUrl}/cached-revalidate`);
  const secondHtml = await secondResponse.text();

  assert.equal(firstResponse.headers.get("x-nextsx-cache"), "MISS");
  assert.equal(secondResponse.headers.get("x-nextsx-cache"), "HIT");
  assert.equal(secondHtml, firstHtml);

  await new Promise((resolve) => {
    setTimeout(resolve, 1100);
  });

  const thirdResponse = await fetch(`${baseUrl}/cached-revalidate`);
  const thirdHtml = await thirdResponse.text();
  const { response: fourthResponse, body: fourthHtml } = await waitForResponse(
    () => fetch(`${baseUrl}/cached-revalidate`),
    ({ response, body }) => response.headers.get("x-nextsx-cache") === "HIT" && body !== firstHtml,
  );

  assert.equal(thirdResponse.headers.get("x-nextsx-cache"), "STALE");
  assert.equal(thirdHtml, firstHtml);
  assert.equal(fourthResponse.headers.get("x-nextsx-cache"), "HIT");
  assert.match(firstHtml, /revalidate:1/);
  assert.match(fourthHtml, /revalidate:2/);
});

test("dev server revalidates dynamic routes in the background per pathname", async () => {
  const firstResponse = await fetch(`${baseUrl}/cached-revalidate/alpha`);
  const firstHtml = await firstResponse.text();
  const secondResponse = await fetch(`${baseUrl}/cached-revalidate/alpha`);
  const secondHtml = await secondResponse.text();

  assert.equal(firstResponse.headers.get("x-nextsx-cache"), "MISS");
  assert.equal(secondResponse.headers.get("x-nextsx-cache"), "HIT");
  assert.equal(secondHtml, firstHtml);

  await new Promise((resolve) => {
    setTimeout(resolve, 1100);
  });

  const thirdResponse = await fetch(`${baseUrl}/cached-revalidate/alpha`);
  const thirdHtml = await thirdResponse.text();
  const { response: fourthResponse, body: fourthHtml } = await waitForResponse(
    () => fetch(`${baseUrl}/cached-revalidate/alpha`),
    ({ response, body }) => response.headers.get("x-nextsx-cache") === "HIT" && body !== firstHtml,
  );
  const otherPathResponse = await fetch(`${baseUrl}/cached-revalidate/beta`);
  const otherPathHtml = await otherPathResponse.text();

  assert.equal(thirdResponse.headers.get("x-nextsx-cache"), "STALE");
  assert.equal(thirdHtml, firstHtml);
  assert.equal(fourthResponse.headers.get("x-nextsx-cache"), "HIT");
  assert.match(firstHtml, /dynamic-revalidate:&quot;alpha&quot;:1/);
  assert.match(fourthHtml, /dynamic-revalidate:&quot;alpha&quot;:2/);
  assert.equal(otherPathResponse.headers.get("x-nextsx-cache"), "MISS");
  assert.match(otherPathHtml, /dynamic-revalidate:&quot;beta&quot;:3/);
});

test("dev server discovers new routes and invalidates cached route responses", async () => {
  const routeDirectory = path.join(fixtureRoot, "app", "watcher-route");
  const routePath = path.join(routeDirectory, "page.litsx");

  const initialResponse = await fetch(`${baseUrl}/watcher-route`);
  assert.equal(initialResponse.status, 404);

  await fs.mkdir(routeDirectory, { recursive: true });
  await fs.writeFile(
    routePath,
    [
      'export const routeConfig = { cache: "static" };',
      "",
      "export default async function WatcherRoute() {",
      '  return "<main>watcher version one</main>";',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  const createdRoute = await waitForResponse(
    () => fetch(`${baseUrl}/watcher-route`),
    ({ response, body }) => response.status === 200 && body.includes("watcher version one"),
  );
  assert.equal(createdRoute.response.headers.get("x-nextsx-cache"), "MISS");

  await fs.writeFile(
    routePath,
    [
      'export const routeConfig = { cache: "static" };',
      "",
      "export default async function WatcherRoute() {",
      '  return "<main>watcher version two</main>";',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  await waitForResponse(
    () => fetch(`${baseUrl}/watcher-route`),
    ({ response, body }) => response.status === 200 && body.includes("watcher version two"),
  );
});
