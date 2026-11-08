import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
export const harnessDir = here;

await build({
  entryPoints: [path.join(here, "harness.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  outfile: path.join(here, "harness.bundle.js"),
  logLevel: "warning",
  sourcemap: false,
  define: { "process.env.NODE_ENV": '"production"' },
});
console.log("harness bundled");
