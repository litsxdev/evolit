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
