import assert from "node:assert/strict";
import test from "node:test";
import {
  getExtensionClientDescriptors,
  resolveEvolitExtensions,
  runRequestExtensions,
} from "../src/extensions.js";
import {
  createRequestContext,
  getRequestContext,
  runWithRequestContext,
} from "../src/request-context.js";
import {
  registerNavigationExtensions,
  runAfterNavigation,
  runBeforeNavigation,
  transformNavigationUrl,
} from "../src/extensions-client.js";

test("request extensions compose rewrites and keep serializable context isolated per request", async () => {
  const extensions = resolveEvolitExtensions({
    plugins: [
      {
        name: "tenant",
        async onRequest(context) {
          const tenant = context.headers().get("x-tenant");
          context.set("tenant", tenant);
          if (context.pathname === "/store") return { rewrite: "/catalog" };
        },
      },
      {
        name: "canonical",
        onRequest(context) {
          if (context.pathname === "/catalog") context.set("canonical", true);
        },
      },
    ],
  });
  const render = async (tenant) => {
    const extensionState = await runRequestExtensions(
      extensions,
      new Request("http://evolit.test/store", { headers: { "x-tenant": tenant } }),
    );
    assert.equal(new URL(extensionState.request.url).pathname, "/catalog");
    const requestContext = createRequestContext({
      request: extensionState.request,
      extensionValues: extensionState.values,
      didUseDynamicRequestData: extensionState.didUseDynamicRequestData,
    });
    return runWithRequestContext(requestContext, async () => {
      await new Promise((resolve) => setTimeout(resolve, tenant === "one" ? 10 : 0));
      return getRequestContext();
    });
  };

  const [first, second] = await Promise.all([render("one"), render("two")]);
  assert.deepEqual(first, { tenant: "one", canonical: true });
  assert.deepEqual(second, { tenant: "two", canonical: true });
});

test("request extensions can short-circuit with redirects and responses", async () => {
  const extensions = resolveEvolitExtensions({
    plugins: [{
      name: "short-circuit",
      onRequest(context) {
        if (context.pathname === "/old") return { redirect: "/new", status: 308 };
        if (context.pathname === "/health") return new Response(null, { status: 204 });
      },
    }],
  });

  const redirect = await runRequestExtensions(extensions, new Request("http://evolit.test/old"));
  assert.equal(redirect.redirect, "http://evolit.test/new");
  assert.equal(redirect.status, 308);
  const response = await runRequestExtensions(extensions, new Request("http://evolit.test/health"));
  assert.equal(response.response.status, 204);
});

test("browser extensions transform hrefs and navigation lifecycle without server hooks", async () => {
  const source = [
    "export const navigation = {",
    " transformUrl({ url }) { const target = new URL(url, 'http://example.test'); return target.pathname.startsWith('/tenant/') ? target.pathname + target.search : '/tenant' + target.pathname + target.search; },",
    " beforeNavigate({ url }) { return url === '/tenant/blocked' ? false : undefined; },",
    " afterNavigate(context) { globalThis.__evolitExtensionAfter = context; }",
    "};",
  ].join("");
  await registerNavigationExtensions([{
    name: "tenant",
    module: `data:text/javascript,${encodeURIComponent(source)}`,
  }]);
  try {
    assert.equal(transformNavigationUrl("/products?sort=price"), "/tenant/products?sort=price");
    assert.equal(transformNavigationUrl("http://example.test/tenant/products?sort=price"), "/tenant/products?sort=price");
    assert.deepEqual(await runBeforeNavigation("/tenant/products"), { url: "/tenant/products", cancelled: false });
    assert.deepEqual(await runBeforeNavigation("/tenant/blocked"), { url: "/tenant/blocked", cancelled: true });
    await runAfterNavigation({ from: "/", url: "/tenant/products" });
    assert.equal(globalThis.__evolitExtensionAfter.url, "/tenant/products");
  } finally {
    delete globalThis.__evolitExtensionAfter;
    registerNavigationExtensions([]);
  }
});

test("client extension declarations stay package-addressable and JSON-safe", () => {
  const extensions = resolveEvolitExtensions({
    plugins: [{ name: "tenant", client: { module: "@example/evolit-tenant/client", options: { prefix: "acme" } } }],
  });
  assert.deepEqual(getExtensionClientDescriptors(extensions), [{
    name: "tenant",
    module: "@example/evolit-tenant/client",
    options: { prefix: "acme" },
  }]);
  assert.throws(() => resolveEvolitExtensions({
    plugins: [{ name: "unsafe", client: "./browser.js" }],
  }), /package specifier/);
});
