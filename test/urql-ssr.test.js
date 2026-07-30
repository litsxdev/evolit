import assert from "node:assert/strict";
import test from "node:test";
import {
  appendSsrUrqlData,
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
