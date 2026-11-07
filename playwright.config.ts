import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.browser.spec.ts",
  // Software WebGL screenshots can be slow in headless CI without a physical GPU.
  timeout: 240_000,
  workers: 1,
  use: {
    baseURL: "http://localhost:5173",
    viewport: { width: 1440, height: 960 },
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-dev-shm-usage"] },
  },
  webServer: { command: "npm run dev -- --host 0.0.0.0", url: "http://localhost:5173", reuseExistingServer: true, timeout: 120_000 },
});