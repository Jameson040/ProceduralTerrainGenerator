/**
 * Terrain material system (renderer-agnostic).
 *
 * Materials are derived from terrain properties, never placed randomly:
 * normalised elevation, slope, surface orientation (aspect), flow accumulation,
 * curvature, proximity to water and the carved river-bed mask. Every rule is a
 * smoothstep blend of continuous inputs, so neighbouring materials always fade
 * into each other instead of meeting at a band edge.
 *
 * The same formulas are mirrored in terrain/materials.py so both backends
 * describe the same ground.
 *
 * Extension points (Phase 4 requirement 4): append a definition to MATERIALS
 * (or call `registerMaterial`) with a `weight(ctx)` function. Nothing in the
 * generator, the mesher or the exporters needs to change: materials are a
 * derived field over the existing source grid, and the shaders blend whatever
 * channels the registry provides (up to MAX_MATERIALS). Snow and sand are
 * already registered and drive the same code path a future biome would.
 */
import type { TerrainData } from "./types";
import { fbm } from "./noise";

export const MATERIAL_FORMAT_VERSION = 1;
export const MAX_MATERIALS = 8;

export type MaterialId = "sand" | "gravel" | "grass" | "dry_grass" | "soil" | "rock" | "snow";

export interface MaterialSettings {
  /** Normalised slope (0 flat .. 1 vertical) where bare rock starts to win. */
  rock_slope: number;
  /** Metres above the local water surface that keep sand. */
  sand_shore_m: number;
  /** Normalised elevation where snow starts to settle. */
  snow_line: number;
  /** 0 = pure grass, 1 = dry grass / soil dominance on gentle ground. */
  soil_bias: number;
  /** Strength of low-frequency procedural variation (still world-space, smooth). */
  variation: number;
  /** World metres per texture tile; identical in every chunk by construction. */
  texture_scale_m: number;
  /** 0 = vertex colours only, 1 = triplanar detail, 2 = detail + macro + rock sheen. */
  quality: 0 | 1 | 2;
}

export const defaultMaterialSettings = (): MaterialSettings => ({
  rock_slope: 0.30,
  sand_shore_m: 5.0,
  snow_line: 0.78,
  soil_bias: 0.35,
  variation: 0.55,
  texture_scale_m: 9.0,
  quality: 2,
});

/** Everything a material rule may read. All values are already normalised. */
export interface MaterialSample {
  /** 0..1 across the world's height range. */
  elevation: number;
  /** Metres above the local water surface (0 when submerged). */
  height_above_water: number;
  /** 0 flat .. 1 vertical. */
  slope: number;
  /** Normal .Z, -1 north .. +1 south (world Z grows south). */
  aspect: number;
  /** log-normalised flow accumulation, 0..1. */
  flow: number;
  /** Signed curvature: >0 ridge / convex, <0 hollow. Normalised by relief. */
  curvature: number;
  /** 1 on a carved river bed or bank. */
  river_bed: number;
  /** 1 one cell from the waterline, decaying fast inland. */
  wetness: number;
  /** 1 on ground below the local water surface (lakebed / riverbed). */
  submerged: number;
  /** Smooth world-space variation noise, -1..1 (two octaves). */
  variation: number;
  /** -1..1 finer world-space noise for mottling. */
  detail: number;
}

export interface MaterialDef {
  id: MaterialId;
  label: string;
  /** sRGB-ish albedo used for vertex colours and the debug legend. */
  albedo: [number, number, number];
  /** 0 glossy .. 1 rough. */
  roughness: number;
  /** Specular strength hint for the renderers (rock and wet gravel are shinier). */
  specular: number;
  /** Raw, unnormalised weight. Values above 0 blend in. */
  weight: (s: MaterialSample, m: MaterialSettings) => number;
}

/** sRGB -> linear. Renderers light in linear space, so exported colours are linear. */
export const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

