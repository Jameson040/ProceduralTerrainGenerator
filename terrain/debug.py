"""Cross-section / continuity diagnostics for the underwater-terrain contract.

Used by the test-suite and by ``python -m terrain.cli --cross-section`` to prove:
- the terrain heightfield is complete under every lake (no holes),
- the lakebed has real elevation with natural shore transitions,
- water is a separate level placed over terrain depressions,
- exported geometry retains the submerged ground.

``river_sections`` / ``riverbed_report`` do the same for rivers: the water is a
separate surface placed inside a channel that was actually incised into the
source heightfield, with banks above the waterline and continuous bed terrain.
"""
import math
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


# ---------------------------------------------------------------------------
# Riverbed cross-sections
# ---------------------------------------------------------------------------
# The river correction is validated by cutting perpendicular sections through
# several rivers and checking the geometry, not by trusting the water mask.
#
#   python -m terrain.cli --seed 42 --resolution 256 --river-sections
#
# Every section prints terrain, water surface and riverbed, and every check in
# ``riverbed_report`` must hold for an exported world as well.

def _flow_unit(t, flat: int) -> tuple[float, float]:
    """Unit flow direction (dr, dc) recovered from the D8 flow-direction layer."""
    layers = getattr(t, "layers", {}) or {}
    direction = layers.get("flow_direction")
    if direction is None:
        return 0.0, 1.0
    value = float(np.asarray(direction).ravel()[flat])
    if not np.isfinite(value):
        return 0.0, 1.0
    angle = value * 2.0 * np.pi - np.pi
    dc, dr = float(np.cos(angle)), float(np.sin(angle))
    length = math.hypot(dr, dc)
    if length <= 1e-9:
        return 0.0, 1.0
    return dr / length, dc / length


def _cell_at(t, r: float, c: float) -> "tuple[int, int] | None":
    rr = int(math.floor(r + 0.5))
    cc = int(math.floor(c + 0.5))
    if 0 <= rr < t.depth and 0 <= cc < t.width:
        return rr, cc
    return None


