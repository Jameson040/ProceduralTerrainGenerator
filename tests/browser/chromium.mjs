/**
 * Chromium resolution for the visual tests.
 *
 * 1. If a Playwright/Chrome binary is already present, use it.
 * 2. Otherwise use the Chromium bundled with the `@sparticuz/chromium` npm
 *    package (no network needed at test time) and synthesise the few NSS
 *    shared libraries it links against, which sandbox images often lack.
 *
 * Returns { executablePath, args, env } for puppeteer/Playwright.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const stubDir = join(tmpdir(), "terrain-nss-stub");

const NSS_PREFIX = /^(PR_|PL_|PLA_|NSS|NSSUTIL|SEC|SECITEM|PK11|CERT|VFY|HASH|SSL_)/;

/** Build libnss3 / libnssutil3 / libnspr4 stubs exporting what Chromium imports. */
export function ensureNssStubs(binary) {
  if (existsSync(join(stubDir, "libnss3.so")) && existsSync(join(stubDir, "libnspr4.so"))) return stubDir;
  const dump = execFileSync("readelf", ["--dyn-syms", "-W", binary], { encoding: "utf8" });
  const versioned = new Map();
  const plain = new Set();
  for (const line of dump.split("\n")) {
    if (!line.includes(" UND ")) continue;
    for (const token of line.split(/\s+/)) {
      if (!token.includes("@")) {
        if (NSS_PREFIX.test(token)) plain.add(token);
        continue;
      }
      const [sym, ver] = token.split("@");
      if (ver.startsWith("GLIBC") || ver.startsWith("GCC")) continue;
      if (!NSS_PREFIX.test(sym)) continue;
      if (!versioned.has(ver)) versioned.set(ver, new Set());
      versioned.get(ver).add(sym);
    }
  }
  const symbols = new Set([...plain]);
  for (const set of versioned.values()) for (const s of set) symbols.add(s);
  const source = ["void __stub(void){}", ...[...symbols].map(s => `void ${s}(void){}`)].join("\n") + "\n";
  const versionedScript = [...versioned.entries()]
    .map(([ver, syms]) => `${ver} { global: ${[...syms].map(s => `${s};`).join(" ")} local: *; };`).join("\n") + "\n";
  const plainScript = `{ global: ${[...plain].map(s => `${s};`).join(" ")} local: *; };\n`;
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(join(stubDir, "stub.c"), source);
  writeFileSync(join(stubDir, "versioned.map"), versionedScript);
  writeFileSync(join(stubDir, "plain.map"), plainScript);
  const build = (lib, script) => execFileSync("gcc", ["-shared", "-fPIC", "-o", join(stubDir, lib),
    `-Wl,-soname,${lib}`, `-Wl,--version-script=${join(stubDir, script)}`, join(stubDir, "stub.c")]);
  build("libnss3.so", "versioned.map");
  build("libnssutil3.so", "versioned.map");
  build("libnspr4.so", "plain.map");
  return stubDir;
}

/** @returns {Promise<{executablePath: string, args: string[], env: Record<string,string>}>} */
export async function chromiumSpec() {
  const args = ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader", "--disable-gpu-sandbox", "--hide-scrollbars", "--mute-audio"];
  const bundled = process.env.TERRAIN_CHROMIUM;
  if (bundled && existsSync(bundled)) {
    return { executablePath: bundled, args, env: { ...process.env, LD_LIBRARY_PATH: ensureNssStubs(bundled) } };
  }
  const { default: chromium } = await import("@sparticuz/chromium");
  const executablePath = await chromium.executablePath();
  const libs = ensureNssStubs(executablePath);
  return {
    executablePath,
    args: [...args, ...chromium.args.filter(a => !a.startsWith("--use-gl") && !a.startsWith("--use-angle"))],
    env: { ...process.env, LD_LIBRARY_PATH: [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") },
  };
}
