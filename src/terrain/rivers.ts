/** D8 river extraction, riverbed incision, and variable-width surface geometry. */
import type { DrainageData } from "./hydrology";
import type { RiverInfo, TerrainSettings } from "./types";

export interface RiverNetwork {
  mask: Uint8Array;
  surface: Float32Array;
  depth: Float32Array;
  centerline: Uint8Array;
  rivers: RiverInfo[];
  carved_volume: number;
}

export function buildRiverNetwork(
  heights: Float32Array, rows: number, cols: number, cellSize: number,
  drainage: DrainageData, lakeMask: Uint8Array, settings: TerrainSettings,
): { heights: Float32Array; network: RiverNetwork } {
  const total = rows * cols;
  const work = new Float64Array(heights);
  const base = new Float64Array(heights);
  const empty = () => ({
    mask: new Uint8Array(total), surface: new Float32Array(heights), depth: new Float32Array(total),
    centerline: new Uint8Array(total), rivers: [], carved_volume: 0,
  });
  if (!settings.rivers_enabled || !settings.water_enabled) return { heights: heights.slice(), network: empty() };
  const acc = drainage.accumulation;
  const threshold = Math.max(18, Math.floor(total * (0.0085 - 0.0055 * Math.min(1, Math.max(0, settings.river_density)))));
  const channel = new Uint8Array(total);
  let channelCount = 0;
  for (let i = 0; i < total; i++) if (acc[i] >= threshold && !lakeMask[i]) { channel[i] = 1; channelCount++; }
  const support = new Uint8Array(total);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c;
    if (!channel[i]) continue;
    if ((r > 0 && channel[i - cols]) || (r < rows - 1 && channel[i + cols]) || (c > 0 && channel[i - 1]) || (c < cols - 1 && channel[i + 1]))
      support[i] = 1;
  }
  for (let i = 0; i < total; i++) if (channel[i] && !support[i] && acc[i] < threshold * 2) channel[i] = 0;
  channelCount = 0;
  let maxAcc = 1;
  for (let i = 0; i < total; i++) {
    if (channel[i]) { channelCount++; maxAcc = Math.max(maxAcc, acc[i]); }
  }
  if (!channelCount) return { heights: heights.slice(), network: empty() };

  const channelIdx: number[] = [];
  for (let i = 0; i < total; i++) if (channel[i]) channelIdx.push(i);
  channelIdx.sort((a, b) => acc[a] - acc[b] || a - b);
  const channelPos = new Int32Array(total).fill(-1);
  for (let k = 0; k < channelIdx.length; k++) channelPos[channelIdx[k]] = k;
  const centerSurfaceArr = new Float64Array(channelIdx.length);
  const channelWidth = new Float64Array(channelIdx.length);
  const channelDepth = new Float64Array(channelIdx.length);
  for (let k = 0; k < channelIdx.length; k++) {
    const idx = channelIdx[k];
    const q = Math.sqrt(Math.max(acc[idx], 1) / maxAcc);
    channelWidth[k] = Math.min(settings.river_width * 2.6, Math.max(Math.max(1, settings.river_width * 0.45), settings.river_width * (0.62 + 0.95 * q)));
    channelDepth[k] = Math.min(settings.river_depth * 2.2, Math.max(Math.max(0.15, settings.river_depth * 0.35), settings.river_depth * (0.55 + 0.85 * q)));
    centerSurfaceArr[k] = base[idx] - 0.05;
  }
  for (let k = 0; k < channelIdx.length; k++) {
    const idx = channelIdx[k], nxt = drainage.receiver[idx];
    if (nxt !== idx && channel[nxt]) {
      const j = channelPos[nxt];
      centerSurfaceArr[j] = Math.min(centerSurfaceArr[j], centerSurfaceArr[k] - 0.002);
    }
  }

  const surfaceField = new Float64Array(total).fill(NaN);
  const waterHits = new Int32Array(total);
  for (let k = 0; k < channelIdx.length; k++) {
    const idx = channelIdx[k];
    const r = (idx / cols) | 0, c = idx - r * cols;
    const width = channelWidth[k];
    const depth = channelDepth[k];
    const centerSurface = centerSurfaceArr[k];
    const waterHalf = Math.max(cellSize * 1.15, width * 0.5);
    const bank = Math.max(cellSize * 0.8, waterHalf * 0.65);
    const radiusM = waterHalf + bank;
    const radiusCells = Math.ceil(radiusM / cellSize) + 1;
    for (let dr = -radiusCells; dr <= radiusCells; dr++) {
      const rr = r + dr;
      if (rr < 0 || rr >= rows) continue;
      for (let dc = -radiusCells; dc <= radiusCells; dc++) {
        const cc = c + dc;
        if (cc < 0 || cc >= cols) continue;
        const dist = Math.hypot(dr * cellSize, dc * cellSize);
        if (dist > radiusM) continue;
        const cell = rr * cols + cc;
        const profile = Math.max(0, 1 - (dist / radiusM) * (dist / radiusM));
        const target = centerSurface - depth * profile;
        if (target < work[cell]) {
          work[cell] = target;
        }
        if (dist <= waterHalf) {
          waterHits[cell]++;
          const old = surfaceField[cell];
          surfaceField[cell] = Number.isNaN(old) ? centerSurface : Math.min(old, centerSurface);
        }
      }
    }
  }
  const mask = new Uint8Array(total);
  const surface = new Float32Array(total);
  const depthArr = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    if (waterHits[i] > 0 && !lakeMask[i] && Number.isFinite(surfaceField[i])) {
      const dep = surfaceField[i] - work[i];
      if (dep > 0.035) { mask[i] = 1; surface[i] = surfaceField[i]; depthArr[i] = dep; }
    } else {
      surface[i] = work[i];
    }
  }
  // Light smoothing of D8 stair steps, constrained to the water mask and bed.
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float32Array(surface);
    for (let r = 1; r < rows - 1; r++) for (let c = 1; c < cols - 1; c++) {
      const i = r * cols + c;
      if (!mask[i]) continue;
      let sum = 0, n = 0;
      for (const j of [i - cols, i + cols, i - 1, i + 1]) if (mask[j]) { sum += surface[j]; n++; }
      if (n) next[i] = Math.max(work[i], surface[i] * 0.7 + (sum / n) * 0.3);
    }
    surface.set(next);
  }
  // Enforce a strictly descending centre line and a real bed below it.
  for (let k = 0; k < channelIdx.length; k++) {
    const idx = channelIdx[k];
    surface[idx] = Math.min(surface[idx], centerSurfaceArr[k]);
    work[idx] = Math.min(work[idx], surface[idx] - Math.max(0.08, channelDepth[k]));
    mask[idx] = 1;
    const nxt = drainage.receiver[idx];
    if (nxt !== idx && channel[nxt]) {
      if (surface[nxt] > surface[idx] - 0.002) surface[nxt] = surface[idx] - 0.002;
      if (work[nxt] > work[idx] - 0.002) work[nxt] = work[idx] - 0.002;
      work[nxt] = Math.min(work[nxt], surface[nxt] - 0.05);
      mask[nxt] = 1;
    }
  }
  for (let i = 0; i < total; i++) {
    if (mask[i]) {
      depthArr[i] = Math.max(0, surface[i] - work[i]);
      if (depthArr[i] <= 0.02) mask[i] = 0;
    }
    if (!mask[i]) surface[i] = work[i];
  }
  let carvedVolume = 0;
  for (let i = 0; i < total; i++) carvedVolume += Math.max(0, base[i] - work[i]) * cellSize * cellSize;

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
    let maxA = 0;
    for (const p of path) maxA = Math.max(maxA, acc[p]);
    rivers.push({
      source_cell: [source % cols, (source / cols) | 0],
      length_m: Math.round(path.length * cellSize * 100) / 100,
      mean_width_m: Math.round(settings.river_width * 100) / 100,
      max_accumulation: maxA,
      cell_count: path.length,
    });
  }
  rivers.sort((a, b) => b.length_m - a.length_m);
  return {
    heights: Float32Array.from(work),
    network: {
      mask, surface, depth: depthArr, centerline: channel, rivers: rivers.slice(0, 24),
      carved_volume: carvedVolume,
    },
  };
}
