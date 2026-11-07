"""River-network extraction and riverbed carving.

Rivers are taken from the strictly-downhill D8 drainage graph. A cell becomes
part of the channel network only when its upstream flow accumulation exceeds
a density-derived threshold. Channel centre lines are traced to their sinks
for metadata; the actual water surface is built as a separate variable-width
surface. Terrain is incised beneath that surface, never removed.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List

import numpy as np

from .config import TerrainSettings
from .hydrology import DrainageData


@dataclass
class RiverNetwork:
    mask: np.ndarray             # bool where river water covers the cell
    surface: np.ndarray          # float32 water surface elevation
    depth: np.ndarray            # float32 water depth over carved bed
    centerline: np.ndarray       # bool D8 channel cells
    rivers: List[Dict[str, Any]] = field(default_factory=list)
    carved_volume: float = 0.0
    max_order: int = 0


def build_river_network(
    heights: np.ndarray,
    drainage: DrainageData,
    lake_mask: np.ndarray,
    settings: TerrainSettings,
    cell_size: float,
) -> tuple[np.ndarray, RiverNetwork]:
    """Carve variable-width riverbeds and return the new heightfield + network."""
    rows, cols = heights.shape
    total = rows * cols
    base_h = np.asarray(heights, dtype=np.float64)
    work = base_h.copy()
    empty = RiverNetwork(
        mask=np.zeros((rows, cols), dtype=bool),
        surface=base_h.astype(np.float32),
        depth=np.zeros((rows, cols), dtype=np.float32),
        centerline=np.zeros((rows, cols), dtype=bool),
    )
    if not settings.rivers_enabled or not settings.water_enabled:
        return heights.astype(np.float32, copy=True), empty

    acc = np.asarray(drainage.accumulation, dtype=np.float64)
    threshold = max(18, int(total * (0.0085 - 0.0055 * np.clip(settings.river_density, 0.0, 1.0))))
    channel = (acc >= threshold) & (~lake_mask)
    # Do not force channels through isolated single cells.
    if channel.any():
        neighbor_support = np.zeros_like(channel)
        neighbor_support[1:, :] |= channel[:-1, :]
        neighbor_support[:-1, :] |= channel[1:, :]
        neighbor_support[:, 1:] |= channel[:, :-1]
        neighbor_support[:, :-1] |= channel[:, 1:]
        channel &= neighbor_support | (acc >= threshold * 2.0)
    if not channel.any():
        return heights.astype(np.float32, copy=True), empty

    channel_idx = np.flatnonzero(channel)
    max_channel_acc = float(acc.ravel()[channel_idx].max())
    surface_field = np.full(total, np.nan, dtype=np.float64)
    water_hits = np.zeros(total, dtype=np.int32)
    center_surface = np.full(total, np.nan, dtype=np.float64)
    centers: List[tuple[int, int, float, float]] = []
    carved_volume = 0.0
    base_flat = base_h.ravel()
    work_flat = work.ravel()
    channel_acc = acc.ravel()
    # Upstream -> downstream accumulation order is deterministic and avoids
    # the cost/ambiguity of re-sorting the full D8 graph here.
    channel_idx = channel_idx[np.argsort(channel_acc[channel_idx], kind="stable")]
    channel_pos = np.full(total, -1, dtype=np.int32)
    channel_pos[channel_idx] = np.arange(channel_idx.size, dtype=np.int32)
    channel_center_surface = (base_flat[channel_idx] - 0.05).copy()
    # Guarantee a descending water surface along every D8 channel edge, even
    # where the routing surface crosses a shallow depression.
    for k in range(channel_idx.size):
        flat = int(channel_idx[k])
        nxt = int(drainage.receiver[flat])
        if nxt != flat and channel.ravel()[nxt]:
            j = int(channel_pos[nxt])
            channel_center_surface[j] = min(channel_center_surface[j], channel_center_surface[k] - 0.002)
    channel_width = np.clip(
        settings.river_width * (0.62 + 0.95 * np.sqrt(np.maximum(channel_acc[channel_idx], 1.0) / max_channel_acc)),
        max(1.0, settings.river_width * 0.45),
        settings.river_width * 2.6,
    )
    channel_depth = np.clip(
        settings.river_depth * (0.55 + 0.85 * np.sqrt(np.maximum(channel_acc[channel_idx], 1.0) / max_channel_acc)),
        max(0.15, settings.river_depth * 0.35),
        settings.river_depth * 2.2,
    )

    for k, flat in enumerate(channel_idx):
        r, c = divmod(int(flat), cols)
        center_surface[flat] = channel_center_surface[k]
        water_half = max(cell_size * 1.15, channel_width[k] * 0.5)
        bank = max(cell_size * 0.8, water_half * 0.65)
        radius_m = water_half + bank
        radius_cells = int(math.ceil(radius_m / cell_size)) + 1
        center_depth = channel_depth[k]
        for dr in range(-radius_cells, radius_cells + 1):
            rr = r + dr
            if rr < 0 or rr >= rows:
                continue
            for dc in range(-radius_cells, radius_cells + 1):
                cc = c + dc
                if cc < 0 or cc >= cols:
                    continue
                d = math.hypot(dr * cell_size, dc * cell_size)
                if d > radius_m:
                    continue
                idx = rr * cols + cc
                profile = max(0.0, 1.0 - (d / radius_m) ** 2)
                target = channel_center_surface[k] - center_depth * profile
                if target < work_flat[idx]:
                    carved_volume += (work_flat[idx] - target) * cell_size * cell_size
                    work_flat[idx] = target
                if d <= water_half:
                    water_hits[idx] += 1
                    old = surface_field[idx]
                    surface_field[idx] = channel_center_surface[k] if np.isnan(old) else min(old, channel_center_surface[k])

    mask_flat = (water_hits > 0) & (~lake_mask.ravel()) & np.isfinite(surface_field)
    # A river must sit below the surrounding carved bed and have positive depth.
    depth_flat = np.where(mask_flat, surface_field - work_flat, 0.0)
    mask_flat &= depth_flat > 0.035
    surface_flat = np.where(mask_flat, surface_field, work_flat)

    # Soften the one-cell stair steps of the D8 centre line, but never let the
    # surface fall below its bed.
    mask2 = mask_flat.reshape(rows, cols)
    surf2 = surface_flat.reshape(rows, cols).copy()
    for _ in range(2):
        valid = mask2.astype(np.float64)
        vals = np.where(mask2, surf2, 0.0)
        padded_valid = np.pad(valid, 1, mode="edge")
        padded_vals = np.pad(vals, 1, mode="edge")
        count = (
            padded_valid[:-2, 1:-1] + padded_valid[2:, 1:-1]
            + padded_valid[1:-1, :-2] + padded_valid[1:-1, 2:]
        )
        neighbor_sum = (
            padded_vals[:-2, 1:-1] + padded_vals[2:, 1:-1]
            + padded_vals[1:-1, :-2] + padded_vals[1:-1, 2:]
        )
        neighbor_mean = np.where(count > 0, neighbor_sum / np.maximum(count, 1), surf2)
        surf2 = np.where(mask2, np.maximum(work, surf2 * 0.7 + neighbor_mean * 0.3), surf2)
    surface_flat = surf2.ravel()
    # Final centre-line monotonicity + bed enforcement. This is what makes a
    # river usable as a continuous downhill course rather than disconnected
    # puddles on a rough D8 staircase.
    for k in range(channel_idx.size):
        flat = int(channel_idx[k])
        surface_flat[flat] = min(float(surface_flat[flat]), float(channel_center_surface[k]))
        bed_target = surface_flat[flat] - max(0.08, float(channel_depth[k]))
        work_flat[flat] = min(work_flat[flat], bed_target)
        nxt = int(drainage.receiver[flat])
        if nxt != flat and channel.ravel()[nxt]:
            j = int(channel_pos[nxt])
            if surface_flat[nxt] > surface_flat[flat] - 0.002:
                surface_flat[nxt] = surface_flat[flat] - 0.002
            if work_flat[nxt] > work_flat[flat] - 0.002:
                work_flat[nxt] = work_flat[flat] - 0.002
            # Keep the downstream bed below its newly clamped surface.
            work_flat[nxt] = min(work_flat[nxt], surface_flat[nxt] - 0.05)
    mask_flat = (water_hits > 0) & (~lake_mask.ravel()) & np.isfinite(surface_flat)
    depth_flat = np.where(mask_flat, np.maximum(0.0, surface_flat - work_flat), 0.0)
    mask_flat &= depth_flat > 0.02
    surface_flat = np.where(mask_flat, surface_flat, work_flat)
    carved_volume = float(np.sum(np.maximum(base_flat - work_flat, 0.0)) * cell_size * cell_size)

    # Trace the channel graph from sources for human-readable metadata. The
    # mask itself is what drives rendering, so tracing cannot create gaps.
    receiver = drainage.receiver
    incoming = np.zeros(total, dtype=np.int32)
    ch_flat = np.flatnonzero(mask_flat)
    for idx in ch_flat:
        target = int(receiver[idx])
        if target != idx and channel.ravel()[target]:
            incoming[target] += 1
    sources = [int(i) for i in ch_flat if incoming[i] == 0]
    rivers: List[Dict[str, Any]] = []
    visited_edges: set[int] = set()
    for source in sources:
        path: List[int] = []
        cur = source
        for _ in range(min(total, 2000)):
            if (not bool(channel.ravel()[cur])) or cur in visited_edges:
                break
            visited_edges.add(cur)
            path.append(cur)
            nxt = int(receiver[cur])
            if nxt == cur:
                break
            cur = nxt
        if len(path) < 3:
            continue
        length_m = float(len(path) * cell_size)
        widths = [float(channel_width[int(channel_pos[p])]) for p in path if int(channel_pos[p]) >= 0]
        rivers.append({
            "source_cell": [int(source % cols), int(source // cols)],
            "length_m": round(length_m, 2),
            "mean_width_m": round(float(np.mean(widths)), 2) if widths else round(float(settings.river_width), 2),
            "max_accumulation": int(acc.ravel()[np.asarray(path, dtype=np.int64)].max()),
            "cell_count": len(path),
        })
    rivers.sort(key=lambda item: item["length_m"], reverse=True)
    rivers = rivers[:24]

    return work.astype(np.float32), RiverNetwork(
        mask=mask_flat.reshape(rows, cols),
        surface=surface_flat.reshape(rows, cols).astype(np.float32),
        depth=depth_flat.reshape(rows, cols).astype(np.float32),
        centerline=channel,
        rivers=rivers,
        carved_volume=float(carved_volume),
        max_order=int(np.max(acc.ravel()[channel_idx])) if channel_idx.size else 0,
    )
