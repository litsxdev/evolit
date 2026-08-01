import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserNavigation } from "../src/navigation-client.js";

function createBrowserWindow(fetch) {
  const listeners = new Map();
  const documentListeners = new Map();
  return {
    location: {
      href: "http://example.test/",
      origin: "http://example.test",
      assign(href) { this.lastAssign = href; },
      replace(href) { this.lastReplace = href; },
    },
    scrollX: 12,
    scrollY: 34,
    scrollTo(x, y) { this.lastScroll = { x, y }; },
    fetch,
    document: {
      addEventListener(type, listener) { documentListeners.set(type, listener); },
      getElementById() { return null; },
      querySelector() { return null; },
      dispatch(type, event) { documentListeners.get(type)?.(event); },
    },
    history: {
      state: null,
      pushState(state, _title, href) { this.state = state; this.lastPush = href; },
      replaceState(state, _title, href) { this.state = state; this.lastReplace = href; },
    },
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatch(type, event) { listeners.get(type)?.(event); },
  };
}

test("a superseded navigation cannot apply its late delta", async () => {
  const pending = new Map();
  const windowRef = createBrowserWindow((href) => new Promise((resolve) => {
    pending.set(new URL(href).pathname, resolve);
  }));
  const applied = [];
  const navigation = createBrowserNavigation({
    window: windowRef,
    applyDelta: async (delta) => { applied.push(delta.url); },
  });

  const first = navigation.push("/first");
  const second = navigation.push("/second");
  pending.get("/second")({
    headers: new Headers({ "content-type": "application/vnd.evolit.navigation+json" }),
    json: async () => ({ type: "route", url: "/second", route: {} }),
  });
  await second;
  pending.get("/first")({
    headers: new Headers({ "content-type": "application/vnd.evolit.navigation+json" }),
    json: async () => ({ type: "route", url: "/first", route: {} }),
  });
  await first;

  assert.deepEqual(applied, ["/second"]);
  assert.equal(windowRef.history.lastPush, "http://example.test/second");
  assert.deepEqual(navigation.getState(), {
    status: "idle",
    url: "http://example.test/second",
    pendingUrl: null,
    error: null,
  });
});

