import assert from "node:assert/strict";
import test from "node:test";
import { createHref } from "../src/navigation-url.js";

test("createHref preserves repeated URLSearchParams without manual serialization", () => {
  const searchParams = new URLSearchParams("facet=brand&facet=material&page=2");
  searchParams.delete("page");
  searchParams.append("sort", "price");

  assert.equal(
    createHref("/explore/home-garden", searchParams),
    "/explore/home-garden?facet=brand&facet=material&sort=price",
  );
});

test("createHref retains a pathname query when no URLSearchParams are supplied", () => {
  assert.equal(createHref("/explore?view=grid#results"), "/explore?view=grid#results");
});

test("createHref only accepts internal paths and URLSearchParams", () => {
  assert.throws(() => createHref("explore"), /internal pathname/);
  assert.throws(() => createHref("/explore", { view: "grid" }), /URLSearchParams/);
});
