import test from "node:test";
import assert from "node:assert/strict";
import { hotComponent } from "../src/development-hot-client.js";

const HOT_COMPONENTS = Symbol.for("evolit.hotComponents");
const HYDRATABLE_TAG = Symbol.for("litsx.hydratableTag");

test("hotComponent preserves class identity while replacing its implementation", () => {
  delete globalThis[HOT_COMPONENTS];

  class FirstImplementation {
    static [HYDRATABLE_TAG] = "feature-card";
    render() {
      return "first";
    }
  }
  class SecondImplementation {
    static [HYDRATABLE_TAG] = "feature-card";
    render() {
      return "second";
    }
  }

  const proxy = hotComponent("src/feature-card.litsx", FirstImplementation);
  const existingInstance = new proxy();
  const replacement = hotComponent("src/feature-card.litsx", SecondImplementation);

  assert.equal(replacement, proxy);
  assert.equal(existingInstance.render(), "second");
  assert.equal(new replacement().render(), "second");
  assert.equal(replacement[HYDRATABLE_TAG], "feature-card");

  delete globalThis[HOT_COMPONENTS];
});

test("hotComponent does not wrap non-hydratable exports", () => {
  class PlainExport {}
  assert.equal(hotComponent("src/plain.js", PlainExport), PlainExport);
});
