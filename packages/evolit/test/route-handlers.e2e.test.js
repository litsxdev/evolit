import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDevServer } from "../src/server.js";
import { discoverAppRouteHandlers } from "../src/app-discovery.js";
import { scaffoldSite } from "../src/scaffold.js";

const frameworkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frameworkNodeModules = path.resolve(frameworkRoot, "..", "..", "node_modules");
const requestContextUrl = pathToFileURL(
  path.join(frameworkRoot, "src", "request-context.js"),
).href;

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

      socket.close((error) => error ? reject(error) : resolve(address.port));
    });
    socket.on("error", reject);
  });
}

test("route handlers expose Web Request and Response semantics", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-route-handlers-"));
  const fixtureRoot = path.join(tempRoot, "app");
  let server;

  try {
    await scaffoldSite(fixtureRoot);
    await fs.symlink(
      frameworkNodeModules,
      path.join(fixtureRoot, "node_modules"),
      "dir",
    );
    const handlerDirectory = path.join(fixtureRoot, "app", "api", "echo", "[slug]");
    await fs.mkdir(handlerDirectory, { recursive: true });
    await fs.writeFile(
      path.join(handlerDirectory, "route.js"),
      [
        `import { cookies, responseHeaders } from ${JSON.stringify(requestContextUrl)};`,
        "",
        "export async function GET(_request, { params }) {",
        '  return new Response(`get:${params.slug}`);',
        "}",
        "",
        "export async function POST(request, { params, searchParams }) {",
        "  const body = await request.json();",
        '  cookies().set("handler", params.slug, { httpOnly: true });',
        '  responseHeaders().set("x-handler", "active");',
        "  return Response.json({ method: request.method, slug: params.slug, query: searchParams.q, body });",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const port = await getAvailablePort();
    server = await createDevServer(fixtureRoot, { port });
    await server.listen();
    const baseUrl = `http://127.0.0.1:${port}`;

    const getResponse = await fetch(`${baseUrl}/api/echo/hello`);
    const postResponse = await fetch(`${baseUrl}/api/echo/hello?q=route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: 1 }),
    });
    const methodResponse = await fetch(`${baseUrl}/api/echo/hello`, { method: "PUT" });

    assert.equal(await getResponse.text(), "get:hello");
    assert.equal(getResponse.headers.get("cache-control"), "no-store");
    assert.deepEqual(await postResponse.json(), {
      method: "POST",
      slug: "hello",
      query: "route",
      body: { value: 1 },
    });
    assert.equal(postResponse.headers.get("x-handler"), "active");
    assert.match(postResponse.headers.get("set-cookie") ?? "", /handler=hello/);
    assert.equal(methodResponse.status, 405);
    assert.equal(methodResponse.headers.get("allow"), "GET, POST");
  } finally {
    server?.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("route handlers cannot coexist with pages in the same segment", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-handler-conflict-"));

  try {
    await fs.mkdir(path.join(root, "app", "api"), { recursive: true });
    await fs.writeFile(path.join(root, "app", "api", "page.js"), "export default async function Page() {}\n");
    await fs.writeFile(path.join(root, "app", "api", "route.js"), "export function GET() {}\n");

    await assert.rejects(
      () => discoverAppRouteHandlers(root),
      /cannot coexist with page module/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
