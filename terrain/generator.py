"""Heightfield assembly.

The heightfield is sampled at *global world coordinates* derived from
(origin, cell_size, index). Because every layer is a pure function of world
position + seed, any sub-rectangle (future chunk) generated independently will
match the corresponding region of the full world exactly.
"""
from dataclasses import dataclass, field
from typing import Any, Dict, Optional
import time

import numpy as np

from .config import TerrainSettings
from . import noise as N
from .erosion import hydraulic_erosion, thermal_erosion
from .hydrology import d8_drainage, fill_depressions
from .rivers import RiverNetwork, build_river_network
from .water import LakeField, assemble_water, detect_lakes

GENERATOR_VERSION = "0.4.0"


@dataclass
class TerrainData:
    """Renderer-agnostic terrain dataset."""
    heights: np.ndarray            # (depth, width) float32, world units (Y up)
    origin_x: float
    origin_z: float
    cell_size: float               # world units between adjacent samples
    settings: TerrainSettings
    metadata: Dict[str, Any] = field(default_factory=dict)
    water: Optional["WaterData"] = None  # type: ignore[name-defined]
    layers: Dict[str, np.ndarray] = field(default_factory=dict)
    spacing_x: float | None = None
    spacing_z: float | None = None

    @property
    def width(self) -> int:
        return int(self.heights.shape[1])

    @property
    def depth(self) -> int:
        return int(self.heights.shape[0])

    def world_coords(self):
        """World-space X and Z grids matching `heights`."""
        xs = self.origin_x + np.arange(self.width) * (self.spacing_x or self.cell_size)
        zs = self.origin_z + np.arange(self.depth) * (self.spacing_z or self.cell_size)
        return np.meshgrid(xs, zs)

    def extract(self, x0: int, z0: int, w: int, d: int) -> "TerrainData":
        """Slice a sub-region (basis for future chunk extraction)."""
        from .water import WaterData
        sub = self.heights[z0:z0 + d, x0:x0 + w]
        water = None
        if self.water is not None:
            sl = np.s_[z0:z0 + d, x0:x0 + w]
            water = WaterData(
                level=self.water.level,
                mask=self.water.mask[sl],
                surface=self.water.surface[sl] if self.water.surface is not None else None,
                depth=self.water.depth[sl] if self.water.depth is not None else None,
                lake_mask=self.water.lake_mask[sl] if self.water.lake_mask is not None else None,
                river_mask=self.water.river_mask[sl] if self.water.river_mask is not None else None,
                lakes=list(self.water.lakes),
                rivers=list(self.water.rivers),
            )
        return TerrainData(
            heights=sub,
            origin_x=self.origin_x + x0 * (self.spacing_x or self.cell_size),
            origin_z=self.origin_z + z0 * (self.spacing_z or self.cell_size),
            cell_size=self.cell_size,
            spacing_x=self.spacing_x,
            spacing_z=self.spacing_z,
            settings=self.settings,
            metadata={**self.metadata, "extracted_from": [x0, z0, w, d]},
            water=water,
            layers={k: v[z0:z0 + d, x0:x0 + w] for k, v in self.layers.items()},
        )


def _terrace(h: np.ndarray, steps: float) -> np.ndarray:
    s = h * steps
    base = np.floor(s)
    f = s - base
    f3 = f * f * f
    g3 = (1.0 - f) ** 3
    sharp = f3 / (f3 + g3 + 1e-9)
    return (base + sharp) / steps


