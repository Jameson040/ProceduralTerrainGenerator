"""Procedural terrain generation core (v0.1).

Engine-agnostic: depends only on NumPy. Produces TerrainData that any renderer
(Babylon.js, Three.js, ...) can consume.
"""
from .config import TerrainSettings, SETTINGS_VERSION
from .generator import generate_terrain, TerrainData
from .water import generate_lake, generate_water, detect_lakes, assemble_water, WaterData, LakeField
from .erosion import hydraulic_erosion, thermal_erosion
from .hydrology import d8_drainage, fill_depressions
from .rivers import build_river_network, RiverNetwork
from .export import export_json, export_npy, export_obj, load_json
from .debug import transect_report, render_ascii, export_continuity_check
from .world import FiniteWorld, generate_world, load_world, balance_lods

__all__ = [
    "TerrainSettings", "SETTINGS_VERSION", "generate_terrain", "TerrainData",
    "generate_lake", "generate_water", "detect_lakes", "assemble_water", "WaterData", "LakeField",
    "hydraulic_erosion", "thermal_erosion", "d8_drainage", "fill_depressions",
    "build_river_network", "RiverNetwork",
    "export_json", "export_npy", "export_obj", "load_json",
    "transect_report", "render_ascii", "export_continuity_check",
    "FiniteWorld", "generate_world", "load_world", "balance_lods",
]
