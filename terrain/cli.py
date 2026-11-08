"""Command line entry point.

    python -m terrain.cli --seed 42 --resolution 256 --out out/

Writes terrain.json (viewer-compatible), heights .npy, meta json, and OBJ meshes.
"""
import argparse
import os

from .config import TerrainSettings
from .generator import generate_terrain
from .export import export_json, export_npy, export_obj


def main(argv=None):
    p = argparse.ArgumentParser(description="Procedural terrain generator v0.4 - finite worlds")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--resolution", type=int, default=256)
    p.add_argument("--width", type=float, default=1024.0)
    p.add_argument("--depth", type=float, default=1024.0)
    p.add_argument("--height-scale", type=float, default=180.0)
    p.add_argument("--mountains", type=float, default=0.55)
    p.add_argument("--mountain-frequency", type=float, default=1.0,
                   help="mountain spacing multiplier; higher creates more frequent ranges")
    p.add_argument("--mountain-height", type=float, default=1.0,
                   help="mountain relief multiplier")
    p.add_argument("--mountain-sharpness", type=float, default=1.4)
    p.add_argument("--hills", type=float, default=0.5)
    p.add_argument("--valleys", type=float, default=0.45)
    p.add_argument("--cliffs", type=float, default=0.6)
    p.add_argument("--roughness", type=float, default=0.45)
    p.add_argument("--detail-scale", type=float, default=42.0,
                   help="fine-detail wavelength in metres")
    p.add_argument("--quality", type=int, choices=(0, 1, 2), default=1,
                   help="0=off, 1=fast preview, 2=high quality erosion")
    p.add_argument("--no-hydraulic", action="store_true")
    p.add_argument("--no-thermal", action="store_true")
    p.add_argument("--hydraulic-strength", type=float, default=0.55)
    p.add_argument("--talus", type=float, default=34.0, help="thermal repose angle (degrees)")
    p.add_argument("--no-rivers", action="store_true")
    p.add_argument("--river-density", type=float, default=0.5)
    p.add_argument("--river-width", type=float, default=8.0)
    p.add_argument("--river-depth", type=float, default=1.4)
    p.add_argument("--water-level", type=float, default=0.2)
    p.add_argument("--no-basin-lakes", action="store_true")
    p.add_argument("--no-water", action="store_true")
    p.add_argument("--obj", action="store_true", help="also write OBJ meshes")
    p.add_argument("--chunks", action="store_true", help="also write a finite-world manifest and independent chunk files")
    p.add_argument("--chunk-width", type=float, default=256.0)
    p.add_argument("--chunk-depth", type=float, default=256.0)
    p.add_argument("--cross-section", action="store_true",
                   help="print ASCII cross-section through the largest lake + continuity report")
    p.add_argument("--river-sections", action="store_true",
                   help="print perpendicular cross-sections through several rivers and the riverbed report")
    p.add_argument("--materials-report", action="store_true",
                   help="print the material distribution (plains / hills / mountains) and transition metrics")
    p.add_argument("--snow-line", type=float, default=None, help="normalized elevation where snow settles (0..1)")
    p.add_argument("--rock-slope", type=float, default=None, help="normalized slope where bare rock starts to win")
    p.add_argument("--out", default="out")
    a = p.parse_args(argv)

    s = TerrainSettings(
        seed=a.seed, resolution=a.resolution, world_width=a.width, world_depth=a.depth,
        height_scale=a.height_scale, mountain_amount=a.mountains,
        mountain_frequency=a.mountain_frequency, mountain_height=a.mountain_height,
        mountain_sharpness=a.mountain_sharpness, hill_amount=a.hills,
        valley_depth=a.valleys, cliff_amount=a.cliffs,
        terrain_roughness=a.roughness, detail_scale=a.detail_scale,
        erosion_quality=a.quality, hydraulic_enabled=not a.no_hydraulic,
        thermal_enabled=not a.no_thermal, hydraulic_strength=a.hydraulic_strength,
        thermal_talus=a.talus, rivers_enabled=not a.no_rivers,
        river_density=a.river_density, river_width=a.river_width, river_depth=a.river_depth,
        water_level=a.water_level, basin_lakes_enabled=not a.no_basin_lakes,
        water_enabled=not a.no_water,
    )
    t = generate_terrain(s)
    os.makedirs(a.out, exist_ok=True)
    export_json(t, os.path.join(a.out, "terrain.json"))
    export_npy(t, a.out)
    from .materials import MaterialSettings, compute_materials
    material_settings = MaterialSettings()
    if a.snow_line is not None:
        material_settings.snow_line = a.snow_line
    if a.rock_slope is not None:
        material_settings.rock_slope = a.rock_slope
    if a.chunks:
        from .world import FiniteWorld, VisualSettings
        world = FiniteWorld(t, a.chunk_width, a.chunk_depth, VisualSettings(material=material_settings))
        world.export(os.path.join(a.out, "world"))
        print(f"Exported {world.columns} x {world.rows} chunks with shared normals and LOD 0/1/2")
    if a.obj:
        export_obj(t, os.path.join(a.out, "terrain.obj"))
        export_obj(t, os.path.join(a.out, "water.obj"), water=True)
    print(f"Generated {t.width}x{t.depth} terrain, seed={s.seed}")
    for k, v in t.metadata.items():
        print(f"  {k}: {v}")
    if a.cross_section:
        from .debug import transect_report, render_ascii, export_continuity_check
        print()
        print(render_ascii(t))
        print()
        for k, v in transect_report(t).items():
            print(f"  transect.{k}: {v}")
        for k, v in export_continuity_check(t).items():
            print(f"  export.{k}: {v}")
    if a.river_sections:
        from .debug import render_river_sections, riverbed_report
        print()
        print(render_river_sections(t, 5))
        report = riverbed_report(t)
        for k, v in report.items():
            if k == "section_list":
                continue
            print(f"  riverbed.{k}: {v}")
    if a.materials_report:
        from .materials import render_material_report
        print()
        print(render_material_report(t, material_settings))
        field = compute_materials(t, material_settings)
        print(f"  materials.albedo_mean: {[round(float(v), 3) for v in field.albedo.mean(axis=0)]}")
    print(f"Output written to {a.out}/")


if __name__ == "__main__":
    main()
