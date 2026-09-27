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
  return output;
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

async function writeUrqlFixture(projectRoot) {
  await scaffoldSite(projectRoot);
  await linkFrameworkDependencies(projectRoot);
  const packageJsonPath = path.join(projectRoot, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  packageJson.dependencies["@litsx/urql"] = "^0.4.2";
  await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  await fs.writeFile(path.join(projectRoot, "evolit.config.js"), [
    "export default {",
    '  server: { setup: "./server/setup.js" },',
    "};",
    "",
  ].join("\n"));
  await fs.mkdir(path.join(projectRoot, "server"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "server", "setup.js"), [
    'import { cacheExchange, createClient, fetchExchange, ssrExchange } from "@urql/core";',
    'import { configureUrqlSsr } from "@litsx/urql";',
    "",
    "export function setup() {",
    "  return configureUrqlSsr({",
    "    createResource({ request, responseHeaders }) {",
    '      const requestValue = String(new URL(request.url).searchParams.get("value") ?? "missing");',
    '      responseHeaders.set("x-urql-resource", requestValue);',
    "      const cache = ssrExchange({ isClient: false });",
    "      const client = createClient({",
    '        url: "http://fixture.test/graphql",',
    "        exchanges: [cacheExchange, cache, fetchExchange],",
    "        async fetch(input, init) {",
    "          await new Promise((resolve) => setTimeout(resolve, requestValue === \"one\" ? 20 : 5));",
    "          return new Response(JSON.stringify({ data: { viewer: { name: `server:${requestValue}` } } }), {",
    '            headers: { "content-type": "application/json" },',
    "          });",
    "        },",
    "      });",
    "      return {",
    "        client,",
    "        extractData: () => cache.extractData(),",
    "      };",
    "    },",
    "  });",
    "}",
    "",
  ].join("\n"));
  await fs.writeFile(path.join(projectRoot, "app", "urql-probe.jsx"), [
    'import { cacheExchange, createClient, fetchExchange, gql, ssrExchange } from "@urql/core";',
    'import { initializeUrqlClient, useMutation, useQuery, useSubscription } from "@litsx/urql";',
    "",
    "export const ViewerQuery = gql`query Viewer($value: String!) { viewer(value: $value) { name } }`;",
    "const RenameMutation = gql`mutation Rename($value: String!) { rename(value: $value) { name } }`;",
    "const ViewerSubscription = gql`subscription ViewerChanged($value: String!) { viewerChanged(value: $value) { name } }`;",
    "",
    'if (typeof document?.getElementById === "function") {',
    '  const element = document.getElementById("__LITSX_URQL_DATA__");',
    "  const initialState = element?.textContent ? JSON.parse(element.textContent) : undefined;",
    "  globalThis.__URQL_HYDRATED_KEYS__ = Object.keys(initialState ?? {});",
    "  const cache = ssrExchange({ isClient: true, initialState });",
    "  globalThis.__URQL_FETCH_COUNT__ = 0;",
    "  initializeUrqlClient(createClient({",
    '    url: "/graphql",',
    "    exchanges: [cacheExchange, cache, fetchExchange],",
    "    async fetch(input, init) {",
    "      globalThis.__URQL_FETCH_COUNT__ += 1;",
    "      const requestUrl = new URL(input instanceof Request ? input.url : String(input), location.href);",
    "      const body = init?.body ? JSON.parse(String(init.body)) : {};",
    '      const urlVariables = JSON.parse(requestUrl.searchParams.get("variables") ?? "{}");',
    '      const value = String(body.variables?.value ?? urlVariables.value ?? "missing");',
    "      return new Response(JSON.stringify({ data: { viewer: { name: `browser:${value}` } } }), {",
    '        headers: { "content-type": "application/json" },',
    "      });",
    "    },",
    "  }));",
    "}",
    "",
    "export default function UrqlProbe({ initialName, value }) {",
    "  const [queryState, reexecute] = useQuery({ query: ViewerQuery, variables: { value } });",
    "  const [mutationState] = useMutation({ mutation: RenameMutation });",
    "  const [subscriptionState] = useSubscription({",
    "    pause: true,",
    "    subscription: ViewerSubscription,",
    "    variables: { value },",
    "  });",
    "  return (",
    '    <section data-mutation-fetching={String(mutationState.fetching)} data-subscription-fetching={String(subscriptionState.fetching)}>',
    '      <output>{queryState.data?.viewer?.name ?? initialName}</output>',
    '      <button on:click={() => reexecute({ requestPolicy: "network-only" })}>refresh</button>',
    "    </section>",
    "  );",
    "}",
    "",
  ].join("\n"));
  await fs.writeFile(path.join(projectRoot, "app", "page.jsx"), [
    'import { executeQuery } from "@litsx/urql";',
    'import UrqlProbe, { ViewerQuery } from "./urql-probe.jsx";',
    "",
    'export const routeConfig = { cache: "dynamic" };',
    "export default async function HomePage({ searchParams }) {",
    '  const value = String(searchParams.value ?? "default");',
    '  const result = await executeQuery(ViewerQuery, { value }, { requestPolicy: "network-only" });',
    '  return <main><UrqlProbe initialName={result.data?.viewer?.name ?? "missing"} value={value} /></main>;',
    "}",
    "",
  ].join("\n"));
}

function readUrqlData(html) {
  const match = html.match(/<script type="application\/json" id="__LITSX_URQL_DATA__">([\s\S]*?)<\/script>/);
  if (!match) throw new Error("Missing __LITSX_URQL_DATA__ payload");
  return JSON.parse(match[1]);
}

test("URQL request scopes, production identity, and browser hydration stay isolated", async ({ page }, testInfo) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evolit-urql-browser-"));
  const projectRoot = path.join(tempRoot, "app");
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await writeUrqlFixture(projectRoot);
    await page.addInitScript({
      path: path.join(
        frameworkNodeModules,
        "@webcomponents",
        "scoped-custom-element-registry",
        "scoped-custom-element-registry.min.js",
      ),
    });

    for (const [index, mode] of ["dev", "production"].entries()) {
      let buildOutput = "";
      if (mode === "production") {
        buildOutput = await runCli(projectRoot, "build");
        expect(buildOutput).not.toMatch(/Circular chunk:.*vendor-(?:litsx|misc)/i);
      }

      const port = 4900 + (testInfo.workerIndex * 4) + index;
      const origin = `http://127.0.0.1:${port}`;
      const child = spawn(
        process.execPath,
        [path.join(frameworkRoot, "src", "cli.js"), mode === "dev" ? "dev" : "start", "--port", String(port)],
        { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] },
      );
      let serverOutput = "";
      child.stdout.on("data", (chunk) => { serverOutput += String(chunk); });
      child.stderr.on("data", (chunk) => { serverOutput += String(chunk); });

      try {
        await waitForServer(`${origin}/?value=ready`);
        const [firstResponse, secondResponse] = await Promise.all([
          fetch(`${origin}/?value=one`),
          fetch(`${origin}/?value=two`),
        ]);
        const [firstHtml, secondHtml] = await Promise.all([
          firstResponse.text(),
          secondResponse.text(),
        ]);
        expect(firstResponse.status).toBe(200);
        expect(secondResponse.status).toBe(200);
        expect(firstResponse.headers.get("x-urql-resource")).toBe("one");
        expect(secondResponse.headers.get("x-urql-resource")).toBe("two");
        const firstData = JSON.stringify(readUrqlData(firstHtml));
        const secondData = JSON.stringify(readUrqlData(secondHtml));
        expect(firstData).toContain("server:one");
        expect(firstData).not.toContain("server:two");
        expect(secondData).toContain("server:two");
        expect(secondData).not.toContain("server:one");

        await page.goto(`${origin}/?value=hydrate`, { waitUntil: "networkidle" });
        expect(pageErrors).toEqual([]);
        expect(await page.evaluate(() => globalThis.__URQL_FETCH_COUNT__)).toBe(0);
        expect(await page.evaluate(() => globalThis.__URQL_HYDRATED_KEYS__.length)).toBeGreaterThan(0);
        await expect(page.locator("urql-probe output")).toHaveText("server:hydrate");
        await expect(page.locator("urql-probe section")).toHaveAttribute("data-mutation-fetching", "false");
        await expect(page.locator("urql-probe section")).toHaveAttribute("data-subscription-fetching", "false");
        await page.locator("urql-probe button").click();
        await expect.poll(() => page.evaluate(() => globalThis.__URQL_FETCH_COUNT__)).toBe(1);
        await expect(page.locator("urql-probe output")).toHaveText("browser:hydrate");
        expect(pageErrors).toEqual([]);
        expect(serverOutput).not.toMatch(/Circular chunk:.*vendor-(?:litsx|misc)/i);
      } finally {
        if (child.exitCode === null) {
          child.kill();
          await once(child, "exit");
        }
      }
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
