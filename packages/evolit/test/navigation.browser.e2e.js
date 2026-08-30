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
import {
  EVOLIT_NAVIGATION_CONTEXT_HEADER,
  encodeNavigationContext,
} from "../src/navigation-context.js";

const frameworkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frameworkNodeModules = path.resolve(frameworkRoot, "..", "..", "node_modules");

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

async function linkFrameworkDependencies(projectRoot) {
  const targetRoot = path.join(projectRoot, "node_modules");
  await fs.mkdir(targetRoot, { recursive: true });
  for (const entry of await fs.readdir(frameworkNodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const sourcePath = path.join(frameworkNodeModules, entry.name);
    const targetPath = path.join(targetRoot, entry.name);
    if (entry.name.startsWith("@")) {
      await fs.mkdir(targetPath, { recursive: true });
      for (const scopedEntry of await fs.readdir(sourcePath)) {
        await fs.symlink(path.join(sourcePath, scopedEntry), path.join(targetPath, scopedEntry), "dir");
      }
    } else {
      await fs.symlink(sourcePath, targetPath, "dir");
    }
  }
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
        rootSegments: delta.hydrationData?.roots?.map((root) => root.segmentModulePath) ?? [],
        imports: delta.hydrationData?.clientImports ?? [],
        page: (delta.route.segments.find((segment) => segment.kind === "page")?.projections ?? []).map((projection) => projection.html),
      };
    });
    expect(deltaDiagnostics.contentType).toContain("application/vnd.evolit.navigation+json");
    expect(deltaDiagnostics.roots.length).toBeGreaterThan(0);
    expect(deltaDiagnostics.rootSegments.every((modulePath) => typeof modulePath === "string")).toBe(true);
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

