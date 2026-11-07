"""Deterministic landscape-evolution stages for the heightfield.

Hydraulic erosion is a vectorized droplet simulation over the existing grid:
raindrops follow the downhill gradient, pick up material according to slope,
speed and water, carry it, evaporate / run off, and deposit when capacity
falls. Droplet batches are advanced together with NumPy, while every source
of randomness is a pure 32-bit hash of (seed, batch, droplet) — there is no
sequential RNG state.

Thermal erosion is a material-conserving talus relaxation pass. It is
independent of hydraulic erosion and is always applied to the heightfield
only, never to water geometry.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Dict, Tuple

import numpy as np

from . import noise as N
from .config import TerrainSettings


QUALITY_PROFILES: Dict[int, Dict[str, float]] = {
    0: {"droplets_per_cell": 0.0, "droplet_steps": 0, "thermal_iterations": 0},
    1: {"droplets_per_cell": 0.16, "droplet_steps": 26, "thermal_iterations": 3},
    2: {"droplets_per_cell": 0.62, "droplet_steps": 42, "thermal_iterations": 9},
}


@dataclass
class ErosionResult:
    heights: np.ndarray
    hydraulic_delta: np.ndarray
    thermal_delta: np.ndarray
    droplets: int
    thermal_iterations: int


def _quality(settings: TerrainSettings) -> Dict[str, float]:
    return QUALITY_PROFILES.get(int(np.clip(settings.erosion_quality, 0, 2)), QUALITY_PROFILES[1])


def _sample4(h: np.ndarray, px: np.ndarray, py: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """Bilinear sample of h at continuous grid coordinates + 4 corner weights."""
    rows, cols = h.shape
    x = np.clip(px, 0.0, cols - 1.000001)
    y = np.clip(py, 0.0, rows - 1.000001)
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    fx = x - x0
    fy = y - y0
    x1 = np.minimum(x0 + 1, cols - 1)
    y1 = np.minimum(y0 + 1, rows - 1)
    h00 = h[y0, x0]
    h10 = h[y0, x1]
    h01 = h[y1, x0]
    h11 = h[y1, x1]
    value = h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) + h01 * (1 - fx) * fy + h11 * fx * fy
    gx = (h10 - h00) * (1 - fy) + (h11 - h01) * fy
    gy = (h01 - h00) * (1 - fx) + (h11 - h10) * fx
    return value, np.stack([gx, gy], axis=-1)


def _scatter(h: np.ndarray, px: np.ndarray, py: np.ndarray, amount: np.ndarray) -> None:
    """Bilinearly scatter a material amount (positive or negative) to the grid."""
    rows, cols = h.shape
    x = np.clip(px, 0.0, cols - 1.000001)
    y = np.clip(py, 0.0, rows - 1.000001)
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    fx = x - x0
    fy = y - y0
    x1 = np.minimum(x0 + 1, cols - 1)
    y1 = np.minimum(y0 + 1, rows - 1)
    idx = np.concatenate([y0 * cols + x0, y0 * cols + x1, y1 * cols + x0, y1 * cols + x1])
    w = np.concatenate([
        (1 - fx) * (1 - fy),
        fx * (1 - fy),
        (1 - fx) * fy,
        fx * fy,
    ])
    np.add.at(h.reshape(-1), idx, np.tile(amount, 4) * w)


def hydraulic_erosion(heights: np.ndarray, settings: TerrainSettings) -> Tuple[np.ndarray, np.ndarray, int]:
    """Particle hydraulic erosion. Returns (heights, signed delta, droplets)."""
    profile = _quality(settings)
    rows, cols = heights.shape
    h = np.array(heights, dtype=np.float64, copy=True)
    before = h.copy()
    cells = rows * cols
    droplets = int(min(60000, max(1200, cells * profile["droplets_per_cell"])))
    steps = int(profile["droplet_steps"])
    if droplets <= 0 or steps <= 0 or not settings.hydraulic_enabled:
        return heights.astype(np.float32, copy=True), np.zeros_like(heights, dtype=np.float32), 0

    seed = int(settings.seed) & 0xFFFFFFFF
    strength = float(np.clip(settings.hydraulic_strength, 0.0, 1.5))
    if strength <= 0.0:
        return heights.astype(np.float32, copy=True), np.zeros_like(heights, dtype=np.float32), 0

    erosion_rate = 0.055 * strength
    deposit_rate = 0.12 * strength
    capacity_factor = 1.8
    inertia = 0.055
    evaporation = 0.022
    gravity = 1.2
    batch_size = 4096

    for offset in range(0, droplets, batch_size):
        n = min(batch_size, droplets - offset)
        stream = np.arange(offset, offset + n, dtype=np.int64)
        rand = lambda salt: N.hash2(stream, np.full(n, salt, dtype=np.int64), seed) .astype(np.float64) / 4294967296.0
        px = rand(101) * (cols - 1.0)
        py = rand(211) * (rows - 1.0)
        angle = rand(307) * (2.0 * math.pi)
        dx = np.cos(angle)
        dy = np.sin(angle)
        speed = np.full(n, 1.0)
        water = np.full(n, 1.0)
        sediment = np.zeros(n)
        active = np.ones(n, dtype=bool)

        for step in range(steps):
            if not active.any():
                break
            px_old, py_old = px.copy(), py.copy()
            h_old, grad = _sample4(h, px, py)
            # Steering: preserve momentum, add a downhill component.
            n_dx = dx * inertia - grad[:, 0] * (1.0 - inertia)
            n_dy = dy * inertia - grad[:, 1] * (1.0 - inertia)
            norm = np.hypot(n_dx, n_dy)
            flat = norm < 1e-8
            if flat.any():
                a = N.hash2(stream[flat], np.full(flat.sum(), step + 997, dtype=np.int64), seed).astype(np.float64) / 4294967296.0
                n_dx[flat] = np.cos(a * 2.0 * math.pi)
                n_dy[flat] = np.sin(a * 2.0 * math.pi)
                norm[flat] = 1.0
            dx, dy = n_dx / norm, n_dy / norm
            px = px_old + dx
            py = py_old + dy

            out = (px < 1.0) | (px > cols - 2.0) | (py < 1.0) | (py > rows - 2.0)
            if out.any():
                active &= ~out
                px = np.clip(px, 1.0, cols - 2.0)
                py = np.clip(py, 1.0, rows - 2.0)
            if not active.any():
                break

            h_new, _ = _sample4(h, px, py)
            dh = h_new - h_old
            speed = np.sqrt(np.maximum(0.01, speed * speed + (-dh) * gravity))
            speed = np.minimum(speed, 8.0)
            capacity = np.maximum(-dh, 0.0) * speed * water * capacity_factor
            deposit = np.zeros(n)
            erode = np.zeros(n)

            # Deposition occurs on flats / uphill steps and when overloaded.
            moving = (sediment > capacity) | (dh > 0.0)
            if moving.any():
                deposit[moving] = np.where(
                    dh[moving] > 0.0,
                    np.minimum(sediment[moving], dh[moving] * deposit_rate + sediment[moving] * deposit_rate),
                    np.minimum(sediment[moving], (sediment[moving] - capacity[moving]) * deposit_rate),
                )
                deposit = np.maximum(deposit, 0.0)
            eroding = ~moving
            if eroding.any():
                erode[eroding] = np.minimum(
                    np.maximum(capacity[eroding] - sediment[eroding], 0.0) * erosion_rate,
                    np.maximum(-dh[eroding], 0.0) * 0.5,
                )

            # Keep the ground finite and non-negative.
            old_flat = np.floor(py_old).astype(np.int64) * cols + np.floor(px_old).astype(np.int64)
            safe_erode = np.minimum(erode, np.maximum(h.ravel()[old_flat] - 0.02, 0.0))
            if np.any(safe_erode > 0.0):
                _scatter(h, px_old, py_old, -safe_erode)
                erosion_amt = safe_erode
            else:
                erosion_amt = np.zeros(n)
            if np.any(deposit > 0.0):
                _scatter(h, px_old, py_old, deposit)
            sediment = np.maximum(0.0, sediment + erosion_amt - deposit)
            water = water * (1.0 - evaporation)
            alive = (water > 0.01) & (speed > 0.02)
            active &= alive

        h = np.maximum(h, 0.0)

    return h.astype(np.float32), (h - before).astype(np.float32), droplets


def thermal_erosion(heights: np.ndarray, settings: TerrainSettings, cell_size: float) -> Tuple[np.ndarray, np.ndarray, int]:
    """Material-conserving talus relaxation. Returns (heights, delta, iterations)."""
    if not settings.thermal_enabled:
        return heights.astype(np.float32, copy=True), np.zeros_like(heights, dtype=np.float32), 0
    iterations = int(_quality(settings)["thermal_iterations"])
    if iterations <= 0:
        return heights.astype(np.float32, copy=True), np.zeros_like(heights, dtype=np.float32), 0

    h = np.array(heights, dtype=np.float64, copy=True)
    before = h.copy()
    strength = float(np.clip(settings.thermal_strength, 0.0, 1.0))
    angle = math.radians(float(np.clip(settings.thermal_talus, 2.0, 80.0)))
    diag = cell_size * math.sqrt(2.0)
    # Source/destination slices for east, south, south-east, south-west.
    offsets = (
        ((slice(None), slice(0, -1)), (slice(None), slice(1, None)), cell_size),
        ((slice(0, -1), slice(None)), (slice(1, None), slice(None)), cell_size),
        ((slice(0, -1), slice(0, -1)), (slice(1, None), slice(1, None)), diag),
        ((slice(0, -1), slice(1, None)), (slice(1, None), slice(0, -1)), diag),
    )

    for _ in range(iterations):
        delta = np.zeros_like(h)
        for src, dst, distance in offsets:
            a = h[src]
            b = h[dst]
            talus = math.tan(angle) * distance
            excess = a - b - talus
            move = np.where(excess > 0.0, excess * 0.5 * strength, 0.0)
            # Moving less than half the excess guarantees no slope reversal.
            delta[src] -= move
            delta[dst] += move
        h += delta
    return h.astype(np.float32), (h - before).astype(np.float32), iterations
