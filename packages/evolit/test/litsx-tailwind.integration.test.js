import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildProject } from "../src/build.js";
import { createDeploymentRuntime } from "../src/deployment-runtime.js";
import { scaffoldSite } from "../src/scaffold.js";

const frameworkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frameworkNodeModules = path.resolve(frameworkRoot, "..", "..", "node_modules");

async function writeFixture(projectRoot) {
  await scaffoldSite(projectRoot);
  await fs.symlink(frameworkNodeModules, path.join(projectRoot, "node_modules"), "dir");
  await fs.writeFile(path.join(projectRoot, "evolit.config.js"), [
    'import { litsxTailwind } from "@litsx/tailwind";',
    "export default {",
    "  litsx: {",
    "    compiler: { sourceMaps: true },",
    '    integrations: [litsxTailwind({ integration: { entry: "./tailwind.css" } })],',
    "  },",
    "};",
    "",
  ].join("\n"));
  await fs.writeFile(path.join(projectRoot, "tailwind.css"), [
    '@config "./tailwind.config.mjs";',
    '@import "tailwindcss" source(none);',
    '@theme static { --color-fixture-theme: rgb(12 34 56); }',
    "",
  ].join("\n"));
  await fs.writeFile(path.join(projectRoot, "tailwind.config.mjs"), [
    "export default {",
    '  theme: { extend: { colors: { brand: "#123456" } } },',
    "};",
    "",
  ].join("\n"));
  await fs.writeFile(path.join(projectRoot, "app", "components", "class-maps.js"), [
    "export const CARD_STATES = {",
    '  active: "bg-brand text-white",',
    '  idle: "bg-slate-200 text-slate-900",',
    "};",
    'export const EXPLICIT_GUARD = ["ring-2", "ring-amber-400"];',
    'export const BADGE_TONES = { info: "bg-blue-500", warning: "bg-orange-500" };',
    "",
  ].join("\n"));
  await fs.writeFile(path.join(projectRoot, "app", "components", "tailwind-card.jsx"), [
    'import { css } from "lit";',
    'import { CARD_STATES, EXPLICIT_GUARD } from "./class-maps.js";',
    'const DENSITY = { compact: "py-2", roomy: "py-6" };',
    "export default function TailwindCard({ density = \"compact\", active = true }) {",
    "  return (",
    '    <article data-state="open" aria-expanded="true" class={`text-sm m-7 px-4 ${DENSITY[density]} ${CARD_STATES[active ? "active" : "idle"]} w-[37px] data-[state=open]:border-green-500 aria-[expanded=true]:opacity-100 dark:text-white`}>',
    '      <span class="authored-order">Card</span>',
    "    </article>",
    "  );",
    "}",
    "TailwindCard.styles = [",
    "  EXPLICIT_GUARD,",
    '  css`:host{display:block;color:var(--color-fixture-theme)}.authored-order{--authored-order:1}`',
    "];",
    "",
  ].join("\n"));
  await fs.writeFile(path.join(projectRoot, "app", "components", "status-badge.jsx"), [
    'import { BADGE_TONES } from "./class-maps.js";',
    "export default function StatusBadge({ tone = \"info\" }) {",
    '  return <strong className={`text-sm font-bold rounded-full px-2 ${BADGE_TONES[tone]}`}>Ready</strong>;',
    "}",
    "",
  ].join("\n"));
  await fs.writeFile(path.join(projectRoot, "app", "page.jsx"), [
    'import TailwindCard from "./components/tailwind-card.jsx";',
    'import StatusBadge from "./components/status-badge.jsx";',
    'export const routeConfig = { cache: "static" };',
    "export default async function HomePage() {",
    '  return <section><TailwindCard density="roomy" /><StatusBadge tone="warning" /></section>;',
    "}",
    "",
  ].join("\n"));
}

function integrationStyleAsset(manifest) {
  return manifest.clientAssets.assets.find((asset) => (
    asset.integration === "tailwind" && asset.type === "style"
  ));
}

