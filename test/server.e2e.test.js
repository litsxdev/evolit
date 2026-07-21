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

function createCounterPageSource(cacheExport, counterKey, label) {
  return [
    cacheExport,
    "globalThis.__NEXTSX_ROUTE_CACHE_COUNTERS ??= { static: 0, dynamic: 0, revalidate: 0 };",
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
  await fs.mkdir(path.join(fixtureRoot, "app", "blog", "[slug]"), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, "app", "docs", "[...slug]"), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, "app", "optional", "[[...slug]]"), { recursive: true });
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
  const featureCardPath = path.join(fixtureRoot, "app", "components", "feature-card.litsx");
  const featureCardSource = await fs.readFile(featureCardPath, "utf8");
  await fs.writeFile(
    featureCardPath,
    [
      'import CardAccent from "./card-accent.litsx";',
      "",
      featureCardSource.replace(
        '      <h2 style={{ margin: "0 0 12px", fontSize: "1.25rem" }}>{title}</h2>',
        [
          "      <CardAccent />",
          '      <h2 style={{ margin: "0 0 12px", fontSize: "1.25rem" }}>{title}</h2>',
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
    await new Promise((resolve) => {
      server.close();
      resolve();
    });
  }

  if (fixtureRoot) {
    await fs.rm(path.dirname(fixtureRoot), { recursive: true, force: true });
  }
});

test("home route emits LitSX hydration bootstrap for hydratable roots", async () => {
  const response = await fetch(`${baseUrl}/`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /<script type="importmap">/);
  assert.match(html, /registerHydrationModules/);
  assert.match(html, /await hydratePage\(\)/);
  assert.match(html, /\/_nextsx\/client\/app\/components\/feature-card\.mjs/);
  assert.match(html, /<link rel="stylesheet" href="\/_nextsx\/client\/app\/components\/card-accent\.css">/);
  assert.match(html, /id="__LITSX_HYDRATION__"/);
  assert.match(html, /data-litsx-root="litsx-root-0"/);
  assert.doesNotMatch(html, /__nextsx\/hydration/);
  assert.doesNotMatch(html, /customElements\.define/);
});

test("dev server serves imported client css assets", async () => {
  const response = await fetch(`${baseUrl}/_nextsx/client/app/components/card-accent.css`);
  const css = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/css; charset=utf-8");
  assert.match(css, /\.card-accent/);
  assert.match(css, /background: #ef9459/);
});

test("dev server serves imported static svg assets", async () => {
  const response = await fetch(`${baseUrl}/_nextsx/client/app/components/card-accent.svg`);
  const svg = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/svg+xml");
  assert.match(svg, /<svg/);
  assert.match(svg, /circle/);
});

test("dev server serves imported static png assets", async () => {
  const response = await fetch(`${baseUrl}/_nextsx/client/app/components/card-badge.png`);
  const pngBase64 = Buffer.from(await response.arrayBuffer()).toString("base64");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(pngBase64, cardBadgePngBase64);
});

test("dev server serves imported static png assets with special characters in the file name", async () => {
  const response = await fetch(
    `${baseUrl}/_nextsx/client/app/components/${encodeURIComponent(cardBadgeSpecialPngFile)}`,
  );
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
  assert.match(html, /<script type="importmap">/);
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

  assert.equal(thirdResponse.headers.get("x-nextsx-cache"), "MISS");
  assert.match(firstHtml, /revalidate:1/);
  assert.match(thirdHtml, /revalidate:2/);
});