def river_sections(t, count: int = 5, reach: int = 5) -> "list[Dict[str, Any]]":
    """Perpendicular cross-sections through several rivers.

    Section centres are the deepest channel cells, kept spatially apart so the
    report samples different rivers. ``reach`` is the half-length in cells.
    Every section reports the real terrain profile, the per-cell water surface
    and whether the geometry forms an enclosed channel at that point.
    """
    if t.water is None or t.water.river_mask is None or not t.water.river_mask.any():
        return []
    river = np.asarray(t.water.river_mask, dtype=bool)
    lake = (np.asarray(t.water.lake_mask, dtype=bool)
            if t.water.lake_mask is not None else np.zeros_like(river))
    heights = np.asarray(t.heights, dtype=np.float64)
    wet = np.asarray(t.water.mask, dtype=bool)
    surface = (np.asarray(t.water.surface, dtype=np.float64)
               if t.water.surface is not None else np.full_like(heights, t.water.level))
    depth = (np.asarray(t.water.depth, dtype=np.float64)
             if t.water.depth is not None else np.maximum(0.0, surface - heights))
    bed_layer = (getattr(t, "layers", {}) or {}).get("river_bed_mask")

    candidates = river & ~lake
    if not candidates.any():
        candidates = river
    order = np.argsort(-depth.ravel()[candidates.ravel()], kind="stable")
    min_sep = max(6.0, min(t.width, t.depth) / 12.0)
    picked: list[tuple[int, int]] = []
    for flat in np.flatnonzero(candidates.ravel())[order]:
        r, c = divmod(int(flat), t.width)
        if all(math.hypot(r - pr, c - pc) >= min_sep for pr, pc in picked):
            picked.append((r, c))
        if len(picked) >= count * 8:
            break

    def build(r: int, c: int) -> "Dict[str, Any] | None":
        flat = r * t.width + c
        dr, dc = _flow_unit(t, flat)
        perp_r, perp_c = -dc, dr
        rows: "list[int]" = []
        cols: "list[int]" = []
        profile: "list[float]" = []
        profile_surface: "list[float]" = []
        profile_wet: "list[bool]" = []
        for k in range(-reach, reach + 1):
            cell = _cell_at(t, r + perp_r * k, c + perp_c * k)
            if cell is None:
                continue
            rr, cc = cell
            rows.append(rr)
            cols.append(cc)
            profile.append(float(heights[rr, cc]))
            profile_surface.append(float(surface[rr, cc]) if wet[rr, cc] else float("nan"))
            profile_wet.append(bool(wet[rr, cc]))
        if not profile:
            return None
        wet_idx = [i for i, w in enumerate(profile_wet) if w]
        wet_height = min((profile[i] for i in wet_idx), default=float("nan"))
        wet_surface = max((profile_surface[i] for i in wet_idx), default=float("nan"))
        dry_left = list(range(0, wet_idx[0])) if wet_idx else []
        dry_right = list(range(wet_idx[-1] + 1, len(profile))) if wet_idx else []
        bank_left = max((profile[i] for i in dry_left), default=float("nan"))
        bank_right = max((profile[i] for i in dry_right), default=float("nan"))
        banks_above = bool(
            wet_idx and dry_left and dry_right
            and bank_left > wet_surface + 1e-6 and bank_right > wet_surface + 1e-6
        )
        enclosed = bool(
            wet_idx and dry_left and dry_right
            and profile[0] > wet_surface + 1e-6 and profile[-1] > wet_surface + 1e-6
        )
        slope_left = slope_right = 0.0
        if wet_idx and dry_left:
            slope_left = max(0.0, (profile[wet_idx[0] - 1] - profile[wet_idx[0]]) / t.cell_size)
        if wet_idx and dry_right:
            slope_right = max(0.0, (profile[wet_idx[-1] + 1] - profile[wet_idx[-1]]) / t.cell_size)
        bed_steps = [abs(profile[i + 1] - profile[i]) for i in wet_idx if i + 1 in wet_idx]
        return {
            "cell": [int(r), int(c)],
            "world": [round(t.origin_x + c * (t.spacing_x or t.cell_size), 2),
                      round(t.origin_z + r * (t.spacing_z or t.cell_size), 2)],
            "flow": [round(dr, 3), round(dc, 3)],
            "rows": rows,
            "cols": cols,
            "heights": [round(v, 3) for v in profile],
            "surface": [round(v, 3) if np.isfinite(v) else None for v in profile_surface],
            "wet": profile_wet,
            "carved": [bool(bed_layer[rr, cc]) if bed_layer is not None else False
                       for rr, cc in zip(rows, cols)],
            "center_index": int(min(range(len(profile)), key=lambda i: profile[i])),
            "bed": round(float(heights[r, c]), 3),
            "water_surface": round(float(surface[r, c]), 3) if wet[r, c] else None,
            "depth": round(float(depth[r, c]), 3),
            "wet_cells": len(wet_idx),
            "bed_below_surface": bool(wet_idx and wet_height < wet_surface),
            "water_below_banks": banks_above,
            "water_enclosed": enclosed,
            "terrain_above_bed": bool(wet_idx and bank_left > wet_height and bank_right > wet_height),
            "bank_slope_left": round(slope_left, 3),
            "bank_slope_right": round(slope_right, 3),
            "max_bed_step_m": round(max(bed_steps), 3) if bed_steps else 0.0,
            "max_bed_slope": round(max(bed_steps) / t.cell_size, 3) if bed_steps else 0.0,
            "all_terrain_finite": bool(np.all(np.isfinite(profile))),
        }

    sections: "list[Dict[str, Any]]" = []
    full_sections: "list[Dict[str, Any]]" = []
    for r, c in picked:
        section = build(int(r), int(c))
        if section is None:
            continue
        full_sections.append(section)
        # Prefer reaches that are enclosed on both sides: a section cut through
        # the outside of a bend would say nothing about the channel shape.
        if section["water_enclosed"]:
            sections.append(section)
        if len(sections) >= count:
            break
    if len(sections) < count:
        for section in full_sections:
            if section not in sections:
                sections.append(section)
            if len(sections) >= count:
                break
    for index, section in enumerate(sections):
        section["river_index"] = index
    return sections


