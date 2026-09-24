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
    'import { litsxUnoCss } from "@litsx/unocss";',
    "export default {",
    "  litsx: {",
    "    compiler: { sourceMaps: true },",
    "    integrations: [litsxUnoCss()],",
    "  },",
    "};",
    "",
  ].join("\n"));
  await fs.writeFile(path.join(projectRoot, "uno.config.mjs"), [
    'import { presetWind3 } from "unocss";',
    "export default {",
    '  safelist: ["bg-fuchsia-500"],',
    "  presets: [presetWind3()],",
    "  preflights: [",
    '    { layer: "theme", getCSS: () => ":root{--fixture-brand:rgb(12 34 56)}" },',
    '    { layer: "preflights", getCSS: () => ":host{box-sizing:border-box}*,::before,::after{box-sizing:inherit}" },',
    "  ],",
    "};",
    "",
  ].join("\n"));
  await fs.writeFile(path.join(projectRoot, "app", "components", "class-maps.js"), [
    "export const CARD_STATES = {",
    '  active: "bg-emerald-500 text-white",',
    '  idle: "bg-slate-200 text-slate-900",',
    "};",
    'export const EXPLICIT_GUARD = ["ring-2", "ring-amber-400"];',
    'export const BADGE_TONES = { info: "bg-blue-500", warning: "bg-orange-500" };',
    "",
  ].join("\n"));
  await fs.writeFile(path.join(projectRoot, "app", "components", "utility-card.jsx"), [
    'import { css } from "lit";',
    'import { CARD_STATES, EXPLICIT_GUARD } from "./class-maps.js";',
    'const DENSITY = { compact: "py-2", roomy: "py-6" };',
    "export default function UtilityCard({ density = \"compact\", active = true }) {",
    "  return (",
    '    <article data-state="open" aria-expanded="true" class={`text-sm m-7 px-4 ${DENSITY[density]} ${CARD_STATES[active ? "active" : "idle"]} w-[37px] data-[state=open]:border-green-500 aria-[expanded=true]:opacity-100 dark:text-white`} >',
    '      <span class="authored-order">Card</span>',
    "    </article>",
    "  );",
    "}",
    "UtilityCard.styles = [",
    "  EXPLICIT_GUARD,",
    '  css`:host{display:block;color:var(--fixture-brand)}.authored-order{--authored-order:1}`',
    "];",
    "",
  ].join("\n"));
  await fs.writeFile(path.join(projectRoot, "app", "components", "status-badge.jsx"), [
    'import { css } from "lit";',
    'import { BADGE_TONES } from "./class-maps.js";',
    "export default function StatusBadge({ tone = \"info\" }) {",
    '  return <strong className={`text-sm font-bold rounded-full px-2 ${BADGE_TONES[tone]}`}>Ready</strong>;',
    "}",
    'StatusBadge.styles = css`:host{color:var(--fixture-brand)}.badge-authored{--badge-authored:1}`;',
    "",
  ].join("\n"));
  await fs.writeFile(path.join(projectRoot, "app", "page.jsx"), [
    'import UtilityCard from "./components/utility-card.jsx";',
    'import StatusBadge from "./components/status-badge.jsx";',
    "export const routeConfig = { cache: \"static\" };",
    "export default async function HomePage() {",
    "  return <section><UtilityCard density=\"roomy\" /><StatusBadge tone=\"warning\" /></section>;",
    "}",
    "",
  ].join("\n"));
}

function integrationStyleAsset(manifest) {
  return manifest.clientAssets.assets.find((asset) => (
    asset.integration === "unocss" && asset.type === "style"
  ));
}

