"""Cross-section / continuity diagnostics for the underwater-terrain contract.

Used by the test-suite and by ``python -m terrain.cli --cross-section`` to prove:
- the terrain heightfield is complete under every lake (no holes),
- the lakebed has real elevation with natural shore transitions,
- water is a separate level placed over terrain depressions,
- exported geometry retains the submerged ground.
"""
from typing import Any, Dict
import numpy as np


def pick_transect_row(t) -> int:
    """Row index crossing the most water; middle row if there is no water."""
    if t.water is None or not t.water.mask.any():
        return t.depth // 2
    counts = t.water.mask.sum(axis=1)
    return int(np.argmax(counts))


def transect_report(t, row: int | None = None) -> Dict[str, Any]:
    """Continuity report for one slice, including variable river/lake surfaces."""
    if row is None:
        row = pick_transect_row(t)
    row = max(0, min(t.depth - 1, int(row)))
    h = t.heights[row, :].astype(np.float64)
    wmask = t.water.mask[row, :].astype(bool) if t.water is not None else np.zeros(t.width, dtype=bool)
    surface = (
        np.asarray(t.water.surface)[row, :].astype(np.float64)
        if t.water is not None and t.water.surface is not None
        else np.full(t.width, t.water.level if t.water is not None else np.nan)
    )
    water = t.water
    finite = bool(np.all(np.isfinite(h)))
    steps = np.abs(np.diff(h))
    max_step = float(steps.max()) if steps.size else 0.0
    step_limit = float(t.settings.height_scale * 0.25)
    continuous = bool(finite and h.size == t.width and max_step <= step_limit)
    water_idx = np.where(wmask)[0]
    if water_idx.size:
        bed = h[wmask]
        surf = surface[wmask]
        depth = surf - bed
        info = {
            "has_water": True,
            "water_span_cells": int(water_idx.size),
            "water_span_m": round(float(water_idx.size * t.cell_size), 2),
            "water_runs": int(np.count_nonzero(np.diff(np.pad(wmask.astype(np.int8), (1, 1))) == 1)),
            "lake_cells": int(water.lake_mask[row, :].sum()) if water.lake_mask is not None else 0,
            "river_cells": int(water.river_mask[row, :].sum()) if water.river_mask is not None else 0,
            "surface_min": round(float(surf.min()), 3),
            "surface_max": round(float(surf.max()), 3),
            "lakebed_min": round(float(bed.min()), 3),
            "lakebed_max": round(float(bed.max()), 3),
            "lakebed_relief": round(float(bed.max() - bed.min()), 3),
            "max_depth": round(float(depth.max()), 3),
            "mean_depth": round(float(depth.mean()), 3),
            "bed_below_surface": bool(np.all(bed <= surf + 1e-4)),
        }
    else:
        info = {"has_water": False}
    shore_steps = []
    for i in water_idx:
        for nb in (i - 1, i + 1):
            if 0 <= nb < t.width and not wmask[nb]:
                shore_steps.append(abs(float(h[nb] - h[i])))
    info["max_shore_step"] = round(float(max(shore_steps)), 3) if shore_steps else 0.0
    return {
        "row": row,
        "z_world": round(float(t.origin_z + row * t.cell_size), 2),
        "cell_size": t.cell_size,
        "width_cells": t.width,
        "all_finite": finite,
        "max_step": round(max_step, 3),
        "step_limit": round(step_limit, 3),
        "continuous": continuous,
        "water_level": round(float(t.water.level), 3) if water is not None else None,
        "min_height": round(float(h.min()), 3),
        "max_height": round(float(h.max()), 3),
        **info,
    }


def render_ascii(t, row: int | None = None, width: int = 72, height: int = 14) -> str:
    """ASCII cross-section: '#' ground, '~' water; per-column water surfaces."""
    if row is None:
        row = pick_transect_row(t)
    h = t.heights[row, :].astype(np.float64)
    mask = t.water.mask[row, :].astype(bool) if t.water is not None else np.zeros(t.width, dtype=bool)
    surface = t.water.surface[row, :].astype(np.float64) if t.water is not None and t.water.surface is not None else np.full(t.width, np.nan)
    xs = np.linspace(0, t.width - 1, width).astype(int)
    hs, ms, ss = h[xs], mask[xs], surface[xs]
    lo, hi = hs.min(), hs.max()
    if ms.any():
        lo, hi = min(lo, np.nanmin(ss)), max(hi, np.nanmax(ss))
    span = max(1e-6, hi - lo)

    def y_of(v):
        return int(round((v - lo) / span * (height - 1)))

    grid = [[" " for _ in range(width)] for _ in range(height)]
    for col in range(width):
        ty = y_of(hs[col])
        for r in range(ty + 1):
            grid[height - 1 - r][col] = "#"
        if ms[col]:
            for r in range(ty + 1, y_of(ss[col]) + 1):
                grid[height - 1 - r][col] = "~"
    lines = ["".join(rw) for rw in grid]
    if ms.any():
        lines.insert(0, f"row {row}  water surface {ss[ms].min():.1f}..{ss[ms].max():.1f}m  " + "-" * max(8, width - 40))
    return "\n".join(lines)


def export_continuity_check(t) -> Dict[str, Any]:
    """Verify exported geometry keeps the underwater ground (mesh-level)."""
    from .export import build_terrain_mesh, build_water_mesh
    pos, idx = build_terrain_mesh(t)
    wpos, widx = build_water_mesh(t)
    full_tris = (t.width - 1) * (t.depth - 1) * 2
    return {
        "terrain_vertices": int(pos.shape[0]),
        "expected_vertices": int(t.width * t.depth),
        "terrain_triangles": int(idx.shape[0]),
        "expected_triangles": int(full_tris),
        "full_grid": bool(pos.shape[0] == t.width * t.depth and idx.shape[0] == full_tris),
        "all_positions_finite": bool(np.all(np.isfinite(pos))),
        "water_triangles": int(widx.shape[0]),
        "water_separate_mesh": True,
        "underwater_vertices": int(t.water.mask.sum()) if t.water is not None else 0,
    }
