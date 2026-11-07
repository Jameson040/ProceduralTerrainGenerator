/** Deterministic hydraulic droplet erosion + thermal talus relaxation. */
import { hash2 } from "./noise";
import type { TerrainSettings } from "./types";

const PROFILES: Record<number, { perCell: number; steps: number; thermal: number }> = {
  0: { perCell: 0, steps: 0, thermal: 0 },
  1: { perCell: 0.16, steps: 26, thermal: 3 },
  2: { perCell: 0.62, steps: 42, thermal: 9 },
};

export interface ErosionResult {
  heights: Float32Array;
  hydraulic_delta: Float32Array;
  thermal_delta: Float32Array;
  droplets: number;
  thermal_iterations: number;
}

function profile(settings: TerrainSettings) {
  return PROFILES[Math.max(0, Math.min(2, Math.round(settings.erosion_quality)))] ?? PROFILES[1];
}

function rand01(index: number, salt: number, seed: number): number {
  return hash2(index, salt, seed) / 4294967296;
}

function sample4(h: Float64Array, rows: number, cols: number, px: number, py: number): [number, number, number] {
  const x = Math.min(cols - 1.000001, Math.max(0, px));
  const y = Math.min(rows - 1.000001, Math.max(0, py));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const x1 = Math.min(x0 + 1, cols - 1), y1 = Math.min(y0 + 1, rows - 1);
  const h00 = h[y0 * cols + x0], h10 = h[y0 * cols + x1];
  const h01 = h[y1 * cols + x0], h11 = h[y1 * cols + x1];
  const value = h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) + h01 * (1 - fx) * fy + h11 * fx * fy;
  const gx = (h10 - h00) * (1 - fy) + (h11 - h01) * fy;
  const gy = (h01 - h00) * (1 - fx) + (h11 - h10) * fx;
  return [value, gx, gy];
}

function scatter(h: Float64Array, rows: number, cols: number, px: number, py: number, amount: number) {
  const x = Math.min(cols - 1.000001, Math.max(0, px));
  const y = Math.min(rows - 1.000001, Math.max(0, py));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const x1 = Math.min(x0 + 1, cols - 1), y1 = Math.min(y0 + 1, rows - 1);
  h[y0 * cols + x0] += amount * (1 - fx) * (1 - fy);
  h[y0 * cols + x1] += amount * fx * (1 - fy);
  h[y1 * cols + x0] += amount * (1 - fx) * fy;
  h[y1 * cols + x1] += amount * fx * fy;
}