test("development refresh applies server deltas and hot-swaps changed client code", async ({ page }, testInfo) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-development-refresh-"));
  const projectRoot = path.join(tempRoot, "site");
  const port = 3900 + testInfo.workerIndex;
  const origin = `http://127.0.0.1:${port}`;
  let child;

  try {
    await scaffoldSite(projectRoot);
    await linkFrameworkDependencies(projectRoot);
    let browserDeltaRequests = 0;
    page.on("request", (request) => {
      if (request.headers().accept?.includes("application/vnd.evolit.navigation+json")) {
        browserDeltaRequests += 1;
      }
    });
    child = spawn(process.execPath, [path.join(frameworkRoot, "src", "cli.js"), "dev", "--port", String(port)], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForServer(origin);
    await page.goto(origin, { waitUntil: "networkidle", timeout: 20_000 });
    const initialScroll = await page.evaluate(() => {
      window.__evolitDocumentIdentity = "initial-document";
      window.scrollTo(0, 120);
      return window.scrollY;
    });
    await page.evaluate(() => {
      const card = document.querySelector("feature-card");
      window.__evolitUnrelatedRefreshCount = 0;
      window.__evolitInitialCard = card;
      window.__evolitInitialTitle = card?.shadowRoot?.querySelector(".title");
      addEventListener("evolit:development-refresh", () => {
        window.__evolitUnrelatedRefreshCount += 1;
      });
    });
    const unrelatedRouteDirectory = path.join(projectRoot, "app", "unrelated");
    await fs.mkdir(unrelatedRouteDirectory, { recursive: true });
    await fs.writeFile(
      path.join(unrelatedRouteDirectory, "page.jsx"),
      'export default async function UnrelatedPage() { return <main>Unrelated route</main>; }\n',
      "utf8",
    );
    await expect.poll(() => page.evaluate(() => window.__evolitUnrelatedRefreshCount), {
      timeout: 10_000,
    }).toBeGreaterThan(0);
    expect(await page.evaluate(() => {
      const card = document.querySelector("feature-card");
      return {
        sameCard: card === window.__evolitInitialCard,
        sameTitle: card?.shadowRoot?.querySelector(".title") === window.__evolitInitialTitle,
        title: card?.shadowRoot?.querySelector(".title")?.textContent?.trim(),
      };
    })).toEqual({
      sameCard: true,
      sameTitle: true,
      title: "File Routing",
    });

    const pagePath = path.join(projectRoot, "app", "page.jsx");
    const pageSource = await fs.readFile(pagePath, "utf8");
    await fs.writeFile(
      pagePath,
      pageSource.replace("LitSX application framework", "Incrementally refreshed on the server"),
      "utf8",
    );

    await expect(page.locator(".eyebrow")).toHaveText("Incrementally refreshed on the server", { timeout: 10_000 });
    expect(await page.evaluate(() => window.__evolitDocumentIdentity)).toBe("initial-document");
    expect(await page.evaluate(() => window.scrollY)).toBe(initialScroll);
    expect(browserDeltaRequests).toBe(0);

    const layoutPath = path.join(projectRoot, "app", "layout.jsx");
    const layoutSource = await fs.readFile(layoutPath, "utf8");
    await fs.writeFile(
      layoutPath,
      layoutSource.replace('<div class="wordmark">evolit</div>', '<div class="wordmark">evolit incremental</div>'),
      "utf8",
    );

    await expect(page.locator(".wordmark")).toHaveText("evolit incremental", { timeout: 10_000 });
    await expect(page.locator(".eyebrow")).toHaveText("Incrementally refreshed on the server");
    expect(await page.evaluate(() => window.__evolitDocumentIdentity)).toBe("initial-document");

    const globalStylePath = path.join(projectRoot, "app", "global.css");
    const globalStyleSource = await fs.readFile(globalStylePath, "utf8");
    await fs.writeFile(
      globalStylePath,
      globalStyleSource.replace("letter-spacing: 0.16em", "letter-spacing: 0.2em"),
      "utf8",
    );

    await expect.poll(() => page.locator(".wordmark").evaluate((element) =>
      getComputedStyle(element).letterSpacing,
    ), { timeout: 10_000 }).toBe("2.4px");
    expect(browserDeltaRequests).toBe(0);

    const componentPath = path.join(projectRoot, "app", "components", "feature-card.jsx");
    const componentSource = await fs.readFile(componentPath, "utf8");
    await fs.writeFile(
      componentPath,
      componentSource.replace("padding: 24px", "padding: 25px"),
      "utf8",
    );

    await expect.poll(() => page.locator("feature-card").first().evaluate((element) =>
      getComputedStyle(element.shadowRoot.querySelector(".card")).padding,
    ), { timeout: 10_000 }).toBe("25px");
    expect(await page.evaluate(() => window.__evolitDocumentIdentity ?? null)).toBe("initial-document");
    await expect(page.locator(".eyebrow")).toHaveText("Incrementally refreshed on the server");
    expect(browserDeltaRequests).toBe(0);
  } finally {
    if (child?.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
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
        frameworkNodeModules,
        "@webcomponents",
        "scoped-custom-element-registry",
        "scoped-custom-element-registry.min.js",
      ),
    });
    await scaffoldSite(projectRoot);
    await fs.symlink(frameworkNodeModules, path.join(projectRoot, "node_modules"), "dir");
    await fs.mkdir(path.join(projectRoot, "app", "components"), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, "app", "components", "payload-leaf.jsx"),
      [
        'import { useHost } from "@litsx/core";',
        'import { css } from "lit";',
        "",
        "export default function PayloadLeaf({ payload }) {",
        "  useHost();",
        '  return <article class=\"payload-card\">{payload?.label ?? "missing"}</article>;',
        "}",
        "PayloadLeaf.styles = css`:host { display: block; }`;",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(projectRoot, "app", "components", "payload-card.jsx"),
      [
        'import { useHost, useOnConnect, useSsrResourceSnapshot } from "@litsx/core";',
        'import PayloadLeaf from "./payload-leaf.jsx";',
        "",
        "const payloadResources = new Map();",
        "function usePayloadResource(payload) {",
        '  if (typeof process !== "undefined" && process.versions?.node) payloadResources.set("current", payload.label);',
        "  useSsrResourceSnapshot({",
        '    key: "test:payload-resource",',
        "    capture: () => Object.fromEntries(payloadResources),",
        "    restore(snapshot) {",
        "      payloadResources.clear();",
        "      for (const [key, value] of Object.entries(snapshot)) payloadResources.set(key, value);",
        '      window.__payloadResourceEvents ??= [];',
        '      window.__payloadResourceEvents.push(`restore:${payloadResources.get("current")}`);',
        "    },",
        "  });",
        '  return payloadResources.get("current") ?? "missing";',
        "}",
        "",
        "export default function PayloadCard({ payload, showDetails }) {",
        "  const host = useHost();",
        "  const resource = usePayloadResource(payload);",
        "  useOnConnect(() => {",
        '    host.setAttribute("data-connected", "true");',
        '    window.__payloadResourceEvents ??= [];',
        '    window.__payloadResourceEvents.push(`connect:${resource}`);',
        "  }, [resource]);",
        '  return <section data-resource={resource}>{showDetails ? <PayloadLeaf payload={payload} /> : ""}<slot name="actions"></slot></section>;',
        "}",
        'PayloadCard.elements = { "payload-leaf": PayloadLeaf };',
        "",
      ].join("\n"),
      "utf8",
    );
    const payloadRoute = path.join(projectRoot, "app", "payload", "[name]");
    await fs.mkdir(payloadRoute, { recursive: true });
    await fs.writeFile(
      path.join(payloadRoute, "page.jsx"),
      [
        'import PayloadCard from "../../components/payload-card.jsx";',
        "",
        "export default async function PayloadPage({ params }) {",
        '  return <main><PayloadCard payload={{ label: params.name }} showDetails={params.name !== "hidden"}><span slot="actions" data-payload-action>{params.name}</span></PayloadCard><PayloadCard payload={{ label: params.name + "-second" }} showDetails={params.name !== "hidden"}><span slot="actions" data-payload-action>{params.name}-second</span></PayloadCard></main>;',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    child = spawn(process.execPath, [path.join(frameworkRoot, "src", "cli.js"), "dev", "--port", String(port)], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let serverOutput = "";
    child.stdout.on("data", (chunk) => { serverOutput += String(chunk); });
    child.stderr.on("data", (chunk) => { serverOutput += String(chunk); });
    try {
      await waitForServer(`${origin}/payload/alpha`);
    } catch (error) {
      throw new Error(`${error.message}\n${serverOutput.slice(-8_000)}`, { cause: error });
    }
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
    await page.evaluate(() => { window.__payloadResourceEvents = []; });
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
    await expect.poll(() => page.evaluate(() => window.__payloadResourceEvents ?? [])).toEqual([
      "restore:beta-second",
      "connect:beta-second",
      "connect:beta-second",
    ]);
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
    await fs.symlink(frameworkNodeModules, path.join(projectRoot, "node_modules"), "dir");
    const routeRoot = path.join(projectRoot, "app", "shape", "[mode]");
    await fs.mkdir(routeRoot, { recursive: true });
    await fs.writeFile(
      path.join(routeRoot, "layout.jsx"),
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
      path.join(routeRoot, "page.jsx"),
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
    await fs.symlink(frameworkNodeModules, path.join(projectRoot, "node_modules"), "dir");
    const routeRoot = path.join(projectRoot, "app", "nested", "[outer]", "[inner]");
    await fs.mkdir(routeRoot, { recursive: true });
    await fs.writeFile(path.join(projectRoot, "app", "nested", "[outer]", "layout.jsx"), [
      "export default async function OuterLayout({ children, params, searchParams }) {",
      '  return <section data-outer={params.outer} data-view={searchParams.view ?? "default"}>{children}</section>;',
      "}",
      "",
    ].join("\n"));
    await fs.writeFile(path.join(routeRoot, "layout.jsx"), [
      "export default async function InnerLayout({ children, params }) {",
      '  return <section data-inner={params.inner}>{children}</section>;',
      "}",
      "",
    ].join("\n"));
    await fs.writeFile(path.join(routeRoot, "page.jsx"), [
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

test("navigation context deltas preserve a root body and track segment dependencies", async ({ page }, testInfo) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-navigation-root-body-"));
  const projectRoot = path.join(tempRoot, "app");
  const port = 4200 + testInfo.workerIndex;
  const origin = `http://127.0.0.1:${port}`;
  const pageErrors = [];
  let serverOutput = "";
  let child;

  try {
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await scaffoldSite(projectRoot);
    await fs.symlink(frameworkNodeModules, path.join(projectRoot, "node_modules"), "dir");
    await fs.writeFile(path.join(projectRoot, "app", "layout.jsx"), [
      "export default async function RootLayout(props) {",
      "  const { children, searchParams } = props;",
      '  const rootTheme = searchParams.root === "active" ? (props.navigationContext?.rootTheme ?? "none") : "none";',
      '  return <body data-root-body="yes"><storefront-shell data-root-shell data-root-theme={rootTheme}>{children}</storefront-shell></body>;',
      "}",
      "",
    ].join("\n"));
    await fs.mkdir(path.join(projectRoot, "app", "context"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "app", "context", "layout.jsx"), [
      "export default async function ContextLayout({ children, navigationContext }) {",
      '  return <section data-context-layout={navigationContext?.nested ?? "none"}>{children}</section>;',
      "}",
      "",
    ].join("\n"));
    await fs.writeFile(path.join(projectRoot, "app", "context", "status.jsx"), [
      'import { useHost, useOnConnect } from "@litsx/core";',
      "export default function RouteStatus() {",
      "  const host = useHost();",
      '  useOnConnect(() => host.setAttribute("data-hydrated", "yes"), []);',
      '  return <span data-status-content>ready</span>;',
      "}",
      "",
    ].join("\n"));
    await fs.writeFile(path.join(projectRoot, "app", "context", "page.jsx"), [
      'import RouteStatus from "./status.jsx";',
      "export default async function ContextPage() {",
      "  return <main data-context-page><RouteStatus /></main>;",
      "}",
      "",
    ].join("\n"));
    child = spawn(process.execPath, [path.join(frameworkRoot, "src", "cli.js"), "dev", "--port", String(port)], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { serverOutput += String(chunk); });
    child.stderr.on("data", (chunk) => { serverOutput += String(chunk); });
    try {
      await waitForServer(`${origin}/context?root=passive`);
    } catch (error) {
      throw new Error(`${error.message}\n${serverOutput.slice(-8_000)}`, { cause: error });
    }
    const initialContext = { nested: "zero" };
    await page.setExtraHTTPHeaders({
      [EVOLIT_NAVIGATION_CONTEXT_HEADER]: encodeNavigationContext(initialContext),
    });
    await page.goto(`${origin}/context?root=passive`, { waitUntil: "networkidle", timeout: 20_000 });
    await page.evaluate(async (context) => {
      const bootstrap = [...document.scripts].filter((script) => script.type === "module")
        .map((script) => script.textContent ?? "")
        .find((source) => source.includes("getNavigation"));
      const { getNavigation } = await import(bootstrap.match(/import \{ getNavigation \} from "([^"]+)"/)[1]);
      await getNavigation().replaceContext(context);
      window.__evolitInitialBody = document.body;
      window.__evolitInitialRootShell = document.querySelector("[data-root-shell]");
    }, initialContext);
    await page.setExtraHTTPHeaders({});

    const pushContext = (context, target = null) => page.evaluate(async ({ nextContext, nextTarget }) => {
      const bootstrap = [...document.scripts].filter((script) => script.type === "module")
        .map((script) => script.textContent ?? "")
        .find((source) => source.includes("getNavigation"));
      const { getNavigation } = await import(bootstrap.match(/import \{ getNavigation \} from "([^"]+)"/)[1]);
      await getNavigation().push(nextTarget ?? `${location.pathname}${location.search}`, { context: nextContext });
    }, { nextContext: context, nextTarget: target });

    await pushContext({ nested: "one" });
    await expect(page.locator('[data-context-layout="one"]')).toHaveCount(1);
    expect(await page.evaluate(() => document.querySelector("[data-root-shell]") === window.__evolitInitialRootShell)).toBe(true);

    await pushContext({ nested: "two" });
    await expect(page.locator('[data-context-layout="two"]')).toHaveCount(1);
    expect(await page.evaluate(() => document.querySelector("[data-root-shell]") === window.__evolitInitialRootShell)).toBe(true);

    await pushContext({ nested: "two", rootTheme: "dark" }, "/context?root=active");
    await expect(page.locator("body")).toHaveAttribute("data-root-body", "yes");
    await expect(page.locator("body > storefront-shell")).toHaveAttribute("data-root-theme", "dark");
    await page.locator("[data-root-shell]").evaluate((element) => { window.__evolitDarkRootShell = element; });
    await pushContext({ nested: "two", rootTheme: "light" });
    await expect(page.locator("body > storefront-shell")).toHaveAttribute("data-root-theme", "light");
    expect(await page.evaluate(() => document.querySelector("[data-root-shell]") === window.__evolitDarkRootShell)).toBe(false);
    await expect(page.locator("body > storefront-shell")).toHaveCount(1);
    await expect(page.locator("body route-status")).toHaveCount(1);
    await expect(page.locator("body route-status")).toHaveAttribute("data-hydrated", "yes");
    expect(await page.evaluate(() => ({
      bodyConnected: document.body.isConnected,
      bodyPreserved: document.body === window.__evolitInitialBody,
      headCount: document.documentElement.querySelectorAll(":scope > head").length,
      bodyCount: document.documentElement.querySelectorAll(":scope > body").length,
      invalidElementSiblings: document.documentElement.querySelectorAll(":scope > :not(head):not(body)").length,
      routeScriptsInBody: document.body.querySelectorAll("#__EVOLIT_ROUTE__, #__EVOLIT_DOCUMENT__, #__LITSX_HYDRATION__").length,
      bootstrapCount: [...document.body.querySelectorAll('script[type="module"]')]
        .filter((script) => script.textContent.includes("getNavigation")).length,
      liveReloadCount: document.body.querySelectorAll("script[data-evolit-live-reload]").length,
      statusCount: document.body.querySelectorAll("route-status").length,
      stateContext: window.history.state.__evolitNavigationContext,
    }))).toEqual({
      bodyConnected: true,
      bodyPreserved: true,
      headCount: 1,
      bodyCount: 1,
      invalidElementSiblings: 0,
      routeScriptsInBody: 3,
      bootstrapCount: 1,
      liveReloadCount: 1,
      statusCount: 1,
      stateContext: { nested: "two", rootTheme: "light" },
    });

    await page.goBack();
    await expect(page.locator('[data-context-layout="two"]')).toHaveCount(1);
    await expect(page.locator("body > storefront-shell")).toHaveAttribute("data-root-theme", "dark");
    await page.goBack();
    await expect(page.locator('[data-context-layout="two"]')).toHaveCount(1);
    await expect(page.locator("body > storefront-shell")).toHaveAttribute("data-root-theme", "none");
    await page.goBack();
    await expect(page.locator('[data-context-layout="one"]')).toHaveCount(1);
    await page.goForward();
    await expect(page.locator('[data-context-layout="two"]')).toHaveCount(1);
    expect(await page.evaluate(() => ({
      url: `${location.pathname}${location.search}`,
      context: window.history.state.__evolitNavigationContext,
      bodyPreserved: document.body === window.__evolitInitialBody,
      statusCount: document.body.querySelectorAll("route-status").length,
      invalidElementSiblings: document.documentElement.querySelectorAll(":scope > :not(head):not(body)").length,
    }))).toEqual({
      url: "/context?root=passive",
      context: { nested: "two" },
      bodyPreserved: true,
      statusCount: 1,
      invalidElementSiblings: 0,
    });
    expect(pageErrors).toEqual([]);
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
    await fs.symlink(frameworkNodeModules, path.join(projectRoot, "node_modules"), "dir");
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
    await linkFrameworkDependencies(projectRoot);
    const packageRoot = path.join(projectRoot, "node_modules", "@fixture", "browser-card");
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@fixture/browser-card",
        type: "module",
        exports: { ".": { browser: "./browser.js", import: "./server.js" } },
      }),
    );
    const createPackageCard = (runtime) => [
      'import { LITSX_MODULE_ID } from "@litsx/core/elements";',
      'import { LitElement, html } from "lit";',
      "export default class PackageCard extends LitElement {",
      `  static runtime = "${runtime}";`,
      '  static [LITSX_MODULE_ID] = "@fixture/browser-card";',
      '  static [Symbol.for("litsx.hydratableTag")] = "package-card";',
      '  static [Symbol.for("litsx.component")] = true;',
      `  render() { return html\`<p data-package-runtime="${runtime}">Package card</p>\`; }`,
      "}",
      "",
    ].join("\n");
    await fs.writeFile(path.join(packageRoot, "browser.js"), createPackageCard("browser"), "utf8");
    await fs.writeFile(path.join(packageRoot, "server.js"), createPackageCard("server"), "utf8");
    const formatPackageRoot = path.join(projectRoot, "node_modules", "@fixture", "client-format");
    await fs.mkdir(formatPackageRoot, { recursive: true });
    await fs.writeFile(
      path.join(formatPackageRoot, "package.json"),
      JSON.stringify({ name: "@fixture/client-format", main: "./index.cjs" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(formatPackageRoot, "index.cjs"),
      'module.exports = function format(value) { return String(value); };\n',
      "utf8",
    );
    const jsconfigPath = path.join(projectRoot, "jsconfig.json");
    const jsconfig = JSON.parse(await fs.readFile(jsconfigPath, "utf8"));
    jsconfig.compilerOptions.baseUrl = ".";
    jsconfig.compilerOptions.paths = {
      ...jsconfig.compilerOptions.paths,
      "@ui/*": ["src/ui/*"],
    };
    jsconfig.include.push("src/**/*");
    await fs.writeFile(jsconfigPath, `${JSON.stringify(jsconfig, null, 2)}\n`, "utf8");
    await fs.mkdir(path.join(projectRoot, "src", "ui"), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, "src", "ui", "alias-card.jsx"),
      [
        'import format from "@fixture/client-format";',
        'export default function AliasCard() { return <article data-alias-card="hydrated">{format("Alias card")}</article>; }',
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(projectRoot, "src", "ui", "mixed-card.jsx"),
      [
        'import { createHash } from "node:crypto";',
        'export default async function ServerOnlyFragment() { return <p>{createHash("sha1").update("server").digest("hex")}</p>; }',
        'export function MixedCard() { return <article data-mixed-card="hydrated">Mixed card</article>; }',
        "",
      ].join("\n"),
      "utf8",
    );
    const routeRoot = path.join(projectRoot, "app", "explore", "[...slug]");
    await fs.mkdir(routeRoot, { recursive: true });
    await fs.writeFile(
      path.join(routeRoot, "page.jsx"),
      [
        'import FeatureCard from "../../components/feature-card.jsx";',
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
      path.join(projectRoot, "app", "other", "page.jsx"),
      [
        'import "./other.css";',
        'import AliasCard from "@/src/ui/alias-card";',
        'import PackageCard from "@fixture/browser-card";',
        'import { MixedCard } from "@ui/mixed-card";',
        "",
        'export const metadata = { title: "Other", description: "Other collection", lang: "es", htmlAttributes: { dir: "rtl", "data-route": "other" }, bodyAttributes: { "data-route": "other" }, head: \'<meta name="robots" content="noindex">\' };',
        "",
        "export default async function OtherPage() {",
        '  return <main data-other-route="yes">Other<AliasCard /><PackageCard /><MixedCard /></main>;',
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
    expect(await page.evaluate(() => JSON.parse(
      document.getElementById("__EVOLIT_ROUTE__").textContent,
    ).params)).toEqual({ slug: ["home-garden"] });

    await page.locator("form[data-explore-filter]").evaluate((form) => form.requestSubmit());
    await expect(page).toHaveURL(/\/explore\/home-garden\/furniture\?facet=brand&facet=color$/);
    await expect(routeMain).toHaveAttribute("data-slug", '["home-garden","furniture"]');
    await expect(routeMain).toHaveAttribute("data-facets", '["brand","color"]');
    expect(await page.evaluate(() => JSON.parse(
      document.getElementById("__EVOLIT_ROUTE__").textContent,
    ).params)).toEqual({ slug: ["home-garden", "furniture"] });

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
    const aliasCard = page.locator("alias-card");
    await expect.poll(() => aliasCard.evaluate((element) => ({
      upgraded: element.constructor.name !== "HTMLElement",
      content: element.shadowRoot?.querySelector("[data-alias-card]")?.textContent ?? "",
    }))).toEqual({ upgraded: true, content: "Alias card" });
    const packageCard = page.locator("package-card");
    await expect.poll(() => packageCard.evaluate((element) => ({
      upgraded: element.constructor.name !== "HTMLElement",
      runtime: element.constructor.runtime,
    }))).toEqual({ upgraded: true, runtime: "browser" });
    const mixedCard = page.locator("mixed-card");
    await expect.poll(() => mixedCard.evaluate((element) => ({
      upgraded: element.constructor.name !== "HTMLElement",
      content: element.shadowRoot?.querySelector("[data-mixed-card]")?.textContent,
    }))).toEqual({ upgraded: true, content: "Mixed card" });
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