const smooth = (edge0: number, edge1: number, x: number): number => {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

export const MATERIALS: MaterialDef[] = [
  {
    id: "sand",
    label: "Sand",
    albedo: [0.78, 0.71, 0.55],
    roughness: 0.82,
    specular: 0.06,
    // Beaches: low, gentle ground within a few metres of the waterline.
    weight: (s, m) =>
      (1 - s.submerged) *
      (1 - smooth(m.sand_shore_m * 0.45, m.sand_shore_m, s.height_above_water)) *
      (1 - smooth(0.22, 0.5, s.slope)) *
      // A beach needs an actual shoreline: the damp halo, not dry inland ground.
      smooth(0.1, 0.42, s.wetness),
  },
  {
    id: "gravel",
    label: "Gravel",
    albedo: [0.55, 0.53, 0.48],
    roughness: 0.74,
    specular: 0.1,
    // Coarse material where water moves fastest: channel beds, banks, scree fans.
    weight: (s) =>
      0.85 * s.river_bed +
      // Submerged ground is silt/pebble rather than meadow, and it stays visible
      // through shallow water instead of turning the lake into a sand pit.
      0.8 * s.submerged +
      0.55 * smooth(0.45, 0.95, s.flow) * (1 - smooth(0.42, 0.7, s.slope)) +
      0.35 * smooth(0.1, 0.35, s.curvature) * (1 - smooth(0.3, 0.6, s.slope)) +
      0.12 * s.detail,
  },
  {
    id: "grass",
    label: "Grass",
    albedo: [0.33, 0.47, 0.21],
    roughness: 0.9,
    specular: 0.03,
    // Lowland meadow: gentle, low, and away from bare rock.
    weight: (s, m) =>
      (1 - s.submerged) *
      (1 - smooth(0.42, 0.72, s.elevation)) *
      (1 - smooth(0.24, 0.52, s.slope)) *
      (1 - 0.8 * s.river_bed) *
      (1 - 0.7 * m.soil_bias * smooth(-0.2, 0.5, s.variation)) *
      (1 + 0.25 * s.detail),
  },
  {
    id: "dry_grass",
    label: "Dry grass",
    albedo: [0.56, 0.55, 0.31],
    roughness: 0.92,
    specular: 0.03,
    // South-facing and higher slopes dry out first.
    weight: (s, m) =>
      (1 - s.submerged) *
      smooth(0.25, 0.6, s.elevation) *
      (1 - smooth(0.3, 0.62, s.slope)) *
      (0.35 + 0.65 * smooth(-0.3, 0.6, s.aspect)) *
      (0.45 + 0.55 * m.soil_bias) *
      (1 - 0.6 * s.river_bed),
  },
  {
    id: "soil",
    label: "Soil",
    albedo: [0.4, 0.3, 0.21],
    roughness: 0.88,
    specular: 0.04,
    // Exposed soil sits in the grass -> rock transition and in hollows.
    weight: (s, m) =>
      (1 - s.submerged) *
      smooth(0.18, 0.34, s.slope) *
      (1 - smooth(0.5, 0.78, s.slope)) *
      (0.35 + 0.65 * m.soil_bias) *
      (1 - 0.5 * s.river_bed) *
      (0.6 + 0.4 * smooth(0.05, 0.5, -s.curvature)),
  },
  {
    id: "rock",
    label: "Rock",
    albedo: [0.45, 0.43, 0.41],
    roughness: 0.58,
    specular: 0.22,
    // Steep faces, ridges and altitude: stone wins where soil cannot sit.
    weight: (s, m) => {
      const steep = smooth(m.rock_slope * 0.72, m.rock_slope * 1.25, s.slope);
      const cliff = smooth(0.12, 0.42, s.curvature);
      const high = smooth(0.42, 0.82, s.elevation);
      // High ground exposes stone even where it is not vertical, and ridges above
      // the tree/grass line read as rock rather than meadow.
      const alpine = high * smooth(0.08, 0.34, s.slope);
      return steep * (0.75 + 0.35 * high) + 0.45 * cliff * (0.4 + 0.6 * steep) + 0.75 * alpine;
    },
  },
  {
    id: "snow",
    label: "Snow",
    albedo: [0.94, 0.95, 0.98],
    roughness: 0.45,
    specular: 0.14,
    // Settles above the snow line on ground flat enough to hold it.
    weight: (s, m) => {
      const line = m.snow_line + 0.06 * s.variation;
      return (1 - s.submerged) * smooth(line - 0.1, line + 0.07, s.elevation) * (1 - smooth(0.5, 0.82, s.slope));
    },
  },
];

/** Registered materials, index = channel in the weights field. */
const registry: MaterialDef[] = [...MATERIALS];

/** Add a material at runtime (snow/sand/biome extensions) without touching generation. */
export function registerMaterial(def: MaterialDef): number {
  if (registry.length >= MAX_MATERIALS) throw new Error(`At most ${MAX_MATERIALS} materials are supported.`);
  const index = registry.findIndex(m => m.id === def.id);
  if (index >= 0) { registry[index] = def; return index; }
  registry.push(def);
  return registry.length - 1;
}

export const materialIds = (): MaterialId[] => registry.map(m => m.id);
export const materialDefs = (): readonly MaterialDef[] => registry;

export interface MaterialField {
  /** Channel order; index in this array is the channel in `weights`. */
  ids: MaterialId[];
  count: number;
  /** n * count normalised weights, row-major by sample. */
  weights: Float32Array;
  /** n * 3 blended albedo (what the vertex colours carry). */
  albedo: Float32Array;
  settings: MaterialSettings;
}

export interface MaterialStats {
  samples: number;
  /** Mean weight per material over the whole world. */
  fractions: Record<string, number>;
  /** Dominant material share inside plains / hills / mountains. */
  bands: { plains: Record<string, number>; hills: Record<string, number>; mountains: Record<string, number> };
  /** Largest per-cell weight change between 4-neighbours (cliffs score high). */
  max_neighbour_jump: number;
  /** Median / 95th percentile neighbour weight change: the band detector. */
  jump_p50: number;
  jump_p95: number;
  /** Fraction of cells whose dominant material differs from a neighbour's. */
  transition_fraction: number;
  /** Rock share above 0.45 normalised slope, and grass share below 0.15. */
  rock_on_steep: number;
  grass_on_flat: number;
  classes: number;
}

/** Deterministic world-space normals for a height grid (same convention as the mesher). */
export function materialNormals(h: Float32Array, w: number, d: number, sx: number, sz: number): Float32Array {
  const out = new Float32Array(w * d * 3);
  for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) {
    const l = Math.max(0, x - 1), r = Math.min(w - 1, x + 1);
    const n = Math.max(0, z - 1), s = Math.min(d - 1, z + 1);
    const nx = -(h[z * w + r] - h[z * w + l]) / ((r - l) * sx);
    const nz = -(h[s * w + x] - h[n * w + x]) / ((s - n) * sz);
    const len = Math.hypot(nx, 1, nz), i = (z * w + x) * 3;
    out[i] = nx / len || 0; out[i + 1] = 1 / len; out[i + 2] = nz / len || 0;
  }
  return out;
}

