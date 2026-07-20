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
  assert.match(html, /id="__LITSX_HYDRATION__"/);
  assert.match(html, /data-litsx-root="litsx-root-0"/);
  assert.doesNotMatch(html, /__nextsx\/hydration/);
  assert.doesNotMatch(html, /customElements\.define/);
});

test("non-hydrated route omits the generated hydration bootstrap", async () => {
  const response = await fetch(`${baseUrl}/about`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /<title>About \| nextsx<\/title>/);
  assert.match(html, /<script type="importmap">/);
  assert.doesNotMatch(html, /registerHydrationModules/);
  assert.doesNotMatch(html, /await hydratePage\(\)/);
  assert.doesNotMatch(html, /id="__LITSX_HYDRATION__"/);
});
