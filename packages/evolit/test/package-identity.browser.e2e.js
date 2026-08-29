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
const frameworkNodeModules = path.resolve(frameworkRoot, "..", "..", "node_modules");
const packageSpecifiers = {
  blocks: "@fixture/hydration-identity/blocks",
  components: "@fixture/hydration-identity/components",
  features: "@fixture/hydration-identity/features",
};

async function waitForServer(url) {
  let lastResponse = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastResponse = `${response.status} ${await response.text()}`;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}${lastResponse ? `: ${lastResponse}` : ""}`);
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

async function linkFrameworkDependencies(targetRoot) {
  const targetNodeModules = path.join(targetRoot, "node_modules");
  await fs.mkdir(targetNodeModules, { recursive: true });
  for (const entry of await fs.readdir(frameworkNodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const sourcePath = path.join(frameworkNodeModules, entry.name);
    const targetPath = path.join(targetNodeModules, entry.name);
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

async function writeFixture(projectRoot, workspaceRoot) {
  await scaffoldSite(projectRoot);
  const projectPackageJsonPath = path.join(projectRoot, "package.json");
  const projectPackageJson = JSON.parse(await fs.readFile(projectPackageJsonPath, "utf8"));
  projectPackageJson.dependencies["@fixture/hydration-identity"] = "workspace:*";
  await fs.writeFile(projectPackageJsonPath, `${JSON.stringify(projectPackageJson, null, 2)}\n`, "utf8");
  await linkFrameworkDependencies(workspaceRoot);
  await fs.symlink(path.join(workspaceRoot, "node_modules"), path.join(projectRoot, "node_modules"), "dir");

  const packageRoot = path.join(workspaceRoot, "node_modules", "@fixture", "hydration-identity");
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "@fixture/hydration-identity",
    type: "module",
    exports: {
      "./package.json": "./package.json",
      "./blocks": {
        browser: "./dist/blocks.mjs",
        import: "./dist/blocks.mjs",
      },
      "./components": {
        browser: "./dist/components.mjs",
        import: "./dist/components.mjs",
      },
      "./features": {
        browser: "./dist/features.mjs",
        import: "./dist/features.mjs",
      },
    },
  }), "utf8");
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  const internalEntry = path.join(packageRoot, "dist", "internal", "icon.mjs");
  await fs.mkdir(path.dirname(internalEntry), { recursive: true });
  await fs.writeFile(internalEntry, [
    'import { LITSX_MODULE_ID } from "@litsx/core/elements";',
    'import { LitElement, html } from "lit";',
    "globalThis.__fixtureIconEvaluations = (globalThis.__fixtureIconEvaluations ?? 0) + 1;",
    "export class FixtureIcon extends LitElement {",
    `  static [LITSX_MODULE_ID] = ${JSON.stringify(internalEntry)};`,
    '  static [Symbol.for("litsx.hydratableTag")] = "fixture-icon";',
    '  static [Symbol.for("litsx.component")] = true;',
    "  count = 0;",
    "  increment() { this.count += 1; this.requestUpdate(); }",
    '  render() { return html`<button @click=${() => this.increment()}>count:${this.count}</button>`; }',
    "}",
    "",
  ].join("\n"), "utf8");
  const entries = {
    blocks: ["BlockRoot", "block-root"],
    features: ["FeatureRoot", "feature-root"],
  };
  for (const [subpath, [className, tagName]] of Object.entries(entries)) {
    const packageEntry = path.join(packageRoot, "dist", `${subpath}.mjs`);
    await fs.writeFile(packageEntry, [
      'import { LITSX_MODULE_ID } from "@litsx/core/elements";',
      'import { LitElement, html } from "lit";',
      'import { FixtureIcon } from "./internal/icon.mjs";',
      `export class ${className} extends LitElement {`,
      `  static [LITSX_MODULE_ID] = ${JSON.stringify(packageEntry)};`,
      `  static [Symbol.for("litsx.hydratableTag")] = ${JSON.stringify(tagName)};`,
      '  static [Symbol.for("litsx.component")] = true;',
      '  static elements = { "fixture-icon": FixtureIcon };',
      '  render() { return html`<fixture-icon></fixture-icon>`; }',
      "}",
      'export { FixtureIcon } from "./internal/icon.mjs";',
      "",
    ].join("\n"), "utf8");
  }
  await fs.writeFile(
    path.join(packageRoot, "dist", "components.mjs"),
    'export { FixtureIcon } from "./internal/icon.mjs";\n',
    "utf8",
  );

  await fs.mkdir(path.join(projectRoot, "app", "components"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "app", "components", "local-wrapper.jsx"), [
    `import { FixtureIcon } from ${JSON.stringify(packageSpecifiers.components)};`,
    "export default function LocalWrapper() {",
    "  return <section><FixtureIcon /></section>;",
    "}",
    'LocalWrapper.elements = { "fixture-icon": FixtureIcon };',
    "",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(projectRoot, "app", "page.jsx"), [
    `import { BlockRoot } from ${JSON.stringify(packageSpecifiers.blocks)};`,
    `import { FeatureRoot } from ${JSON.stringify(packageSpecifiers.features)};`,
    'import LocalWrapper from "./components/local-wrapper.jsx";',
    "export default async function HomePage() {",
    '  return <div><BlockRoot /><FeatureRoot /><LocalWrapper /><a href="/other">other</a></div>;',
    "}",
    "",
  ].join("\n"), "utf8");
  await fs.mkdir(path.join(projectRoot, "app", "other"), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, "app", "other", "page.jsx"),
    'export default async function OtherPage() { return <main><p data-other>other</p><a href="/">home</a></main>; }\n',
    "utf8",
  );
}

test("declared workspace package hydration uses one canonical constructor in dev and production", async ({ page }, testInfo) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-package-identity-"));
  const projectRoot = path.join(workspaceRoot, "app");
  const pageErrors = [];
  const consoleErrors = [];
  const requestFailures = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => requestFailures.push({
    url: request.url(),
    error: request.failure()?.errorText ?? null,
  }));

  try {
    await writeFixture(projectRoot, workspaceRoot);
    await page.addInitScript({
      path: path.join(
        frameworkNodeModules,
        "@webcomponents",
        "scoped-custom-element-registry",
        "scoped-custom-element-registry.min.js",
      ),
    });

    for (const [index, mode] of ["dev", "production"].entries()) {
      if (mode === "production") await runCli(projectRoot, "build");
      const port = 4700 + (testInfo.workerIndex * 4) + index;
      const origin = `http://127.0.0.1:${port}`;
      const child = spawn(
        process.execPath,
        [path.join(frameworkRoot, "src", "cli.js"), mode === "dev" ? "dev" : "start", "--port", String(port)],
        { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (chunk) => { output += String(chunk); });
      child.stderr.on("data", (chunk) => { output += String(chunk); });
      const errorOffset = pageErrors.length;
      const consoleErrorOffset = consoleErrors.length;
      try {
        await waitForServer(origin);
        await page.goto(origin, { waitUntil: "networkidle", timeout: 30_000 });
        expect(pageErrors.slice(errorOffset)).toEqual([]);
        await expect(page.locator("block-root fixture-icon button")).toHaveText("count:0");
        await expect(page.locator("feature-root fixture-icon button")).toHaveText("count:0");
        const nestedButton = page.locator("local-wrapper").locator("fixture-icon button");
        await expect(nestedButton).toHaveText("count:0");
        await expect.poll(() => page.locator("block-root").evaluate((element) =>
          Boolean(element.shadowRoot?.querySelector("fixture-icon")?.shadowRoot)
        )).toBe(true);
        await expect.poll(() => page.locator("local-wrapper").evaluate((element) =>
          Boolean(element.shadowRoot?.querySelector("fixture-icon")?.shadowRoot)
        )).toBe(true);
        await nestedButton.click();
        await expect(nestedButton).toHaveText("count:1");

        const identity = await page.evaluate(async () => {
          const hydration = JSON.parse(document.getElementById("__LITSX_HYDRATION__").textContent);
          const packageUrls = [...new Set(performance.getEntriesByType("resource")
            .map((entry) => new URL(entry.name).pathname)
            .filter((value) => value.includes("/_evolit/shared/") && value.includes("hydration-identity")))];
          const modules = await Promise.all(packageUrls.map((url) => import(url)));
          const identities = modules.map((module) => module.FixtureIcon);
          const wrapper = document.querySelector("local-wrapper");
          const current = wrapper.constructor.elements["fixture-icon"];
          const registered = wrapper.shadowRoot.querySelector("fixture-icon").constructor;
          return {
            sharedUrl: packageUrls[0],
            packageUrls,
            clientImports: hydration.clientImports,
            sameIdentity: identities.every((identity) => identity === identities[0]),
            sameExport: current === identities[0],
            currentEqualsRegistered: current === registered,
            iconEvaluations: globalThis.__fixtureIconEvaluations,
            resourceUrls: performance.getEntriesByType("resource").map((entry) => entry.name),
          };
        });
        expect(identity.sameExport).toBe(true);
        expect(identity.sameIdentity).toBe(true);
        expect(identity.currentEqualsRegistered).toBe(true);
        expect(identity.iconEvaluations).toBe(1);
        expect(new Set(identity.packageUrls.map((url) => url.slice(0, url.lastIndexOf("/")))).size).toBe(1);
        expect(identity.sharedUrl).toContain("/_evolit/shared/");
        expect(identity.clientImports.some((value) => value.includes("__unmanaged__"))).toBe(false);
        expect(identity.resourceUrls.some((value) => value.includes("__unmanaged__") && value.includes("hydration-identity"))).toBe(false);
        expect(pageErrors.slice(errorOffset)).toEqual([]);
        expect(consoleErrors.slice(consoleErrorOffset).filter((message) =>
          message.includes("different constructor")
        )).toEqual([]);

        if (mode === "dev") {
          const wrapperPath = path.join(projectRoot, "app", "components", "local-wrapper.jsx");
          const wrapperSource = await fs.readFile(wrapperPath, "utf8");
          await fs.writeFile(
            wrapperPath,
            wrapperSource.replace("<section>", '<section data-hot="updated">'),
            "utf8",
          );
          await expect(page.locator("local-wrapper section")).toHaveAttribute("data-hot", "updated", {
            timeout: 10_000,
          });
          expect(await page.locator("local-wrapper").evaluate((wrapper) =>
            wrapper.constructor.elements["fixture-icon"]
            === wrapper.shadowRoot.querySelector("fixture-icon").constructor
          )).toBe(true);
        }

        if (mode === "production") {
          const manifest = JSON.parse(await fs.readFile(
            path.join(projectRoot, ".evolit", "build", "manifest.json"),
            "utf8",
          ));
          const scriptUrls = manifest.clientAssets.assets
            .filter((asset) => asset.type === "script")
            .map((asset) => asset.publicUrl);
          const loadedSharedUrls = identity.resourceUrls
            .map((url) => new URL(url).pathname)
            .filter((url) => url.startsWith("/_evolit/shared/") && url.endsWith(".mjs"));
          expect(manifest.clientAssets.assets.some((asset) =>
            asset.clientModule.includes("__unmanaged__") && asset.clientModule.includes("hydration-identity")
          )).toBe(false);
          for (const publicUrl of [...new Set([...scriptUrls, ...loadedSharedUrls, identity.sharedUrl])]) {
            expect((await fetch(`${origin}${publicUrl}`)).status, publicUrl).toBe(200);
          }
        }

        await page.getByRole("link", { name: "other" }).click();
        await expect(page.locator("[data-other]")).toHaveText("other");
        await page.getByRole("link", { name: "home" }).click();
        await expect(page.locator("local-wrapper fixture-icon button")).toHaveText("count:0");
        expect(pageErrors.slice(errorOffset)).toEqual([]);
      } catch (error) {
        const diagnostics = await page.evaluate(async () => {
          const hydrationText = document.getElementById("__LITSX_HYDRATION__")?.textContent ?? null;
          const hydration = hydrationText ? JSON.parse(hydrationText) : null;
          const sharedUrl = hydration?.clientImports?.find((value) =>
            value.includes("/_evolit/shared/") && value.includes("features")
          );
          const module = sharedUrl ? await import(sharedUrl) : null;
          return {
            hydration: hydrationText,
            scripts: [...document.scripts].map((script) => script.textContent ?? ""),
            scriptTypes: [...document.scripts].map((script) => script.type),
            blockConstructor: document.querySelector("block-root")?.constructor?.name ?? null,
            blockDefined: customElements.get("block-root")?.name ?? null,
            localWrapperConstructor: document.querySelector("local-wrapper")?.constructor?.name ?? null,
            filtersConstructor: document.querySelector("local-wrapper")?.shadowRoot
              ?.querySelector("fixture-icon")?.constructor?.name ?? null,
            resourceUrls: performance.getEntriesByType("resource").map((entry) => entry.name),
            sharedExports: module ? Object.keys(module) : [],
            sharedTags: module ? Object.fromEntries(Object.entries(module).map(([key, value]) => [
              key,
              value?.[Symbol.for("litsx.hydratableTag")] ?? null,
            ])) : {},
          };
        }).catch(() => null);
        throw new Error(
          `${mode} package identity check failed:\n${output.slice(-8_000)}\n${JSON.stringify({ diagnostics, consoleErrors, requestFailures })}`,
          { cause: error },
        );
      } finally {
        if (child.exitCode === null) {
          child.kill();
          await once(child, "exit");
        }
      }
    }
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
