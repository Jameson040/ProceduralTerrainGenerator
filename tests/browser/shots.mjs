/**
 * Renders every harness view in a real (headless, SwiftShader) Chromium and
 * writes screenshots + a JSON report to artifacts/phase4/.
 *
 *   node tests/browser/shots.mjs            # all views
 *   node tests/browser/shots.mjs under      # one view
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { build } from "esbuild";
import { chromiumSpec } from "./chromium.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const outDir = join(root, "artifacts/phase4");
mkdirSync(outDir, { recursive: true });

const common = { bundle: true, format: "iife", platform: "browser", target: "chrome120", logLevel: "error",
  define: { "process.env.NODE_ENV": '"production"' } };
await build({ ...common, entryPoints: [join(here, "harness.ts")], outfile: join(here, "harness.bundle.js") });
await build({ ...common, entryPoints: [join(here, "matmap.ts")], outfile: join(here, "matmap.bundle.js") });
await build({ ...common, entryPoints: [join(here, "threeHarness.ts")], outfile: join(here, "threeHarness.bundle.js") });

const VIEWS = [
  { name: "materials-overview", query: "view=overview&resolution=257&quality=2" },
  { name: "materials-cliff", query: "view=cliff&resolution=257&quality=2" },
  { name: "materials-vertex-only", query: "view=overview&resolution=257&quality=0" },
  { name: "water-lake", query: "view=lake&resolution=257&quality=2" },
  { name: "water-river", query: "view=river&resolution=257&quality=2" },
  { name: "water-still", query: "view=lake&resolution=257&quality=2&waves=0" },
  { name: "under-terrain", query: "view=under&resolution=257&quality=2" },
  { name: "chunk-seam", query: "view=seam&resolution=257&quality=2&chunk=256&lod=mixed" },
  { name: "lod-consistency", query: "view=overview&resolution=257&quality=2&lod=low" },
  { name: "water-coverage", query: "view=topdown&resolution=257&quality=0&hide=terrain" },
  { name: "water-overview-only", query: "view=overview&resolution=257&quality=0&hide=terrain" },
  { name: "material-map", page: "matmap.html", query: "seed=42&resolution=257", width: 1536, height: 1536, readyFlag: "__mapReady" },
  // Same world, same data, Three.js adapter instead of Babylon.
  { name: "three-overview", page: "three.html", query: "view=overview&resolution=257&quality=2" },
  { name: "three-cliff", page: "three.html", query: "view=cliff&resolution=257&quality=2" },
  { name: "three-lake", page: "three.html", query: "view=lake&resolution=257&quality=2" },
  { name: "three-river", page: "three.html", query: "view=river&resolution=257&quality=2" },
  { name: "three-under", page: "three.html", query: "view=under&resolution=257&quality=2" },
  { name: "three-seam", page: "three.html", query: "view=seam&resolution=257&quality=2&chunk=256&lod=mixed" },
  { name: "three-lod-consistency", page: "three.html", query: "view=overview&resolution=257&quality=2&lod=low" },
];

const only = process.argv.slice(2);
const spec = await chromiumSpec();
const browser = await puppeteer.launch({
  headless: true, executablePath: spec.executablePath, args: spec.args, env: spec.env,
  protocolTimeout: 240_000,
});
const report = [];
try {
  for (const v of VIEWS) {
    if (only.length && !only.some(o => v.name.includes(o))) continue;
    const page = await browser.newPage();
    await page.setViewport({ width: v.width ?? 1280, height: v.height ?? 720, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", e => errors.push(String(e)));
    page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    const url = `file://${join(here, v.page ?? "harness.html")}?${v.query}`;
    await page.goto(url, { waitUntil: "load", timeout: 120_000 });
    const ready = v.readyFlag
      ? `window.${v.readyFlag} === true`
      : "window.__harness && window.__harness.ready === true";
    await page.waitForFunction(ready, { timeout: 240_000 });
    const probe = v.readyFlag ? { note: "2d map" } : await page.evaluate(async () => await window.__harness.render());
    const info = v.readyFlag ? { kind: "2d-map" } : await page.evaluate(() => window.__harness.info());
    await page.screenshot({ path: join(outDir, `${v.name}.png`) });
    report.push({ name: v.name, query: v.query, probe, info, errors });
    console.log(v.readyFlag ? `${v.name}: rendered ${errors.length} errors` :
      `${v.name}: water=${probe.waterFraction.toFixed(3)} sky=${probe.skyFraction.toFixed(3)} land=${probe.landFraction.toFixed(3)} errors=${errors.length}`);
    await page.close();
  }
} finally {
  await browser.close();
}
writeFileSync(join(outDir, "render-report.json"), JSON.stringify(report, null, 2));
console.log(`wrote ${report.length} views to artifacts/phase4`);
