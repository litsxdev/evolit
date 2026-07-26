import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildProject } from "../src/build.js";
import { createStartServer } from "../src/server.js";
import { scaffoldSite } from "../src/scaffold.js";

const frameworkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let fixtureRoot;
let server;
let baseUrl;
let buildManifest;
let deployRoutesManifest;
let deployAssetsManifest;
let deployServerManifest;
let builtRuntimeEntry;
const cardBadgePngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yF9sAAAAASUVORK5CYII=";
const cardBadgeSpecialPngFile = "card badge@2x.png";

function createCounterPageSource(cacheExport, counterKey, label) {
  return [
    cacheExport,
    "globalThis.__EVOLIT_ROUTE_CACHE_COUNTERS ??= { static: 0, dynamic: 0, revalidate: 0, dynamicRevalidate: 0 };",
    "",
    `export default async function ${label.replace(/[^A-Za-z]/g, "")}Page() {`,
    `  globalThis.__EVOLIT_ROUTE_CACHE_COUNTERS.${counterKey} += 1;`,
    `  const value = globalThis.__EVOLIT_ROUTE_CACHE_COUNTERS.${counterKey};`,
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
    "globalThis.__EVOLIT_ROUTE_CACHE_COUNTERS ??= { static: 0, dynamic: 0, revalidate: 0, dynamicRevalidate: 0 };",
    'export const routeConfig = { cache: { revalidate: 1 } };',
    "",
    `export default async function ${label.replace(/[^A-Za-z]/g, "")}Page({ params }) {`,
    "  await new Promise((resolve) => {",
    "    setTimeout(resolve, 50);",
    "  });",
    `  globalThis.__EVOLIT_ROUTE_CACHE_COUNTERS.${counterKey} ??= 0;`,
    `  globalThis.__EVOLIT_ROUTE_CACHE_COUNTERS.${counterKey} += 1;`,
    `  const value = globalThis.__EVOLIT_ROUTE_CACHE_COUNTERS.${counterKey};`,
    `  return \`<main data-route="${label}">${label}:\${JSON.stringify(params.${paramKey} ?? null)}:\${value}</main>\`;`,
    "}",
    "",
  ].join("\n");
}

function createStaticParamsLayoutSource(categoryEntries) {
  return [
    "export async function generateStaticParams() {",
    `  return ${JSON.stringify(categoryEntries)};`,
    "}",
    "",
    "export default async function CatalogLayout({ children }) {",
    "  return children;",
    "}",
    "",
  ].join("\n");
}