def sample_height_field(xs: np.ndarray, zs: np.ndarray, s: TerrainSettings) -> np.ndarray:
    """Normalized heights for arbitrary global coordinates (vectorized)."""
    seed = int(s.seed)
    f = s.base_frequency

    # Low-frequency warp bends formations without making every layer share one field.
    wx, wz = N.domain_warp(xs, zs, seed, s.warp_strength, f * 0.6)

    # A seed-derived orientation gives each world one long, coherent orogenic axis.
    angle = N.seed_orientation(seed)
    ca, sa = np.cos(angle), np.sin(angle)
    along = wx * ca + wz * sa
    across = -wx * sa + wz * ca

    # Broad continent context combined with an anisotropic range-belt field.
    continent = N.fbm(wx, wz, seed + 11, octaves=3, frequency=f * 0.58) * 0.5 + 0.5
    mf = max(0.1, float(s.mountain_frequency))
    range_context = N.fbm(
        along * 0.22, across * 0.90, seed + 31, octaves=3,
        frequency=f * 0.78 * mf, lacunarity=1.95, gain=0.55,
    ) * 0.5 + 0.5
    tectonic = 0.54 * continent + 0.46 * range_context
    lo = 0.68 - s.mountain_amount * 0.5
    mountain_mask = N.smoothstep(lo, lo + 0.20, tectonic)

    # Plains and rolling hills use distinct broad and medium scales.
    broad_hills = N.fbm(wx, wz, seed + 23, octaves=5, frequency=f * 1.45) * 0.5 + 0.5
    plains = 0.18 + broad_hills * 0.23 * s.hill_amount
    plains += N.fbm(xs, zs, seed + 29, octaves=2, frequency=f * 0.48) * 0.035
    rolling_detail = N.fbm(wx, wz, seed + 61, octaves=3, frequency=f * 2.7)
    plains += rolling_detail * (0.006 + 0.026 * s.terrain_roughness)

    # Anisotropic ridged multifractal spines create connected directional ranges;
    # smaller isotropic spurs provide peaks without uniformly distributed spikes.
    spine = N.ridged(
        along * 0.24, across * 0.95, seed + 37, octaves=6,
        frequency=f * 1.30 * mf, lacunarity=2.0, gain=0.5,
        sharpness=s.mountain_sharpness,
    )
    spurs = N.ridged(
        wx, wz, seed + 43, octaves=4, frequency=f * 2.65 * mf,
        lacunarity=2.06, gain=0.47,
        sharpness=max(0.8, s.mountain_sharpness * 0.9),
    )
    ridge_field = np.clip(
        spine * (0.88 - 0.18 * s.terrain_roughness)
        + spurs * (0.12 + 0.18 * s.terrain_roughness),
        0.0, 1.0,
    )
    mountain_relief = (0.11 + 0.63 * ridge_field) * s.mountain_height

    # A formation-specific foothill band softens the transition into plains.
    foothill_band = 4.0 * mountain_mask * (1.0 - mountain_mask)
    foothill_shape = N.fbm(
        along * 0.32, across * 0.72, seed + 47, octaves=3,
        frequency=f * 1.45 * mf,
    ) * 0.5 + 0.5
    foothills = foothill_band * (0.035 + 0.075 * foothill_shape)
    foothills *= (0.25 + 0.75 * s.hill_amount) * s.mountain_height
    h = plains + mountain_mask * mountain_relief + foothills

    # Trunk valleys and finer tributaries carve more strongly through uplands.
    trunk_noise = N.billow(wx, wz, seed + 53, octaves=4, frequency=f * 1.45)
    branch_noise = N.billow(wx, wz, seed + 67, octaves=3, frequency=f * 3.0)
    trunk_channel = 1.0 - N.smoothstep(0.0, 0.31, trunk_noise)
    branch_channel = 1.0 - N.smoothstep(0.0, 0.21, branch_noise)
    channel = np.clip(0.74 * trunk_channel + 0.26 * branch_channel, 0.0, 1.0)
    carve = channel * s.valley_depth * (0.25 + 0.10 * mountain_mask)
    carve *= N.smoothstep(0.10, 0.42, h)
    h -= carve

    # Localized escarpments, not global terracing.
    cliff_zone = mountain_mask * N.smoothstep(0.30, 0.55, h)
    cliff_noise = N.fbm(xs, zs, seed + 71, octaves=2, frequency=f * 1.1) * 0.5 + 0.5
    blend = np.clip(cliff_zone * s.cliff_amount * (0.5 + cliff_noise), 0.0, 0.85)
    h += (_terrace(h, 7.0) - h) * blend

    # Terrain-carved lake basins remain independent of the water mask.
    basin_n = N.fbm(wx, wz, seed + 113, octaves=3, frequency=f * 0.9) * 0.5 + 0.5
    rim0 = 0.30
    rim1 = rim0 + 0.08 + s.shore_softness * 0.12
    bowl = 1.0 - N.smoothstep(rim0, rim1, basin_n)
    lowland = (1.0 - mountain_mask * 0.85) * (1.0 - N.smoothstep(0.35, 0.60, h))
    bowl *= lowland
    profile = bowl * bowl * (3.0 - 2.0 * bowl)
    h -= profile * 0.10
    h += bowl * N.fbm(xs, zs, seed + 127, octaves=2, frequency=f * 6.0) * 0.01

    # Detail has an explicit world-space wavelength and does not change with grid density.
    detail_wavelength = max(2.0, float(s.detail_scale))
    detail_amplitude = 0.003 + 0.018 * s.terrain_roughness
    h += N.fbm(xs, zs, seed + 97, octaves=3, frequency=1.0 / detail_wavelength) * detail_amplitude

    return np.clip(h, 0.0, 1.0)


