/**
 * D8 river extraction and riverbed incision.
 *
 * Cross-section contract (mirrored by terrain/rivers.py):
 * - The terrain heightfield is the foundation. A river is an INCISION of the
 *   source heightfield, never a water ribbon laid over unmodified ground.
 * - Each channel cell gets a wetted in-channel bed `depth` below a channel
 *   water surface `ws`, a bank rising at BANK_SLOPE, and a merge back into the
 *   surrounding terrain. The bank is geometrically above the waterline.
 * - `ws` is anchored to the lowest ground of the LATERAL cross-section minus
 *   freeboard, then forced to descend along every D8 edge.
 * - A containment pass lowers (never raises) any residual surface that would
 *   stand above neighbouring dry ground.
 * - Only carving is performed, so no hole, shelf or disconnected bank can
 *   appear. Water stays a separate surface assembled by water.ts.
 */
import type { DrainageData } from "./hydrology";
import type { RiverInfo, TerrainSettings } from "./types";

export const BANK_SLOPE = 0.70;
export const BED_EDGE_FRACTION = 0.58;
export const FREEBOARD_FRACTION = 0.30;
export const MIN_FREEBOARD = 0.12;
export const MIN_WATER_DEPTH = 0.035;
export const MERGE_START = 0.62;
export const MAX_DIG_FACTOR = 10.0;
export const RECEIVER_STEP = 0.002;
export const ANCHOR_CELLS = 1.0;

export interface RiverNetwork {
  mask: Uint8Array;
  surface: Float32Array;
  depth: Float32Array;
  centerline: Uint8Array;
  rivers: RiverInfo[];
  carved_volume: number;
  /** 1 where the terrain heightfield was actually incised (bed and banks). */
  bed_mask: Uint8Array;
}

const roundHalfUp = (v: number): number => Math.floor(v + 0.5);
const smoothstep01 = (u: number): number => {
  const t = u <= 0 ? 0 : u >= 1 ? 1 : u;
  return t * t * (3 - 2 * t);
};