def render_river_sections(t, count: int = 5) -> str:
    """ASCII perpendicular sections: '#' terrain, '~' water, '+' carved bed."""
    lines: "list[str]" = []
    for section in river_sections(t, count):
        heights = section["heights"]
        surface = section["surface"]
        wet = section["wet"]
        values = list(heights) + [v for v in surface if v is not None]
        lo, hi = min(values), max(values)
        span = max(hi - lo, 1e-6)
        height = 12
        grid = [[" " for _ in heights] for _ in range(height)]

        def level(value: float) -> int:
            return int(round((value - lo) / span * (height - 1)))

        for col, value in enumerate(heights):
            for row in range(level(value) + 1):
                grid[height - 1 - row][col] = "#"
        for col, value in enumerate(surface):
            if value is None or not wet[col]:
                continue
            for row in range(level(heights[col]) + 1, level(value) + 1):
                grid[height - 1 - row][col] = "~"
        bed_col = min(range(len(heights)), key=lambda i: heights[i])
        grid[height - 1 - level(heights[bed_col])][bed_col] = "+"
        surf = section["water_surface"]
        lines.append(
            "river section {idx}  cell {cell}  world {world}  bed {bed:.2f} m  "
            "surface {surf}  depth {depth:.2f} m  ({wet} wet cells)".format(
                idx=section["river_index"], cell=tuple(section["cell"]),
                world=tuple(section["world"]), bed=section["bed"],
                surf=("n/a" if surf is None else "{:.2f} m".format(surf)),
                depth=section["depth"], wet=section["wet_cells"]))
        lines.extend("".join(row) for row in grid)
        lines.append(
            "  banks above water {}  enclosed {}  terrain above bed {}  "
            "bank slope L/R {:.2f}/{:.2f}  max bed slope {:.2f}".format(
                section["water_below_banks"], section["water_enclosed"],
                section["terrain_above_bed"], section["bank_slope_left"],
                section["bank_slope_right"], section["max_bed_slope"]))
        lines.append("")
    return "\n".join(lines)


