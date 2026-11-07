/**
 * Deterministic global-coordinate gradient noise.
 * Numerically matched port of terrain/noise.py (same 32-bit hash, same layering).
 */

const TWO_PI_OVER_2_32 = (2 * Math.PI) / 4294967296;

/** Stable seed-derived angle in [0, pi) for oriented mountain belts. */
export function seedOrientation(seed: number): number {
  let h = seed >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h * (Math.PI / 4294967296);
}

export function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) >>> 0;
  h = (h ^ (Math.imul(iz | 0, 0x165667b1) >>> 0)) >>> 0;
  h = (h ^ (Math.imul(seed | 0, 0x9e3779b1) >>> 0)) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

function gradDot(ix: number, iz: number, seed: number, fx: number, fz: number): number {
  const ang = hash2(ix, iz, seed) * TWO_PI_OVER_2_32;
  return Math.cos(ang) * fx + Math.sin(ang) * fz;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function gradientNoise(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fz = z - z0;
  const n00 = gradDot(x0, z0, seed, fx, fz);
  const n10 = gradDot(x0 + 1, z0, seed, fx - 1, fz);
  const n01 = gradDot(x0, z0 + 1, seed, fx, fz - 1);
  const n11 = gradDot(x0 + 1, z0 + 1, seed, fx - 1, fz - 1);
  const u = fade(fx);
  const v = fade(fz);
  const nx0 = n00 + (n10 - n00) * u;
  const nx1 = n01 + (n11 - n01) * u;
  return (nx0 + (nx1 - nx0) * v) * 1.4142;
}

export function fbm(x: number, z: number, seed: number, octaves = 6, frequency = 1, lacunarity = 2, gain = 0.5): number {
  let total = 0, amp = 1, freq = frequency, norm = 0;
  for (let i = 0; i < octaves; i++) {
    total += gradientNoise(x * freq, z * freq, seed + i * 7919) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return total / norm;
}

export function ridged(x: number, z: number, seed: number, octaves = 6, frequency = 1, lacunarity = 2, gain = 0.5, sharpness = 1.4): number {
  let total = 0, amp = 1, freq = frequency, norm = 0, weight = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(gradientNoise(x * freq, z * freq, seed + i * 7919));
    n = Math.pow(Math.min(1, Math.max(0, n)), sharpness);
    n *= weight;
    weight = Math.min(1, Math.max(0, n * 2));
    total += n * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return total / norm;
}

export function billow(x: number, z: number, seed: number, octaves = 5, frequency = 1, lacunarity = 2, gain = 0.5): number {
  let total = 0, amp = 1, freq = frequency, norm = 0;
  for (let i = 0; i < octaves; i++) {
    total += Math.abs(gradientNoise(x * freq, z * freq, seed + i * 7919)) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return total / norm;
}

export function domainWarp(x: number, z: number, seed: number, strength: number, frequency: number): [number, number] {
  const wx = fbm(x, z, seed + 1301, 3, frequency);
  const wz = fbm(x, z, seed + 2609, 3, frequency);
  return [x + wx * strength, z + wz * strength];
}

export function smoothstep(e0: number, e1: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
