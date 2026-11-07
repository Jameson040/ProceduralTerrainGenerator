/**
 * Water appearance settings and the per-vertex colour/alpha field the renderers
 * share. Water stays a separate layer: nothing here touches terrain heights.
 *
 * The colour comes from the real carved depth of the water body, so lakes read
 * as deep bowls and rivers read as shallow channels with the bed visible —
 * without a single extra draw call or texture fetch.
 */
import type { TerrainData } from "./types";

export interface WaterVisualSettings {
  /** Deep-water opacity, 0.2 .. 1. */
  opacity: number;
  /** Shallow lake colour (sRGB 0..1). */
  lake_shallow: [number, number, number];
  /** Deep lake colour. */
  lake_deep: [number, number, number];
  /** Shallow river colour. */
  river_shallow: [number, number, number];
  /** Deep river colour. */
  river_deep: [number, number, number];
  /** Depth (metres) at which the water reaches its deep colour. */
  depth_scale_m: number;
  /** Surface motion amount, 0 = still. */
  motion: number;
  /** Metres per wave tile; keeps ripples the same size in every chunk. */
  wave_scale_m: number;
  /** Specular sharpness of the sun highlight. */
  gloss: number;
}

export const defaultWaterVisual = (): WaterVisualSettings => ({
  opacity: 0.86,
  lake_shallow: [0.44, 0.7, 0.66],
  lake_deep: [0.1, 0.3, 0.42],
  river_shallow: [0.46, 0.68, 0.6],
  river_deep: [0.11, 0.32, 0.36],
  depth_scale_m: 2.2,
  motion: 0.35,
  wave_scale_m: 14,
  gloss: 0.72,
});

const smooth = (edge0: number, edge1: number, x: number): number => {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

const mix = (a: readonly number[], b: readonly number[], t: number): [number, number, number] => [
  a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t,
];

/** Colour + opacity for one water vertex. `river` is 0 lake .. 1 river. */
export function waterColor(depth: number, river: number, s: WaterVisualSettings): [number, number, number, number] {
  const k = smooth(0, Math.max(0.1, s.depth_scale_m), Math.max(0, depth));
  const shallow = mix(s.lake_shallow, s.river_shallow, river);
  const deep = mix(s.lake_deep, s.river_deep, river);
  const [r, g, b] = mix(shallow, deep, k);
  // The two tints above are authored in sRGB; renderers consume linear colour.
  // Shallow water is clearer so the riverbed/lakebed stays readable.
  const alpha = s.opacity * (0.5 + 0.5 * k) * (1 - 0.12 * river);
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b), alpha];
}

/** Depth (m) and lake/river mix at a fractional grid coordinate. */
export function waterSample(t: TerrainData, x: number, z: number): { depth: number; river: number; mask: number } {
  const w = t.width, d = t.depth;
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const x1 = Math.min(w - 1, x0 + 1), z1 = Math.min(d - 1, z0 + 1);
  const fx = x - x0, fz = z - z0;
  const sample = (arr: Float32Array | Uint8Array | undefined, ix: number, iz: number) => (arr ? arr[iz * w + ix] : 0);
  const bilerp = (arr: Float32Array | Uint8Array | undefined) => {
    const a = sample(arr, x0, z0) * (1 - fx) + sample(arr, x1, z0) * fx;
    const b = sample(arr, x0, z1) * (1 - fx) + sample(arr, x1, z1) * fx;
    return a * (1 - fz) + b * fz;
  };
  const depth = bilerp(t.water?.depth);
  const lake = bilerp(t.water?.lake_mask);
  const rive = bilerp(t.water?.river_mask);
  const total = lake + rive;
  return { depth, river: total > 1e-6 ? rive / total : 0, mask: bilerp(t.water?.mask) };
}

/** Water depth extremes, for the UI legend and tests. */
export function waterDepthStats(t: TerrainData): { max: number; mean: number; cells: number } {
  const depth = t.water?.depth, mask = t.water?.mask;
  if (!depth || !mask) return { max: 0, mean: 0, cells: 0 };
  let max = 0, sum = 0, cells = 0;
  for (let i = 0; i < depth.length; i++) {
    if (!mask[i]) continue;
    cells++;
    sum += depth[i];
    if (depth[i] > max) max = depth[i];
  }
  return { max, mean: cells ? sum / cells : 0, cells };
}