test("direct @litsx/unocss integration owns Shadow DOM CSS and one document asset", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-unocss-"));
  const projectRoot = path.join(tempRoot, "app");
  try {
    await writeFixture(projectRoot);
    const manifestPath = await buildProject(projectRoot);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const globalStyle = integrationStyleAsset(manifest);
    assert.ok(globalStyle, "the integration emits one document stylesheet");
    assert.equal(manifest.clientAssets.documentStyles.length, 1);
    const globalCss = await fs.readFile(globalStyle.outputPath, "utf8");
    assert.equal((globalCss.match(/--fixture-brand/g) ?? []).length, 1);
    assert.match(globalCss, /rgb\(12 34 56\)/);

    const runtimeEntry = path.join(projectRoot, ".evolit", "build", "runtime-entry.mjs");
    const builtRuntime = await import(`${pathToFileURL(runtimeEntry).href}?test=${Date.now()}`);
    const runtime = await builtRuntime.createBuiltDeploymentRuntime({ projectRoot });
    try {
      const response = await runtime.handle(new Request("http://localhost/"));
      const html = String(response.body);
      const preloadHrefs = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)]
        .map((match) => match[1]);
      assert.ok(preloadHrefs.length > 0);
      assert.equal(html.includes(projectRoot), false, "prerendered HTML must not expose filesystem paths");
      assert.equal(preloadHrefs.every((href) => href.startsWith("/_evolit/")), true);
      assert.match(html, /<template[^>]*shadowrootmode="open"/);
      assert.equal((html.match(/\/integrations\/unocss\/global\.[a-f0-9]{8}\.css/g) ?? []).length, 1);
      assert.match(html, /\.m-7/);
      assert.match(html, /\.font-bold/);
      assert.match(html, /width:37px|width: 37px/);
      assert.match(html, /data-state/);
      assert.match(html, /aria-expanded/);
      assert.match(html, /\.ring-2|ring-width/);
      assert.doesNotMatch(globalCss, /\.m-7|\.font-bold/);
      const preflightIndex = html.indexOf("box-sizing:border-box");
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

test("development invalidation removes stale utility CSS and reloads uno.config", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-unocss-dev-"));
  const projectRoot = path.join(tempRoot, "app");
  let runtime;
  try {
    await writeFixture(projectRoot);
    runtime = await createDeploymentRuntime({ projectRoot, mode: "development" });
    const request = () => runtime.handle(new Request("http://localhost/"));
    const initial = String((await request()).body);
    assert.match(initial, /\.m-7/);

    const cardPath = path.join(projectRoot, "app", "components", "utility-card.jsx");
    const originalCard = await fs.readFile(cardPath, "utf8");
    await fs.writeFile(cardPath, originalCard.replace("m-7", "m-9"));
    await runtime.invalidateDevelopmentState([cardPath]);
    const changed = String((await request()).body);
    assert.match(changed, /\.m-9/);
    assert.doesNotMatch(changed, /\.m-7\{/);

    const configPath = path.join(projectRoot, "uno.config.mjs");
    const originalConfig = await fs.readFile(configPath, "utf8");
    await fs.writeFile(configPath, originalConfig.replace("rgb(12 34 56)", "rgb(98 76 54)"));
    await runtime.invalidateDevelopmentState([configPath]);
    const configured = String((await request()).body);
    assert.equal((configured.match(/\/integrations\/unocss\/global\.[a-f0-9]{8}\.css/g) ?? []).length, 1);
    const styleUrl = configured.match(/href="([^"]*\/integrations\/unocss\/global\.[a-f0-9]{8}\.css)"/)?.[1];
    assert.ok(styleUrl);
    const asset = await runtime.handle(new Request(`http://localhost${styleUrl}`));
    assert.match(String(asset.body), /rgb\(98 76 54\)/);
    assert.doesNotMatch(String(asset.body), /rgb\(12 34 56\)/);
  } finally {
    await runtime?.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("concurrent production builds isolate integration state and emit deterministic assets", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-unocss-isolation-"));
  const firstRoot = path.join(tempRoot, "first");
  const secondRoot = path.join(tempRoot, "second");
  try {
    await Promise.all([writeFixture(firstRoot), writeFixture(secondRoot)]);
    const secondConfigPath = path.join(secondRoot, "uno.config.mjs");
    const secondConfig = await fs.readFile(secondConfigPath, "utf8");
    await fs.writeFile(
      secondConfigPath,
      secondConfig.replace("rgb(12 34 56)", "rgb(210 45 67)"),
    );

    const [firstManifestPath, secondManifestPath] = await Promise.all([
      buildProject(firstRoot),
      buildProject(secondRoot),
    ]);
    const firstManifestText = await fs.readFile(firstManifestPath, "utf8");
    const firstManifest = JSON.parse(firstManifestText);
    const secondManifest = JSON.parse(await fs.readFile(secondManifestPath, "utf8"));
    const firstAsset = integrationStyleAsset(firstManifest);
    const secondAsset = integrationStyleAsset(secondManifest);
    const [firstCss, secondCss] = await Promise.all([
      fs.readFile(firstAsset.outputPath, "utf8"),
      fs.readFile(secondAsset.outputPath, "utf8"),
    ]);
    assert.match(firstCss, /rgb\(12 34 56\)/);
    assert.doesNotMatch(firstCss, /rgb\(210 45 67\)/);
    assert.match(secondCss, /rgb\(210 45 67\)/);
    assert.doesNotMatch(secondCss, /rgb\(12 34 56\)/);

    const firstPublicUrl = firstManifest.clientAssets.assets.find((asset) => (
      asset.integration === "unocss" && asset.integrationOutputId === "global.css"
    )).publicUrl;
    assert.doesNotMatch(
      JSON.stringify(firstManifest.clientAssets),
      /virtual[\\/][0-9a-f]{8}-[0-9a-f-]{27}/i,
    );
    const rebuiltManifestPath = await buildProject(firstRoot);
    const rebuiltManifestText = await fs.readFile(rebuiltManifestPath, "utf8");
    const rebuiltManifest = JSON.parse(rebuiltManifestText);
    const rebuiltAsset = integrationStyleAsset(rebuiltManifest);
    const rebuiltPublicUrl = rebuiltManifest.clientAssets.assets.find((asset) => (
      asset.integration === "unocss" && asset.integrationOutputId === "global.css"
    )).publicUrl;
    assert.equal(rebuiltPublicUrl, firstPublicUrl);
    assert.equal(await fs.readFile(rebuiltAsset.outputPath, "utf8"), firstCss);
    assert.deepEqual(rebuiltManifest.clientAssets, firstManifest.clientAssets);
    const { builtAt: _firstBuiltAt, ...firstDeterministicManifest } = JSON.parse(firstManifestText);
    const { builtAt: _rebuiltAt, ...rebuiltDeterministicManifest } = JSON.parse(rebuiltManifestText);
    assert.deepEqual(rebuiltDeterministicManifest, firstDeterministicManifest);

    const virtualSourceMaps = rebuiltManifest.clientAssets.assets
      .filter((asset) => asset.outputPath.includes("__litsx_virtual__") && asset.outputPath.endsWith(".map"));
    for (const sourceMapAsset of virtualSourceMaps) {
      const sourceMap = await fs.readFile(sourceMapAsset.outputPath, "utf8");
      assert.doesNotMatch(sourceMap, /virtual[\\/][0-9a-f]{8}-[0-9a-f-]{27}/i);
      assert.match(sourceMap, /__litsx_virtual__/);
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
