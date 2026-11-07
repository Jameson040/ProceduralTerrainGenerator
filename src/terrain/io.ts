/** JSON interchange (format_version 1) — compatible with terrain/export.py. */
import type { TerrainData, TerrainSettings } from "./types";
import { FORMAT_VERSION, SETTINGS_VERSION, defaultSettings } from "./types";

export function terrainToJSON(t: TerrainData): string {
  const obj: Record<string, unknown> = {
    format_version: FORMAT_VERSION,
    settings: t.settings,
    metadata: t.metadata,
    width: t.width,
    depth: t.depth,
    origin_x: t.origin_x,
    origin_z: t.origin_z,
    cell_size: t.cell_size,
    spacing_x: t.spacing_x ?? t.cell_size,
    spacing_z: t.spacing_z ?? t.cell_size,
    heights: Array.from(t.heights, (v) => Math.round(v * 1000) / 1000),
  };
  if (t.water) {
    const makeMask = (arr: Uint8Array) => {
      let out = "";
      for (let i = 0; i < arr.length; i++) out += arr[i] ? "1" : "0";
      return out;
    };
    obj.water = {
      level: t.water.level,
      mask: makeMask(t.water.mask),
      surface: Array.from(t.water.surface, (v) => Math.round(v * 1000) / 1000),
      depth: Array.from(t.water.depth, (v) => Math.round(v * 1000) / 1000),
      lake_mask: makeMask(t.water.lake_mask),
      river_mask: makeMask(t.water.river_mask),
      lakes: t.water.lakes,
      rivers: t.water.rivers,
    };
  }
  return JSON.stringify(obj);
}

export function terrainFromJSON(text: string): TerrainData {
  const d = JSON.parse(text);
  if (d.format_version !== FORMAT_VERSION) throw new Error(`Unsupported format_version ${d.format_version}`);
  const settings: TerrainSettings = { ...defaultSettings(), ...(d.settings ?? {}) };
  if (settings.settings_version < SETTINGS_VERSION) settings.settings_version = SETTINGS_VERSION;
  const heights = Float32Array.from(d.heights as number[]);
  const total = heights.length;
  const readMask = (str: string | undefined) => {
    const out = new Uint8Array(total);
    if (str) for (let i = 0; i < Math.min(total, str.length); i++) out[i] = str.charCodeAt(i) === 49 ? 1 : 0;
    return out;
  };
  let water = null;
  if (d.water) {
    const level = Number(d.water.level);
    const mask = readMask(d.water.mask);
    const surface = d.water.surface ? Float32Array.from(d.water.surface as number[]) : Float32Array.from(heights, (h, i) => mask[i] ? level : h);
    const depth = d.water.depth ? Float32Array.from(d.water.depth as number[]) : Float32Array.from(heights, (h, i) => mask[i] ? Math.max(0, surface[i] - h) : 0);
    const lakeMask = readMask(d.water.lake_mask);
    const riverMask = readMask(d.water.river_mask);
    if (!d.water.lake_mask) lakeMask.set(mask);
    water = {
      level, mask, surface, depth, lake_mask: lakeMask, river_mask: riverMask,
      lakes: d.water.lakes ?? [], rivers: d.water.rivers ?? [],
    };
  }
  return {
    width: d.width, depth: d.depth, origin_x: d.origin_x, origin_z: d.origin_z, cell_size: d.cell_size,
    spacing_x: d.spacing_x ?? d.cell_size, spacing_z: d.spacing_z ?? d.cell_size,
    heights, settings, water, layers: null,
    metadata: { ...(d.metadata ?? {}), source: "file" },
  };
}

/** 16-bit grayscale PNG-free alternative: raw heightmap as little-endian float32. */
export function heightsToRaw(t: TerrainData): Blob {
  return new Blob([t.heights.buffer as ArrayBuffer], { type: "application/octet-stream" });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