/**
 * Material weights + blended albedo for every source sample.
 * O(n · materials) with two noise evaluations per sample; no allocation per cell.
 */
export function computeMaterialField(t: TerrainData, settings?: Partial<MaterialSettings>, normals?: Float32Array): MaterialField {
  const m: MaterialSettings = { ...defaultMaterialSettings(), ...settings };
  const w = t.width, d = t.depth, n = w * d;
  const sx = t.spacing_x ?? t.cell_size, sz = t.spacing_z ?? t.cell_size;
  const nrm = normals ?? materialNormals(t.heights, w, d, sx, sz);
  const ids = materialIds(), count = ids.length;
  const weights = new Float32Array(n * count);
  const albedo = new Float32Array(n * 3);

  const min = t.metadata?.min_height ?? Infinity, max = t.metadata?.max_height ?? -Infinity;
  let lo = min, hi = max;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
    lo = Infinity; hi = -Infinity;
    for (let i = 0; i < n; i++) { if (t.heights[i] < lo) lo = t.heights[i]; if (t.heights[i] > hi) hi = t.heights[i]; }
  }
  const relief = Math.max(1e-3, hi - lo);
  const level = t.water?.level ?? lo;
  const mask = t.water?.mask, surface = t.water?.surface;
  const bedMask = t.layers?.river_bed_mask;
  const flow = t.layers?.flow_accumulation;
  let maxFlow = 1;
  if (flow) for (let i = 0; i < n; i++) if (flow[i] > maxFlow) maxFlow = flow[i];
  const logMaxFlow = Math.log1p(maxFlow);

  // Shore halo: one cell past the waterline keeps a damp, sandy feel.
  const wet = new Float32Array(n);
  if (mask) for (let i = 0; i < n; i++) wet[i] = mask[i] ? 1 : 0;
  // Shore halo: 0.55 one cell inland, ~0.3 two cells inland, then nothing.
  const haloRing = new Float32Array(wet);
  for (let pass = 0; pass < 2; pass++) {
    const prev = haloRing.slice();
    for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) {
      const i = z * w + x;
      if (prev[i] >= 0.999) continue;
      let best = 0;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, z > 0 ? i - w : -1, z < d - 1 ? i + w : -1])
        if (j >= 0 && prev[j] > best) best = prev[j];
      haloRing[i] = Math.max(prev[i], best * 0.55);
    }
  }

  // One 3x3 blur turns the two-cell halo into a gradual two-cell gradient, so a
  // beach never steps from nothing to a full sand cell across one edge.
  const haloBlur = new Float32Array(n);
  for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) {
    let sum = 0, count = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const zz = z + dz, xx = x + dx;
      if (zz < 0 || xx < 0 || zz >= d || xx >= w) continue;
      sum += haloRing[zz * w + xx]; count++;
    }
    haloBlur[z * w + x] = sum / count;
  }
  const seed = (t.settings?.seed ?? 0) >>> 0;
  const varScale = 1 / 140, detailScale = 1 / 26;
  const sample: MaterialSample = {
    elevation: 0, height_above_water: 0, slope: 0, aspect: 0, flow: 0,
    curvature: 0, river_bed: 0, wetness: 0, submerged: 0, variation: 0, detail: 0,
  };

  for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) {
    const k = z * w + x;
    const h = t.heights[k];
    const wx = t.origin_x + x * sx, wz = t.origin_z + z * sz;
    const ny = nrm[k * 3 + 1];
    const localSurface = mask?.[k] && surface ? surface[k] : level;
    const above = h - localSurface;

    // Curvature: this sample minus the mean of its 4-neighbourhood, per metre.
    const hl = t.heights[z * w + Math.max(0, x - 1)], hr = t.heights[z * w + Math.min(w - 1, x + 1)];
    const hn = t.heights[Math.max(0, z - 1) * w + x], hs = t.heights[Math.min(d - 1, z + 1) * w + x];
    const laplacian = (hl + hr + hn + hs - 4 * h) / (2 * (sx + sz));

    sample.elevation = Math.min(1, Math.max(0, (h - lo) / relief));
    sample.height_above_water = above;
    sample.slope = Math.min(1, Math.max(0, 1 - ny));
    sample.aspect = nrm[k * 3 + 2];
    sample.flow = flow ? Math.min(1, Math.log1p(flow[k]) / logMaxFlow) : 0;
    sample.curvature = Math.max(-1, Math.min(1, laplacian / (relief * 0.08)));
    sample.river_bed = bedMask ? Math.min(1, bedMask[k]) : 0;
    sample.wetness = haloBlur[k];
    // Smooth 0..1 submerged flag (soft shoreline, no hard underwater edge).
    sample.submerged = smooth(0.6, -0.6, above);
    // fbm already returns ~[-1, 1] in both backends.
    sample.variation = fbm(wx * varScale, wz * varScale, seed ^ 0x9e37, 2);
    sample.detail = fbm(wx * detailScale, wz * detailScale, seed ^ 0x51ed, 2);

    let total = 0;
    for (let c = 0; c < count; c++) {
      const v = registry[c].weight(sample, m) * (1 + 0.35 * m.variation * sample.variation);
      const clamped = Math.max(0, Number.isFinite(v) ? v : 0);
      weights[k * count + c] = clamped;
      total += clamped;
    }
    // Normalise; a fully flat distribution means "nothing matched" -> grass.
    const inv = total > 1e-6 ? 1 / total : 0;
    let r = 0, g = 0, b = 0;
    for (let c = 0; c < count; c++) {
      const v = total > 1e-6 ? weights[k * count + c] * inv : (c === 2 ? 1 : 0);
      weights[k * count + c] = v;
      const a = registry[c].albedo;
      r += a[0] * v; g += a[1] * v; b += a[2] * v;
    }
    // Registry albedos are authored in sRGB; the field is stored linear.
    albedo[k * 3] = srgbToLinear(r); albedo[k * 3 + 1] = srgbToLinear(g); albedo[k * 3 + 2] = srgbToLinear(b);
  }

  return { ids, count, weights, albedo, settings: m };
}

