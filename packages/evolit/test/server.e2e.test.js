import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { createDevServer } from "../src/server.js";
import { scaffoldSite } from "../src/scaffold.js";

const frameworkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frameworkNodeModules = path.resolve(frameworkRoot, "..", "..", "node_modules");

let fixtureRoot;
let server;
let baseUrl;
let unmanagedSharedPath;
let managedSharedPath;
const developmentEvents = [];
const cardBadgePngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yF9sAAAAASUVORK5CYII=";
const cardBadgeSpecialPngFile = "card badge@2x.png";

async function readDevClientAssetsManifest() {
  return JSON.parse(
    await fs.readFile(
      path.join(fixtureRoot, ".evolit", "dev", "client-assets.json"),
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

async function openLiveReloadSocket(url = baseUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/_evolit/live-reload`);
    socket.once("open", () => {
      socket.send(JSON.stringify({ type: "subscribe", url }));
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

async function waitForLiveReload(socket, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for a development live reload message."));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("error", onError);
    }

    function onMessage(message) {
      const source = String(message);
      try {
        const update = JSON.parse(source);
        if (update?.type !== "update" && update?.type !== "reload") return;
        cleanup();
        resolve(update);
      } catch {
        // Ignore unrelated development socket messages.
      }
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

before(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-e2e-"));
  fixtureRoot = path.join(tempRoot, "app");

  await scaffoldSite(fixtureRoot);
  await fs.symlink(
    frameworkNodeModules,
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
  await fs.mkdir(path.join(fixtureRoot, "app", "explore", "[...slug]"), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, "app", "optional", "[[...slug]]"), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, "app", "lit"), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, "app", "multi"), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, "app", "forwarded-ref"), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, "app", "cached-layout", "a"), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, "app", "cached-layout", "b"), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, "app", "request-layout", "a"), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, "app", "request-layout", "b"), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, "app", "param-layout", "[slug]"), { recursive: true });
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
    path.join(fixtureRoot, "app", "explore", "[...slug]", "page.litsx"),
    [
      'import FeatureCard from "../../components/feature-card.litsx";',
      "",
      "export default async function ExplorePage({ params }) {",
      "  return <FeatureCard title=\"Explore\" body={JSON.stringify(params.slug ?? [])} />;",
      "}",
      "",
    ].join("\n"),
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
  await fs.writeFile(
    path.join(fixtureRoot, "app", "multi", "layout.litsx"),
    [
      "export default async function MultiLayout({ children }) {",
      "  return <section data-route-layout=\"multi\"><aside>{children}</aside><main>{children}</main></section>;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(fixtureRoot, "app", "multi", "page.litsx"),
    [
      'import FeatureCard from "../components/feature-card.litsx";',
      "",
      "export default async function MultiPage() {",
      '  return <FeatureCard title="Repeated projection" body="Rendered twice by the layout." />;',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(fixtureRoot, "app", "components", "forwarded-ref-host.litsx"),
    [
      "export default function ForwardedRefHost({ label = '' }) {",
      "  return <span data-forwarded-ref-host>{label}</span>;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(fixtureRoot, "app", "forwarded-ref", "layout.litsx"),
    [
      'import ForwardedRefHost from "../components/forwarded-ref-host.litsx";',
      "",
      "export default async function ForwardedRefLayout({ children }) {",
      "  return <section><ForwardedRefHost .contextRef={children.ref} />{children}</section>;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(fixtureRoot, "app", "forwarded-ref", "page.litsx"),
    [
      'import ForwardedRefHost from "../components/forwarded-ref-host.litsx";',
      "",
      "export default async function ForwardedRefPage(_props, ref) {",
      '  return <ForwardedRefHost ref={ref} label="ref target" />;',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(fixtureRoot, "app", "cached-layout", "layout.litsx"),
    [
      "globalThis.__EVOLIT_LAYOUT_RENDER_COUNT ??= 0;",
      "",
      "export default async function CachedLayout({ children }) {",
      "  globalThis.__EVOLIT_LAYOUT_RENDER_COUNT += 1;",
      "  return <section data-cached-layout={String(globalThis.__EVOLIT_LAYOUT_RENDER_COUNT)}>{children}</section>;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(fixtureRoot, "app", "cached-layout", "a", "page.litsx"),
    [
      "export default async function CachedLayoutPageA() {",
      '  return <main data-cached-layout-page="a">A</main>; ',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(fixtureRoot, "app", "cached-layout", "b", "page.litsx"),
    [
      "export default async function CachedLayoutPageB() {",
      '  return <main data-cached-layout-page="b">B</main>; ',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(fixtureRoot, "app", "request-layout", "layout.litsx"),
    [
      "globalThis.__EVOLIT_REQUEST_LAYOUT_RENDER_COUNT ??= 0;",
      "",
      "export default async function RequestLayout({ children, request }) {",
      "  globalThis.__EVOLIT_REQUEST_LAYOUT_RENDER_COUNT += 1;",
      "  return <section data-request-layout={new URL(request.url).pathname} data-request-layout-count={String(globalThis.__EVOLIT_REQUEST_LAYOUT_RENDER_COUNT)}>{children}</section>;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  for (const page of ["a", "b"]) {
    await fs.writeFile(
      path.join(fixtureRoot, "app", "request-layout", page, "page.litsx"),
      [
        `export default async function RequestLayoutPage${page.toUpperCase()}() {`,
        `  return <main data-request-layout-page="${page}">${page.toUpperCase()}</main>;`,
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
  }
  await fs.writeFile(
    path.join(fixtureRoot, "app", "param-layout", "[slug]", "layout.litsx"),
    [
      "globalThis.__EVOLIT_PARAM_LAYOUT_RENDER_COUNT ??= 0;",
      "",
      "export default async function ParamLayout({ children, params, searchParams }) {",
      "  globalThis.__EVOLIT_PARAM_LAYOUT_RENDER_COUNT += 1;",
      "  return <section data-param-layout={String(params.slug)} data-param-layout-view={String(searchParams.view ?? \"default\")} data-param-layout-count={String(globalThis.__EVOLIT_PARAM_LAYOUT_RENDER_COUNT)}>{children}</section>;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(fixtureRoot, "app", "param-layout", "[slug]", "page.litsx"),
    [
      "export default async function ParamLayoutPage({ params }) {",
      "  return <main data-param-layout-page={String(params.slug)}>{params.slug}</main>;",
      "}",
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

  await fs.mkdir(path.join(fixtureRoot, "src"), { recursive: true });
  await fs.writeFile(
    path.join(fixtureRoot, "src", "shared.litsx"),
    'export const sharedMessage = "shared source version one";\n',
    "utf8",
  );
  await fs.mkdir(path.join(fixtureRoot, "app", "watcher-app"), { recursive: true });
  await fs.writeFile(
    path.join(fixtureRoot, "app", "watcher-app", "page.litsx"),
    [
      'export const routeConfig = { cache: "static" };',
      "",
      "export default function WatcherAppPage() {",
      '  return "<main>app watcher version one</main>";',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.mkdir(path.join(fixtureRoot, "app", "watcher-source"), { recursive: true });
  await fs.writeFile(
    path.join(fixtureRoot, "app", "watcher-source", "page.litsx"),
    [
      'import { sharedMessage } from "../../src/shared.litsx";',
      'export const routeConfig = { cache: "static" };',
      "",
      "export default function WatcherSourcePage() {",
      '  return `<main>${sharedMessage}</main>`;',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  unmanagedSharedPath = path.join(path.dirname(fixtureRoot), "unmanaged-shared.litsx");
  await fs.writeFile(unmanagedSharedPath, 'export const unmanagedMessage = "unmanaged version one";\n', "utf8");
  await fs.mkdir(path.join(fixtureRoot, "app", "watcher-unmanaged"), { recursive: true });
  await fs.writeFile(
    path.join(fixtureRoot, "app", "watcher-unmanaged", "page.litsx"),
    [
      'import { unmanagedMessage } from "../../../unmanaged-shared.litsx";',
      'export const routeConfig = { cache: "static" };',
      "",
      "export default function WatcherUnmanagedPage() {",
      '  return `<main>${unmanagedMessage}</main>`;',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  managedSharedPath = path.join(path.dirname(fixtureRoot), "managed-source", "shared.litsx");
  await fs.mkdir(path.dirname(managedSharedPath), { recursive: true });
  await fs.writeFile(managedSharedPath, 'export const managedMessage = "managed version one";\n', "utf8");
  await fs.mkdir(path.join(fixtureRoot, "app", "watcher-managed"), { recursive: true });
  await fs.writeFile(
    path.join(fixtureRoot, "app", "watcher-managed", "page.litsx"),
    [
      'import { managedMessage } from "../../../managed-source/shared.litsx";',
      'export const routeConfig = { cache: "static" };',
      "export default function WatcherManagedPage() {",
      '  return `<main>${managedMessage}</main>`;',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  const port = await getAvailablePort();
  server = await createDevServer(fixtureRoot, {
    port,
    evolitConfig: { development: { managedSourceRoots: ["../managed-source"] } },
    onDevelopmentEvent(event) {
      developmentEvents.push(event);
    },
  });
  await server.listen();
  assert.deepEqual(
    developmentEvents.slice(0, 3).map((event) => event.type),
    ["server-starting", "initializing", "vendor-runtime-ready"],
  );
  assert.equal(developmentEvents.at(-1)?.type, "server-ready");
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
  const globalCssUrl = await getDevAssetPublicUrl("app/global.css");

  assert.equal(response.status, 200);
  assert.doesNotMatch(html, /<script type="importmap">/);
  assert.match(html, /import \{ hydratePage, registerHydrationModules \} from "\/_evolit\/shared\/(?:base\/)?litsx__ssr__hydration(?:-[A-Za-z0-9_-]+)?\.mjs"/);
  assert.match(html, /registerHydrationModules/);
  assert.match(html, /await hydratePage\(\{/);
  assert.match(html, /clientImports: \["\/_evolit\/static\/app\/components\/feature-card\.mjs"/);
  assert.match(html, /\/_evolit\/static\/app\/components\/feature-card\.mjs/);
  assert.match(html, /<link rel="stylesheet" href="\/_evolit\/static\/app\/components\/card-accent\.[a-f0-9]{8}\.css" data-evolit-route-asset="style">/);
  assert.ok(html.includes(`<link rel="stylesheet" href="${globalCssUrl}" data-evolit-route-asset="style">`));
  assert.match(html, /id="__LITSX_HYDRATION__"/);
  assert.match(html, /<!--evolit:segment:start:layout-[A-Za-z0-9_-]+-->/);
  assert.match(html, /<!--evolit:segment:start:page-[A-Za-z0-9_-]+-->/);
  assert.match(html, /id="__EVOLIT_ROUTE__"/);
  assert.match(html, /"kind":"layout"/);
  assert.match(html, /"kind":"page"/);
  assert.match(html, /data-evolit-live-reload/);
  assert.match(html, /new WebSocket/);
  assert.match(html, /data-litsx-root="page-[A-Za-z0-9_-]+-p0-root-0"/);
  assert.doesNotMatch(html, /__evolit\/hydration/);
  assert.doesNotMatch(html, /customElements\.define/);
});

test("SSR composition exposes a forwarded page ref to the layout and its target", async () => {
  const response = await fetch(`${baseUrl}/forwarded-ref`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /data-litsx-forwarded-ref-target="evolit-ref:[^"]+"/);
  assert.match(html, /data-litsx-forwarded-ref-props="[^"]*contextRef[^"]*"/);
  assert.match(html, /data-forwarded-ref-host/);
  assert.match(html, /ref target/);
});

test("dev server returns route segment deltas from the canonical SSR document", async () => {
  const response = await fetch(`${baseUrl}/`, {
    headers: { accept: "application/vnd.evolit.navigation+json" },
  });
  const delta = await response.json();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/vnd\.evolit\.navigation\+json/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("vary") ?? "", /accept/i);
  assert.equal(delta.version, 1);
  assert.equal(delta.type, "route");
  assert.equal(delta.url, "/");
  assert.equal(delta.route.pathname, "/");
  assert.deepEqual(delta.route.cachePolicy, { mode: "revalidate", ttlSeconds: 60 });
  assert.ok(delta.headAssets.styles.some((href) => href.includes("app/global.")));
  assert.ok(delta.headAssets.styles.some((href) => href.includes("card-accent.")));
  assert.ok(delta.route.segments.some((segment) => segment.kind === "layout"));
  assert.ok(delta.route.segments.some((segment) => segment.kind === "page"));
  assert.ok(delta.route.segments.every((segment) => Array.isArray(segment.projections)));
});

test("dev server accepts live reload WebSocket connections", async () => {
  const socket = await openLiveReloadSocket();
  assert.equal(socket.readyState, WebSocket.OPEN);
  socket.close();
});

test("dev server renders native Lit page and layout modules", async () => {
  const response = await fetch(`${baseUrl}/lit`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /<title>Native Lit Route<\/title>/);
  assert.match(html, /data-route-layout="lit"/);
  assert.match(html, /data-route="lit"/);
  assert.match(html, /Native Lit route/);
  assert.match(html, /<product-card\b[^>]*data-litsx-root="page-[A-Za-z0-9_-]+-p0-0-root-0"/);
  assert.match(html, /data-product-card[\s\S]*?Field Guide/);
  assert.match(html, /"moduleId":"\/app\/lit\/product-card\.js"/);
  assert.match(html, /\/_evolit\/static\/app\/lit\/product-card\.mjs/);
  assert.doesNotMatch(html, /customElements\.define/);
});

test("dev server composes every repeated children projection with distinct hydration roots", async () => {
  const response = await fetch(`${baseUrl}/multi`);
  const html = await response.text();
  const hydration = JSON.parse(html.match(/<script type="application\/json" id="__LITSX_HYDRATION__">([\s\S]*?)<\/script>/)?.[1] ?? "null");

  assert.equal(response.status, 200);
  assert.match(html, /data-route-layout="multi"/);
  assert.equal((html.match(/<feature-card\b/g) ?? []).length, 2);
  assert.equal(hydration.roots.length, 2);
  assert.notEqual(hydration.roots[0].id, hydration.roots[1].id);
  assert.match(hydration.roots[0].id, /-p0-0-root-0$/);
  assert.match(hydration.roots[1].id, /-p0-1-root-0$/);

  const deltaResponse = await fetch(`${baseUrl}/multi`, {
    headers: { accept: "application/vnd.evolit.navigation+json" },
  });
  const delta = await deltaResponse.json();
  const pageSegment = delta.route.segments.find((segment) => segment.kind === "page");
  assert.equal(pageSegment.projections.length, 2);
});

test("dev server reuses a layout shell across cacheable sibling pages", async () => {
  const first = await fetch(`${baseUrl}/cached-layout/a`);
  const second = await fetch(`${baseUrl}/cached-layout/b`);
  const firstHtml = await first.text();
  const secondHtml = await second.text();

  assert.match(firstHtml, /data-cached-layout="1"/);
  assert.match(secondHtml, /data-cached-layout="1"/);
  assert.match(secondHtml, /data-cached-layout-page="b"/);
});

test("dev invalidation preserves unaffected cached layout shells", async () => {
  const pagePath = path.join(fixtureRoot, "app", "cached-layout", "a", "page.litsx");
  const originalSource = await fs.readFile(pagePath, "utf8");
  const eventCount = developmentEvents.length;
  await fs.writeFile(pagePath, originalSource.replace(">A</main>", ">A changed</main>"), "utf8");

  await waitForResponse(
    () => fetch(`${baseUrl}/cached-layout/a?invalidate=1`),
    ({ body }) => body.includes("A changed"),
  );
  const siblingResponse = await fetch(`${baseUrl}/cached-layout/b?after-invalidation=1`);
  const siblingHtml = await siblingResponse.text();
  const invalidationEvents = developmentEvents.slice(eventCount);

  assert.match(siblingHtml, /data-cached-layout="1"/);
  assert.ok(invalidationEvents.some((event) => event.type === "segment-cache-invalidated"));
});

test("dev server does not cache a layout that reads the request", async () => {
  const first = await fetch(`${baseUrl}/request-layout/a`);
  const second = await fetch(`${baseUrl}/request-layout/b`);
  const firstHtml = await first.text();
  const secondHtml = await second.text();

  assert.match(firstHtml, /data-request-layout="\/request-layout\/a"/);
  assert.match(firstHtml, /data-request-layout-count="1"/);
  assert.match(secondHtml, /data-request-layout="\/request-layout\/b"/);
  assert.match(secondHtml, /data-request-layout-count="2"/);
});

test("dev server keys cached shells by the params and query values read by a layout", async () => {
  const first = await fetch(`${baseUrl}/param-layout/a?view=grid`);
  const changedParam = await fetch(`${baseUrl}/param-layout/b?view=grid`);
  const changedQuery = await fetch(`${baseUrl}/param-layout/a?view=list`);
  const restored = await fetch(`${baseUrl}/param-layout/a?view=grid`);
  const [firstHtml, changedParamHtml, changedQueryHtml, restoredHtml] = await Promise.all([
    first.text(),
    changedParam.text(),
    changedQuery.text(),
    restored.text(),
  ]);

  assert.match(firstHtml, /data-param-layout-count="1"/);
  assert.match(changedParamHtml, /data-param-layout-count="2"/);
  assert.match(changedQueryHtml, /data-param-layout-count="3"/);
  assert.match(restoredHtml, /data-param-layout-count="1"/);
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
  assert.match(html, /<title>About \| evolit<\/title>/);
  assert.doesNotMatch(html, /<script type="importmap">/);
  assert.match(html, /<link rel="stylesheet" href="\/_evolit\/static\/app\/global\.[a-f0-9]{8}\.css" data-evolit-route-asset="style">/);
  assert.doesNotMatch(html, /registerHydrationModules/);
  assert.doesNotMatch(html, /await hydratePage\(\)/);
  assert.doesNotMatch(html, /id="__LITSX_HYDRATION__"/);
});

test("dev server caches static routes across requests", async () => {
  const firstResponse = await fetch(`${baseUrl}/cached-static`);
  const firstHtml = await firstResponse.text();
  const secondResponse = await fetch(`${baseUrl}/cached-static`);
  const secondHtml = await secondResponse.text();

  assert.equal(firstResponse.headers.get("x-evolit-cache"), "MISS");
  assert.equal(secondResponse.headers.get("x-evolit-cache"), "HIT");
  assert.match(firstHtml, /static:1/);
  assert.equal(secondHtml, firstHtml);
});

test("dev server keeps dynamic routes uncached", async () => {
  const firstResponse = await fetch(`${baseUrl}/cached-dynamic`);
  const firstHtml = await firstResponse.text();
  const secondResponse = await fetch(`${baseUrl}/cached-dynamic`);
  const secondHtml = await secondResponse.text();

  assert.equal(firstResponse.headers.get("x-evolit-cache"), "SKIP");
  assert.equal(secondResponse.headers.get("x-evolit-cache"), "SKIP");
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

test("dev server injects the catch-all route's hydratable boundary without compiling the route entry", async () => {
  const renderedRoutes = [];
  for (const pathname of ["/explore", "/explore/home-garden/furniture"]) {
    const response = await fetch(`${baseUrl}${pathname}`);
    renderedRoutes.push({
      pathname,
      response,
      html: await response.text(),
    });
  }
  const manifest = await readDevClientAssetsManifest();
  const routeEntry = manifest.assets.find((asset) =>
    asset.clientModule.includes("app/explore/")
    && asset.clientModule.includes("...slug")
    && asset.clientModule.endsWith("/page.mjs"),
  );
  const featureCardEntry = manifest.assets.find(
    (asset) => asset.clientModule === "app/components/feature-card.mjs",
  );

  assert.equal(routeEntry, undefined, "Server route modules must not become client entries");
  assert.ok(featureCardEntry, "Expected the hydratable component boundary to be compiled");

  for (const { pathname, response, html } of renderedRoutes) {
    const hydrationMatch = html.match(/<script type="application\/json" id="__LITSX_HYDRATION__">([\s\S]*?)<\/script>/);
    const hydrationData = hydrationMatch ? JSON.parse(hydrationMatch[1]) : null;

    assert.equal(response.status, 200);
    assert.ok(hydrationData);
    assert.ok(hydrationData.clientImports.includes(featureCardEntry.publicUrl));
    assert.match(html, new RegExp(featureCardEntry.publicUrl.replaceAll(".", "\\.")));
  }
});

test("dev server returns navigation deltas for catch-all routes and repeated query params", async () => {
  const pathname = "/explore/home-garden/furniture?facet=brand&facet=material&sort=price";
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { accept: "application/vnd.evolit.navigation+json" },
  });
  const delta = await response.json();
  const pageSegment = delta.route.segments.find((segment) => segment.kind === "page");

  assert.equal(response.status, 200);
  assert.equal(delta.url, pathname);
  assert.equal(delta.route.pathname, "/explore/home-garden/furniture");
  assert.ok(pageSegment);
  assert.equal(pageSegment.projections.length, 1);
  assert.match(pageSegment.projections[0].html, /home-garden/);
  assert.match(pageSegment.projections[0].html, /furniture/);
  assert.ok(delta.hydrationData.clientImports.some((specifier) => specifier.includes("app/components/feature-card")));
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
    ({ response, body }) => response.headers.get("x-evolit-cache") === "HIT" && body !== firstHtml,
  );

  assert.equal(thirdResponse.headers.get("x-evolit-cache"), "STALE");
  assert.equal(thirdHtml, firstHtml);
  assert.equal(fourthResponse.headers.get("x-evolit-cache"), "HIT");
  assert.match(firstHtml, /revalidate:1/);
  assert.match(fourthHtml, /revalidate:2/);
});

test("dev server revalidates dynamic routes in the background per pathname", async () => {
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
    ({ response, body }) => response.headers.get("x-evolit-cache") === "HIT" && body !== firstHtml,
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

test("dev server discovers new routes and invalidates cached route responses", async () => {
  const routeDirectory = path.join(fixtureRoot, "app", "watcher-route");
  const routePath = path.join(routeDirectory, "page.litsx");
  const liveReloadSocket = await openLiveReloadSocket(`${baseUrl}/watcher-route`);
  const liveReloadEvent = waitForLiveReload(liveReloadSocket);

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
  // Rendering the subscribed update warms the route before this explicit
  // request reaches it; the browser itself does not need that second fetch.
  assert.equal(createdRoute.response.headers.get("x-evolit-cache"), "HIT");
  await liveReloadEvent;
  liveReloadSocket.close();

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

test("dev server invalidates routes when an app source changes", async () => {
  const pagePath = path.join(fixtureRoot, "app", "watcher-app", "page.litsx");
  const invalidationCount = developmentEvents.filter((event) => event.type === "invalidated").length;

  const initialResponse = await fetch(`${baseUrl}/watcher-app`);
  assert.match(await initialResponse.text(), /app watcher version one/);

  await fs.writeFile(
    pagePath,
    [
      'export const routeConfig = { cache: "static" };',
      "",
      "export default function WatcherAppPage() {",
      '  return "<main>app watcher version two</main>";',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  await waitForResponse(
    () => fetch(`${baseUrl}/watcher-app`),
    ({ response, body }) => response.status === 200 && body.includes("app watcher version two"),
  );
  assert.ok(developmentEvents.filter((event) => event.type === "invalidated").length > invalidationCount);
});

test("dev server invalidates routes when an imported project src module changes", async () => {
  const sharedPath = path.join(fixtureRoot, "src", "shared.litsx");
  const invalidationCount = developmentEvents.filter((event) => event.type === "invalidated").length;
  const liveReloadSocket = await openLiveReloadSocket(`${baseUrl}/watcher-source`);
  const liveReloadEvent = waitForLiveReload(liveReloadSocket);

  const initialResponse = await fetch(`${baseUrl}/watcher-source`);
  assert.match(await initialResponse.text(), /shared source version one/);

  await fs.writeFile(sharedPath, 'export const sharedMessage = "shared source version two";\n', "utf8");

  const liveUpdate = await liveReloadEvent;
  liveReloadSocket.close();
  assert.equal(liveUpdate.type, "update");
  assert.equal(liveUpdate.strategy, "delta");
  assert.equal(typeof liveUpdate.version, "number");
  assert.equal(liveUpdate.delta.type, "route");
  assert.equal(liveUpdate.url, `${baseUrl}/watcher-source`);
  assert.ok(liveUpdate.delta.route.segments.some((segment) =>
    segment.modulePath === "app/watcher-source/page.litsx"
    && typeof segment.revision === "number"
  ));
  assert.ok(liveUpdate.delta.route.segments.some((segment) =>
    segment.projections.some((projection) => projection.html.includes("shared source version two"))
  ));
  assert.ok(developmentEvents.filter((event) => event.type === "invalidated").length > invalidationCount);
  assert.ok(developmentEvents.some((event) => event.type === "live-update" && event.strategy === "delta"));
});

test("dev server requests a hot refresh when a hydratable client boundary changes", async () => {
  const componentPath = path.join(fixtureRoot, "app", "components", "feature-card.litsx");
  const componentSource = await fs.readFile(componentPath, "utf8");
  const initialResponse = await fetch(`${baseUrl}/`);
  assert.equal(initialResponse.status, 200);
  await initialResponse.text();
  const liveReloadSocket = await openLiveReloadSocket(`${baseUrl}/`);
  const liveReloadEvent = waitForLiveReload(liveReloadSocket);

  await fs.writeFile(
    componentPath,
    componentSource.replace("padding: 24px", "padding: 25px"),
    "utf8",
  );

  const liveUpdate = await liveReloadEvent;
  liveReloadSocket.close();
  assert.equal(liveUpdate.type, "update");
  assert.equal(liveUpdate.strategy, "hot", JSON.stringify(developmentEvents.slice(-5)));
  assert.equal(typeof liveUpdate.version, "number");
  assert.equal(liveUpdate.delta.type, "route");
});

test("dev server ignores generated Evolit output changes", async () => {
  const generatedPath = path.join(fixtureRoot, ".evolit", "dev", "watcher-ignore.txt");
  const invalidationCount = developmentEvents.filter((event) => event.type === "invalidated").length;

  await fs.writeFile(generatedPath, "generated\n", "utf8");
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(developmentEvents.filter((event) => event.type === "invalidated").length, invalidationCount);
});

test("dev server does not watch unmanaged modules outside the project root", async () => {
  const invalidationCount = developmentEvents.filter((event) => event.type === "invalidated").length;

  const initialResponse = await fetch(`${baseUrl}/watcher-unmanaged`);
  assert.match(await initialResponse.text(), /unmanaged version one/);

  await fs.writeFile(unmanagedSharedPath, 'export const unmanagedMessage = "unmanaged version two";\n', "utf8");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const response = await fetch(`${baseUrl}/watcher-unmanaged`);
  assert.match(await response.text(), /unmanaged version one/);
  assert.equal(developmentEvents.filter((event) => event.type === "invalidated").length, invalidationCount);
});

test("dev server watches explicitly managed source roots outside the project", async () => {
  const invalidationCount = developmentEvents.filter((event) => event.type === "invalidated").length;
  const initialResponse = await fetch(`${baseUrl}/watcher-managed`);
  assert.match(await initialResponse.text(), /managed version one/);

  await fs.writeFile(managedSharedPath, 'export const managedMessage = "managed version two";\n', "utf8");
  await waitForResponse(
    () => fetch(`${baseUrl}/watcher-managed`),
    ({ response, body }) => response.status === 200 && body.includes("managed version two"),
  );
  assert.ok(developmentEvents.filter((event) => event.type === "invalidated").length > invalidationCount);
});
