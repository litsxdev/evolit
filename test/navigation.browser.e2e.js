// This is intentionally an E2E suffix so Node's unit-test discovery ignores it.
import test, { expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { scaffoldSite } from "../src/scaffold.js";

const frameworkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function waitForServer(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function runCli(projectRoot, ...args) {
  const child = spawn(process.execPath, [path.join(frameworkRoot, "src", "cli.js"), ...args], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  const [code] = await once(child, "exit");
  if (code !== 0) throw new Error(`evolit ${args.join(" ")} failed:\n${output}`);
}

async function navigate(page, href) {
  await page.evaluate(async (target) => {
    const bootstrap = [...document.scripts]
      .map((script) => script.textContent ?? "")
      .find((source) => source.includes("getNavigation"));
    const moduleUrl = bootstrap.match(/import \{ getNavigation \} from "([^"]+)"/)[1];
    const { getNavigation } = await import(moduleUrl);
    await getNavigation().push(target);
  }, href);
}

test("browser can load an Evolit SSR document with route segment metadata", async ({ page }, testInfo) => {
  const port = 3500 + testInfo.workerIndex;
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn("node", ["../../src/cli.js", "dev", "--port", String(port)], {
    cwd: new URL("../templates/default/", import.meta.url),
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForServer(`${origin}/`);
    if (child.exitCode !== null) throw new Error(`Development server exited with code ${child.exitCode}`);
    await page.goto(origin, { waitUntil: "networkidle", timeout: 20_000 });
    await expect(page.locator("#__EVOLIT_ROUTE__")).toHaveCount(1);
    await expect(page.locator("#__LITSX_HYDRATION__")).toHaveCount(1);
    const featureCard = page.locator("feature-card").first();
    await expect(featureCard).toHaveCount(1);
    await expect.poll(() => featureCard.evaluate((element) => ({
      shadowRoot: Boolean(element.shadowRoot),
      upgraded: element.constructor.name !== "HTMLElement",
    }))).toEqual({ shadowRoot: true, upgraded: true });
    await page.evaluate(() => {
      const originalFetch = window.fetch.bind(window);
      window.__evolitNavigationRequestCount = 0;
      window.fetch = (input, init) => {
        if (new Headers(init?.headers).get("accept") === "application/vnd.evolit.navigation+json") {
          window.__evolitNavigationRequestCount += 1;
        }
        return originalFetch(input, init);
      };
    });
    await page.evaluate(async () => {
      const bootstrap = [...document.scripts]
        .map((script) => script.textContent ?? "")
        .find((source) => source.includes("getNavigation"));
      const moduleUrl = bootstrap.match(/import \{ getNavigation \} from "([^"]+)"/)[1];
      const { getNavigation } = await import(moduleUrl);
      await getNavigation().push("/about");
    });
    await expect(page).toHaveURL(/\/about$/);
    await expect(page.locator("main")).toContainText("About");
    await page.evaluate(async () => {
      const bootstrap = [...document.scripts].map((script) => script.textContent ?? "").find((source) => source.includes("getNavigation"));
      const { getNavigation } = await import(bootstrap.match(/import \{ getNavigation \} from "([^"]+)"/)[1]);
      await getNavigation().replace("/about?view=compact");
    });
    await expect(page).toHaveURL(/\/about\?view=compact$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    const restoredCard = page.locator("feature-card").first();
    await expect.poll(() => restoredCard.evaluate((element) => ({
      cards: element.shadowRoot?.querySelectorAll(".card").length ?? 0,
      titles: [...(element.shadowRoot?.querySelectorAll(".title") ?? [])]
        .map((node) => node.textContent?.trim()),
    }))).toEqual({ cards: 1, titles: ["File Routing"] });
    const deltaDiagnostics = await page.evaluate(async () => {
      const response = await fetch("/", {
        cache: "no-store",
        headers: { accept: "application/vnd.evolit.navigation+json" },
      });
      const contentType = response.headers.get("content-type");
      if (!contentType?.includes("application/vnd.evolit.navigation+json")) {
        return { contentType, body: await response.text() };
      }
      const delta = await response.json();
      return {
        contentType,
        roots: delta.hydrationData?.roots?.map((root) => root.id) ?? [],
        imports: delta.hydrationData?.clientImports ?? [],
        page: (delta.route.segments.find((segment) => segment.kind === "page")?.projections ?? []).map((projection) => projection.html),
      };
    });
    expect(deltaDiagnostics.contentType).toContain("application/vnd.evolit.navigation+json");
    expect(deltaDiagnostics.roots.length).toBeGreaterThan(0);
    expect(deltaDiagnostics.page.join("\n")).toContain("data-litsx-root");
    await expect.poll(() => restoredCard.evaluate((element) => ({
      shadowRoot: Boolean(element.shadowRoot),
      upgraded: element.constructor.name !== "HTMLElement",
    }))).toEqual({ shadowRoot: true, upgraded: true });
    const requestsBeforeNewHistoryEntry = await page.evaluate(() => window.__evolitNavigationRequestCount);
    await page.evaluate(async () => {
      const bootstrap = [...document.scripts].map((script) => script.textContent ?? "").find((source) => source.includes("getNavigation"));
      const { getNavigation } = await import(bootstrap.match(/import \{ getNavigation \} from "([^"]+)"/)[1]);
      await getNavigation().push("/about");
    });
    await expect(page.locator("main")).toContainText("About");
    expect(await page.evaluate(() => window.__evolitNavigationRequestCount)).toBe(requestsBeforeNewHistoryEntry + 1);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
  }
});

test("browser navigation falls back to the SSR document for a route without a delta", async ({ page }, testInfo) => {
  const port = 3700 + testInfo.workerIndex;
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn("node", ["../../src/cli.js", "dev", "--port", String(port)], {
    cwd: new URL("../templates/default/", import.meta.url),
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForServer(`${origin}/`);
    await page.goto(origin, { waitUntil: "networkidle", timeout: 20_000 });
    await page.evaluate(() => {
      const bootstrap = [...document.scripts]
        .map((script) => script.textContent ?? "")
        .find((source) => source.includes("getNavigation"));
      const moduleUrl = bootstrap.match(/import \{ getNavigation \} from "([^"]+)"/)[1];
      void import(moduleUrl).then(({ getNavigation }) => getNavigation().push("/missing"));
    });
    await page.waitForURL(/\/missing$/);
    await expect(page.locator("h1")).toHaveText("404");
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
  }
});

test("incremental navigation preserves scoped hydrated shadow roots with the registry polyfill", async ({ page }, testInfo) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-navigation-hydration-"));
  const projectRoot = path.join(tempRoot, "app");
  const port = 3900 + testInfo.workerIndex;
  const origin = `http://127.0.0.1:${port}`;
  const pageErrors = [];
  let child;

  try {
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.addInitScript({
      path: path.join(
        frameworkRoot,
        "node_modules",
        "@webcomponents",
        "scoped-custom-element-registry",
        "scoped-custom-element-registry.min.js",
      ),
    });
    await scaffoldSite(projectRoot);
    await fs.symlink(path.join(frameworkRoot, "node_modules"), path.join(projectRoot, "node_modules"), "dir");
    await fs.mkdir(path.join(projectRoot, "app", "components"), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, "app", "components", "payload-leaf.litsx"),
      [
        'import { useHost } from "@litsx/core";',
        "",
        "export default function PayloadLeaf({ payload }) {",
        "  useHost();",
        '  static styles = `:host { display: block; }`;',
        '  return <article class=\"payload-card\">{payload?.label ?? "missing"}</article>;',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(projectRoot, "app", "components", "payload-card.litsx"),
      [
        'import { useHost, useOnConnect } from "@litsx/core";',
        'import PayloadLeaf from "./payload-leaf.litsx";',
        "",
        "export default function PayloadCard({ payload, showDetails }) {",
        '  static elements = { "payload-leaf": PayloadLeaf };',
        "  const host = useHost();",
        "  useOnConnect(() => {",
        '    host.setAttribute("data-connected", "true");',
        "  }, []);",
        '  return <section>{showDetails ? <PayloadLeaf .payload={payload} /> : ""}<slot name="actions"></slot></section>;',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    const payloadRoute = path.join(projectRoot, "app", "payload", "[name]");
    await fs.mkdir(payloadRoute, { recursive: true });
    await fs.writeFile(
      path.join(payloadRoute, "page.litsx"),
      [
        'import PayloadCard from "../../components/payload-card.litsx";',
        "",
        "export default async function PayloadPage({ params }) {",
        '  return <main><PayloadCard .payload={{ label: params.name }} .showDetails={params.name !== "hidden"}><span slot="actions" data-payload-action>{params.name}</span></PayloadCard><PayloadCard .payload={{ label: params.name + "-second" }} .showDetails={params.name !== "hidden"}><span slot="actions" data-payload-action>{params.name}-second</span></PayloadCard></main>;',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    child = spawn(process.execPath, [path.join(frameworkRoot, "src", "cli.js"), "dev", "--port", String(port)], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForServer(`${origin}/payload/alpha`);
    await page.goto(`${origin}/payload/alpha`, { waitUntil: "networkidle", timeout: 20_000 });
    const payloadCards = page.locator("payload-card");
    await expect(payloadCards).toHaveCount(2);
    const payloadCard = payloadCards.first();
    await expect(payloadCard).toHaveAttribute("data-connected", "true");
    await expect.poll(() => payloadCard.evaluate((element) =>
      element.shadowRoot?.querySelector("payload-leaf")?.shadowRoot?.querySelector(".payload-card")?.textContent?.trim(),
    ))
      .toBe("alpha");
    await navigate(page, "/about");
    await expect(page).toHaveURL(/\/about$/);
    await navigate(page, "/payload/hidden");
    await expect(page).toHaveURL(/\/payload\/hidden$/);
    await expect.poll(() => payloadCards.evaluateAll((elements) => elements.map((element) => ({
      cards: element.shadowRoot?.querySelector("payload-leaf")?.shadowRoot?.querySelectorAll(".payload-card").length ?? 0,
      actions: element.querySelectorAll("[data-payload-action]").length,
    })))).toEqual([
      { cards: 0, actions: 1 },
      { cards: 0, actions: 1 },
    ]);
    await navigate(page, "/payload/beta");
    await expect(page).toHaveURL(/\/payload\/beta$/);
    await expect.poll(() => payloadCard.evaluate((element) => ({
      cards: element.shadowRoot?.querySelector("payload-leaf")?.shadowRoot?.querySelectorAll(".payload-card").length ?? 0,
      text: element.shadowRoot?.querySelector("payload-leaf")?.shadowRoot?.querySelector(".payload-card")?.textContent?.trim(),
      connected: element.getAttribute("data-connected"),
      constructorName: element.constructor.name,
      root: element.getAttribute("data-litsx-root"),
    }))).toEqual({
      cards: 1,
      text: "beta",
      connected: "true",
      constructorName: expect.not.stringMatching(/^HTMLElement$/),
      root: expect.any(String),
    });
    await expect.poll(() => payloadCards.evaluateAll((elements) => elements.map((element) => ({
      text: element.shadowRoot?.querySelector("payload-leaf")?.shadowRoot?.querySelector(".payload-card")?.textContent?.trim(),
      connected: element.getAttribute("data-connected"),
      root: element.getAttribute("data-litsx-root"),
    })))).toEqual([
      { text: "beta", connected: "true", root: expect.any(String) },
      { text: "beta-second", connected: "true", root: expect.any(String) },
    ]);
    expect(await payloadCards.evaluateAll((elements) => new Set(
      elements.map((element) => element.getAttribute("data-litsx-root")),
    ).size)).toBe(2);
    expect(pageErrors).toEqual([]);
  } finally {
    if (child?.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("incremental navigation never reuses a segment projection when its cardinality changes", async ({ page }, testInfo) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-navigation-projections-"));
  const projectRoot = path.join(tempRoot, "app");
  const port = 4000 + testInfo.workerIndex;
  const origin = `http://127.0.0.1:${port}`;
  let child;

  try {
    await scaffoldSite(projectRoot);
    await fs.symlink(path.join(frameworkRoot, "node_modules"), path.join(projectRoot, "node_modules"), "dir");
    const routeRoot = path.join(projectRoot, "app", "shape", "[mode]");
    await fs.mkdir(routeRoot, { recursive: true });
    await fs.writeFile(
      path.join(routeRoot, "layout.litsx"),
      [
        "export default async function ShapeLayout({ children, params }) {",
        '  return params.mode === "many"',
        '    ? <section data-shape=\"many\"><aside>{children}</aside><main>{children}</main></section>',
        '    : <section data-shape=\"one\"><main>{children}</main></section>;',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(routeRoot, "page.litsx"),
      [
        "export default async function ShapePage({ params }) {",
        '  return <article data-shape-page>{params.mode}</article>;',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    child = spawn(process.execPath, [path.join(frameworkRoot, "src", "cli.js"), "dev", "--port", String(port)], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForServer(`${origin}/`);
    await page.goto(`${origin}/`, { waitUntil: "networkidle", timeout: 20_000 });
    await navigate(page, "/shape/many");
    await expect(page).toHaveURL(/\/shape\/many$/);
    await expect(page.locator("[data-shape-page]")).toHaveCount(2);

    await navigate(page, "/shape/one");
    await expect(page).toHaveURL(/\/shape\/one$/);
    await expect(page.locator("[data-shape=\"one\"]")).toHaveCount(1);
    await expect(page.locator("[data-shape-page]")).toHaveCount(1);

    await navigate(page, "/shape/many");
    await expect(page).toHaveURL(/\/shape\/many$/);
    await expect(page.locator("[data-shape=\"many\"]")).toHaveCount(1);
    await expect(page.locator("[data-shape-page]")).toHaveCount(2);
  } finally {
    if (child?.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("incremental navigation preserves unaffected nested layouts", async ({ page }, testInfo) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-navigation-nested-layouts-"));
  const projectRoot = path.join(tempRoot, "app");
  const port = 4100 + testInfo.workerIndex;
  const origin = `http://127.0.0.1:${port}`;
  let child;

  try {
    await scaffoldSite(projectRoot);
    await fs.symlink(path.join(frameworkRoot, "node_modules"), path.join(projectRoot, "node_modules"), "dir");
    const routeRoot = path.join(projectRoot, "app", "nested", "[outer]", "[inner]");
    await fs.mkdir(routeRoot, { recursive: true });
    await fs.writeFile(path.join(projectRoot, "app", "nested", "[outer]", "layout.litsx"), [
      "export default async function OuterLayout({ children, params, searchParams }) {",
      '  return <section data-outer={params.outer} data-view={searchParams.view ?? "default"}>{children}</section>;',
      "}",
      "",
    ].join("\n"));
    await fs.writeFile(path.join(routeRoot, "layout.litsx"), [
      "export default async function InnerLayout({ children, params }) {",
      '  return <section data-inner={params.inner}>{children}</section>;',
      "}",
      "",
    ].join("\n"));
    await fs.writeFile(path.join(routeRoot, "page.litsx"), [
      "export default async function NestedPage({ params, searchParams }) {",
      '  return <article data-page>{params.outer}:{params.inner}:{searchParams.page ?? "1"}</article>;',
      "}",
      "",
    ].join("\n"));
    child = spawn(process.execPath, [path.join(frameworkRoot, "src", "cli.js"), "dev", "--port", String(port)], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForServer(`${origin}/`);
    await page.goto(`${origin}/`, { waitUntil: "networkidle", timeout: 20_000 });
    await navigate(page, "/nested/a/one?view=grid&page=1");
    await page.locator('[data-outer="a"]').evaluate((element) => { window.__evolitOuterLayout = element; });

    await navigate(page, "/nested/a/two?view=grid&page=2");
    await expect(page.locator('[data-outer="a"]')).toHaveText("a:two:2");
    expect(await page.locator('[data-outer="a"]').evaluate((element) => element === window.__evolitOuterLayout)).toBe(true);

    await navigate(page, "/nested/a/two?view=list&page=2");
    await expect(page.locator('[data-outer="a"]')).toHaveText("a:two:2");
    expect(await page.locator('[data-outer="a"]').evaluate((element) => element === window.__evolitOuterLayout)).toBe(false);

    await navigate(page, "/nested/b/two?view=list&page=2");
    await expect(page.locator('[data-outer="b"]')).toHaveText("b:two:2");
    expect(await page.locator('[data-outer="b"]').evaluate((element) => element === window.__evolitOuterLayout)).toBe(false);
  } finally {
    if (child?.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("browser navigation works with production build assets", async ({ page }, testInfo) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-navigation-production-"));
  const projectRoot = path.join(tempRoot, "app");
  const port = 3800 + testInfo.workerIndex;
  const origin = `http://127.0.0.1:${port}`;
  let child;
  try {
    await scaffoldSite(projectRoot);
    await fs.symlink(path.join(frameworkRoot, "node_modules"), path.join(projectRoot, "node_modules"), "dir");
    await runCli(projectRoot, "build");
    child = spawn(process.execPath, [path.join(frameworkRoot, "src", "cli.js"), "start", "--port", String(port)], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForServer(`${origin}/`);
    const html = await (await fetch(origin)).text();
    expect(html).toMatch(/\/_evolit\/static\/.*-[A-Za-z0-9_-]{8,}\.mjs/);

    await page.goto(origin, { waitUntil: "networkidle", timeout: 20_000 });
    const featureCard = page.locator("feature-card").first();
    await expect.poll(() => featureCard.evaluate((element) => element.constructor.name)).not.toBe("HTMLElement");
    await page.evaluate(async () => {
      const bootstrap = [...document.scripts]
        .map((script) => script.textContent ?? "")
        .find((source) => source.includes("getNavigation"));
      const moduleUrl = bootstrap.match(/import \{ getNavigation \} from "([^"]+)"/)[1];
      const { getNavigation } = await import(moduleUrl);
      await getNavigation().push("/about");
    });
    await expect(page).toHaveURL(/\/about$/);
    await expect(page.locator("main")).toContainText("About");
    await navigate(page, "/");
    const restoredCard = page.locator("feature-card").first();
    await expect.poll(() => restoredCard.evaluate((element) => ({
      cards: element.shadowRoot?.querySelectorAll(".card").length ?? 0,
      upgraded: element.constructor.name !== "HTMLElement",
    }))).toEqual({ cards: 1, upgraded: true });
  } finally {
    if (child?.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("browser navigation preserves catch-all params and repeated query params", async ({ page }, testInfo) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-navigation-browser-"));
  const projectRoot = path.join(tempRoot, "app");
  const port = 3600 + testInfo.workerIndex;
  const origin = `http://127.0.0.1:${port}`;
  let child;

  try {
    await scaffoldSite(projectRoot);
    await fs.symlink(path.join(frameworkRoot, "node_modules"), path.join(projectRoot, "node_modules"), "dir");
    const routeRoot = path.join(projectRoot, "app", "explore", "[...slug]");
    await fs.mkdir(routeRoot, { recursive: true });
    await fs.writeFile(
      path.join(routeRoot, "page.litsx"),
      [
        'import FeatureCard from "../../components/feature-card.litsx";',
        'import "./explore.css";',
        "",
        'export const metadata = { title: "Explore", description: "Explore collections", lang: "en", htmlAttributes: { dir: "ltr", "data-route": "explore" }, bodyAttributes: { "data-route": "explore" }, head: \'<meta name="robots" content="index,follow">\' };',
        "",
        "export default async function ExplorePage({ params, searchParams }) {",
        "  const slug = JSON.stringify(params.slug ?? []);",
        "  const facets = JSON.stringify(searchParams.facet ?? []);",
        '  return <main data-slug={slug} data-facets={facets}><form data-explore-filter method="get" action="/explore/home-garden/furniture"><input name="facet" value="brand" /><input name="facet" value="color" /><button type="submit">Filter</button></form><FeatureCard title={slug} body={facets} /></main>;',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(path.join(routeRoot, "explore.css"), ".explore-route { color: tomato; }\n", "utf8");
    await fs.mkdir(path.join(projectRoot, "app", "other"), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, "app", "other", "page.litsx"),
      [
        'import "./other.css";',
        "",
        'export const metadata = { title: "Other", description: "Other collection", lang: "es", htmlAttributes: { dir: "rtl", "data-route": "other" }, bodyAttributes: { "data-route": "other" }, head: \'<meta name="robots" content="noindex">\' };',
        "",
        "export default async function OtherPage() {",
        '  return <main data-other-route="yes">Other</main>;',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(path.join(projectRoot, "app", "other", "other.css"), ".other-route { color: royalblue; }\n", "utf8");
    child = spawn(process.execPath, [path.join(frameworkRoot, "src", "cli.js"), "dev", "--port", String(port)], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForServer(`${origin}/explore/home-garden?facet=brand&facet=material`);
    await page.goto(`${origin}/explore/home-garden?facet=brand&facet=material`, {
      waitUntil: "networkidle",
      timeout: 20_000,
    });
    const routeMain = page.locator("main[data-slug]");
    await expect(routeMain).toHaveAttribute("data-slug", '["home-garden"]');
    await expect(routeMain).toHaveAttribute("data-facets", '["brand","material"]');

    await page.locator("form[data-explore-filter]").evaluate((form) => form.requestSubmit());
    await expect(page).toHaveURL(/\/explore\/home-garden\/furniture\?facet=brand&facet=color$/);
    await expect(routeMain).toHaveAttribute("data-slug", '["home-garden","furniture"]');
    await expect(routeMain).toHaveAttribute("data-facets", '["brand","color"]');

    await page.evaluate(async () => {
      const bootstrap = [...document.scripts].map((script) => script.textContent ?? "").find((source) => source.includes("getNavigation"));
      const { getNavigation } = await import(bootstrap.match(/import \{ getNavigation \} from "([^"]+)"/)[1]);
      await getNavigation().push("/explore/home-garden/furniture?facet=brand&facet=color&sort=price");
    });
    await expect(page).toHaveURL(/\/explore\/home-garden\/furniture\?facet=brand&facet=color&sort=price$/);
    await expect(routeMain).toHaveAttribute("data-slug", '["home-garden","furniture"]');
    await expect(routeMain).toHaveAttribute("data-facets", '["brand","color"]');

    await page.evaluate(async () => {
      const bootstrap = [...document.scripts].map((script) => script.textContent ?? "").find((source) => source.includes("getNavigation"));
      const { getNavigation } = await import(bootstrap.match(/import \{ getNavigation \} from "([^"]+)"/)[1]);
      await getNavigation().push("/other");
    });
    await expect(page).toHaveURL(/\/other$/);
    await expect(page.locator("main[data-other-route]")).toHaveCount(1);
    await expect(page).toHaveTitle("Other");
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", "Other collection");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.locator("html")).toHaveAttribute("data-route", "other");
    await expect(page.locator("body")).toHaveAttribute("data-route", "other");
    await expect.poll(() => page.evaluate(() =>
      [...document.head.querySelectorAll('link[data-evolit-route-asset="style"]')].map((link) => link.getAttribute("href")),
    )).toEqual(expect.arrayContaining([expect.stringContaining("app/other")]));
    expect(await page.evaluate(() =>
      [...document.head.querySelectorAll('link[data-evolit-route-asset="style"]')].map((link) => link.getAttribute("href")),
    )).not.toEqual(expect.arrayContaining([expect.stringContaining("explore")]));

    await page.goBack();
    await expect(page).toHaveURL(/\/explore\/home-garden\/furniture\?facet=brand&facet=color&sort=price$/);
    await expect(page).toHaveTitle("Explore");
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", "Explore collections");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "index,follow");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.locator("html")).toHaveAttribute("data-route", "explore");
    await expect(page.locator("body")).toHaveAttribute("data-route", "explore");
    await expect.poll(() => page.evaluate(() =>
      [...document.head.querySelectorAll('link[data-evolit-route-asset="style"]')].map((link) => link.getAttribute("href")),
    )).toEqual(expect.arrayContaining([expect.stringContaining("explore")]));
    expect(await page.evaluate(() =>
      [...document.head.querySelectorAll('link[data-evolit-route-asset="style"]')].map((link) => link.getAttribute("href")),
    )).not.toEqual(expect.arrayContaining([expect.stringContaining("app/other")]));
    await page.goBack();
    await expect(page).toHaveURL(/\/explore\/home-garden\/furniture\?facet=brand&facet=color$/);
    await expect(routeMain).toHaveAttribute("data-slug", '["home-garden","furniture"]');
    await expect(routeMain).toHaveAttribute("data-facets", '["brand","color"]');
    await page.goBack();
    await expect(page).toHaveURL(/\/explore\/home-garden\?facet=brand&facet=material$/);
    await expect(routeMain).toHaveAttribute("data-slug", '["home-garden"]');
    await expect(routeMain).toHaveAttribute("data-facets", '["brand","material"]');
  } finally {
    if (child?.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
