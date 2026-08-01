import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./test", testMatch: "**/*.browser.e2e.js", use: { browserName: "chromium", headless: true } });