def generate_terrain(settings: TerrainSettings) -> TerrainData:
    """Generate a full TerrainData (heights + lake) from settings."""
    t0 = time.perf_counter()
    if not all(np.isfinite(v) and v > 0 for v in (settings.world_width, settings.world_depth, settings.height_scale)):
        raise ValueError("World dimensions and height scale must be positive and finite")
    if not 16 <= settings.resolution <= 1025:
        raise ValueError("Source resolution must be in [16, 1025]")
    res = int(settings.resolution)
    cell_x = settings.world_width / (res - 1)
    cell_z = settings.world_depth / (res - 1)
    cell = float(min(cell_x, cell_z))
    width = res
    depth = max(2, int(np.floor(settings.world_depth / cell + 0.5)) + 1)
    width = max(2, int(np.floor(settings.world_width / cell + 0.5)) + 1)
    if width * depth > 1_100_000:
        raise ValueError("Finite-world source grid exceeds 1.1 million samples")
    sx = settings.world_width / (width - 1)
    sz = settings.world_depth / (depth - 1)
    xs = settings.origin_x + np.arange(width, dtype=np.float64) * sx
    zs = settings.origin_z + np.arange(depth, dtype=np.float64) * sz
    gx, gz = np.meshgrid(xs, zs)

    h01 = sample_height_field(gx, gz, settings)
    base_heights = (h01 * settings.height_scale).astype(np.float32)
    t_base = time.perf_counter()

    # Stage 2: hydraulic erosion. Stage 3: independent thermal relaxation.
    eroded = base_heights.astype(np.float32, copy=True)
    hydraulic_delta = np.zeros_like(base_heights, dtype=np.float32)
    thermal_delta = np.zeros_like(base_heights, dtype=np.float32)
    droplets = 0
    thermal_iterations = 0
    if int(settings.erosion_quality) > 0:
        if settings.hydraulic_enabled:
            eroded, hydraulic_delta, droplets = hydraulic_erosion(eroded, settings)
        if settings.thermal_enabled:
            eroded, thermal_delta, thermal_iterations = thermal_erosion(eroded, settings, cell)
    t_erosion = time.perf_counter()

    # Stage 4: drainage. Depressions are filled only for routing so rivers
    # continue through lakes to their spill point; the real terrain is NOT
    # levelled and lakebeds remain intact. River centre lines exclude lake
    # surfaces, so no channel is ever carved through a lake.
    drainage_surface = fill_depressions(eroded, epsilon=0.0005)
    drainage = d8_drainage(drainage_surface, cell)
    t_drainage = time.perf_counter()

    # Stage 5: lake basins and river networks in their actual depressions.
    lake_field: LakeField = detect_lakes(eroded, settings, cell)
    river_network: RiverNetwork | None = None
    if settings.water_enabled and settings.rivers_enabled:
        eroded, river_network = build_river_network(
            eroded, drainage, lake_field.mask, settings, cell
        )
    t_rivers = time.perf_counter()

    heights = eroded.astype(np.float32)
    data = TerrainData(
        heights=heights,
        origin_x=settings.origin_x,
        origin_z=settings.origin_z,
        cell_size=cell,
        spacing_x=sx,
        spacing_z=sz,
        settings=settings,
    )
    # Stage 8: water surfaces are assembled independently of terrain geometry.
    data.water = assemble_water(heights, settings, cell, lake_field, river_network)
    data.layers = {
        "flow_accumulation": drainage.accumulation.astype(np.float32),
        "flow_direction": drainage.direction,
        "drainage_slope": drainage.slope,
        "watershed": drainage.watershed,
        "erosion": (heights - base_heights).astype(np.float32),
        "hydraulic_delta": hydraulic_delta,
        "thermal_delta": thermal_delta,
        "river_mask": (river_network.mask.astype(np.float32) if river_network else np.zeros_like(heights)),
        "lake_mask": lake_field.mask.astype(np.float32),
    }

    dt = time.perf_counter() - t0
    water_mask = data.water.mask if data.water is not None else np.zeros_like(heights, dtype=bool)
    meta = {
        "generator_version": GENERATOR_VERSION,
        "settings_version": settings.settings_version,
        "seed": settings.seed,
        "grid": [width, depth],
        "cell_size": cell,
        "min_height": float(heights.min()),
        "max_height": float(heights.max()),
        "generation_time_ms": round(dt * 1000.0, 2),
        "timing_ms": {
            "terrain": round((t_base - t0) * 1000.0, 2),
            "erosion": round((t_erosion - t_base) * 1000.0, 2),
            "drainage": round((t_drainage - t_erosion) * 1000.0, 2),
            "lakes_rivers": round((t_rivers - t_drainage) * 1000.0, 2),
            "water": round((time.perf_counter() - t_rivers) * 1000.0, 2),
        },
        "water_cells": int(water_mask.sum()),
        "lake_cells": int(lake_field.mask.sum()),
        "river_cells": int(river_network.mask.sum()) if river_network else 0,
        "river_count": len(river_network.rivers) if river_network else 0,
        "lake_count": len(data.water.lakes) if data.water else 0,
        "watershed_count": drainage.watershed_count,
        "max_flow_accumulation": int(drainage.accumulation.max()),
        "erosion_quality": int(settings.erosion_quality),
        "hydraulic_droplets": int(droplets),
        "thermal_iterations": int(thermal_iterations),
        "erosion_mean_abs_m": round(float(np.mean(np.abs(heights - base_heights))), 4),
        "erosion_max_cut_m": round(float(np.max(base_heights - heights)), 4),
        "erosion_max_fill_m": round(float(np.max(heights - base_heights)), 4),
        "river_carved_volume_m3": round(float(river_network.carved_volume), 2) if river_network else 0.0,
    }
    # Submerged-terrain diagnostics: water never removes ground.
    if np.any(water_mask):
        bed = heights[water_mask]
        depths = data.water.depth[water_mask] if data.water and data.water.depth is not None else np.maximum(0, data.water.level - bed)
        meta["lakebed_min"] = round(float(bed.min()), 3)
        meta["lakebed_max"] = round(float(bed.max()), 3)
        meta["lakebed_mean"] = round(float(bed.mean()), 3)
        meta["max_water_depth"] = round(float(np.max(depths)), 3)
        meta["water_level"] = round(float(data.water.level), 3)
        meta["underwater_terrain_cells"] = int(np.count_nonzero(water_mask))
    data.metadata = meta
    return data
