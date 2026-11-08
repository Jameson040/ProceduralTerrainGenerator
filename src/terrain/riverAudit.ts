/**
 * Riverbed cross-sections and whole-world audits (mirror of terrain/debug.py).
 *
 * The river correction is only credible if the geometry can be inspected, so
 * this module cuts perpendicular sections through several rivers and checks the
 * riverbed-terrain contract:
 *   - surrounding terrain is higher than the riverbed,
 *   - banks rise above the waterline and slope naturally,
 *   - water sits above a real, finite bed,
 *   - terrain exists beneath the entire water surface,
 *   - the carved bed is continuous and mostly walkable.
 */
import type { TerrainData } from "./types";

export interface RiverSection {
  index: number;
  cell: [number, number];
  world: [number, number];
  flow: [number, number];
  rows: number[];
  cols: number[];
  heights: number[];
  surface: (number | null)[];
  wet: boolean[];
  carved: boolean[];
  centerIndex: number;
  bed: number;
  waterSurface: number | null;
  depth: number;
  wetCells: number;
  bedBelowSurface: boolean;
  waterBelowBanks: boolean;
  waterEnclosed: boolean;
  terrainAboveBed: boolean;
  bankSlopeLeft: number;
  bankSlopeRight: number;
  maxBedStep: number;
  maxBedSlope: number;
  allTerrainFinite: boolean;
}

