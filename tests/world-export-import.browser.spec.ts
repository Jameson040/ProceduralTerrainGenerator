import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";

// One scenario per file: each spec file gets its own browser, so a heavy WebGL
// world (or a wedged software-GL renderer) cannot take the next test down with it.
test("a single exported chunk loads independently; a ZIP restores the complete world", async ({ page }) => {
  await page.goto("/");
  const canvas = page.getByLabel("Chunked terrain viewport");
  await expect(canvas).toHaveAttribute("data-chunks", "16", { timeout: 90_000 });
  await page.getByTestId("world-import").setInputFiles("artifacts/phase3/chunks/c_2_1.json");
  await expect(canvas).toHaveAttribute("data-chunks", "1", { timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Export world ZIP", exact: true })).toBeDisabled();
  await page.getByTestId("world-import").setInputFiles("artifacts/phase3/chunks/c_1_1.json");
  await expect(canvas).toHaveAttribute("data-chunks", "2", { timeout: 60_000 });
  await expect(page.getByTestId("world-notice")).toContainText("2 / 16 individual chunk files loaded");
  await page.getByTestId("world-import").setInputFiles("artifacts/phase3/world.zip");
  await expect(canvas).toHaveAttribute("data-chunks", "16", { timeout: 60_000 });
  await page.getByRole("button", { name: "Inspect seams", exact: true }).click();
  await expect(page.getByTestId("seam-report")).toContainText("Shared boundaries verified");
});
