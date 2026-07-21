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
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nextsx-start-e2e-"));
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
      '    <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>',
      '      <img src={accentIcon} alt="" style={{ display: "inline-block", width: "10px", height: "10px" }} />',
      '      <img src={badgeIcon} alt="" style={{ display: "inline-block", width: "6px", height: "6px" }} />',
      '      <img src={badgePoster} alt="" style={{ display: "inline-block", width: "6px", height: "6px" }} />',
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
      "  border-radius: 999px;",
      "  background: #ef9459;",
      `  background-image: url("./${cardBadgeSpecialPngFile}");`,
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
  await buildProject(fixtureRoot);
  buildManifest = JSON.parse(
    await fs.readFile(
      path.join(fixtureRoot, ".nextsx", "build", "manifest.json"),
      "utf8",
    ),
  );
  deployRoutesManifest = JSON.parse(
    await fs.readFile(
      path.join(fixtureRoot, ".nextsx", "build", "deploy-routes.json"),
      "utf8",
    ),
  );
  deployAssetsManifest = JSON.parse(
    await fs.readFile(
      path.join(fixtureRoot, ".nextsx", "build", "deploy-assets.json"),
      "utf8",
    ),
  );
  deployServerManifest = JSON.parse(
    await fs.readFile(
      path.join(fixtureRoot, ".nextsx", "build", "deploy-server.json"),
      "utf8",
    ),
  );
  builtRuntimeEntry = await import(
    pathToFileURL(path.join(fixtureRoot, ".nextsx", "build", "runtime-entry.mjs")).href
  );

  const port = await getAvailablePort();
  server = await createStartServer(fixtureRoot, { port });
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

test("start server emits hashed public asset URLs for hydration bootstrap", async () => {
  const response = await fetch(`${baseUrl}/`);
  const html = await response.text();
  const featureCardAsset = buildManifest.clientAssets.assets.find(
    (asset) => asset.clientModule === "app/components/feature-card.mjs",
  );

  assert.equal(response.status, 200);
  assert.ok(featureCardAsset);
  assert.match(html, /registerHydrationModules/);
  assert.match(
    html,
    new RegExp(featureCardAsset.publicUrl.replaceAll(".", "\\.")),
  );
  assert.doesNotMatch(html, /\/_nextsx\/client\/app\/components\/feature-card\.mjs/);
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
  assert.equal(buildManifest.clientAssets.publicPathPrefix, "/_nextsx/static/");
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
      { pathname: "/cached-static", cache: "static" },
      { pathname: "/docs/*slug", cache: "dynamic" },
      { pathname: "/optional/**slug", cache: "dynamic" },
    ],
  );
  assert.deepEqual(buildManifest.prerenderedRoutes, ["/cached-static"]);
});

