"""River-network extraction and riverbed incision.

Rivers are taken from the strictly-downhill D8 drainage graph. A cell becomes
part of the channel network only when its upstream flow accumulation exceeds
a density-derived threshold.

Cross-section contract
----------------------
The terrain is the foundational geometry: every river is an *incision* of the
source heightfield, never a ribbon laid over it.

For each channel cell the generator builds an explicit cross-section:

* a wetted in-channel bed lying ``depth`` below a channel water surface ``ws``;
* a sloping bank rising at ``BANK_SLOPE`` from the bed edge until it merges
  back into the surrounding terrain, so the reach has real riverbanks;
* ``ws`` anchored to the lowest ground of the *lateral* cross-section (minus
  freeboard). Along the flow direction the surface descends with the bed,
  which is what a river does; across it, the banks are geometrically above the
  waterline, so the water cannot spill sideways over unmodified landscape;
* a monotone-descending ``ws`` along every D8 edge, so a river is a continuous
  downhill course instead of disconnected puddles;
* a containment pass that lowers (never raises) any residual surface that
  would stand above neighbouring dry ground at confluences or cliffs.

Only carving is performed — the heightfield is lowered, never raised, so the
result can never contain a hole, a floating shelf or a disconnected bank. The
separate water surface is assembled later by ``water.assemble_water`` from
``RiverNetwork.surface``; terrain geometry is never derived from it.

The cross-section constants and the final pass order are mirrored exactly by
``src/terrain/rivers.ts`` so both backends produce the same landscape.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List

import numpy as np

from .config import TerrainSettings
from .hydrology import DrainageData

BANK_SLOPE = 0.70            # bank rise per metre of horizontal run (~35 degrees)
BED_EDGE_FRACTION = 0.58     # bed depth at the waterline / depth at the centre
FREEBOARD_FRACTION = 0.30    # bank freeboard above the waterline / channel depth
MIN_FREEBOARD = 0.12         # metres of bank guaranteed above every water surface
MIN_WATER_DEPTH = 0.035      # metres; shallower cells are not water
MERGE_START = 0.62           # fraction of the footprint where banks merge with terrain
MAX_DIG_FACTOR = 10.0        # cascade guard (effectively off); steep reaches keep their water
RECEIVER_STEP = 0.002        # metres; guaranteed descent per D8 channel edge
ANCHOR_CELLS = 1.0           # cells beyond the waterline used to anchor the surface


@dataclass
class RiverNetwork:
    mask: np.ndarray             # bool where river water covers the cell
    surface: np.ndarray          # float32 water surface elevation
    depth: np.ndarray            # float32 water depth over carved bed
    centerline: np.ndarray       # bool D8 channel cells
    rivers: List[Dict[str, Any]] = field(default_factory=list)
    carved_volume: float = 0.0
    max_order: int = 0
    bed_mask: np.ndarray | None = None  # bool where terrain was actually incised


def _smoothstep(u: float) -> float:
    t = 0.0 if u <= 0.0 else (1.0 if u >= 1.0 else u)
    return t * t * (3.0 - 2.0 * t)


def _cross_min(field: np.ndarray, r: int, c: int, step_r: float, step_c: float,
               radius_m: float, cell: float) -> tuple[float, float]:
    """Lowest ground on both sides of the flow direction, and its distance.

    ``step_r``/``step_c`` is the unit D8 flow direction in grid indices.
    Sampling is done on integer cells (nearest), which keeps the result
    deterministic and independent of floating-point rounding at the edges.
    """
    rows, cols = field.shape
    length = math.hypot(step_r, step_c)
    if length <= 0.0:
        return float(field[r, c]), radius_m
    perp_r, perp_c = -step_c / length, step_r / length
    best = float(field[r, c])
    best_d = radius_m
    steps = int(math.ceil(radius_m / cell))
    for k in range(1, steps + 1):
        d = k * cell
        for sign in (-1.0, 1.0):
            rr = int(math.floor(r + sign * perp_r * k + 0.5))
            cc = int(math.floor(c + sign * perp_c * k + 0.5))
            if 0 <= rr < rows and 0 <= cc < cols:
                v = float(field[rr, cc])
                if v < best:
                    best = v
                    best_d = d
    return best, best_d


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
    base = np.asarray(heights, dtype=np.float64)
    work = base.copy()
    lake_flat = np.asarray(lake_mask, dtype=bool).ravel()

    def empty_network() -> RiverNetwork:
        return RiverNetwork(
            mask=np.zeros((rows, cols), dtype=bool),
            surface=base.astype(np.float32),
            depth=np.zeros((rows, cols), dtype=np.float32),
            centerline=np.zeros((rows, cols), dtype=bool),
            bed_mask=np.zeros((rows, cols), dtype=bool),
        )

    if not settings.rivers_enabled or not settings.water_enabled:
        return heights.astype(np.float32, copy=True), empty_network()

    acc = np.asarray(drainage.accumulation, dtype=np.float64).ravel()
    threshold = max(18, int(total * (0.0085 - 0.0055 * np.clip(settings.river_density, 0.0, 1.0))))
    channel = (acc >= threshold) & (~lake_flat)
    if channel.any():
        # Do not force channels through isolated single cells.
        channel2 = channel.reshape(rows, cols)
        acc2 = acc.reshape(rows, cols)
        support = np.zeros_like(channel2)
        support[1:, :] |= channel2[:-1, :]
        support[:-1, :] |= channel2[1:, :]
        support[:, 1:] |= channel2[:, :-1]
        support[:, :-1] |= channel2[:, 1:]
        channel = (channel2 & (support | (acc2 >= threshold * 2.0))).ravel()
    if not channel.any():
        return heights.astype(np.float32, copy=True), empty_network()

    # Ascending accumulation is a valid topological order of the D8 graph, so a
    # single upstream -> downstream sweep can enforce a descending water surface.
    channel_idx = np.flatnonzero(channel)
    channel_idx = channel_idx[np.argsort(acc[channel_idx], kind="stable")]
    n_ch = channel_idx.size
    channel_acc = acc[channel_idx]
    max_acc = max(1.0, float(channel_acc.max()))
    receiver = drainage.receiver
    channel_pos = np.full(total, -1, dtype=np.int32)
    channel_pos[channel_idx] = np.arange(n_ch, dtype=np.int32)

    quality = np.sqrt(np.maximum(channel_acc, 1.0) / max_acc)
    channel_width = np.clip(
        settings.river_width * (0.62 + 0.95 * quality),
        max(1.0, settings.river_width * 0.45),
        settings.river_width * 2.6,
    )
    channel_depth = np.clip(
        settings.river_depth * (0.60 + 0.80 * quality),
        max(0.30, settings.river_depth * 0.50),
        settings.river_depth * 2.2,
    )

    # A channel narrower than a cell still needs a resolvable footprint, and the
    # bank must always fit at least one ring of source cells around the water.
    half_width = np.maximum(channel_width * 0.5, cell_size * 0.60)
    bank_run = np.maximum(cell_size * 1.6, half_width * 1.10)
    radius_m = half_width + bank_run
    freeboard = np.maximum(MIN_FREEBOARD, FREEBOARD_FRACTION * channel_depth)

    # Water surface: the lowest ground of the lateral cross-section, minus
    # freeboard. The bed then descends along the flow, so consecutive channel
    # cells still form one continuous downhill course.
    channel_surface = np.empty(n_ch, dtype=np.float64)
    for k in range(n_ch):
        flat = int(channel_idx[k])
        r, c = divmod(flat, cols)
        nxt = int(receiver[flat])
        if nxt == flat:
            flow_r, flow_c = 0.0, 1.0
        else:
            rr, cc = divmod(nxt, cols)
            flow_r, flow_c = float(rr - r), float(cc - c)
        anchor = float(half_width[k]) + ANCHOR_CELLS * cell_size
        cross, _ = _cross_min(base, r, c, flow_r, flow_c, anchor, cell_size)
        channel_surface[k] = min(float(base[r, c]), cross) - float(freeboard[k])
    for k in range(n_ch):
        flat = int(channel_idx[k])
        nxt = int(receiver[flat])
        if nxt == flat or not channel[nxt]:
            continue
        j = int(channel_pos[nxt])
        candidate = float(channel_surface[k] - RECEIVER_STEP)
        if channel_surface[j] > candidate:
            channel_surface[j] = candidate

    # Build the cross-section: wetted bed, then a bank that merges into the
    # untouched terrain. This stage only lowers terrain and records the surface.
    surface_field = np.full(total, np.nan, dtype=np.float64)
    design_depth = np.zeros(total, dtype=np.float64)
    carved = np.zeros(total, dtype=bool)
    for k in range(n_ch):
        flat = int(channel_idx[k])
        r, c = divmod(flat, cols)
        wh = float(half_width[k])
        dep = float(channel_depth[k])
        ws = float(channel_surface[k])
        edge = ws - BED_EDGE_FRACTION * dep
        radius = float(radius_m[k])
        merge_from = radius * MERGE_START
        merge_span = max(radius - merge_from, 1e-9)
        rc = int(math.ceil(radius / cell_size))
        r0, r1 = max(0, r - rc), min(rows, r + rc + 1)
        c0, c1 = max(0, c - rc), min(cols, c + rc + 1)
        for rr in range(r0, r1):
            dz = (rr - r) * cell_size
            for cc in range(c0, c1):
                dx = (cc - c) * cell_size
                d = math.hypot(dx, dz)
                if d > radius:
                    continue
                idx = rr * cols + cc
                if lake_flat[idx]:
                    continue
                ground = base[rr, cc]
                if d <= wh:
                    t = d / wh if wh > 0.0 else 0.0
                    target = ws - dep * (1.0 - (1.0 - BED_EDGE_FRACTION) * t * t)
                else:
                    cone = edge + BANK_SLOPE * (d - wh)
                    if d > merge_from:
                        cone += (ground - cone) * _smoothstep((d - merge_from) / merge_span)
                    target = ground if cone > ground else cone
                if target < work[rr, cc]:
                    work[rr, cc] = target
                    if ground - target > 0.02:
                        carved[idx] = True
                old = surface_field[idx]
                surface_field[idx] = ws if np.isnan(old) else min(old, ws)
                if dep > design_depth[idx]:
                    design_depth[idx] = dep

    # Wet cells are exactly the footprint cells whose carved bed lies below the
    # river surface, so the shoreline follows real geometry.
    valid = np.isfinite(surface_field) & (~lake_flat)
    surface_flat = np.where(valid, surface_field, work.ravel())
    mask_flat = valid & (surface_flat - work.ravel() > MIN_WATER_DEPTH)

    # Soften D8 stair steps. Smoothing may only lower a surface, never lift it
    # over the banks, and the bed always stays below the result.
    mask2 = mask_flat.reshape(rows, cols)
    surf2 = surface_flat.reshape(rows, cols).copy()
    design2 = np.where(np.isfinite(surface_field), surface_field, work.ravel()).reshape(rows, cols)
    for _ in range(2):
        wet = mask2.astype(np.float64)
        vals = np.where(mask2, surf2, 0.0)
        pad_w = np.pad(wet, 1, mode="edge")
        pad_v = np.pad(vals, 1, mode="edge")
        count = pad_w[:-2, 1:-1] + pad_w[2:, 1:-1] + pad_w[1:-1, :-2] + pad_w[1:-1, 2:]
        nsum = pad_v[:-2, 1:-1] + pad_v[2:, 1:-1] + pad_v[1:-1, :-2] + pad_v[1:-1, 2:]
        mean = np.where(count > 0, nsum / np.maximum(count, 1), surf2)
        blended = np.minimum(surf2 * 0.72 + mean * 0.28, design2)
        surf2 = np.where(mask2, blended, surf2)

    # The centre line is the river course: it is always wet and its bed always
    # lies genuinely below the surface, so the channel cannot break apart.
    for k in range(n_ch):
        flat = int(channel_idx[k])
        if lake_flat[flat]:
            continue
        r, c = divmod(flat, cols)
        s = min(float(surf2[r, c]), float(channel_surface[k]))
        if not np.isfinite(s):
            continue
        need = max(0.10, 0.55 * float(channel_depth[k]))
        if s - work[r, c] <= MIN_WATER_DEPTH:
            work[r, c] = s - need
            carved[flat] = True
        surf2[r, c] = s
        mask2[r, c] = True

    # Containment: a wet cell may never stand above neighbouring dry ground.
    # At confluences and river cliffs the surface is lowered (never raised) and
    # the bed follows it down, bounded by MAX_DIG_FACTOR so a cliff cannot
    # become an artificial canyon. Whatever cannot stay two centimetres deep
    # simply stops being water there.
    allowance = MAX_DIG_FACTOR * design_depth.reshape(rows, cols)
    need = np.maximum(0.06, BED_EDGE_FRACTION * design_depth.reshape(rows, cols))
    for _ in range(72):
        wet = mask2
        if not wet.any():
            break
        dry_ground = np.where(wet, np.inf, work)
        pad = np.pad(dry_ground, 1, mode="constant", constant_values=np.inf)
        bound = np.minimum.reduce([pad[:-2, 1:-1], pad[2:, 1:-1], pad[1:-1, :-2], pad[1:-1, 2:]])
        target = np.minimum(surf2, bound - 0.01)
        lowered = target < surf2 - 1e-12
        if not lowered.any():
            break
        surf2 = np.where(lowered, target, surf2)
        # The bed follows a lowered surface, bounded so a cliff cannot be
        # turned into an artificial canyon. Cells that cannot stay deep
        # enough simply become dry there (a waterfall lip, not a spill).
        floor = np.maximum(surf2 - need, design2 - allowance)
        work = np.where(lowered & wet, np.minimum(work, floor), work)
        carved |= (lowered & wet & (base - work > 0.02)).ravel()
        mask2 = wet & (surf2 - work > MIN_WATER_DEPTH * 0.6)

    mask2 = mask2 & (~lake_flat.reshape(rows, cols))
    surf2 = np.where(mask2, surf2, work)
    depth2 = np.where(mask2, np.maximum(0.0, surf2 - work), 0.0)
    carved = carved & (~lake_flat)
    surface_flat = surf2.ravel()
    depth_flat = depth2.ravel()
    mask_flat = mask2.ravel()

    # Trace the channel graph from sources for human-readable metadata. The
    # mask itself drives rendering, so tracing cannot create gaps.
    incoming = np.zeros(total, dtype=np.int32)
    ch_flat = np.flatnonzero(mask_flat)
    for idx in ch_flat:
        target = int(receiver[idx])
        if target != idx and channel[target]:
            incoming[target] += 1
    sources = [int(i) for i in ch_flat if incoming[i] == 0]
    rivers: List[Dict[str, Any]] = []
    visited: set[int] = set()
    for source in sources:
        path: List[int] = []
        cur = source
        for _ in range(min(total, 2000)):
            if (not bool(channel[cur])) or cur in visited:
                break
            visited.add(cur)
            path.append(cur)
            nxt = int(receiver[cur])
            if nxt == cur:
                break
            cur = nxt
        if len(path) < 3:
            continue
        positions = [int(channel_pos[p]) for p in path if int(channel_pos[p]) >= 0]
        widths = [float(channel_width[j]) for j in positions]
        depths = [float(depth_flat[p]) for p in path if bool(mask_flat[p])]
        banks = [float(freeboard[j]) for j in positions]
        rivers.append({
            "source_cell": [int(source % cols), int(source // cols)],
            "length_m": round(float(len(path) * cell_size), 2),
            "mean_width_m": round(float(np.mean(widths)), 2) if widths else round(float(settings.river_width), 2),
            "mean_depth_m": round(float(np.mean(depths)), 2) if depths else 0.0,
            "max_depth_m": round(float(np.max(depths)), 2) if depths else 0.0,
            "bank_height_m": round(float(np.mean(banks)), 2) if banks else 0.0,
            "max_accumulation": int(acc[np.asarray(path, dtype=np.int64)].max()),
            "cell_count": len(path),
        })
    rivers.sort(key=lambda item: item["length_m"], reverse=True)
    rivers = rivers[:24]

    carved_volume = float(np.sum(np.maximum(base.ravel() - work.ravel(), 0.0)) * cell_size * cell_size)
    return work.astype(np.float32), RiverNetwork(
        mask=mask_flat.reshape(rows, cols),
        surface=surface_flat.reshape(rows, cols).astype(np.float32),
        depth=depth_flat.reshape(rows, cols).astype(np.float32),
        centerline=channel.reshape(rows, cols),
        rivers=rivers,
        carved_volume=carved_volume,
        max_order=int(channel_acc.max()) if n_ch else 0,
        bed_mask=carved.reshape(rows, cols),
    )
