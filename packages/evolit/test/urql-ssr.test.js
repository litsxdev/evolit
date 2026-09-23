import assert from "node:assert/strict";
import test from "node:test";
import {
  appendSsrUrqlData,
  applySsrUrqlRequestContext,
  createSsrUrqlRequestContext,
  runWithOptionalSsrUrqlScope,
} from "../src/urql-ssr.js";

test("runs a complete render inside the optional URQL scope", async () => {
  let active = false;
  const adapter = {
    async runWithUrqlScope(callback) {
      active = true;
      try {
        return await callback();
      } finally {
        active = false;
      }
    },
  };

  const result = await runWithOptionalSsrUrqlScope(
    () => ({ active }),
    { adapter },
  );

  assert.deepEqual(result, { active: true });
  assert.equal(active, false);
});

test("passes request and response headers into the complete URQL render scope", async () => {
  const request = new Request("http://evolit.test/products", {
    headers: { cookie: "session=one" },
  });
  const context = createSsrUrqlRequestContext(request);
  const adapter = {
    async runWithUrqlScope(receivedContext, callback) {
      assert.equal(receivedContext, context);
      assert.equal(receivedContext.request.headers.get("cookie"), "session=one");
      receivedContext.responseHeaders.set("x-session", "renewed");
      return callback();
    },
  };

  const result = await runWithOptionalSsrUrqlScope(
    context,
    () => "rendered",
    { adapter },
  );

  assert.equal(result, "rendered");
  assert.equal(context.responseHeaders.get("x-session"), "renewed");
});

test("applies URQL response headers and prevents caching after request data is read", () => {
  const context = createSsrUrqlRequestContext(new Request("http://evolit.test/products"));
  void context.request.headers;
  context.responseHeaders.set("set-cookie", "session=two; Path=/");
  const routeResult = {
    cachePolicy: { mode: "static" },
    responseHeaders: { "x-route": "route" },
  };

  const response = applySsrUrqlRequestContext(
    routeResult,
    { headers: { "content-type": "text/html" }, body: "page" },
    context,
  );

  assert.deepEqual(routeResult.cachePolicy, { mode: "dynamic" });
  assert.equal(routeResult.responseHeaders["x-route"], "route");
  assert.ok(routeResult.responseHeaders["set-cookie"]);
  assert.ok(response.headers["set-cookie"]);
});

test("leaves renders unchanged when @litsx/urql is not installed", async () => {
  const result = await runWithOptionalSsrUrqlScope(
    (adapter) => ({ adapter }),
    { adapter: null },
  );

  assert.deepEqual(result, { adapter: null });
});

test("serializes optional application-defined URQL data into HTML safely", () => {
  const response = appendSsrUrqlData(
    { body: "<!doctype html><body>page</body>" },
    { payload: "<unsafe>" },
  );

  assert.match(response.body, /id="__LITSX_URQL_DATA__"/);
  assert.match(response.body, /\\u003Cunsafe\\u003E/);
  assert.match(response.body, /<\/script>\s*<\/body>/);
});

test("does not modify a response when no SSR data is extracted", () => {
  const response = { body: "<body>page</body>" };
  assert.equal(appendSsrUrqlData(response, undefined), response);
});