/** Distribution + transition metrics used by the tests and the debug panel. */
export function materialStats(t: TerrainData, field: MaterialField, normals?: Float32Array): MaterialStats {
  const w = t.width, d = t.depth, n = w * d, count = field.count;
  const sx = t.spacing_x ?? t.cell_size, sz = t.spacing_z ?? t.cell_size;
  const nrm = normals ?? materialNormals(t.heights, w, d, sx, sz);
  const blank = () => Object.fromEntries(field.ids.map(id => [id, 0])) as Record<string, number>;
  const fractions = blank(), plains = blank(), hills = blank(), mountains = blank();
  const bandCount = { plains: 0, hills: 0, mountains: 0 };
  let maxJump = 0, transitions = 0, pairs = 0, rockSteep = 0, steepCells = 0, grassFlat = 0, flatCells = 0;
  const jumps: number[] = [];
  const dominant = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    let best = 0, bestV = -1;
    for (let c = 0; c < count; c++) {
      const v = field.weights[k * count + c];
      fractions[field.ids[c]] += v;
      if (v > bestV) { bestV = v; best = c; }
    }
    dominant[k] = best;
    const slope = Math.min(1, Math.max(0, 1 - nrm[k * 3 + 1]));
    const band = slope < 0.16 ? "plains" : slope < 0.4 ? "hills" : "mountains";
    bandCount[band]++;
    const target = band === "plains" ? plains : band === "hills" ? hills : mountains;
    for (let c = 0; c < count; c++) target[field.ids[c]] += field.weights[k * count + c];
    if (slope > 0.45) { steepCells++; rockSteep += field.weights[k * count + field.ids.indexOf("rock")]; }
    if (slope < 0.15) { flatCells++; grassFlat += field.weights[k * count + field.ids.indexOf("grass")]; }
    const x = k % w, z = (k - x) / w;
    const masked = t.water?.mask;
    for (const j of [x > 0 ? k - 1 : -1, z > 0 ? k - w : -1]) {
      if (j < 0) continue;
      // Underwater -> dry is a hard physical edge (the waterline). Transitions
      // are measured on dry ground, where a band would actually be visible.
      if (masked && (masked[k] || masked[j])) continue;
      pairs++;
      let jump = 0;
      for (let c = 0; c < count; c++) jump = Math.max(jump, Math.abs(field.weights[k * count + c] - field.weights[j * count + c]));
      if (jump > maxJump) maxJump = jump;
      jumps.push(jump);
      if (dominant[j] !== dominant[k]) transitions++;
    }
  }
  const norm = (o: Record<string, number>, by: number) => {
    const out: Record<string, number> = {};
    for (const id of field.ids) out[id] = by ? o[id] / by : 0;
    return out;
  };
  jumps.sort((a, b) => a - b);
  const pct = (q: number) => (jumps.length ? jumps[Math.min(jumps.length - 1, Math.floor(q * jumps.length))] : 0);
  return {
    samples: n,
    fractions: norm(fractions, n),
    bands: { plains: norm(plains, bandCount.plains), hills: norm(hills, bandCount.hills), mountains: norm(mountains, bandCount.mountains) },
    max_neighbour_jump: maxJump,
    jump_p50: pct(0.5),
    jump_p95: pct(0.95),
    transition_fraction: pairs ? transitions / pairs : 0,
    rock_on_steep: steepCells ? rockSteep / steepCells : 0,
    grass_on_flat: flatCells ? grassFlat / flatCells : 0,
    classes: count,
  };
}

