"""Versioned generation settings.

Every parameter that influences the output lives here so that
(seed, settings) fully determines the terrain.
"""
from dataclasses import dataclass, asdict, field
from typing import Any, Dict

SETTINGS_VERSION = 3


@dataclass
class TerrainSettings:
    seed: int = 42

    # World extent in world units (metres). origin_* allows chunk extraction later.
    world_width: float = 1024.0
    world_depth: float = 1024.0
    origin_x: float = 0.0
    origin_z: float = 0.0

    # Grid resolution: number of vertices along each axis.
    resolution: int = 256

    # Vertical scale of the final heightfield (world units).
    height_scale: float = 180.0

    # Shape controls (0..1 unless noted). Mountain frequency is a multiplier
    # on the base feature frequency; height is a normalized relief multiplier.
    mountain_amount: float = 0.55
    mountain_frequency: float = 1.0
    mountain_height: float = 1.0
    mountain_sharpness: float = 1.4
    hill_amount: float = 0.5
    valley_depth: float = 0.45
    cliff_amount: float = 0.6
    terrain_roughness: float = 0.45
    detail_scale: float = 42.0  # small-detail wavelength in world units (metres)
    warp_strength: float = 60.0     # domain warp in world units
    base_frequency: float = 1.0 / 420.0  # 1/world-units for the largest feature

    # Water
    water_enabled: bool = True
    water_level: float = 0.2  # normalized 0..1 of height_scale; lakes fill basins below
    shore_softness: float = 0.6
    basin_lakes_enabled: bool = True
    min_lake_depth: float = 1.5

    # Phase 2 processing. Quality independently selects simulation cost:
    # 0 = off, 1 = fast preview, 2 = high quality.
    erosion_quality: int = 1
    hydraulic_enabled: bool = True
    hydraulic_strength: float = 0.55
    thermal_enabled: bool = True
    thermal_talus: float = 34.0       # loose-material repose angle, degrees
    thermal_strength: float = 0.6
    rivers_enabled: bool = True
    river_density: float = 0.5
    river_width: float = 8.0          # base channel width, world metres
    river_depth: float = 1.4          # base channel incision, world metres

    settings_version: int = SETTINGS_VERSION

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "TerrainSettings":
        known = {k: v for k, v in d.items() if k in cls.__dataclass_fields__}
        # Older format-version-1 packages predate the formation controls. Let
        # dataclass defaults supply them and upgrade the settings schema.
        if int(known.get("settings_version", 1)) < SETTINGS_VERSION:
            known["settings_version"] = SETTINGS_VERSION
        return cls(**known)