def riverbed_report(t) -> "Dict[str, Any]":
    """Whole-world invariants for the riverbed-terrain contract."""
    if t.water is None or t.water.river_mask is None or not np.any(t.water.river_mask):
        return {"has_rivers": False}
    heights = np.asarray(t.heights, dtype=np.float64)
    river = np.asarray(t.water.river_mask, dtype=bool)
    lake = (np.asarray(t.water.lake_mask, dtype=bool)
            if t.water.lake_mask is not None else np.zeros_like(river))
    wet = np.asarray(t.water.mask, dtype=bool)
    surface = (np.asarray(t.water.surface, dtype=np.float64)
               if t.water.surface is not None else np.full_like(heights, t.water.level))
    depth = (np.asarray(t.water.depth, dtype=np.float64)
             if t.water.depth is not None else np.maximum(0.0, surface - heights))
    bed_layer = (getattr(t, "layers", {}) or {}).get("river_bed_mask")
    rows, cols = heights.shape

    # A wet cell may never stand above a neighbouring dry cell's ground.
    # Edge-pad wetness so a border cell does not invent a phantom dry neighbour.
    river_pad = np.pad(river, 1)
    wet_pad = np.pad(wet, 1, mode="edge")
    surf_pad = np.pad(surface, 1, mode="edge")
    ground_pad = np.pad(heights, 1, mode="edge")
    edges = 0
    spill = 0
    for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        neighbour_wet = wet_pad[1 + dr:1 + dr + rows, 1 + dc:1 + dc + cols]
        neighbour_ground = ground_pad[1 + dr:1 + dr + rows, 1 + dc:1 + dc + cols]
        dry = river_pad[1:-1, 1:-1] & ~neighbour_wet
        edges += int(dry.sum())
        spill += int((dry & (surf_pad[1:-1, 1:-1] > neighbour_ground + 1e-4)).sum())

    river_cells = river & ~lake
    river_wet = wet & river_cells
    river_depth = depth[river_wet] if river_wet.any() else np.zeros(0)
    dry_of_rivers = ~wet
    below_surface = bool(np.all(heights[wet] <= surface[wet] + 1e-4)) if wet.any() else True
    positive_depth = bool(np.all(depth[wet] >= -1e-4)) if wet.any() else True
    dry_above_water = bool(np.all(heights[dry_of_rivers] >= 0.0))  # full grid, no holes

    # Longitudinal walkability of the carved riverbed along the D8 course.
    steps: "list[float]" = []
    hflat = heights.ravel()
    for flat in np.flatnonzero(river.ravel()):
        r, c = divmod(int(flat), cols)
        dr, dc = _flow_unit(t, int(flat))
        if abs(dr) < 1e-6 and abs(dc) < 1e-6:
            continue
        nxt = _cell_at(t, r + dr, c + dc)
        if nxt is None or not river[nxt]:
            continue
        nr, nc = nxt
        steps.append(abs(float(hflat[nr * cols + nc]) - float(hflat[flat])))
    step_array = np.asarray(steps, dtype=np.float64) if steps else np.zeros(1)
    slope = step_array / max(t.cell_size, 1e-9)
    sections = river_sections(t, 5)
    return {
        "has_rivers": True,
        "river_cells": int(river_cells.sum()),
        "carved_bed_cells": int(np.count_nonzero(bed_layer > 0.5)) if bed_layer is not None else 0,
        "carved_volume_m3": t.metadata.get("river_carved_volume_m3", 0.0),
        "terrain_finite_everywhere": bool(np.all(np.isfinite(heights))),
        "water_has_terrain_beneath": bool(np.all(np.isfinite(heights[wet]))) if wet.any() else True,
        "dry_ground_present": dry_above_water,
        "bed_below_water_surface": below_surface,
        "positive_water_depth": positive_depth,
        "water_spill_edges": int(spill),
        "water_edge_pairs": int(edges),
        "bed_min_m": round(float(heights[river_cells].min()), 3) if river_cells.any() else None,
        "bed_mean_m": round(float(heights[river_cells].mean()), 3) if river_cells.any() else None,
        "surface_min_m": round(float(surface[wet].min()), 3) if wet.any() else None,
        "surface_max_m": round(float(surface[wet].max()), 3) if wet.any() else None,
        "max_water_depth_m": round(float(river_depth.max()), 3) if river_depth.size else None,
        "mean_water_depth_m": round(float(river_depth.mean()), 3) if river_depth.size else None,
        "bed_step_max_m": round(float(step_array.max()), 3),
        "bed_slope_p50": round(float(np.percentile(slope, 50)), 3),
        "bed_slope_p95": round(float(np.percentile(slope, 95)), 3),
        "walkable_bed_fraction": round(float(np.mean(slope <= 0.6)) if steps else 0.0, 3),
        "gently_sloped_bed_fraction": round(float(np.mean(slope <= 1.0)) if steps else 0.0, 3),
        "bed_step_count": int(step_array.size),
        "rivers": len(t.water.rivers),
        "section_count": len(sections),
        "sections_all_enclosed": bool(sections) and all(s["water_enclosed"] for s in sections),
        "sections_bed_below_surface": bool(sections) and all(s["bed_below_surface"] for s in sections),
        "sections_terrain_above_bed": bool(sections) and all(s["terrain_above_bed"] for s in sections),
        "sections_max_bed_slope": max((s["max_bed_slope"] for s in sections), default=0.0),
        "section_list": sections,
    }
