"""Terrain-aware lakes and final water-surface assembly.

Phase 2 contract:
- Lake detection is strictly READ-ONLY over the terrain.
- Lakes are real topographic depressions, filled either by the global water
  level or by detecting closed basins above it (Priority-Flood).
- Riverbeds are carved by rivers.py; this module only combines their separate
  surface with lake surfaces.
- Water is always a separate geometry. Terrain is never deleted or replaced.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Dict, List

import numpy as np

from .hydrology import connected_components, fill_depressions
from .rivers import RiverNetwork

if TYPE_CHECKING:
    from .generator import TerrainData


@dataclass
class WaterData:
    level: float
    mask: np.ndarray
    surface: np.ndarray | None = None
    depth: np.ndarray | None = None
    lake_mask: np.ndarray | None = None
    river_mask: np.ndarray | None = None
    lakes: List[Dict[str, Any]] = field(default_factory=list)
    rivers: List[Dict[str, Any]] = field(default_factory=list)


@dataclass
class LakeField:
    mask: np.ndarray
    surface: np.ndarray
    level: float
    lakes: List[Dict[str, Any]]
    cells: int = 0


def _lake_from_component(
    comp: np.ndarray,
    heights_flat: np.ndarray,
    surface_flat: np.ndarray,
    cols: int,
    cell_area: float,
    set_surface: bool,
) -> Dict[str, Any]:
    cells = comp.size
    bed = heights_flat[comp]
    surf = surface_flat[comp]
    depth = np.maximum(0.0, surf - bed)
    return {
        "cell_count": int(cells),
        "area_m2": round(float(cells * cell_area), 2),
        "surface_elevation_m": round(float(np.mean(surf)), 3),
        "lakebed_min_m": round(float(bed.min()), 3),
        "lakebed_max_m": round(float(bed.max()), 3),
        "max_depth_m": round(float(depth.max()), 3),
        "mean_depth_m": round(float(depth.mean()), 3),
        "centroid": [round(float(np.mean(comp % cols)), 2), round(float(np.mean(comp // cols)), 2)],
        "source": "global-level" if not set_surface else "closed-basin",
    }


def detect_lakes(heights: np.ndarray, settings: Any, cell_size: float) -> LakeField:
    """Find global-level and closed-basin lakes without touching terrain."""
    rows, cols = heights.shape
    total = heights.size
    h = np.asarray(heights, dtype=np.float64)
    level = float(settings.water_level * settings.height_scale)
    empty_surface = h.astype(np.float32)
    if not settings.water_enabled:
        return LakeField(np.zeros((rows, cols), dtype=bool), empty_surface, level, [])

    min_cells = max(10, int(total * 0.0018))
    mask_flat = np.zeros(total, dtype=bool)
    surface_flat = np.full(total, level, dtype=np.float64)
    lakes: List[Dict[str, Any]] = []

    # 1. Globally flooded lowlands. These are connected topographic low areas.
    below = h < level
    if below.any():
        for comp in connected_components(below):
            if comp.size < min_cells:
                continue
            mask_flat[comp] = True
            surface_flat[comp] = level
            lakes.append(_lake_from_component(comp, h.ravel(), surface_flat, cols, cell_size * cell_size, False))

    # 2. Closed basins above the global level. The diagnostic filled surface
    # identifies the spill elevation; capacity is measured against the real
    # depressed terrain, which remains in place.
    if getattr(settings, "basin_lakes_enabled", True):
        filled = fill_depressions(h)
        depression = filled - h
        candidates = (depression > 0.10) & (filled > level + 0.15)
        for comp in connected_components(candidates):
            if comp.size < min_cells:
                continue
            bed = h.ravel()[comp]
            local_surface = filled.ravel()[comp] - 0.08
            fillable = local_surface > bed + 0.03
            if np.count_nonzero(fillable) < min_cells:
                continue
            max_depth = float(np.max(local_surface - bed))
            if max_depth < float(getattr(settings, "min_lake_depth", 1.5)):
                continue
            cells = comp[fillable]
            mask_flat[cells] = True
            surface_flat[cells] = np.maximum(surface_flat[cells], local_surface[fillable])
            lakes.append(_lake_from_component(cells, h.ravel(), surface_flat, cols, cell_size * cell_size, True))

    # Connected component metadata after combining lake sources.
    combined_components = connected_components(mask_flat.reshape(rows, cols))
    lakes = []
    for comp in combined_components:
        if comp.size < min_cells:
            continue
        is_basin = bool(np.any(filled.ravel()[comp] > h.ravel()[comp] + 0.10)) if getattr(settings, "basin_lakes_enabled", True) else False
        lakes.append(_lake_from_component(comp, h.ravel(), surface_flat, cols, cell_size * cell_size, is_basin))
    lakes.sort(key=lambda item: item["area_m2"], reverse=True)

    return LakeField(
        mask=mask_flat.reshape(rows, cols),
        surface=np.where(mask_flat, surface_flat, h.ravel()).reshape(rows, cols).astype(np.float32),
        level=level,
        lakes=lakes,
        cells=int(np.count_nonzero(mask_flat)),
    )


def assemble_water(
    heights: np.ndarray,
    settings: Any,
    cell_size: float,
    lakes: LakeField | None = None,
    rivers: RiverNetwork | None = None,
) -> WaterData:
    """Combine lake and river surfaces into one renderer/export-friendly dataset."""
    rows, cols = heights.shape
    lake_field = lakes if lakes is not None else detect_lakes(heights, settings, cell_size)
    if not settings.water_enabled:
        empty = np.zeros((rows, cols), dtype=bool)
        return WaterData(
            level=lake_field.level,
            mask=empty,
            surface=heights.astype(np.float32, copy=True),
            depth=np.zeros((rows, cols), dtype=np.float32),
            lake_mask=empty.copy(),
            river_mask=empty.copy(),
        )

    lake_mask = lake_field.mask
    river_mask = rivers.mask if rivers is not None else np.zeros((rows, cols), dtype=bool)
    mask = lake_mask | river_mask
    heights_f = np.asarray(heights, dtype=np.float64)
    surface = heights_f.copy()
    surface = np.where(lake_mask, lake_field.surface, surface)
    if rivers is not None:
        river_surface = np.where(rivers.mask, rivers.surface, heights_f)
        # At shared lake mouths the lake's level is authoritative; elsewhere
        # the river follows its own descending surface.
        surface = np.where(river_mask & ~lake_mask, river_surface, surface)
        surface = np.where(lake_mask & river_mask, np.maximum(surface, river_surface), surface)
    depth = np.where(mask, np.maximum(0.0, surface - heights_f), 0.0)
    return WaterData(
        level=float(lake_field.level),
        mask=mask,
        surface=np.where(mask, surface, heights_f).astype(np.float32),
        depth=depth.astype(np.float32),
        lake_mask=lake_mask,
        river_mask=river_mask,
        lakes=lake_field.lakes,
        rivers=rivers.rivers if rivers is not None else [],
    )


def generate_lake(terrain: "TerrainData") -> WaterData:
    """Backward-compatible lake-only water pass (read-only over terrain)."""
    return assemble_water(terrain.heights, terrain.settings, terrain.cell_size)


def generate_water(
    terrain: "TerrainData",
    lakes: LakeField | None = None,
    rivers: RiverNetwork | None = None,
) -> WaterData:
    """Full lake + river water pass, independent of terrain generation."""
    return assemble_water(terrain.heights, terrain.settings, terrain.cell_size, lakes, rivers)