function createStaticParamsPageSource(label, routesByCategory) {
  return [
    "export const routeConfig = { cache: \"static\" };",
    "",
    "export async function generateStaticParams({ params }) {",
    "  switch (params.category) {",
    ...Object.entries(routesByCategory).flatMap(([category, slugs]) => [
      `    case ${JSON.stringify(category)}:`,
      `      return ${JSON.stringify(slugs.map((slug) => ({ slug })))};`,
    ]),
    "    default:",
    "      return [];",
    "  }",
    "}",
    "",
    `export default async function ${label.replace(/[^A-Za-z]/g, "")}Page({ params }) {`,
    `  return \`<main data-route="${label}">\${params.category}:\${params.slug}</main>\`;`,
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

  throw new Error(`Timed out waiting for cache revalidation: ${lastResponse?.response.headers.get("x-evolit-cache") ?? "no response"}`);
}

before(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-start-e2e-"));
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
      ".card-accent-wrap {",
      "  display: inline-flex;",
      "  align-items: center;",
      "  gap: 4px;",
      "}",
      "",
      ".card-accent {",
      "  width: 10px;",
      "  height: 10px;",
      "  background: #ef9459;",
      `  background-image: url("./${cardBadgeSpecialPngFile}");`,
      "}",
      "",
      ".card-badge {",
      "  width: 6px;",
      "  height: 6px;",
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
  await fs.mkdir(path.join(fixtureRoot, "app", "catalog", "[category]", "[slug]"), { recursive: true });
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
    path.join(fixtureRoot, "app", "catalog", "[category]", "layout.litsx"),
    createStaticParamsLayoutSource([
      { category: "books" },
      { category: "games" },
    ]),
    "utf8",
  );
  await fs.writeFile(
    path.join(fixtureRoot, "app", "catalog", "[category]", "[slug]", "page.litsx"),
    createStaticParamsPageSource("catalog", {
      books: ["guide"],
      games: ["chess"],
    }),
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
  await fs.mkdir(path.join(fixtureRoot, "app", "api", "echo", "[slug]"), { recursive: true });
  await fs.writeFile(
    path.join(fixtureRoot, "app", "api", "echo", "[slug]", "route.js"),
    [
      "export function GET() { return new Response(\"get\"); }",
      "export function POST() { return new Response(\"post\"); }",
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
  await buildProject(fixtureRoot);
  buildManifest = JSON.parse(
    await fs.readFile(
      path.join(fixtureRoot, ".evolit", "build", "manifest.json"),
      "utf8",
    ),
  );
  deployRoutesManifest = JSON.parse(
    await fs.readFile(
      path.join(fixtureRoot, ".evolit", "build", "deploy-routes.json"),
      "utf8",
    ),
  );
  deployAssetsManifest = JSON.parse(
    await fs.readFile(
      path.join(fixtureRoot, ".evolit", "build", "deploy-assets.json"),
      "utf8",
    ),
  );
  deployServerManifest = JSON.parse(
    await fs.readFile(
      path.join(fixtureRoot, ".evolit", "build", "deploy-server.json"),
      "utf8",
    ),
  );
  builtRuntimeEntry = await import(
    pathToFileURL(path.join(fixtureRoot, ".evolit", "build", "runtime-entry.mjs")).href
  );

  const port = await getAvailablePort();
  server = await createStartServer(fixtureRoot, { port });
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

test("start server emits hashed public asset URLs for hydration bootstrap", async () => {
  const response = await fetch(`${baseUrl}/`);
  const html = await response.text();
  const featureCardAsset = buildManifest.clientAssets.assets.find(
    (asset) => asset.clientModule === "app/components/feature-card.mjs",
  );

  assert.equal(response.status, 200);
  assert.doesNotMatch(html, /<script type="importmap">/);
  assert.match(html, /import\s+\{\s*hydratePage,\s*registerHydrationModules\s*\}\s+from\s+"\/_evolit\/shared\/litsx__ssr__hydration-[A-Za-z0-9_-]+\.mjs"/);
  assert.ok(featureCardAsset);
  assert.match(html, /registerHydrationModules/);
  assert.match(
    html,
    new RegExp(featureCardAsset.publicUrl.replaceAll(".", "\\.")),
  );
  assert.doesNotMatch(html, /\/_evolit\/client\/app\/components\/feature-card\.mjs/);
  assert.doesNotMatch(html, /__EVOLIT_ASSET_URL__/);
  assert.doesNotMatch(html, /\/var\/folders\//);
  assert.doesNotMatch(html, /\/Users\//);
});

test("build manifest classifies entry and chunk client assets with structured metadata", () => {
  const featureCardAsset = buildManifest.clientAssets.assets.find(
    (asset) => asset.clientModule === "app/components/feature-card.mjs",
  );
  const cardAccentAsset = buildManifest.clientAssets.assets.find(
    (asset) => asset.clientModule === "app/components/card-accent.mjs",
  );
  const homePageAsset = buildManifest.clientAssets.assets.find(
    (asset) => asset.clientModule === "app/page.mjs",
  );
  const cardAccentStyleAsset = buildManifest.clientAssets.assets.find(
    (asset) => asset.clientModule === "app/components/card-accent.css",
  );
  const cardAccentSvgAsset = buildManifest.clientAssets.assets.find(
    (asset) => asset.clientModule === "app/components/card-accent.svg",
  );
  const cardBadgePngAsset = buildManifest.clientAssets.assets.find(
    (asset) => asset.clientModule === "app/components/card-badge.png",
  );
  const cardBadgeSpecialPngAsset = buildManifest.clientAssets.assets.find(
    (asset) => asset.clientModule === `app/components/${cardBadgeSpecialPngFile}`,
  );

  assert.ok(featureCardAsset);
  assert.ok(cardAccentAsset);
  assert.ok(homePageAsset);
  assert.ok(cardAccentStyleAsset);
  assert.ok(cardAccentSvgAsset);
  assert.ok(cardBadgePngAsset);
  assert.ok(cardBadgeSpecialPngAsset);
  assert.equal(featureCardAsset.kind, "chunk");
  assert.equal(cardAccentAsset.kind, "chunk");
  assert.equal(homePageAsset.kind, "entry");
  assert.equal(cardAccentStyleAsset.kind, "style");
  assert.equal(cardAccentStyleAsset.type, "style");
  assert.equal(cardAccentSvgAsset.kind, "asset");
  assert.equal(cardAccentSvgAsset.type, "asset");
  assert.equal(cardBadgePngAsset.kind, "asset");
  assert.equal(cardBadgePngAsset.type, "asset");
  assert.equal(cardBadgeSpecialPngAsset.kind, "asset");
  assert.equal(cardBadgeSpecialPngAsset.type, "asset");
  assert.equal(buildManifest.clientAssets.version, 1);
  assert.equal(buildManifest.clientAssets.publicPathPrefix, "/_evolit/static/");
  assert.equal(typeof homePageAsset.hash, "string");
  assert.equal(homePageAsset.hash.length, 8);
  assert.equal(typeof homePageAsset.size, "number");
  assert.equal(homePageAsset.size > 0, true);
  assert.equal(buildManifest.clientAssets.entries.includes("app/page.mjs"), true);
  assert.equal(buildManifest.clientAssets.chunks.includes("app/components/feature-card.mjs"), true);
  assert.equal(buildManifest.clientAssets.styles.includes("app/components/card-accent.css"), true);
  assert.equal(buildManifest.clientAssets.resources.includes("app/components/card-accent.svg"), true);
  assert.equal(buildManifest.clientAssets.resources.includes("app/components/card-badge.png"), true);
  assert.equal(buildManifest.clientAssets.resources.includes(`app/components/${cardBadgeSpecialPngFile}`), true);
  assert.deepEqual(
    buildManifest.routeCache,
    [
      { pathname: "/", cache: "dynamic" },
      { pathname: "/about", cache: "dynamic" },
      { pathname: "/blog/:slug", cache: "dynamic" },
      { pathname: "/cached-dynamic", cache: "dynamic" },
      { pathname: "/cached-revalidate", cache: { revalidate: 1 } },
      { pathname: "/cached-revalidate/:slug", cache: { revalidate: 1 } },
      { pathname: "/cached-static", cache: "static" },
      { pathname: "/catalog/:category/:slug", cache: "static" },
      { pathname: "/docs/*slug", cache: "dynamic" },
      { pathname: "/optional/**slug", cache: "dynamic" },
    ],
  );
  assert.deepEqual(buildManifest.prerenderedRoutes, [
    "/cached-static",
    "/catalog/books/guide",
    "/catalog/games/chess",
  ]);
});

test("client compilation metadata captures module and vendor imports", async () => {
  const featureCardMetadata = JSON.parse(
    await fs.readFile(
      path.join(
        fixtureRoot,
        ".evolit",
        "build",
        "client",
        "app",
        "components",
        "feature-card.mjs.meta.json",
      ),
      "utf8",
    ),
  );

  assert.deepEqual(featureCardMetadata.moduleImports, ["app/components/card-accent.mjs"]);
  assert.equal(featureCardMetadata.vendorImports.includes("nanoid"), true);
  assert.equal(featureCardMetadata.vendorImports.includes("@litsx/core"), true);
  assert.equal(featureCardMetadata.vendorImports.includes("@litsx/core/elements"), true);
  assert.equal(featureCardMetadata.vendorImports.includes("lit"), true);
  assert.deepEqual(featureCardMetadata.styleImports, []);
  assert.deepEqual(featureCardMetadata.assetImports, []);
});

test("build emits deploy route and asset manifests for external deployment pipelines", () => {
  assert.equal(deployRoutesManifest.version, 2);
  assert.deepEqual(
    deployRoutesManifest.routes,
    [
      {
        pathname: "/",
        cache: "dynamic",
        cacheKey: "/",
        prerendered: false,
        prerenderedPaths: [],
        responsePath: null,
      },
      {
        pathname: "/about",
        cache: "dynamic",
        cacheKey: "/about",
        prerendered: false,
        prerenderedPaths: [],
        responsePath: null,
      },
      {
        pathname: "/blog/:slug",
        cache: "dynamic",
        cacheKey: "/blog/:slug",
        prerendered: false,
        prerenderedPaths: [],
        responsePath: null,
      },
      {
        pathname: "/cached-dynamic",
        cache: "dynamic",
        cacheKey: "/cached-dynamic",
        prerendered: false,
        prerenderedPaths: [],
        responsePath: null,
      },
      {
        pathname: "/cached-revalidate",
        cache: { revalidate: 1 },
        cacheKey: "/cached-revalidate",
        prerendered: false,
        prerenderedPaths: [],
        responsePath: null,
      },
      {
        pathname: "/cached-revalidate/:slug",
        cache: { revalidate: 1 },
        cacheKey: "/cached-revalidate/:slug",
        prerendered: false,
        prerenderedPaths: [],
        responsePath: null,
      },
      {
        pathname: "/cached-static",
        cache: "static",
        cacheKey: "/cached-static",
        prerendered: true,
        prerenderedPaths: ["/cached-static"],
        responsePath: deployRoutesManifest.routes.find((route) => route.pathname === "/cached-static")?.responsePath ?? null,
      },
      {
        pathname: "/catalog/:category/:slug",
        cache: "static",
        cacheKey: "/catalog/:category/:slug",
        prerendered: true,
        prerenderedPaths: [
          "/catalog/books/guide",
          "/catalog/games/chess",
        ],
        responsePath: null,
      },
      {
        pathname: "/docs/*slug",
        cache: "dynamic",
        cacheKey: "/docs/*slug",
        prerendered: false,
        prerenderedPaths: [],
        responsePath: null,
      },
      {
        pathname: "/optional/**slug",
        cache: "dynamic",
        cacheKey: "/optional/**slug",
        prerendered: false,
        prerenderedPaths: [],
        responsePath: null,
      },
    ],
  );
  assert.deepEqual(deployRoutesManifest.handlers, [
    {
      pathname: "/api/echo/:slug",
      methods: ["GET", "POST"],
      runtime: "server",
      cache: "dynamic",
    },
  ]);

  const htmlAsset = deployAssetsManifest.assets.find(
    (asset) => asset.kind === "html" && asset.pathname === "/cached-static",
  );
  const catalogHtmlAsset = deployAssetsManifest.assets.find(
    (asset) => asset.kind === "html" && asset.pathname === "/catalog/books/guide",
  );
  const scriptAsset = deployAssetsManifest.assets.find((asset) => asset.kind === "script");
  const styleAsset = deployAssetsManifest.assets.find((asset) => asset.kind === "style");
  const resourceAsset = deployAssetsManifest.assets.find(
    (asset) => asset.publicUrl === buildManifest.clientAssets.assets.find(
      (entry) => entry.clientModule === "app/components/card-accent.svg",
    )?.publicUrl,
  );

  assert.equal(deployAssetsManifest.version, 1);
  assert.ok(htmlAsset);
  assert.ok(catalogHtmlAsset);
  assert.ok(scriptAsset);
  assert.ok(styleAsset);
  assert.ok(resourceAsset);
  assert.equal(htmlAsset.pathname, "/cached-static");
  assert.equal(htmlAsset.cacheKey, "/cached-static");
  assert.equal(htmlAsset.cache, "static");
  assert.equal(htmlAsset.contentType, "application/json; charset=utf-8");
  assert.match(htmlAsset.outputPath, /^\.evolit\/build\/route-cache\/[a-f0-9]{40}\.json$/);
  assert.equal(catalogHtmlAsset.cache, "static");
  assert.match(catalogHtmlAsset.outputPath, /^\.evolit\/build\/route-cache\/[a-f0-9]{40}\.json$/);
  assert.match(scriptAsset.outputPath, /^\.evolit\/build\/static\//);
  assert.equal(scriptAsset.contentType, "text/javascript; charset=utf-8");
  assert.equal(styleAsset.contentType, "text/css; charset=utf-8");
  assert.equal(resourceAsset.contentType, "image/svg+xml");
});

test("build emits a generic server runtime entry for external hosts", async () => {
  assert.equal(deployServerManifest.version, 1);
  assert.equal(deployServerManifest.runtimeEntry, ".evolit/build/runtime-entry.mjs");
  assert.equal(deployServerManifest.manifestPath, ".evolit/build/manifest.json");
  assert.equal(deployServerManifest.serverOutputRoot, ".evolit/build/server");
  assert.deepEqual(deployServerManifest.exports, {
    factory: "createBuiltDeploymentRuntime",
    handler: "handleRequest",
  });
  assert.equal(typeof builtRuntimeEntry.createBuiltDeploymentRuntime, "function");
  assert.equal(typeof builtRuntimeEntry.handleRequest, "function");

  const response = await builtRuntimeEntry.handleRequest(
    new Request("http://evolit.local/cached-static"),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers["x-evolit-cache"], "HIT");
  assert.match(String(response.body), /static:1/);
});

test("start server serves hashed client asset files", async () => {
  const featureCardAsset = buildManifest.clientAssets.assets.find(
    (asset) => asset.clientModule === "app/components/feature-card.mjs",
  );

  assert.ok(featureCardAsset);

  const assetResponse = await fetch(`${baseUrl}${featureCardAsset.publicUrl}`);
  const source = await assetResponse.text();

  assert.equal(assetResponse.status, 200);
  assert.match(source, /litsx\.hydratableTag/);
  assert.match(source, /\/_evolit\/shared\/nanoid-[A-Za-z0-9_-]+\.mjs/);
  assert.match(source, /\/_evolit\/shared\/lit-[A-Za-z0-9_-]+\.mjs/);
});

test("start server serves hashed static svg assets", async () => {
  const svgAsset = buildManifest.clientAssets.assets.find(
    (asset) => asset.clientModule === "app/components/card-accent.svg",
  );

  assert.ok(svgAsset);

  const response = await fetch(`${baseUrl}${svgAsset.publicUrl}`);
  const svg = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/svg+xml");
  assert.match(svg, /<svg/);
  assert.match(svg, /circle/);
});

test("start server serves hashed static png assets", async () => {
  const pngAsset = buildManifest.clientAssets.assets.find(
    (asset) => asset.clientModule === "app/components/card-badge.png",
  );

  assert.ok(pngAsset);

  const response = await fetch(`${baseUrl}${pngAsset.publicUrl}`);
  const pngBase64 = Buffer.from(await response.arrayBuffer()).toString("base64");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(pngBase64, cardBadgePngBase64);
});

test("start server serves hashed static png assets with special characters in the file name", async () => {
  const pngAsset = buildManifest.clientAssets.assets.find(
    (asset) => asset.clientModule === `app/components/${cardBadgeSpecialPngFile}`,
  );

  assert.ok(pngAsset);

  const response = await fetch(`${baseUrl}${pngAsset.publicUrl}`);
  const pngBase64 = Buffer.from(await response.arrayBuffer()).toString("base64");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(pngBase64, cardBadgePngBase64);
});

test("start server emits hashed modulepreload links that match the asset manifest", async () => {
  const response = await fetch(`${baseUrl}/`);
  const html = await response.text();
  const featureCardAsset = buildManifest.clientAssets.assets.find(
    (asset) => asset.clientModule === "app/components/feature-card.mjs",
  );
  const cardAccentStyleAsset = buildManifest.clientAssets.assets.find(
    (asset) => asset.clientModule === "app/components/card-accent.css",
  );
  const cardAccentSvgAsset = buildManifest.clientAssets.assets.find(
    (asset) => asset.clientModule === "app/components/card-accent.svg",
  );
  const cardBadgePngAsset = buildManifest.clientAssets.assets.find(
    (asset) => asset.clientModule === "app/components/card-badge.png",
  );
  const cardBadgeSpecialPngAsset = buildManifest.clientAssets.assets.find(
    (asset) => asset.clientModule === `app/components/${cardBadgeSpecialPngFile}`,
  );

  assert.ok(featureCardAsset);
  assert.ok(cardAccentStyleAsset);
  assert.ok(cardAccentSvgAsset);
  assert.ok(cardBadgePngAsset);
  assert.ok(cardBadgeSpecialPngAsset);
  assert.match(
    html,
    new RegExp(
      `<link rel="modulepreload" href="${featureCardAsset.publicUrl.replaceAll(".", "\\.")}">`,
    ),
  );
  assert.doesNotMatch(html, /\/_evolit\/static\/chunks\/vendor-/);
  assert.match(
    html,
    new RegExp(
      `<link rel="stylesheet" href="${cardAccentStyleAsset.publicUrl.replaceAll(".", "\\.")}">`,
    ),
  );
  if (featureCardAsset.importUrls.length > 0) {
    assert.ok(featureCardAsset.importUrls.every((url) => /^\/_evolit\/shared\//.test(url)));
  }
  assert.deepEqual(featureCardAsset.styleImports, ["app/components/card-accent.css"]);
  assert.deepEqual(featureCardAsset.styleUrls, [cardAccentStyleAsset.publicUrl]);
  assert.deepEqual(featureCardAsset.assetImports, [
    `app/components/${cardBadgeSpecialPngFile}`,
    "app/components/card-accent.svg",
    "app/components/card-badge.png",
  ]);
  assert.deepEqual(featureCardAsset.assetUrls, [
    cardBadgeSpecialPngAsset.publicUrl,
    cardAccentSvgAsset.publicUrl,
    cardBadgePngAsset.publicUrl,
  ]);
  const cssResponse = await fetch(`${baseUrl}${cardAccentStyleAsset.publicUrl}`);
  const css = await cssResponse.text();
  assert.equal(cssResponse.status, 200);
  assert.match(
    css,
    new RegExp(path.basename(decodeURIComponent(cardBadgeSpecialPngAsset.publicUrl)).replaceAll(".", "\\.")),
  );
  assert.doesNotMatch(css, /card badge@2x\.png/);
});

test("start server omits hashed hydration preload output for non-hydrated routes", async () => {
  const response = await fetch(`${baseUrl}/about`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.doesNotMatch(html, /rel="modulepreload"/);
  assert.match(html, /<link rel="stylesheet" href="\/_evolit\/static\/app\/global\.[a-f0-9]{8}\.css">/);
  assert.doesNotMatch(html, /registerHydrationModules/);
  assert.doesNotMatch(html, /__LITSX_HYDRATION__/);
});

test("start server serves prerendered static routes from the build cache", async () => {
  const firstResponse = await fetch(`${baseUrl}/cached-static`);
  const firstHtml = await firstResponse.text();
  const secondResponse = await fetch(`${baseUrl}/cached-static`);
  const secondHtml = await secondResponse.text();

  assert.equal(firstResponse.headers.get("x-evolit-cache"), "HIT");
  assert.equal(secondResponse.headers.get("x-evolit-cache"), "HIT");
  assert.match(firstHtml, /static:1/);
  assert.equal(secondHtml, firstHtml);
});

test("start server serves prerendered dynamic static routes from the build cache", async () => {
  const firstResponse = await fetch(`${baseUrl}/catalog/books/guide`);
  const firstHtml = await firstResponse.text();
  const secondResponse = await fetch(`${baseUrl}/catalog/books/guide`);
  const secondHtml = await secondResponse.text();

  assert.equal(firstResponse.headers.get("x-evolit-cache"), "HIT");
  assert.equal(secondResponse.headers.get("x-evolit-cache"), "HIT");
  assert.match(firstHtml, /books:guide/);
  assert.equal(secondHtml, firstHtml);
});

test("start server falls back to on-demand caching for non-prerendered dynamic static routes", async () => {
  const firstResponse = await fetch(`${baseUrl}/catalog/books/novel`);
  const firstHtml = await firstResponse.text();
  const secondResponse = await fetch(`${baseUrl}/catalog/books/novel`);
  const secondHtml = await secondResponse.text();

  assert.equal(firstResponse.headers.get("x-evolit-cache"), "MISS");
  assert.equal(secondResponse.headers.get("x-evolit-cache"), "HIT");
  assert.match(firstHtml, /books:novel/);
  assert.equal(secondHtml, firstHtml);
});

test("start server keeps dynamic routes uncached", async () => {
  const firstResponse = await fetch(`${baseUrl}/cached-dynamic`);
  const firstHtml = await firstResponse.text();
  const secondResponse = await fetch(`${baseUrl}/cached-dynamic`);
  const secondHtml = await secondResponse.text();

  assert.equal(firstResponse.headers.get("x-evolit-cache"), "SKIP");
  assert.equal(secondResponse.headers.get("x-evolit-cache"), "SKIP");
  assert.match(firstHtml, /dynamic:1/);
  assert.match(secondHtml, /dynamic:2/);
});

test("start server resolves single dynamic segments", async () => {
  const response = await fetch(`${baseUrl}/blog/hello-world`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /blog:&quot;hello-world&quot;/);
});

test("start server resolves catch-all dynamic segments", async () => {
  const response = await fetch(`${baseUrl}/docs/guides/routing/dynamic`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /docs:\[&quot;guides&quot;,&quot;routing&quot;,&quot;dynamic&quot;\]/);
});

test("start server resolves optional catch-all routes with and without trailing segments", async () => {
  const withoutSegmentsResponse = await fetch(`${baseUrl}/optional`);
  const withoutSegmentsHtml = await withoutSegmentsResponse.text();
  const withSegmentsResponse = await fetch(`${baseUrl}/optional/a/b`);
  const withSegmentsHtml = await withSegmentsResponse.text();

  assert.equal(withoutSegmentsResponse.status, 200);
  assert.match(withoutSegmentsHtml, /optional:null/);
  assert.equal(withSegmentsResponse.status, 200);
  assert.match(withSegmentsHtml, /optional:\[&quot;a&quot;,&quot;b&quot;\]/);
});

test("start server revalidates cached routes after the configured ttl", async () => {
  const firstResponse = await fetch(`${baseUrl}/cached-revalidate`);
  const firstHtml = await firstResponse.text();
  const secondResponse = await fetch(`${baseUrl}/cached-revalidate`);
  const secondHtml = await secondResponse.text();

  assert.equal(firstResponse.headers.get("x-evolit-cache"), "MISS");
  assert.equal(secondResponse.headers.get("x-evolit-cache"), "HIT");
  assert.equal(secondHtml, firstHtml);

  await new Promise((resolve) => {
    setTimeout(resolve, 1100);
  });

  const thirdResponse = await fetch(`${baseUrl}/cached-revalidate`);
  const thirdHtml = await thirdResponse.text();
  const { response: fourthResponse, body: fourthHtml } = await waitForResponse(
    () => fetch(`${baseUrl}/cached-revalidate`),
    ({ response }) => response.headers.get("x-evolit-cache") === "HIT",
  );

  assert.equal(thirdResponse.headers.get("x-evolit-cache"), "STALE");
  assert.equal(thirdHtml, firstHtml);
  assert.equal(fourthResponse.headers.get("x-evolit-cache"), "HIT");
  assert.match(firstHtml, /revalidate:1/);
  assert.match(fourthHtml, /revalidate:2/);
});

test("start server revalidates dynamic routes in the background per pathname", async () => {
  const firstResponse = await fetch(`${baseUrl}/cached-revalidate/alpha`);
  const firstHtml = await firstResponse.text();
  const secondResponse = await fetch(`${baseUrl}/cached-revalidate/alpha`);
  const secondHtml = await secondResponse.text();

  assert.equal(firstResponse.headers.get("x-evolit-cache"), "MISS");
  assert.equal(secondResponse.headers.get("x-evolit-cache"), "HIT");
  assert.equal(secondHtml, firstHtml);

  await new Promise((resolve) => {
    setTimeout(resolve, 1100);
  });

  const thirdResponse = await fetch(`${baseUrl}/cached-revalidate/alpha`);
  const thirdHtml = await thirdResponse.text();
  const { response: fourthResponse, body: fourthHtml } = await waitForResponse(
    () => fetch(`${baseUrl}/cached-revalidate/alpha`),
    ({ response }) => response.headers.get("x-evolit-cache") === "HIT",
  );
  const otherPathResponse = await fetch(`${baseUrl}/cached-revalidate/beta`);
  const otherPathHtml = await otherPathResponse.text();

  assert.equal(thirdResponse.headers.get("x-evolit-cache"), "STALE");
  assert.equal(thirdHtml, firstHtml);
  assert.equal(fourthResponse.headers.get("x-evolit-cache"), "HIT");
  assert.match(firstHtml, /dynamic-revalidate:&quot;alpha&quot;:1/);
  assert.match(fourthHtml, /dynamic-revalidate:&quot;alpha&quot;:2/);
  assert.equal(otherPathResponse.headers.get("x-evolit-cache"), "MISS");
  assert.match(otherPathHtml, /dynamic-revalidate:&quot;beta&quot;:3/);
});