test("an internal GET form becomes a client navigation with repeated query parameters", async () => {
  const requested = [];
  const windowRef = createBrowserWindow(async (href) => {
    requested.push(href);
    return {
      headers: new Headers({ "content-type": "application/vnd.evolit.navigation+json" }),
      json: async () => ({ type: "route", url: new URL(href).pathname + new URL(href).search, route: {} }),
    };
  });
  const form = {
    tagName: "FORM",
    method: "get",
    target: "",
    action: "http://example.test/explore?ignored=yes",
    dataset: {},
    querySelector() { return null; },
  };
  const originalFormData = globalThis.FormData;
  globalThis.FormData = class {
    constructor(receivedForm) {
      assert.equal(receivedForm, form);
      return [["facet", "brand"], ["facet", "material"], ["sort", "price"]];
    }
  };
  try {
    createBrowserNavigation({ window: windowRef, applyDelta: async () => {} });
    let prevented = false;
    windowRef.document.dispatch("submit", {
      target: form,
      submitter: null,
      defaultPrevented: false,
      preventDefault() { prevented = true; },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(prevented, true);
    assert.deepEqual(requested, ["http://example.test/explore?facet=brand&facet=material&sort=price"]);
  } finally {
    globalThis.FormData = originalFormData;
  }
});

test("non-GET, upload, external, and opted-out forms keep native submission", () => {
  const windowRef = createBrowserWindow(async () => { throw new Error("must not fetch"); });
  createBrowserNavigation({ window: windowRef, applyDelta: async () => {} });
  const cases = [
    { method: "post", target: "", action: "http://example.test/explore", upload: false, optOut: false },
    { method: "get", target: "", action: "http://example.test/explore", upload: true, optOut: false },
    { method: "get", target: "", action: "https://other.test/explore", upload: false, optOut: false },
    { method: "get", target: "", action: "http://example.test/explore", upload: false, optOut: true },
  ];
  for (const item of cases) {
    let prevented = false;
    windowRef.document.dispatch("submit", {
      target: {
        tagName: "FORM",
        method: item.method,
        target: item.target,
        action: item.action,
        dataset: item.optOut ? { evolitNavigation: "false" } : {},
        querySelector() { return item.upload ? {} : null; },
      },
      submitter: null,
      defaultPrevented: false,
      preventDefault() { prevented = true; },
    });
    assert.equal(prevented, false);
  }
});

test("non-delta responses fall back to a document navigation", async () => {
  const windowRef = createBrowserWindow(async () => new Response("<!doctype html><h1>404</h1>", {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  }));
  const applied = [];
  const navigation = createBrowserNavigation({
    window: windowRef,
    applyDelta: async (delta) => applied.push(delta),
  });

  await navigation.push("/missing");
  await navigation.replace("/also-missing");

  assert.deepEqual(applied, []);
  assert.equal(windowRef.location.lastAssign, "http://example.test/missing");
  assert.equal(windowRef.location.lastReplace, "http://example.test/also-missing");
});

test("malformed navigation payloads fall back to a document navigation", async () => {
  const windowRef = createBrowserWindow(async () => new Response("not json", {
    headers: { "content-type": "application/vnd.evolit.navigation+json" },
  }));
  const navigation = createBrowserNavigation({ window: windowRef, applyDelta: async () => {} });

  await navigation.push("/broken");

  assert.equal(windowRef.location.lastAssign, "http://example.test/broken");
});

test("a projection-cardinality mismatch falls back before mutating the live document", async () => {
  const windowRef = createBrowserWindow(async () => ({
    headers: new Headers({ "content-type": "application/vnd.evolit.navigation+json" }),
    json: async () => ({ type: "route", url: "/catalog", route: {} }),
  }));
  let applied = false;
  const navigation = createBrowserNavigation({
    window: windowRef,
    applyDelta: async () => {
      applied = true;
      return false;
    },
  });

  await navigation.push("/catalog");

  assert.equal(applied, true);
  assert.equal(windowRef.location.lastAssign, "http://example.test/catalog");
  assert.equal(windowRef.history.lastPush, undefined);
});

test("a navigation redirect is followed client-side without a document reload", async () => {
  const requested = [];
  const windowRef = createBrowserWindow(async (href) => {
    const pathname = new URL(href).pathname;
    requested.push(pathname);
    return {
      headers: new Headers({ "content-type": "application/vnd.evolit.navigation+json" }),
      json: async () => pathname === "/old"
        ? { type: "redirect", location: "/new" }
        : { type: "route", url: "/new", route: {} },
    };
  });
  const applied = [];
  const navigation = createBrowserNavigation({
    window: windowRef,
    applyDelta: async (delta) => { applied.push(delta.url); },
  });

  await navigation.push("/old");

  assert.deepEqual(requested, ["/old", "/new"]);
  assert.deepEqual(applied, ["/new"]);
  assert.equal(windowRef.location.lastAssign, undefined);
  assert.equal(windowRef.history.lastReplace, "http://example.test/new");
});

test("a client navigation saves the previous position and resets scroll for the new route", async () => {
  const windowRef = createBrowserWindow(async () => ({
    headers: new Headers({ "content-type": "application/vnd.evolit.navigation+json" }),
    json: async () => ({ type: "route", url: "/catalog", route: {} }),
  }));
  const navigation = createBrowserNavigation({ window: windowRef, applyDelta: async () => {} });

  await navigation.push("/catalog");

  assert.deepEqual(windowRef.history.lastReplace, "http://example.test/");
  assert.deepEqual(windowRef.history.lastPush, "http://example.test/catalog");
  assert.deepEqual(windowRef.lastScroll, { x: 0, y: 0 });
});

test("a client navigation can preserve its current scroll position", async () => {
  const windowRef = createBrowserWindow(async () => ({
    headers: new Headers({ "content-type": "application/vnd.evolit.navigation+json" }),
    json: async () => ({ type: "route", url: "/catalog", route: {} }),
  }));
  const navigation = createBrowserNavigation({ window: windowRef, applyDelta: async () => {} });

  await navigation.push("/catalog", { scroll: false });

  assert.deepEqual(windowRef.history.state.__evolitScroll, { x: 12, y: 34 });
  assert.deepEqual(windowRef.lastScroll, undefined);
});

test("replace can preserve its current scroll position", async () => {
  const windowRef = createBrowserWindow(async () => ({
    headers: new Headers({ "content-type": "application/vnd.evolit.navigation+json" }),
    json: async () => ({ type: "route", url: "/catalog?view=grid", route: {} }),
  }));
  const navigation = createBrowserNavigation({ window: windowRef, applyDelta: async () => {} });

  await navigation.replace("/catalog?view=grid", { scroll: false });

  assert.deepEqual(windowRef.history.state.__evolitScroll, { x: 12, y: 34 });
  assert.deepEqual(windowRef.lastScroll, undefined);
});

test("a history entry reuses its delta on popstate without a second request", async () => {
  let requests = 0;
  let applied = 0;
  const windowRef = createBrowserWindow(async () => {
    requests += 1;
    return {
      headers: new Headers({ "content-type": "application/vnd.evolit.navigation+json" }),
      json: async () => ({
        type: "route",
        url: "/catalog",
        route: { cachePolicy: { mode: "static" } },
      }),
    };
  });
  const navigation = createBrowserNavigation({ window: windowRef, applyDelta: async () => { applied += 1; } });

  await navigation.push("/catalog");
  const catalogState = windowRef.history.state;
  windowRef.location.href = "http://example.test/catalog";
  windowRef.dispatch("popstate", { state: catalogState });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(requests, 1);
  assert.equal(applied, 2);
});

test("a pushed development update applies its route delta without fetching or changing history", async () => {
  const requested = [];
  const windowRef = createBrowserWindow(async (href, options) => {
    requested.push({ href, options });
    return {
      headers: new Headers({ "content-type": "application/vnd.evolit.navigation+json" }),
      json: async () => ({ type: "route", url: "/", route: {} }),
    };
  });
  let applied = 0;
  let applyContext = null;
  createBrowserNavigation({
    window: windowRef,
    applyDelta: async (_delta, context) => {
      applied += 1;
      applyContext = context;
    },
  });
  const delta = { type: "route", url: "/", route: {} };
  const detail = {
    update: { type: "update", strategy: "delta", delta },
    handled: false,
    result: null,
  };

  windowRef.dispatch("evolit:development-refresh", { detail });
  assert.equal(detail.handled, true);
  assert.equal(await detail.result, true);

  assert.equal(applied, 1);
  assert.equal(applyContext.requireSegmentChange, true);
  assert.equal(requested.length, 0);
  assert.deepEqual(windowRef.lastScroll, undefined);
  assert.equal(windowRef.history.lastPush, undefined);
});

test("a development hot refresh cache-busts and applies changed client code", async () => {
  const contexts = [];
  const windowRef = createBrowserWindow(async () => ({
    headers: new Headers({ "content-type": "application/vnd.evolit.navigation+json" }),
    json: async () => ({ type: "route", url: "/", route: {} }),
  }));
  createBrowserNavigation({
    window: windowRef,
    applyDelta: async (_delta, context) => { contexts.push(context); },
  });
  const detail = {
    update: { type: "update", strategy: "hot", version: 7, delta: { type: "route", route: {} } },
    handled: false,
    result: null,
  };

  windowRef.dispatch("evolit:development-refresh", { detail });

  assert.equal(detail.handled, true);
  assert.equal(await detail.result, true);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].hot, true);
  assert.equal(contexts[0].moduleVersion, 7);
});
