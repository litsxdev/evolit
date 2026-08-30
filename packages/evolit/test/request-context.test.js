import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRouteResolver } from "../src/render.js";
import { createSsrAdapter } from "../src/ssr-adapter.js";
import {
  createRequestContext,
  getRouteState,
  runWithRequestContext,
} from "../src/request-context.js";

const frameworkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requestContextUrl = pathToFileURL(
  path.join(frameworkRoot, "src", "request-context.js"),
).href;

async function writePage(root, routePath, source) {
  const directory = path.join(root, "app", ...routePath.split("/").filter(Boolean));
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "page.jsx"), source, "utf8");
}

test("server route APIs read request data and write response headers and cookies", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-request-context-"));

  try {
    await writePage(root, "", [
      `import { cookies, headers, requestUrl, responseHeaders } from ${JSON.stringify(requestContextUrl)};`,
      "",
      "export default async function RequestPage() {",
      '  const visit = Number(cookies().get("visit")?.value ?? "0") + 1;',
      '  cookies().set("visit", String(visit), { httpOnly: true, sameSite: "Lax" });',
      '  responseHeaders().set("x-route-context", requestUrl().pathname);',
      '  return `<main>${headers().get("x-example")}:${visit}</main>`;',
      "}",
      "",
    ].join("\n"));

    const resolver = await createRouteResolver(root);
    const routeResult = await resolver.resolveRequest(new Request("http://evolit.local/?q=1", {
      headers: { cookie: "visit=2", "x-example": "request" },
    }));
    const response = await createSsrAdapter().renderRouteTree(routeResult);

    assert.equal(routeResult.cachePolicy.mode, "dynamic");
    assert.equal(response.status, 200);
    assert.equal(response.headers["x-route-context"], "/");
    assert.deepEqual(response.headers["set-cookie"], ["visit=3; Path=/; HttpOnly; SameSite=Lax"]);
    assert.match(response.body, /request:3/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("server route APIs translate redirect and notFound signals into HTTP responses", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-request-signals-"));

  try {
    await writePage(root, "go", [
      `import { redirect } from ${JSON.stringify(requestContextUrl)};`,
      "export default async function GoPage() { redirect(\"/destination\"); }",
      "",
    ].join("\n"));
    await writePage(root, "missing", [
      `import { notFound } from ${JSON.stringify(requestContextUrl)};`,
      "export default async function MissingPage() { notFound(); }",
      "",
    ].join("\n"));

    const resolver = await createRouteResolver(root);
    const adapter = createSsrAdapter();
    const redirectResponse = await adapter.renderRouteTree(
      await resolver.resolveRequest(new Request("http://evolit.local/go")),
    );
    const notFoundResponse = await adapter.renderRouteTree(
      await resolver.resolveRequest(new Request("http://evolit.local/missing")),
    );

    assert.equal(redirectResponse.status, 307);
    assert.equal(redirectResponse.headers.location, "/destination");
    assert.equal(notFoundResponse.status, 404);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("reading the request prop marks an otherwise static route as dynamic", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-request-prop-"));

  try {
    await writePage(root, "", [
      'export const routeConfig = { cache: "static" };',
      "",
      "export default async function RequestPage({ request }) {",
      '  return `<main>${request instanceof Request}:${request.headers.get("x-example")}</main>`;',
      "}",
      "",
    ].join("\n"));

    const resolver = await createRouteResolver(root);
    const routeResult = await resolver.resolveRequest(new Request("http://evolit.local/", {
      headers: { "x-example": "request-prop" },
    }));

    assert.equal(routeResult.cachePolicy.mode, "dynamic");
    assert.match(routeResult.tree, /true:request-prop/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("server route APIs share request context across duplicate module identities", async () => {
  const alternateContextModule = await import(`${requestContextUrl}?duplicate-context`);
  const context = createRequestContext({
    request: new Request("http://evolit.local/duplicate"),
  });

  await runWithRequestContext(context, async () => {
    assert.equal(alternateContextModule.requestUrl().pathname, "/duplicate");
    alternateContextModule.responseHeaders().set("x-shared-context", "yes");
  });

  assert.equal(
    alternateContextModule.getRequestContextResponse(context).headers["x-shared-context"],
    "yes",
  );
});

test("getRouteState returns isolated read-only SSR route snapshots", async () => {
  const firstContext = createRequestContext({
    request: new Request("http://evolit.local/catalog/first?view=grid"),
    params: { slug: "first" },
    searchParams: { view: "grid" },
    navigationContext: { filtersOpen: true },
  });
  const secondContext = createRequestContext({
    request: new Request("http://evolit.local/catalog/second?view=list"),
    params: { slug: "second" },
    searchParams: { view: "list" },
    navigationContext: { filtersOpen: false },
  });

  const [first, second] = await Promise.all([
    runWithRequestContext(firstContext, async () => {
      await Promise.resolve();
      return getRouteState();
    }),
    runWithRequestContext(secondContext, async () => {
      await Promise.resolve();
      return getRouteState();
    }),
  ]);

  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.params), true);
  assert.equal(Object.isFrozen(first.searchParams), true);
  assert.equal(Object.isFrozen(first.navigationContext), true);
  assert.equal(first.url.pathname, "/catalog/first");
  assert.deepEqual(first.params, { slug: "first" });
  assert.deepEqual(first.searchParams, { view: "grid" });
  assert.deepEqual(first.navigationContext, { filtersOpen: true });
  assert.equal(second.url.pathname, "/catalog/second");
  assert.deepEqual(second.params, { slug: "second" });
  assert.deepEqual(second.searchParams, { view: "list" });
  assert.deepEqual(second.navigationContext, { filtersOpen: false });
  assert.equal(firstContext.didUseDynamicRequestData, true);
  assert.equal(secondContext.didUseDynamicRequestData, true);
});

test("getRouteState rejects calls outside SSR route execution", () => {
  assert.throws(
    () => getRouteState(),
    /Request APIs can only be called while rendering a evolit route/,
  );
});
