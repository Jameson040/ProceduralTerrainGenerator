import { defineConfig } from "@playwright/test";
import { chromiumSpec } from "./tests/browser/chromium.mjs";

// Uses Playwright's own Chromium when it is installed; otherwise falls back to
// the npm-bundled Chromium (plus synthesised NSS stubs) resolved here, so the
// browser suite can run in a sandbox without a browser download.
const spec = await chromiumSpec();

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.browser.spec.ts",
  // Software WebGL screenshots can be slow in headless CI without a physical GPU.
  timeout: 300_000,
  workers: 1,
  use: {
    baseURL: "http://localhost:5173",
    viewport: { width: 1440, height: 960 },
    launchOptions: {
      executablePath: spec.executablePath,
      // `--single-process` (from the bundled headless shell) makes Chromium quit as
      // soon as the last page closes, which kills the browser between spec files.
      args: [...spec.args.filter(a => !["--single-process", "--no-zygote"].includes(a)),
        "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-dev-shm-usage", "--no-sandbox"],
      env: spec.env,
    },
  },
  webServer: { command: "npm run dev -- --host 0.0.0.0", url: "http://localhost:5173", reuseExistingServer: true, timeout: 120_000 },
});