test("build emits deploy route and asset manifests for external deployment pipelines", () => {
  assert.equal(deployRoutesManifest.version, 1);
  assert.deepEqual(
    deployRoutesManifest.routes,
    [
      {
        pathname: "/",
        cache: "dynamic",
        cacheKey: "/",
        prerendered: false,
        responsePath: null,
      },
      {
        pathname: "/about",
        cache: "dynamic",
        cacheKey: "/about",
        prerendered: false,
        responsePath: null,
      },
      {
        pathname: "/blog/:slug",
        cache: "dynamic",
        cacheKey: "/blog/:slug",
        prerendered: false,
        responsePath: null,
      },
      {
        pathname: "/cached-dynamic",
        cache: "dynamic",
        cacheKey: "/cached-dynamic",
        prerendered: false,
        responsePath: null,
      },
      {
        pathname: "/cached-revalidate",
        cache: { revalidate: 1 },
        cacheKey: "/cached-revalidate",
        prerendered: false,
        responsePath: null,
      },
      {
        pathname: "/cached-static",
        cache: "static",
        cacheKey: "/cached-static",
        prerendered: true,
        responsePath: deployRoutesManifest.routes.find((route) => route.pathname === "/cached-static")?.responsePath ?? null,
      },
      {
        pathname: "/docs/*slug",
        cache: "dynamic",
        cacheKey: "/docs/*slug",
        prerendered: false,
        responsePath: null,
      },
      {
        pathname: "/optional/**slug",
        cache: "dynamic",
        cacheKey: "/optional/**slug",
        prerendered: false,
        responsePath: null,
      },
    ],
  );

  const htmlAsset = deployAssetsManifest.assets.find((asset) => asset.kind === "html");
  const scriptAsset = deployAssetsManifest.assets.find((asset) => asset.kind === "script");
  const styleAsset = deployAssetsManifest.assets.find((asset) => asset.kind === "style");
  const resourceAsset = deployAssetsManifest.assets.find(
    (asset) => asset.publicUrl === buildManifest.clientAssets.assets.find(
      (entry) => entry.clientModule === "app/components/card-accent.svg",
    )?.publicUrl,
  );

  assert.equal(deployAssetsManifest.version, 1);
  assert.ok(htmlAsset);
  assert.ok(scriptAsset);
  assert.ok(styleAsset);
  assert.ok(resourceAsset);
  assert.equal(htmlAsset.pathname, "/cached-static");
  assert.equal(htmlAsset.cacheKey, "/cached-static");
  assert.equal(htmlAsset.cache, "static");
  assert.equal(htmlAsset.contentType, "application/json; charset=utf-8");
  assert.match(htmlAsset.outputPath, /^\.nextsx\/build\/route-cache\/[a-f0-9]{40}\.json$/);
  assert.match(scriptAsset.outputPath, /^\.nextsx\/build\/static\//);
  assert.equal(scriptAsset.contentType, "text/javascript; charset=utf-8");
  assert.equal(styleAsset.contentType, "text/css; charset=utf-8");
  assert.equal(resourceAsset.contentType, "image/svg+xml");
});

test("build emits a generic server runtime entry for external hosts", async () => {
  assert.equal(deployServerManifest.version, 1);
  assert.equal(deployServerManifest.runtimeEntry, ".nextsx/build/runtime-entry.mjs");
  assert.equal(deployServerManifest.manifestPath, ".nextsx/build/manifest.json");
  assert.equal(deployServerManifest.serverOutputRoot, ".nextsx/build/server");
  assert.deepEqual(deployServerManifest.exports, {
    factory: "createBuiltDeploymentRuntime",
    handler: "handleRequest",
  });
  assert.equal(typeof builtRuntimeEntry.createBuiltDeploymentRuntime, "function");
  assert.equal(typeof builtRuntimeEntry.handleRequest, "function");

  const response = await builtRuntimeEntry.handleRequest(
    new Request("http://nextsx.local/cached-static"),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers["x-nextsx-cache"], "HIT");
  assert.match(String(response.body), /static:1/);
});

test("start server serves hashed client asset files", async () => {
  const pageResponse = await fetch(`${baseUrl}/`);
  const html = await pageResponse.text();
  const match = html.match(/(\/_nextsx\/static\/app\/components\/feature-card\.[a-f0-9]{8}\.mjs)/);

  assert.ok(match);

  const assetResponse = await fetch(`${baseUrl}${match[1]}`);
  const source = await assetResponse.text();

  assert.equal(assetResponse.status, 200);
  assert.match(source, /litsx\.hydratableTag/);
  assert.match(source, /card-accent\.[a-f0-9]{8}\.mjs/);
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
  const cardAccentAsset = buildManifest.clientAssets.assets.find(
    (asset) => asset.clientModule === "app/components/card-accent.mjs",
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
  assert.match(
    html,
    new RegExp(
      `<link rel="modulepreload" href="${cardAccentAsset.publicUrl.replaceAll(".", "\\.")}">`,
    ),
  );
  assert.match(
    html,
    new RegExp(
      `<link rel="stylesheet" href="${cardAccentStyleAsset.publicUrl.replaceAll(".", "\\.")}">`,
    ),
  );
  assert.deepEqual(featureCardAsset.imports, ["app/components/card-accent.mjs"]);
  assert.deepEqual(featureCardAsset.importUrls, [cardAccentAsset.publicUrl]);
  assert.deepEqual(cardAccentAsset.styleImports, ["app/components/card-accent.css"]);
  assert.deepEqual(cardAccentAsset.styleUrls, [cardAccentStyleAsset.publicUrl]);
  assert.deepEqual(cardAccentAsset.assetImports, [
    `app/components/${cardBadgeSpecialPngFile}`,
    "app/components/card-accent.svg",
    "app/components/card-badge.png",
  ]);
  assert.deepEqual(cardAccentAsset.assetUrls, [
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
  assert.doesNotMatch(html, /rel="stylesheet"/);
  assert.doesNotMatch(html, /registerHydrationModules/);
  assert.doesNotMatch(html, /__LITSX_HYDRATION__/);
});

test("start server serves prerendered static routes from the build cache", async () => {
  const firstResponse = await fetch(`${baseUrl}/cached-static`);
  const firstHtml = await firstResponse.text();
  const secondResponse = await fetch(`${baseUrl}/cached-static`);
  const secondHtml = await secondResponse.text();

  assert.equal(firstResponse.headers.get("x-nextsx-cache"), "HIT");
  assert.equal(secondResponse.headers.get("x-nextsx-cache"), "HIT");
  assert.match(firstHtml, /static:1/);
  assert.equal(secondHtml, firstHtml);
});

test("start server keeps dynamic routes uncached", async () => {
  const firstResponse = await fetch(`${baseUrl}/cached-dynamic`);
  const firstHtml = await firstResponse.text();
  const secondResponse = await fetch(`${baseUrl}/cached-dynamic`);
  const secondHtml = await secondResponse.text();

  assert.equal(firstResponse.headers.get("x-nextsx-cache"), "SKIP");
  assert.equal(secondResponse.headers.get("x-nextsx-cache"), "SKIP");
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