export function hydraulicErosion(heights: Float32Array, rows: number, cols: number, settings: TerrainSettings): ErosionResult {
  const p = profile(settings);
  const before = new Float32Array(heights);
  const h = new Float64Array(heights);
  const emptyThermal = new Float32Array(heights.length);
  if (!settings.hydraulic_enabled || p.steps <= 0 || settings.hydraulic_strength <= 0) {
    return { heights: heights.slice(), hydraulic_delta: new Float32Array(heights.length), thermal_delta: emptyThermal, droplets: 0, thermal_iterations: 0 };
  }
  const cells = rows * cols;
  const droplets = Math.min(60000, Math.max(1200, Math.round(cells * p.perCell)));
  const steps = p.steps;
  const seed = settings.seed | 0;
  const strength = Math.min(1.5, Math.max(0, settings.hydraulic_strength));
  const erosionRate = 0.055 * strength;
  const depositRate = 0.12 * strength;
  const capacityFactor = 1.8;
  const inertia = 0.055;
  const evaporation = 0.022;
  const gravity = 1.2;

  for (let d = 0; d < droplets; d++) {
    let px = rand01(d, 101, seed) * (cols - 1);
    let py = rand01(d, 211, seed) * (rows - 1);
    const a = rand01(d, 307, seed) * Math.PI * 2;
    let dx = Math.cos(a), dy = Math.sin(a);
    let speed = 1, water = 1, sediment = 0;

    for (let step = 0; step < steps; step++) {
      const oldX = px, oldY = py;
      const [hOld, gx, gy] = sample4(h, rows, cols, px, py);
      let ndx = dx * inertia - gx * (1 - inertia);
      let ndy = dy * inertia - gy * (1 - inertia);
      let norm = Math.hypot(ndx, ndy);
      if (norm < 1e-8) {
        const aa = rand01(d, step + 997, seed) * Math.PI * 2;
        ndx = Math.cos(aa); ndy = Math.sin(aa); norm = 1;
      }
      dx = ndx / norm; dy = ndy / norm;
      px = oldX + dx; py = oldY + dy;
      if (px < 1 || px > cols - 2 || py < 1 || py > rows - 2) break;
      const [hNew] = sample4(h, rows, cols, px, py);
      const dh = hNew - hOld;
      speed = Math.min(8, Math.sqrt(Math.max(0.01, speed * speed + (-dh) * gravity)));
      const capacity = Math.max(-dh, 0) * speed * water * capacityFactor;
      let erode = 0, deposit = 0;
      if (sediment > capacity || dh > 0) {
        deposit = dh > 0
          ? Math.min(sediment, dh * depositRate + sediment * depositRate)
          : Math.min(sediment, (sediment - capacity) * depositRate);
        deposit = Math.max(0, deposit);
      } else {
        erode = Math.min(
          Math.max(capacity - sediment, 0) * erosionRate,
          Math.max(-dh, 0) * 0.5
        );
      }
      const oldCell = Math.min(rows - 1, Math.max(0, Math.floor(oldY))) * cols + Math.min(cols - 1, Math.max(0, Math.floor(oldX)));
      erode = Math.min(erode, Math.max(h[oldCell] - 0.02, 0));
      if (erode > 0) scatter(h, rows, cols, oldX, oldY, -erode);
      if (deposit > 0) scatter(h, rows, cols, oldX, oldY, deposit);
      sediment = Math.max(0, sediment + erode - deposit);
      water *= 1 - evaporation;
      if (water < 0.01) break;
    }
  }

  const out = new Float32Array(cells);
  const delta = new Float32Array(cells);
  for (let i = 0; i < cells; i++) {
    out[i] = Math.max(0, h[i]);
    delta[i] = out[i] - before[i];
  }
  return { heights: out, hydraulic_delta: delta, thermal_delta: emptyThermal, droplets, thermal_iterations: 0 };
}

export function thermalErosion(heights: Float32Array, rows: number, cols: number, cellSize: number, settings: TerrainSettings): ErosionResult {
  const p = profile(settings);
  const before = new Float32Array(heights);
  const h = Float64Array.from(heights);
  const zero = new Float32Array(heights.length);
  if (!settings.thermal_enabled || p.thermal <= 0) {
    return { heights: heights.slice(), hydraulic_delta: zero, thermal_delta: zero.slice(), droplets: 0, thermal_iterations: 0 };
  }
  const iterations = p.thermal;
  const strength = Math.min(1, Math.max(0, settings.thermal_strength));
  const talus = Math.tan(Math.min(80, Math.max(2, settings.thermal_talus)) * Math.PI / 180);
  const diag = cellSize * Math.SQRT2;
  const offsets: [number, number, number][] = [[0, 1, cellSize], [1, 0, cellSize], [1, 1, diag], [1, -1, diag]];
  const delta = new Float64Array(heights.length);
  for (let it = 0; it < iterations; it++) {
    delta.fill(0);
    for (const [dz, dx, distance] of offsets) {
      const talusHere = talus * distance;
      const r0 = 0, r1 = rows - dz;
      const c0 = dx < 0 ? 1 : 0;
      const c1 = dx < 0 ? cols : cols - dx;
      for (let r = r0; r < r1; r++) {
        for (let c = c0; c < c1; c++) {
          const a = r * cols + c;
          const b = (r + dz) * cols + (c + dx);
          const excess = h[a] - h[b] - talusHere;
          if (excess > 0) {
            const move = excess * 0.5 * strength;
            delta[a] -= move; delta[b] += move;
          }
        }
      }
    }
    for (let i = 0; i < h.length; i++) h[i] += delta[i];
  }
  const out = new Float32Array(h);
  const tdelta = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) tdelta[i] = out[i] - before[i];
  return { heights: out, hydraulic_delta: zero, thermal_delta: tdelta, droplets: 0, thermal_iterations: iterations };
}
