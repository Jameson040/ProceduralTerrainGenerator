"""Deterministic, global-coordinate gradient noise.

All functions are pure: value = f(world_x, world_z, seed). No permutation
tables, no RNG state. The integer hash uses 32-bit wrapping arithmetic and is
mirrored by the TypeScript port (src/terrain/noise.ts).
"""
import numpy as np

_TWO_PI_OVER_2_32 = (2.0 * np.pi) / 4294967296.0


def seed_orientation(seed: int) -> float:
    """Stable seed-derived angle in [0, pi) for oriented global formations."""
    with np.errstate(over="ignore"):
        h = np.uint32(seed & 0xFFFFFFFF)
        h ^= h >> np.uint32(16)
        h *= np.uint32(0x7FEB352D)
        h ^= h >> np.uint32(15)
        h *= np.uint32(0x846CA68B)
        h ^= h >> np.uint32(16)
    return float(h) * (np.pi / 4294967296.0)


def hash2(ix: np.ndarray, iz: np.ndarray, seed: int) -> np.ndarray:
    """32-bit integer hash of lattice coordinates. Inputs are int64 arrays."""
    with np.errstate(over="ignore"):
        x = ix.astype(np.int64).astype(np.uint32)
        z = iz.astype(np.int64).astype(np.uint32)
        s = np.uint32(seed & 0xFFFFFFFF)
        h = x * np.uint32(0x27D4EB2D)
        h ^= z * np.uint32(0x165667B1)
        h ^= s * np.uint32(0x9E3779B1)
        h ^= h >> np.uint32(15)
        h *= np.uint32(0x85EBCA6B)
        h ^= h >> np.uint32(13)
        h *= np.uint32(0xC2B2AE35)
        h ^= h >> np.uint32(16)
    return h


def _grad_dot(ix, iz, seed, fx, fz):
    h = hash2(ix, iz, seed)
    ang = h.astype(np.float64) * _TWO_PI_OVER_2_32
    return np.cos(ang) * fx + np.sin(ang) * fz


def _fade(t):
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0)


def gradient_noise(x: np.ndarray, z: np.ndarray, seed: int) -> np.ndarray:
    """2D Perlin-style gradient noise in roughly [-1, 1]."""
    x0 = np.floor(x)
    z0 = np.floor(z)
    fx = x - x0
    fz = z - z0
    ix = x0.astype(np.int64)
    iz = z0.astype(np.int64)

    n00 = _grad_dot(ix, iz, seed, fx, fz)
    n10 = _grad_dot(ix + 1, iz, seed, fx - 1.0, fz)
    n01 = _grad_dot(ix, iz + 1, seed, fx, fz - 1.0)
    n11 = _grad_dot(ix + 1, iz + 1, seed, fx - 1.0, fz - 1.0)

    u = _fade(fx)
    v = _fade(fz)
    nx0 = n00 + (n10 - n00) * u
    nx1 = n01 + (n11 - n01) * u
    return (nx0 + (nx1 - nx0) * v) * 1.4142


def fbm(x, z, seed, octaves=6, frequency=1.0, lacunarity=2.0, gain=0.5):
    """Standard fractional Brownian motion, normalized to about [-1, 1]."""
    total = np.zeros_like(x)
    amp = 1.0
    freq = frequency
    norm = 0.0
    for i in range(octaves):
        total += gradient_noise(x * freq, z * freq, seed + i * 7919) * amp
        norm += amp
        amp *= gain
        freq *= lacunarity
    return total / norm


def ridged(x, z, seed, octaves=6, frequency=1.0, lacunarity=2.0, gain=0.5, sharpness=1.4):
    """Ridged multifractal: sharp crests, good for mountain ranges. Output in [0, 1]."""
    total = np.zeros_like(x)
    amp = 1.0
    freq = frequency
    norm = 0.0
    weight = np.ones_like(x)
    for i in range(octaves):
        n = gradient_noise(x * freq, z * freq, seed + i * 7919)
        n = 1.0 - np.abs(n)
        n = np.power(np.clip(n, 0.0, 1.0), sharpness)
        n *= weight
        weight = np.clip(n * 2.0, 0.0, 1.0)
        total += n * amp
        norm += amp
        amp *= gain
        freq *= lacunarity
    return total / norm


def billow(x, z, seed, octaves=5, frequency=1.0, lacunarity=2.0, gain=0.5):
    """Billowy noise |n| -> rounded bulges / channels. Output in [0, 1]."""
    total = np.zeros_like(x)
    amp = 1.0
    freq = frequency
    norm = 0.0
    for i in range(octaves):
        total += np.abs(gradient_noise(x * freq, z * freq, seed + i * 7919)) * amp
        norm += amp
        amp *= gain
        freq *= lacunarity
    return total / norm


def domain_warp(x, z, seed, strength, frequency):
    """Offsets coordinates by low-frequency noise so features are less grid-like."""
    wx = fbm(x, z, seed + 1301, octaves=3, frequency=frequency)
    wz = fbm(x, z, seed + 2609, octaves=3, frequency=frequency)
    return x + wx * strength, z + wz * strength


def smoothstep(e0, e1, v):
    t = np.clip((v - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)