/** Bilinear lookup of one material channel at a fractional grid coordinate. */
export function sampleMaterial(field: MaterialField, w: number, d: number, x: number, z: number, channel: number): number {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const x1 = Math.min(w - 1, x0 + 1), z1 = Math.min(d - 1, z0 + 1);
  const fx = x - x0, fz = z - z0, count = field.count;
  const at = (u: number, v: number) => field.weights[(v * w + u) * count + channel];
  const a = at(x0, z0) * (1 - fx) + at(x1, z0) * fx;
  const b = at(x0, z1) * (1 - fx) + at(x1, z1) * fx;
  return a * (1 - fz) + b * fz;
}

/** Bilinear blended albedo at a fractional grid coordinate. */
export function sampleAlbedo(field: MaterialField, w: number, d: number, x: number, z: number): [number, number, number] {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const x1 = Math.min(w - 1, x0 + 1), z1 = Math.min(d - 1, z0 + 1);
  const fx = x - x0, fz = z - z0;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const at = (u: number, v: number) => field.albedo[(v * w + u) * 3 + c];
    const a = at(x0, z0) * (1 - fx) + at(x1, z0) * fx;
    const b = at(x0, z1) * (1 - fx) + at(x1, z1) * fx;
    out[c] = a * (1 - fz) + b * fz;
  }
  return out;
}

/** Quantise weights to bytes for the export format (and back). */
export function packWeights(field: MaterialField): Uint8Array {
  const out = new Uint8Array(field.weights.length);
  for (let i = 0; i < field.weights.length; i++) out[i] = Math.round(Math.min(1, Math.max(0, field.weights[i])) * 255);
  return out;
}

export function packAlbedo(field: MaterialField): Uint8Array {
  const out = new Uint8Array(field.albedo.length);
  for (let i = 0; i < field.albedo.length; i++) out[i] = Math.round(Math.min(1, Math.max(0, field.albedo[i])) * 255);
  return out;
}

export function unpackField(ids: MaterialId[], weights: ArrayLike<number>, albedo: ArrayLike<number>, settings: MaterialSettings): MaterialField {
  const count = ids.length, w = Float32Array.from(weights as ArrayLike<number>, v => v / 255);
  const a = Float32Array.from(albedo as ArrayLike<number>, v => v / 255);
  return { ids, count, weights: w, albedo: a, settings };
}
