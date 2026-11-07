import { test, expect } from "@playwright/test";

// One scenario per file: each spec file gets its own browser, so a heavy WebGL
// world (or a wedged software-GL renderer) cannot take the next test down with it.
test("repartitioning and LOD changes reuse the same processed source world", async ({ page }) => {
  await page.goto("/");
  const canvas = page.getByLabel("Chunked terrain viewport");
  await expect(canvas).toHaveAttribute("data-chunks", "16", { timeout: 90_000 });
  const source = await canvas.getAttribute("data-world-id");
  await page.getByLabel("Chunk width", { exact: true }).fill("512");
  await page.getByLabel("Chunk width", { exact: true }).press("Tab");
  await expect(canvas).toHaveAttribute("data-chunks", "8");
  await expect(canvas).toHaveAttribute("data-world-id", source!);
  await page.getByLabel("Render LOD").selectOption("2");
  await expect(canvas).toHaveAttribute("data-world-id", source!);
  await page.getByRole("button", { name: "Inspect seams", exact: true }).click();
  await expect(page.getByTestId("seam-report")).toContainText("Shared boundaries verified");
});
