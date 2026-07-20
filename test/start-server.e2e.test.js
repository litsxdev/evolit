import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { buildProject } from "../src/build.js";
import { createStartServer } from "../src/server.js";
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
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nextsx-start-e2e-"));
  fixtureRoot = path.join(tempRoot, "app");

  await scaffoldSite(fixtureRoot);
  await fs.symlink(
    path.join(frameworkRoot, "node_modules"),
    path.join(fixtureRoot, "node_modules"),
    "dir",
  );
  await buildProject(fixtureRoot);

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

  assert.equal(response.status, 200);
  assert.match(html, /registerHydrationModules/);
  assert.match(html, /\/_nextsx\/static\/app\/components\/feature-card\.[a-f0-9]{8}\.mjs/);
  assert.doesNotMatch(html, /\/_nextsx\/client\/app\/components\/feature-card\.mjs/);
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
});