export interface RiverbedReport {
  hasRivers: boolean;
  riverCells: number;
  carvedBedCells: number;
  carvedVolume: number;
  terrainFiniteEverywhere: boolean;
  waterHasTerrainBeneath: boolean;
  bedBelowWaterSurface: boolean;
  positiveWaterDepth: boolean;
  waterSpillEdges: number;
  waterEdgePairs: number;
  bedMin: number | null;
  bedMean: number | null;
  surfaceMin: number | null;
  surfaceMax: number | null;
  maxWaterDepth: number | null;
  meanWaterDepth: number | null;
  bedStepMax: number;
  bedSlopeMedian: number;
  bedSlopeP95: number;
  walkableBedFraction: number;
  gentlySlopedBedFraction: number;
  bedStepCount: number;
  rivers: number;
  sections: RiverSection[];
  sectionsAllEnclosed: boolean;
  sectionsBedBelowSurface: boolean;
  sectionsTerrainAboveBed: boolean;
  sectionsMaxBedSlope: number;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

function flowUnit(t: TerrainData, flat: number): [number, number] {
  const direction = t.layers?.flow_direction;
  if (!direction) return [0, 1];
  const value = direction[flat];
  if (!Number.isFinite(value)) return [0, 1];
  const angle = value * 2 * Math.PI - Math.PI;
  const dc = Math.cos(angle), dr = Math.sin(angle);
  const length = Math.hypot(dr, dc);
  if (length <= 1e-9) return [0, 1];
  return [dr / length, dc / length];
}

function cellAt(t: TerrainData, r: number, c: number): [number, number] | null {
  const rr = Math.floor(r + 0.5), cc = Math.floor(c + 0.5);
  if (rr < 0 || rr >= t.depth || cc < 0 || cc >= t.width) return null;
  return [rr, cc];
}

export function riverSections(t: TerrainData, count = 5, reach = 5): RiverSection[] {
  const water = t.water;
  if (!water || !water.river_mask || !water.river_mask.some(v => v)) return [];
  const river = water.river_mask, wet = water.mask;
  const lake = water.lake_mask;
  const heights = t.heights;
  const surface = water.surface;
  const depth = water.depth;
  const bedLayer = t.layers?.river_bed_mask;

  // Candidate centres: deepest river cells that are not lake surface.
  const candidates: number[] = [];
  for (let i = 0; i < river.length; i++) if (river[i] && !lake[i]) candidates.push(i);
  if (!candidates.length) for (let i = 0; i < river.length; i++) if (river[i]) candidates.push(i);
  candidates.sort((a, b) => depth[b] - depth[a] || a - b);
  const minSep = Math.max(6, Math.min(t.width, t.depth) / 12);
  const picked: [number, number][] = [];
  for (const flat of candidates) {
    const r = Math.floor(flat / t.width), c = flat % t.width;
    if (picked.every(([pr, pc]) => Math.hypot(r - pr, c - pc) >= minSep)) picked.push([r, c]);
    if (picked.length >= count * 8) break;
  }

  const build = (r: number, c: number): RiverSection | null => {
    const flat = r * t.width + c;
    const [dr, dc] = flowUnit(t, flat);
    const perpR = -dc, perpC = dr;
    const rows: number[] = [], cols: number[] = [];
    const profile: number[] = [], profileSurface: (number | null)[] = [], profileWet: boolean[] = [];
    for (let k = -reach; k <= reach; k++) {
      const cell = cellAt(t, r + perpR * k, c + perpC * k);
      if (!cell) continue;
      const [rr, cc] = cell;
      const i = rr * t.width + cc;
      rows.push(rr); cols.push(cc);
      profile.push(heights[i]);
      profileSurface.push(wet[i] ? surface[i] : null);
      profileWet.push(!!wet[i]);
    }
    if (!profile.length) return null;
    const wetIdx = profileWet.map((w, i) => (w ? i : -1)).filter(i => i >= 0);
    const wetHeight = wetIdx.length ? Math.min(...wetIdx.map(i => profile[i])) : NaN;
    const wetSurface = wetIdx.length ? Math.max(...wetIdx.map(i => profileSurface[i] as number)) : NaN;
    const dryLeft = wetIdx.length ? profileWet.map((_, i) => i).filter(i => i < wetIdx[0]) : [];
    const dryRight = wetIdx.length ? profileWet.map((_, i) => i).filter(i => i > wetIdx[wetIdx.length - 1]) : [];
    const bankLeft = dryLeft.length ? Math.max(...dryLeft.map(i => profile[i])) : NaN;
    const bankRight = dryRight.length ? Math.max(...dryRight.map(i => profile[i])) : NaN;
    const banksAbove = !!(wetIdx.length && dryLeft.length && dryRight.length
      && bankLeft > wetSurface + 1e-6 && bankRight > wetSurface + 1e-6);
    const enclosed = !!(wetIdx.length && dryLeft.length && dryRight.length
      && profile[0] > wetSurface + 1e-6 && profile[profile.length - 1] > wetSurface + 1e-6);
    const slopeLeft = wetIdx.length && dryLeft.length
      ? Math.max(0, (profile[wetIdx[0] - 1] - profile[wetIdx[0]]) / t.cell_size) : 0;
    const slopeRight = wetIdx.length && dryRight.length
      ? Math.max(0, (profile[wetIdx[wetIdx.length - 1] + 1] - profile[wetIdx[wetIdx.length - 1]]) / t.cell_size) : 0;
    const bedSteps: number[] = [];
    for (let k = 0; k < wetIdx.length - 1; k++) {
      if (wetIdx[k + 1] === wetIdx[k] + 1) bedSteps.push(Math.abs(profile[wetIdx[k] + 1] - profile[wetIdx[k]]));
    }
    const maxStep = bedSteps.length ? Math.max(...bedSteps) : 0;
    let centerIndex = 0;
    for (let i = 1; i < profile.length; i++) if (profile[i] < profile[centerIndex]) centerIndex = i;
    const spacingX = t.spacing_x ?? t.cell_size, spacingZ = t.spacing_z ?? t.cell_size;
    return {
      index: -1,
      cell: [r, c],
      world: [round3(t.origin_x + c * spacingX), round3(t.origin_z + r * spacingZ)],
      flow: [round3(dr), round3(dc)],
      rows, cols,
      heights: profile.map(round3),
      surface: profileSurface.map(v => (v === null ? null : round3(v))),
      wet: profileWet,
      carved: rows.map((rr, i) => (bedLayer ? !!bedLayer[rr * t.width + cols[i]] : false)),
      centerIndex,
      bed: round3(heights[flat]),
      waterSurface: wet[flat] ? round3(surface[flat]) : null,
      depth: round3(depth[flat]),
      wetCells: wetIdx.length,
      bedBelowSurface: !!(wetIdx.length && wetHeight < wetSurface),
      waterBelowBanks: banksAbove,
      waterEnclosed: enclosed,
      terrainAboveBed: !!(wetIdx.length && bankLeft > wetHeight && bankRight > wetHeight),
      bankSlopeLeft: round3(slopeLeft),
      bankSlopeRight: round3(slopeRight),
      maxBedStep: round3(maxStep),
      maxBedSlope: round3(maxStep / Math.max(t.cell_size, 1e-9)),
      allTerrainFinite: profile.every(Number.isFinite),
    };
  };

  const all: RiverSection[] = [];
  const chosen: RiverSection[] = [];
  for (const [r, c] of picked) {
    const section = build(r, c);
    if (!section) continue;
    all.push(section);
    if (section.waterEnclosed) chosen.push(section);
    if (chosen.length >= count) break;
  }
  for (const section of all) {
    if (chosen.length >= count) break;
    if (!chosen.includes(section)) chosen.push(section);
  }
  chosen.forEach((section, i) => { section.index = i; });
  return chosen;
}

export function auditRiverbeds(t: TerrainData): RiverbedReport {
  const water = t.water;
  const base: RiverbedReport = {
    hasRivers: false, riverCells: 0, carvedBedCells: 0, carvedVolume: 0,
    terrainFiniteEverywhere: false, waterHasTerrainBeneath: false, bedBelowWaterSurface: false,
    positiveWaterDepth: false, waterSpillEdges: 0, waterEdgePairs: 0,
    bedMin: null, bedMean: null, surfaceMin: null, surfaceMax: null,
    maxWaterDepth: null, meanWaterDepth: null, bedStepMax: 0,
    bedSlopeMedian: 0, bedSlopeP95: 0, walkableBedFraction: 0, gentlySlopedBedFraction: 0,
    bedStepCount: 0, rivers: 0, sections: [], sectionsAllEnclosed: false,
    sectionsBedBelowSurface: false, sectionsTerrainAboveBed: false, sectionsMaxBedSlope: 0,
  };
  if (!water || !water.river_mask || !water.river_mask.some(v => v)) return base;

  const w = t.width, d = t.depth;
  const heights = t.heights, river = water.river_mask, lake = water.lake_mask, wet = water.mask;
  const surface = water.surface, depth = water.depth;
  const bedLayer = t.layers?.river_bed_mask;

  let spill = 0, edges = 0, riverCells = 0, bedCells = 0;
  let bedMin = Infinity, bedSum = 0;
  let surfaceMin = Infinity, surfaceMax = -Infinity;
  let maxDepth = 0, depthSum = 0, depthCount = 0;
  const steps: number[] = [];
  let finite = true;
  let terrainUnder = true;
  let bedBelow = true;
  let positiveDepth = true;
  const offsets: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  for (let r = 0; r < d; r++) for (let c = 0; c < w; c++) {
    const i = r * w + c;
    if (!Number.isFinite(heights[i])) finite = false;
    if (bedLayer && bedLayer[i] > 0.5 && !lake[i]) bedCells++;
    if (!river[i]) continue;
    if (!lake[i]) {
      riverCells++;
      bedMin = Math.min(bedMin, heights[i]);
      bedSum += heights[i];
    }
    if (wet[i]) {
      surfaceMin = Math.min(surfaceMin, surface[i]);
      surfaceMax = Math.max(surfaceMax, surface[i]);
      if (!(heights[i] <= surface[i] + 1e-4)) bedBelow = false;
      if (depth[i] < -1e-4) positiveDepth = false;
      if (!Number.isFinite(heights[i])) terrainUnder = false;
      if (!lake[i]) { maxDepth = Math.max(maxDepth, depth[i]); depthSum += depth[i]; depthCount++; }
    }
    for (const [dr, dc] of offsets) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= d || nc < 0 || nc >= w) continue;
      const j = nr * w + nc;
      if (wet[j]) continue;
      edges++;
      if (surface[i] > heights[j] + 1e-4) spill++;
    }
    if (wet[i] && !lake[i]) {
      const [fdr, fdc] = flowUnit(t, i);
      const next = cellAt(t, r + fdr, c + fdc);
      if (next && river[next[0] * w + next[1]]) {
        steps.push(Math.abs(heights[next[0] * w + next[1]] - heights[i]));
      }
    }
  }
  const slopes = steps.map(v => v / Math.max(t.cell_size, 1e-9)).sort((a, b) => a - b);
  const percentile = (p: number) => {
    if (!slopes.length) return 0;
    const k = (slopes.length - 1) * p;
    const lo = Math.floor(k), hi = Math.ceil(k);
    return slopes[lo] + (slopes[hi] - slopes[lo]) * (k - lo);
  };
  const sections = riverSections(t, 5);
  return {
    hasRivers: true,
    riverCells,
    carvedBedCells: bedCells,
    carvedVolume: Number(t.metadata.river_carved_volume_m3 ?? 0),
    terrainFiniteEverywhere: finite,
    waterHasTerrainBeneath: terrainUnder,
    bedBelowWaterSurface: bedBelow,
    positiveWaterDepth: positiveDepth,
    waterSpillEdges: spill,
    waterEdgePairs: edges,
    bedMin: riverCells ? round3(bedMin) : null,
    bedMean: riverCells ? round3(bedSum / riverCells) : null,
    surfaceMin: Number.isFinite(surfaceMin) ? round3(surfaceMin) : null,
    surfaceMax: Number.isFinite(surfaceMax) ? round3(surfaceMax) : null,
    maxWaterDepth: depthCount ? round3(maxDepth) : null,
    meanWaterDepth: depthCount ? round3(depthSum / depthCount) : null,
    bedStepMax: steps.length ? round3(Math.max(...steps)) : 0,
    bedSlopeMedian: round3(percentile(0.5)),
    bedSlopeP95: round3(percentile(0.95)),
    walkableBedFraction: slopes.length ? round3(slopes.filter(v => v <= 0.6).length / slopes.length) : 0,
    gentlySlopedBedFraction: slopes.length ? round3(slopes.filter(v => v <= 1.0).length / slopes.length) : 0,
    bedStepCount: steps.length,
    rivers: water.rivers.length,
    sections,
    sectionsAllEnclosed: sections.length > 0 && sections.every(s => s.waterEnclosed),
    sectionsBedBelowSurface: sections.length > 0 && sections.every(s => s.bedBelowSurface),
    sectionsTerrainAboveBed: sections.length > 0 && sections.every(s => s.terrainAboveBed),
    sectionsMaxBedSlope: sections.reduce((a, s) => Math.max(a, s.maxBedSlope), 0),
  };
}