test("direct @litsx/tailwind integration owns Shadow DOM CSS and one document asset", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-tailwind-"));
  const projectRoot = path.join(tempRoot, "app");
  try {
    await writeFixture(projectRoot);
    const manifestPath = await buildProject(projectRoot);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const globalStyle = integrationStyleAsset(manifest);
    assert.ok(globalStyle, "the integration emits one document stylesheet");
    assert.equal(manifest.clientAssets.documentStyles.length, 1);
    const globalCss = await fs.readFile(globalStyle.outputPath, "utf8");
    assert.equal((globalCss.match(/--color-fixture-theme/g) ?? []).length, 1);
    assert.doesNotMatch(globalCss, /\.m-7|\.font-bold/);

    const runtimeEntry = path.join(projectRoot, ".evolit", "build", "runtime-entry.mjs");
    const builtRuntime = await import(`${pathToFileURL(runtimeEntry).href}?test=${Date.now()}`);
    const runtime = await builtRuntime.createBuiltDeploymentRuntime({ projectRoot });
    try {
      const response = await runtime.handle(new Request("http://localhost/"));
      const html = String(response.body);
      assert.match(html, /<template[^>]*shadowrootmode="open"/);
      assert.equal((html.match(/\/integrations\/tailwind\/global\.[a-f0-9]{8}\.css/g) ?? []).length, 1);
      assert.match(html, /\.m-7/);
      assert.match(html, /\.font-bold/);
      assert.match(html, /width:\s*37px/);
      assert.match(html, /data-state/);
      assert.match(html, /aria-expanded/);
      assert.match(html, /#123456/);
      const preflightIndex = html.indexOf("box-sizing: border-box");
      const authoredIndex = html.indexOf("--authored-order:1");
      const utilityIndex = html.indexOf(".m-7");
      assert.ok(preflightIndex >= 0 && authoredIndex > preflightIndex && utilityIndex > authoredIndex);
    } finally {
      await runtime.close();
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("development invalidation removes stale Tailwind CSS and reloads tailwind.config", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-tailwind-dev-"));
  const projectRoot = path.join(tempRoot, "app");
  let runtime;
  try {
    await writeFixture(projectRoot);
    runtime = await createDeploymentRuntime({ projectRoot, mode: "development" });
    const request = () => runtime.handle(new Request("http://localhost/"));
    const initial = String((await request()).body);
    assert.match(initial, /\.m-7/);
    assert.match(initial, /#123456/);
    assert.ok(
      runtime.litsxDependencies.includes(path.join(projectRoot, "tailwind.config.mjs")),
      JSON.stringify(runtime.litsxDependencies),
    );

    const cardPath = path.join(projectRoot, "app", "components", "tailwind-card.jsx");
    const originalCard = await fs.readFile(cardPath, "utf8");
    await fs.writeFile(cardPath, originalCard.replace("m-7", "m-9"));
    await runtime.invalidateDevelopmentState([cardPath]);
    const changed = String((await request()).body);
    assert.match(changed, /\.m-9/);
    assert.doesNotMatch(changed, /\.m-7\{/);

    const configPath = path.join(projectRoot, "tailwind.config.mjs");
    const originalConfig = await fs.readFile(configPath, "utf8");
    await fs.writeFile(configPath, originalConfig.replace("#123456", "#654321"));
    await runtime.invalidateDevelopmentState([configPath]);
    const configured = String((await request()).body);
    assert.match(configured, /#654321/);
    assert.doesNotMatch(configured, /#123456/);
  } finally {
    await runtime?.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("concurrent Tailwind builds isolate state and emit deterministic assets", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-tailwind-isolation-"));
  const firstRoot = path.join(tempRoot, "first");
  const secondRoot = path.join(tempRoot, "second");
  try {
    await Promise.all([writeFixture(firstRoot), writeFixture(secondRoot)]);
    const secondConfigPath = path.join(secondRoot, "tailwind.config.mjs");
    const secondConfig = await fs.readFile(secondConfigPath, "utf8");
    await fs.writeFile(secondConfigPath, secondConfig.replace("#123456", "#abcdef"));

    const [firstManifestPath, secondManifestPath] = await Promise.all([
      buildProject(firstRoot),
      buildProject(secondRoot),
    ]);
    const firstManifestText = await fs.readFile(firstManifestPath, "utf8");
    const firstManifest = JSON.parse(firstManifestText);
    const secondManifest = JSON.parse(await fs.readFile(secondManifestPath, "utf8"));
    const [firstCss, secondCss] = await Promise.all([
      fs.readFile(integrationStyleAsset(firstManifest).outputPath, "utf8"),
      fs.readFile(integrationStyleAsset(secondManifest).outputPath, "utf8"),
    ]);
    assert.doesNotMatch(firstCss, /#abcdef/);
    assert.doesNotMatch(secondCss, /#123456/);

    const firstPublicUrl = integrationStyleAsset(firstManifest).publicUrl;
    const rebuiltManifestPath = await buildProject(firstRoot);
    const rebuiltManifestText = await fs.readFile(rebuiltManifestPath, "utf8");
    const rebuiltManifest = JSON.parse(rebuiltManifestText);
    assert.equal(integrationStyleAsset(rebuiltManifest).publicUrl, firstPublicUrl);
    const { builtAt: _firstBuiltAt, ...firstDeterministicManifest } = JSON.parse(firstManifestText);
    const { builtAt: _rebuiltAt, ...rebuiltDeterministicManifest } = JSON.parse(rebuiltManifestText);
    assert.deepEqual(rebuiltDeterministicManifest, firstDeterministicManifest);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