export function buildRiverNetwork(
  heights: Float32Array, rows: number, cols: number, cellSize: number,
  drainage: DrainageData, lakeMask: Uint8Array, settings: TerrainSettings,
): { heights: Float32Array; network: RiverNetwork } {
  const total = rows * cols;
  const base = new Float64Array(heights);
  const work = new Float64Array(heights);
  const empty = (): RiverNetwork => ({
    mask: new Uint8Array(total), surface: new Float32Array(heights),
    depth: new Float32Array(total), centerline: new Uint8Array(total),
    rivers: [], carved_volume: 0, bed_mask: new Uint8Array(total),
  });
  if (!settings.rivers_enabled || !settings.water_enabled) return { heights: heights.slice(), network: empty() };

  const acc = drainage.accumulation;
  const threshold = Math.max(18, Math.floor(total * (0.0085 - 0.0055 * Math.min(1, Math.max(0, settings.river_density)))));
  const channel = new Uint8Array(total);
  let channelCount = 0;
  for (let i = 0; i < total; i++) if (acc[i] >= threshold && !lakeMask[i]) { channel[i] = 1; channelCount++; }
  if (!channelCount) return { heights: heights.slice(), network: empty() };
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c;
    if (!channel[i]) continue;
    if ((r > 0 && channel[i - cols]) || (r < rows - 1 && channel[i + cols]) || (c > 0 && channel[i - 1]) || (c < cols - 1 && channel[i + 1]))
      continue;
    if (acc[i] < threshold * 2) channel[i] = 0;
  }
  channelCount = 0;
  for (let i = 0; i < total; i++) if (channel[i]) channelCount++;
  if (!channelCount) return { heights: heights.slice(), network: empty() };

  // Ascending accumulation is a valid topological order of the D8 graph.
  const channelIdx: number[] = [];
  for (let i = 0; i < total; i++) if (channel[i]) channelIdx.push(i);
  channelIdx.sort((a, b) => acc[a] - acc[b] || a - b);
  const nCh = channelIdx.length;
  const channelPos = new Int32Array(total).fill(-1);
  for (let k = 0; k < nCh; k++) channelPos[channelIdx[k]] = k;
  let maxAcc = 1;
  for (let k = 0; k < nCh; k++) if (acc[channelIdx[k]] > maxAcc) maxAcc = acc[channelIdx[k]];

  const halfWidth = new Float64Array(nCh);
  const bankRun = new Float64Array(nCh);
  const radiusM = new Float64Array(nCh);
  const freeboard = new Float64Array(nCh);
  const channelDepth = new Float64Array(nCh);
  const channelWidth = new Float64Array(nCh);
  for (let k = 0; k < nCh; k++) {
    const q = Math.sqrt(Math.max(acc[channelIdx[k]], 1) / maxAcc);
    channelWidth[k] = Math.min(settings.river_width * 2.6, Math.max(Math.max(1, settings.river_width * 0.45), settings.river_width * (0.62 + 0.95 * q)));
    channelDepth[k] = Math.min(settings.river_depth * 2.2, Math.max(Math.max(0.30, settings.river_depth * 0.50), settings.river_depth * (0.60 + 0.80 * q)));
    // A channel narrower than a cell still needs a resolvable footprint, and the
    // bank must always fit at least one ring of source cells around the water.
    halfWidth[k] = Math.max(channelWidth[k] * 0.5, cellSize * 0.60);
    bankRun[k] = Math.max(cellSize * 1.6, halfWidth[k] * 1.10);
    radiusM[k] = halfWidth[k] + bankRun[k];
    freeboard[k] = Math.max(MIN_FREEBOARD, FREEBOARD_FRACTION * channelDepth[k]);
  }

  // Water surface anchored to the lowest lateral ground, then descending along
  // the flow so consecutive channel cells form one continuous course.
  const channelSurface = new Float64Array(nCh);
  for (let k = 0; k < nCh; k++) {
    const flat = channelIdx[k];
    const r = (flat / cols) | 0, c = flat - r * cols;
    const nxt = drainage.receiver[flat];
    let flowR = 0, flowC = 1;
    if (nxt !== flat) {
      const rr = (nxt / cols) | 0, cc = nxt - rr * cols;
      flowR = rr - r; flowC = cc - c;
    }
    const anchor = halfWidth[k] + ANCHOR_CELLS * cellSize;
    let cross = base[flat];
    const len = Math.hypot(flowR, flowC);
    if (len > 0) {
      const perpR = -flowC / len, perpC = flowR / len;
      const steps = Math.ceil(anchor / cellSize);
      for (let s = 1; s <= steps; s++) {
        for (const sign of [-1, 1]) {
          const rr = roundHalfUp(r + sign * perpR * s), cc = roundHalfUp(c + sign * perpC * s);
          if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
          const v = base[rr * cols + cc];
          if (v < cross) cross = v;
        }
      }
    }
    channelSurface[k] = Math.min(base[flat], cross) - freeboard[k];
  }
  for (let k = 0; k < nCh; k++) {
    const flat = channelIdx[k], nxt = drainage.receiver[flat];
    if (nxt === flat || !channel[nxt]) continue;
    const j = channelPos[nxt];
    const candidate = channelSurface[k] - RECEIVER_STEP;
    if (channelSurface[j] > candidate) channelSurface[j] = candidate;
  }

  // Cross-section: wetted bed and a bank that merges into untouched terrain.
  const surfaceField = new Float64Array(total).fill(NaN);
  const designDepth = new Float64Array(total);
  const carved = new Uint8Array(total);
  for (let k = 0; k < nCh; k++) {
    const flat = channelIdx[k];
    const r = (flat / cols) | 0, c = flat - r * cols;
    const wh = halfWidth[k], dep = channelDepth[k], ws = channelSurface[k];
    const edge = ws - BED_EDGE_FRACTION * dep;
    const radius = radiusM[k];
    const mergeFrom = radius * MERGE_START;
    const mergeSpan = Math.max(radius - mergeFrom, 1e-9);
    const rc = Math.ceil(radius / cellSize);
    const r0 = Math.max(0, r - rc), r1 = Math.min(rows, r + rc + 1);
    const c0 = Math.max(0, c - rc), c1 = Math.min(cols, c + rc + 1);
    for (let rr = r0; rr < r1; rr++) {
      const dz = (rr - r) * cellSize;
      for (let cc = c0; cc < c1; cc++) {
        const dx = (cc - c) * cellSize;
        const d = Math.hypot(dx, dz);
        if (d > radius) continue;
        const idx = rr * cols + cc;
        if (lakeMask[idx]) continue;
        const ground = base[idx];
        let target: number;
        if (d <= wh) {
          const t = wh > 0 ? d / wh : 0;
          target = ws - dep * (1 - (1 - BED_EDGE_FRACTION) * t * t);
        } else {
          let cone = edge + BANK_SLOPE * (d - wh);
          if (d > mergeFrom) cone += (ground - cone) * smoothstep01((d - mergeFrom) / mergeSpan);
          target = cone > ground ? ground : cone;
        }
        if (target < work[idx]) {
          work[idx] = target;
          if (ground - target > 0.02) carved[idx] = 1;
        }
        const old = surfaceField[idx];
        surfaceField[idx] = Number.isNaN(old) ? ws : Math.min(old, ws);
        if (dep > designDepth[idx]) designDepth[idx] = dep;
      }
    }
  }

  // Wet cells are exactly the footprint cells whose carved bed lies below the
  // river surface, so the shoreline follows real geometry.
  const valid = new Uint8Array(total);
  const surface = new Float64Array(total);
  const mask = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    const sf = surfaceField[i];
    if (!Number.isNaN(sf) && !lakeMask[i]) {
      valid[i] = 1;
      surface[i] = sf;
      if (sf - work[i] > MIN_WATER_DEPTH) mask[i] = 1;
    } else {
      surface[i] = work[i];
    }
  }

  // Soften D8 stair steps. Smoothing may only lower a surface and the bed
  // always stays below the result.
  const design = new Float64Array(total);
  for (let i = 0; i < total; i++) design[i] = valid[i] ? surfaceField[i] : work[i];
  const blended = new Float64Array(total);
  for (let pass = 0; pass < 2; pass++) {
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!mask[i]) { blended[i] = surface[i]; continue; }
      let sum = 0, count = 0;
      const rn = Math.max(0, r - 1), rs = Math.min(rows - 1, r + 1);
      const cn = Math.max(0, c - 1), cs = Math.min(cols - 1, c + 1);
      for (const j of [rn * cols + c, rs * cols + c, r * cols + cn, r * cols + cs]) if (mask[j]) { sum += surface[j]; count++; }
      const mean = count > 0 ? sum / count : surface[i];
      blended[i] = Math.min(surface[i] * 0.72 + mean * 0.28, design[i]);
    }
    for (let i = 0; i < total; i++) if (mask[i]) surface[i] = blended[i];
  }

  // The centre line is the river course: always wet, bed always below the surface.
  for (let k = 0; k < nCh; k++) {
    const flat = channelIdx[k];
    if (lakeMask[flat]) continue;
    const s = Math.min(surface[flat], channelSurface[k]);
    if (!Number.isFinite(s)) continue;
    const need = Math.max(0.10, 0.55 * channelDepth[k]);
    if (s - work[flat] <= MIN_WATER_DEPTH) {
      work[flat] = s - need;
      carved[flat] = 1;
    }
    surface[flat] = s;
    mask[flat] = 1;
  }

  // Containment: a wet cell may never stand above neighbouring dry ground.
  // The surface is lowered (never raised) and its bed follows it down.
  const allowance = new Float64Array(total);
  const need = new Float64Array(total);
  for (let i = 0; i < total; i++) {
    allowance[i] = MAX_DIG_FACTOR * designDepth[i];
    need[i] = Math.max(0.06, BED_EDGE_FRACTION * designDepth[i]);
  }
  const dryGround = new Float64Array(total);
  const bound = new Float64Array(total);
  for (let pass = 0; pass < 72; pass++) {
    let anyWet = false;
    for (let i = 0; i < total; i++) if (mask[i]) { anyWet = true; break; }
    if (!anyWet) break;
    for (let i = 0; i < total; i++) dryGround[i] = mask[i] ? Infinity : work[i];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!mask[i]) { bound[i] = Infinity; continue; }
      let b = Infinity;
      if (r > 0) b = Math.min(b, dryGround[i - cols]);
      if (r < rows - 1) b = Math.min(b, dryGround[i + cols]);
      if (c > 0) b = Math.min(b, dryGround[i - 1]);
      if (c < cols - 1) b = Math.min(b, dryGround[i + 1]);
      bound[i] = b;
    }
    let lowered = false;
    for (let i = 0; i < total; i++) {
      if (!mask[i]) continue;
      const t = Math.min(surface[i], bound[i] - 0.01);
      if (!(t < surface[i] - 1e-12)) continue;
      surface[i] = t;
      lowered = true;
      const floor = Math.max(t - need[i], design[i] - allowance[i]);
      if (floor < work[i]) {
        work[i] = floor;
        if (base[i] - work[i] > 0.02) carved[i] = 1;
      }
    }
    if (!lowered) break;
    for (let i = 0; i < total; i++) if (mask[i] && !(surface[i] - work[i] > MIN_WATER_DEPTH * 0.6)) mask[i] = 0;
  }

  const depth = new Float64Array(total);
  for (let i = 0; i < total; i++) {
    if (mask[i] && lakeMask[i]) mask[i] = 0;
    if (carved[i] && lakeMask[i]) carved[i] = 0;
    if (mask[i]) { surface[i] = surface[i]; depth[i] = Math.max(0, surface[i] - work[i]); }
    else { surface[i] = work[i]; depth[i] = 0; }
  }

  // Trace the channel graph from sources for human-readable metadata.
  const incoming = new Int32Array(total);
  for (let i = 0; i < total; i++) if (mask[i]) {
    const target = drainage.receiver[i];
    if (target !== i && channel[target]) incoming[target]++;
  }
  const rivers: RiverInfo[] = [];
  const visited = new Uint8Array(total);
  for (let source = 0; source < total; source++) {
    if (!mask[source] || incoming[source] !== 0) continue;
    const path: number[] = [];
    let cur = source;
    for (let step = 0; step < Math.min(total, 2000); step++) {
      if (!channel[cur] || visited[cur]) break;
      visited[cur] = 1; path.push(cur);
      const nxt = drainage.receiver[cur];
      if (nxt === cur) break;
      cur = nxt;
    }
    if (path.length < 3) continue;
    const positions: number[] = [];
    const depths: number[] = [];
    const banks: number[] = [];
    let maxA = 0;
    for (const p of path) {
      maxA = Math.max(maxA, acc[p]);
      const j = channelPos[p];
      if (j >= 0) banks.push(freeboard[j]);
      if (mask[p]) depths.push(depth[p]);
      if (j >= 0) positions.push(j);
    }
    rivers.push({
      source_cell: [source % cols, (source / cols) | 0],
      length_m: Math.round(path.length * cellSize * 100) / 100,
      mean_width_m: Math.round((positions.length ? positions.reduce((a, j) => a + channelWidth[j], 0) / positions.length : settings.river_width) * 100) / 100,
      mean_depth_m: Math.round((depths.length ? depths.reduce((a, b) => a + b, 0) / depths.length : 0) * 100) / 100,
      max_depth_m: Math.round((depths.length ? Math.max(...depths) : 0) * 100) / 100,
      bank_height_m: Math.round((banks.length ? banks.reduce((a, b) => a + b, 0) / banks.length : 0) * 100) / 100,
      max_accumulation: maxA,
      cell_count: path.length,
    });
  }
  rivers.sort((a, b) => b.length_m - a.length_m);

  let carvedVolume = 0;
  for (let i = 0; i < total; i++) carvedVolume += Math.max(0, base[i] - work[i]) * cellSize * cellSize;

  return {
    heights: Float32Array.from(work),
    network: {
      mask, surface: Float32Array.from(surface), depth: Float32Array.from(depth),
      centerline: channel, rivers: rivers.slice(0, 24), carved_volume: carvedVolume, bed_mask: carved,
    },
  };
}
