import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRouteResolver } from "../src/render.js";
import { createSsrAdapter } from "../src/ssr-adapter.js";

const frameworkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requestContextUrl = pathToFileURL(
  path.join(frameworkRoot, "src", "request-context.js"),
).href;

async function writeAppFile(root, relativePath, source) {
  const filePath = path.join(root, "app", relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, source, "utf8");
}

test("route conventions render the nearest not-found boundary and server error boundary", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-route-conventions-"));

  try {
    await writeAppFile(root, "layout.litsx", [
      "export default async function Layout({ children }) {",
      '  return `<main data-layout="root">${children}</main>`;',
      "}",
      "",
    ].join("\n"));
    await writeAppFile(root, "not-found.litsx", [
      "export default async function RootNotFound() {",
      '  return "<p>root not found</p>";',
      "}",
      "",
    ].join("\n"));
    await writeAppFile(root, "blog/not-found.litsx", [
      "export default async function BlogNotFound() {",
      '  return "<p>blog not found</p>";',
      "}",
      "",
    ].join("\n"));
    await writeAppFile(root, "blog/page.litsx", [
      `import { notFound } from ${JSON.stringify(requestContextUrl)};`,
      "export default async function BlogPage() { notFound(); }",
      "",
    ].join("\n"));
    await writeAppFile(root, "broken/error.litsx", [
      "export default async function BrokenError({ error }) {",
      '  return `<p>handled error: ${error.message}</p>`;',
      "}",
      "",
    ].join("\n"));
    await writeAppFile(root, "broken/page.litsx", [
      "export default async function BrokenPage() {",
      '  throw new Error("expected failure");',
      "}",
      "",
    ].join("\n"));

    const resolver = await createRouteResolver(root);
    const adapter = createSsrAdapter();
    const unknownResponse = await adapter.renderRouteTree(
      await resolver.resolveRequest(new Request("http://evolit.local/missing")),
    );
    const nestedNotFoundResponse = await adapter.renderRouteTree(
      await resolver.resolveRequest(new Request("http://evolit.local/blog")),
    );
    const errorResponse = await adapter.renderRouteTree(
      await resolver.resolveRequest(new Request("http://evolit.local/broken")),
    );
    const reports = [];
    const productionResolver = await createRouteResolver(root, "production", {
      reportRouteError(report) {
        reports.push(report);
      },
    });
    const productionErrorResult = await productionResolver.resolveRequest(
      new Request("http://evolit.local/broken"),
    );
    const productionErrorResponse = await adapter.renderRouteTree(productionErrorResult);

    assert.equal(unknownResponse.status, 404);
    assert.match(unknownResponse.body, /root not found/);
    assert.match(unknownResponse.body, /data-layout="root"/);
    assert.equal(nestedNotFoundResponse.status, 404);
    assert.match(nestedNotFoundResponse.body, /blog not found/);
    assert.doesNotMatch(nestedNotFoundResponse.body, /root not found/);
    assert.equal(errorResponse.status, 500);
    assert.match(errorResponse.body, /handled error: expected failure/);
    assert.match(errorResponse.body, /data-layout="root"/);
    assert.equal(productionErrorResponse.status, 500);
    assert.match(productionErrorResponse.body, /handled error: An unexpected server error occurred\./);
    assert.doesNotMatch(productionErrorResponse.body, /expected failure/);
    assert.match(productionErrorResult.tree, /An unexpected server error occurred\./);
    assert.equal(typeof productionErrorResult.tree, "string");
    assert.equal(typeof reports[0]?.digest, "string");
    assert.equal(reports[0]?.error.message, "expected failure");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("route composition forwards the same opaque child ref from a layout to its page", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-forwarded-route-ref-"));
  const observationsKey = "__EVOLIT_FORWARDED_ROUTE_REF__";

  try {
    await writeAppFile(root, "layout.litsx", [
      "export default async function Layout({ children }) {",
      `  globalThis[${JSON.stringify(observationsKey)}] = { ...globalThis[${JSON.stringify(observationsKey)}], layout: children.ref };`,
      '  return `<main>${children}</main>`;',
      "}",
      "",
    ].join("\n"));
    await writeAppFile(root, "page.litsx", [
      "export default async function Page(_props, ref) {",
      `  globalThis[${JSON.stringify(observationsKey)}].page = ref;`,
      '  return "<p>ready</p>";',
      "}",
      "",
    ].join("\n"));

    const resolver = await createRouteResolver(root);
    const result = await resolver.resolveRequest(new Request("http://evolit.local/"));
    const observations = globalThis[observationsKey];

    assert.match(result.tree, /<p>ready<\/p>/);
    assert.ok(observations.layout);
    assert.strictEqual(observations.layout, observations.page);
    assert.equal(observations.layout.current, null);
    assert.equal(
      typeof observations.layout[Symbol.for("litsx.forwardedRef")],
      "string",
    );
  } finally {
    delete globalThis[observationsKey];
    await fs.rm(root, { recursive: true, force: true });
  }
});
