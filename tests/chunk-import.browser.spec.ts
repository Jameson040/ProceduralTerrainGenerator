import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";

// One scenario per file: each spec file gets its own browser, so a heavy WebGL
// world (or a wedged software-GL renderer) cannot take the next test down with it.
test("sixteen independent chunks load into a new WebGL scene with mixed LOD and unbroken water", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  const canvas = page.getByLabel("Chunked terrain viewport");
  await expect(canvas).toHaveAttribute("data-chunks", "16", { timeout: 90_000 });
  const originalScene = await canvas.getAttribute("data-scene-id");
  await page.screenshot({ path: "artifacts/phase3/generated-world.png" });

  const files = readdirSync("artifacts/phase3/chunks").filter(n => n.endsWith(".json")).sort();
  expect(files).toHaveLength(16);
  await page.getByTestId("world-import").setInputFiles(files.map(n => `artifacts/phase3/chunks/${n}`));
  await expect(page.getByTestId("world-notice")).toContainText("16 / 16 individual chunk files loaded", { timeout: 90_000 });
  await expect(canvas).toHaveAttribute("data-chunks", "16");
  expect(await canvas.getAttribute("data-scene-id")).not.toEqual(originalScene);
  await page.waitForTimeout(600);
  const levels = JSON.parse((await canvas.getAttribute("data-lods"))!);
  expect(new Set(Object.values(levels)).size).toBe(3);
  await page.getByRole("button", { name: "Inspect seams", exact: true }).click();
  await expect(page.getByTestId("seam-report")).toContainText("Shared boundaries verified");
  await expect(page.getByTestId("seam-report")).toContainText("24 edges");
  await expect(page.getByTestId("seam-report")).toContainText("position error 0");
  await expect(page.getByTestId("seam-report")).toContainText("normal error 0");
  await page.screenshot({ path: "artifacts/phase3/imported-mixed-lod.png" });

  await page.getByLabel("Chunk debug view").selectOption("lod");
  await page.screenshot({ path: "artifacts/phase3/lod-colors.png" });
  await page.getByLabel("Chunk debug view").selectOption("resolution");
  await page.screenshot({ path: "artifacts/phase3/stitched-wireframe.png" });
  await page.getByLabel("Chunk debug view").selectOption("off");

  await page.getByLabel("Select chunk 1,1", { exact: true }).click();
  await page.getByRole("button", { name: "Unload selected", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-chunks", "15");
  await page.getByRole("button", { name: "Load selected", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-chunks", "16");

  await page.getByLabel("Render LOD").selectOption("2");
  await page.getByRole("button", { name: "Inspect seams", exact: true }).click();
  await expect(page.getByTestId("seam-report")).toContainText("Shared boundaries verified");
  await page.getByRole("button", { name: "Water", exact: true }).click();
  await page.screenshot({ path: "artifacts/phase3/underwater-ground.png" });
  await page.getByRole("button", { name: "Water", exact: true }).click();

  // Riverbed correction: water is separate geometry inside a carved channel.
  const report = page.getByTestId("riverbed-report");
  await expect(report).toContainText("Terrain is incised under every river");
  await expect(report).toHaveAttribute("data-spill-edges", "0");
  expect(Number(await report.getAttribute("data-carved-cells"))).toBeGreaterThan(0);
  for (let i = 0; i < 3; i++) {
    const section = page.getByTestId(`river-section-${i}`);
    await expect(section).toHaveAttribute("data-enclosed", "1");
    await expect(section).toHaveAttribute("data-bed-below-surface", "1");
  }
  await page.screenshot({ path: "artifacts/phase3/river-cross-sections.png" });
  await page.getByRole("button", { name: "Water", exact: true }).click();
  await page.screenshot({ path: "artifacts/phase3/dry-riverbed.png" });
  await page.getByRole("button", { name: "Water", exact: true }).click();

  await page.getByLabel("Visible chunks").selectOption("neighbors");
  await expect(canvas).toHaveAttribute("data-chunks", "9");
  await page.getByLabel("Visible chunks").selectOption("selected");
  await expect(canvas).toHaveAttribute("data-chunks", "1");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export chunk JSON", exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("c_1_1.json");
  await file.saveAs("artifacts/phase3/selected-download.json");
  const exported = JSON.parse(readFileSync("artifacts/phase3/selected-download.json", "utf8"));
  expect(exported.chunk.id).toBe("c_1_1");
  expect(exported.lods).toHaveLength(3);
  expect(exported.source.normals.length).toBe(exported.source.heights.length * 3);
  await page.getByLabel("Visible chunks").selectOption("world");
  await page.getByLabel("Render LOD").selectOption("adaptive");
  await page.getByRole("button", { name: "Frame selected", exact: true }).click();
  await page.screenshot({ path: "artifacts/phase3/boundary-closeup.png" });
  expect(errors).toEqual([]);
});
