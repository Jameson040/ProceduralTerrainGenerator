/**
 * Procedural, seamlessly tileable textures generated on the CPU once per scene.
 *
 * They are sampled triplanar in world space by the terrain shader and in metres
 * for the water surface, so the pattern is identical in every chunk and at
 * every LOD. Nothing here reads chunk-local coordinates.
 */

const fade = (t: number) => t * t * (3 - 2 * t);

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = h >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Tileable value noise: `period` lattice cells across the whole texture. */
function valueNoise(size: number, period: number, seed: number): Float32Array {
  const out = new Float32Array(size * size), cell = size / period;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const fx = x / cell, fy = y / cell;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fade(fx - x0), ty = fade(fy - y0);
    const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
    const a = hash(x0, y0, seed), b = hash(x1, y0, seed);
    const c = hash(x0, y1, seed), d = hash(x1, y1, seed);
    const top = a + (b - a) * tx, bottom = c + (d - c) * tx;
    out[y * size + x] = top + (bottom - top) * ty;
  }
  return out;
}

/** Multi-octave tileable fBm in 0..1. */
export function fbmTile(size: number, seed: number, octaves = 4, basePeriod = 4): Float32Array {
  const out = new Float32Array(size * size);
  let amp = 1, norm = 0, period = basePeriod;
  for (let o = 0; o < octaves; o++) {
    const layer = valueNoise(size, period, seed + o * 7919);
    for (let i = 0; i < out.length; i++) out[i] += layer[i] * amp;
    norm += amp;
    amp *= 0.5;
    period = Math.min(size, period * 2);
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/** RGBA bytes for a RawTexture: broadly used as a detail/macro luminance map. */
export function noiseRGBA(size: number, seed: number, octaves = 4): Uint8Array {
  const f = fbmTile(size, seed, octaves);
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < f.length; i++) {
    // Slight contrast curve keeps the detail readable at grazing angles.
    const v = Math.round(Math.min(1, Math.max(0, 0.5 + (f[i] - 0.5) * 1.6)) * 255);
    data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
  }
  return data;
}

/** Tangent-space normal map derived from the same kind of noise, for water ripples. */
export function normalRGBA(size: number, seed: number, strength = 2.2): Uint8Array {
  const h = fbmTile(size, seed, 3, 3);
  const at = (x: number, y: number) => h[((y + size) % size) * size + ((x + size) % size)];
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
    const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
    const nx = -dx, ny = -dy, nz = 1;
    const len = Math.hypot(nx, ny, nz);
    const i = (y * size + x) * 4;
    data[i] = Math.round((nx / len * 0.5 + 0.5) * 255);
    data[i + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
    data[i + 2] = Math.round((nz / len * 0.5 + 0.5) * 255);
    data[i + 3] = 255;
  }
  return data;
}
