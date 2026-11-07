"""Lightweight tests: python -m terrain.test_terrain"""
import numpy as np, os, tempfile
from terrain import TerrainSettings, generate_terrain, export_json, export_npy, export_obj, load_json
from terrain.generator import sample_height_field
from terrain.debug import transect_report, export_continuity_check, render_ascii
from terrain.water import generate_lake, detect_lakes, assemble_water
from terrain.noise import seed_orientation
from terrain.erosion import hydraulic_erosion, thermal_erosion
from terrain.hydrology import d8_drainage, fill_depressions
from terrain.rivers import build_river_network


def _directional_highland_correlation(t, direction_angle, distance):
    """Correlation of upper-quartile terrain along/across a range axis."""
    mask = t.heights > np.percentile(t.heights, 75)
    ca, sa = np.cos(direction_angle), np.sin(direction_angle)
    corrs = []
    for dx_dir, dz_dir in ((ca, sa), (-sa, ca)):
        dx = int(round(distance * dx_dir / t.cell_size))
        dz = int(round(distance * dz_dir / t.cell_size))
        x0, x1 = max(0, -dx), min(t.width, t.width - dx)
        z0, z1 = max(0, -dz), min(t.depth, t.depth - dz)
        a = mask[z0:z1, x0:x1].astype(np.float32).ravel()
        b = mask[z0 + dz:z1 + dz, x0 + dx:x1 + dx].astype(np.float32).ravel()
        corrs.append(float(np.corrcoef(a, b)[0, 1]))
    return corrs[0], corrs[1]

def run():
    a = generate_terrain(TerrainSettings(seed=1, resolution=96))
    b = generate_terrain(TerrainSettings(seed=1, resolution=96))
    c = generate_terrain(TerrainSettings(seed=2, resolution=96))
    assert np.array_equal(a.heights, b.heights), "determinism"
    assert not np.array_equal(a.heights, c.heights), "seed variation"
    assert a.water is not None and a.water.mask.sum() > 0, "lake"
    # chunk consistency: sample a sub-rectangle at global coords directly
    s = TerrainSettings(seed=7, resolution=64, erosion_quality=0, rivers_enabled=False)
    full = generate_terrain(TerrainSettings(seed=7, resolution=64, water_enabled=False, erosion_quality=0, rivers_enabled=False))
    gx, gz = full.world_coords()
    sub = sample_height_field(gx[10:30, 20:50], gz[10:30, 20:50], s) * s.height_scale
    assert np.allclose(sub.astype(np.float32), full.heights[10:30, 20:50]), "global-coordinate seamlessness"
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "t.json"); export_json(a, p); l = load_json(p)
        assert np.allclose(l.heights, a.heights, atol=1e-3) and l.settings.seed == 1
        assert np.array_equal(l.water.mask, a.water.mask)
        assert l.settings.mountain_frequency == a.settings.mountain_frequency
        export_npy(a, d, "roundtrip")
        export_obj(a, os.path.join(d, "terrain.obj"))
        export_obj(a, os.path.join(d, "water.obj"), water=True)
        assert np.array_equal(np.load(os.path.join(d, "roundtrip_heights.npy")), a.heights)
        with open(os.path.join(d, "terrain.obj"), encoding="utf-8") as f:
            terrain_obj = f.read().splitlines()
        with open(os.path.join(d, "water.obj"), encoding="utf-8") as f:
            water_obj = f.read().splitlines()
        terrain_faces = sum(line.startswith("f ") for line in terrain_obj)
        water_faces = sum(line.startswith("f ") for line in water_obj)
        terrain_verts = sum(line.startswith("v ") for line in terrain_obj)
        assert terrain_verts == a.width * a.depth, "OBJ omitted terrain vertices"
        assert terrain_faces == (a.width - 1) * (a.depth - 1) * 2, "OBJ terrain is not a full grid"
        assert 0 < water_faces < terrain_faces, "OBJ water must remain a separate surface"

    # Older settings exports still load and receive the current processing defaults.
    migrated = TerrainSettings.from_dict({"seed": 17, "settings_version": 1})
    assert migrated.settings_version == 3
    assert migrated.mountain_frequency == 1.0 and migrated.detail_scale == 42.0
    assert migrated.erosion_quality == 1 and migrated.rivers_enabled

    # --- Continuous underwater terrain contract ---
    t = generate_terrain(TerrainSettings(seed=42, resolution=128))
    assert t.water is not None and t.water.mask.any(), "expected a lake for seed 42"

    # 1. Water generation is read-only: heights identical before/after.
    before = t.heights.copy()
    w2 = generate_lake(t)
    w3 = generate_lake(t)
    assert np.array_equal(t.heights, before), "water step mutated terrain"
    assert np.array_equal(w2.mask, w3.mask) and w2.level == w3.level, "lake generation not deterministic"
    assert np.all(t.heights[t.water.mask] <= t.water.surface[t.water.mask] + 1e-4)

    # 2. Terrain present under the whole water surface: finite ground everywhere,
    #    lakebed below level with real relief (not flat, not deleted).
    assert np.all(np.isfinite(t.heights)), "non-finite heights (holes)"
    bed = t.heights[t.water.mask]
    wet_surface = t.water.surface[t.water.mask]
    assert np.all(bed <= wet_surface + 1e-4), "lakebed not submerged below its local surface"
    assert np.all(t.water.depth[t.water.mask] >= -1e-4), "negative water depth"
    assert float(bed.max() - bed.min()) > 0.5, "lakebed is flat — needs real elevation"
    assert float(bed.std()) > 0.2, "lakebed has no relief"

    # 3. Cross-section continuity: walkable uninterrupted ground through the lake.
    rep = transect_report(t)
    assert rep["has_water"], "transect misses the lake"
    assert rep["all_finite"] and rep["continuous"], f"transect not continuous: {rep}"
    assert rep["bed_below_surface"], "transect bed not below its water surface"
    assert rep["max_shore_step"] <= rep["step_limit"], f"shore cliff too steep: {rep}"

    # 4. Exported geometry retains underwater ground; water is a separate mesh.
    chk = export_continuity_check(t)
    assert chk["full_grid"], f"terrain mesh not full grid: {chk}"
    assert chk["all_positions_finite"], "exported terrain has holes"
    assert chk["underwater_vertices"] == int(t.water.mask.sum()) > 0, "underwater ground missing from export"
    assert chk["water_triangles"] > 0 and chk["water_separate_mesh"], "water mesh missing"

    # --- Formation controls and landscape diversity ---
    base_cfg = TerrainSettings(seed=42, resolution=96, water_enabled=False)
    base_h = generate_terrain(base_cfg).heights
    control_variants = (
        {"mountain_frequency": 0.55},
        {"mountain_height": 0.25},
        {"mountain_sharpness": 2.35},
        {"hill_amount": 0.05},
        {"valley_depth": 0.95},
        {"terrain_roughness": 1.1},
        {"detail_scale": 110.0},
    )
    for patch in control_variants:
        cfg = TerrainSettings(**{**base_cfg.to_dict(), **patch})
        changed = generate_terrain(cfg).heights
        assert not np.array_equal(base_h, changed), f"control has no effect: {patch}"
        assert float(np.mean(np.abs(base_h - changed))) > 0.1, f"control effect too small: {patch}"

    low_relief = generate_terrain(TerrainSettings(
        seed=42, resolution=96, water_enabled=False,
        mountain_amount=0.08, mountain_height=0.25, hill_amount=0.15,
        terrain_roughness=0.15,
    ))
    rolling = generate_terrain(TerrainSettings(
        seed=42, resolution=96, water_enabled=False,
        mountain_amount=0.12, mountain_height=0.35, hill_amount=0.95,
    ))
    alpine = generate_terrain(TerrainSettings(
        seed=42, resolution=96, water_enabled=False,
        mountain_amount=0.92, mountain_height=1.4, mountain_frequency=0.8,
        mountain_sharpness=2.2, terrain_roughness=0.8, valley_depth=0.8,
    ))
    assert rolling.heights.std() > low_relief.heights.std(), "rolling-hill preset not distinct"
    assert alpine.heights.std() > low_relief.heights.std() * 2.0, "mountain mass not distinct"

    # A highland mask stays correlated farther along the deterministic range
    # axis than across it, testing actual ridge continuity, not just appearance.
    axis_diffs = []
    for seed in (7, 42, 99):
        range_terrain = generate_terrain(TerrainSettings(
            seed=seed, resolution=192, water_enabled=False,
        ))
        along_corr, across_corr = _directional_highland_correlation(
            range_terrain, seed_orientation(seed), 120.0,
        )
        axis_diffs.append(along_corr - across_corr)
    assert float(np.mean(axis_diffs)) > 0.08, f"mountain ranges lack directional continuity: {axis_diffs}"

    # --- Phase 2: erosion, drainage, rivers and lakes ---
    assert t.layers.get("flow_accumulation") is not None
    assert t.layers["flow_accumulation"].shape == t.heights.shape
    assert t.layers["erosion"].shape == t.heights.shape
    assert np.all(np.isfinite(t.layers["erosion"]))
    assert np.all(t.layers["flow_accumulation"] >= 1.0)
    assert np.all((t.layers["flow_direction"] >= -1.0) & (t.layers["flow_direction"] <= 1.0))
    assert t.metadata["max_flow_accumulation"] > 100
    assert t.metadata["watershed_count"] > 0

    quality_runs = {}
    for quality in (0, 1, 2):
        quality_runs[quality] = generate_terrain(TerrainSettings(seed=21, resolution=96, erosion_quality=quality))
    repeat_high = generate_terrain(TerrainSettings(seed=21, resolution=96, erosion_quality=2))
    assert np.array_equal(quality_runs[2].heights, repeat_high.heights), "erosion not deterministic"
    assert quality_runs[0].metadata["hydraulic_droplets"] == 0
    assert quality_runs[1].metadata["hydraulic_droplets"] > 0
    assert quality_runs[2].metadata["hydraulic_droplets"] > quality_runs[1].metadata["hydraulic_droplets"]
    off = quality_runs[0].heights
    assert np.mean(np.abs(quality_runs[1].heights - off)) > 0.05, "hydraulic erosion has no visible effect"
    assert np.mean(np.abs(quality_runs[2].heights - off)) > np.mean(np.abs(quality_runs[1].heights - off)), "high quality did not deepen erosion"
    assert quality_runs[2].metadata["erosion_max_cut_m"] < 80.0

    base_processing = TerrainSettings(seed=55, resolution=96, water_enabled=False, erosion_quality=1, rivers_enabled=False)
    no_erosion = generate_terrain(TerrainSettings(**{**base_processing.to_dict(), "erosion_quality": 0})).heights
    hydraulic_only = generate_terrain(TerrainSettings(**{**base_processing.to_dict(), "thermal_enabled": False})).heights
    thermal_only = generate_terrain(TerrainSettings(**{**base_processing.to_dict(), "hydraulic_enabled": False})).heights
    assert np.mean(np.abs(hydraulic_only - no_erosion)) > 0.03, "hydraulic toggle ineffective"
    assert np.mean(np.abs(thermal_only - no_erosion)) > 0.001, "thermal toggle ineffective"
    assert not np.array_equal(hydraulic_only, thermal_only), "erosion stages not independent"

    spike = np.zeros((21, 21), dtype=np.float32)
    spike[10, 10] = 25.0
    thermal_settings = TerrainSettings(seed=1, erosion_quality=2, hydraulic_enabled=False, thermal_enabled=True, thermal_talus=25, thermal_strength=0.8)
    relaxed, _, _ = thermal_erosion(spike, thermal_settings, 5.0)
    assert relaxed[10, 10] < 25.0
    assert abs(float(relaxed.sum() - spike.sum())) < 0.05
    assert np.any(relaxed > 0)

    test_heights = np.asarray(generate_terrain(TerrainSettings(seed=42, resolution=96, water_enabled=False)).heights)
    routing = fill_depressions(test_heights, epsilon=0.0005)
    drainage = d8_drainage(routing, 1024 / 95)
    sinks = drainage.receiver == np.arange(test_heights.size)
    assert np.all(routing.ravel()[drainage.receiver[~sinks]] < routing.ravel()[~sinks]), "drainage receiver travels uphill"
    assert np.all(drainage.accumulation >= 1.0)

    river_terrain = generate_terrain(TerrainSettings(seed=99, resolution=128, erosion_quality=2))
    rmask = river_terrain.water.river_mask
    assert rmask.any()
    assert np.all(river_terrain.water.depth[rmask] >= 0)
    assert np.all(river_terrain.water.surface[rmask] >= river_terrain.heights[rmask] - 1e-4)
    from terrain.hydrology import connected_components
    river_components = sorted([c.size for c in connected_components(rmask)], reverse=True)
    assert river_components and river_components[0] >= 12, f"river network fragmented: {river_components[:5]}"
    assert river_terrain.metadata["river_count"] > 0 and river_terrain.metadata["river_carved_volume_m3"] > 0
    assert len(river_terrain.water.rivers) > 0

    # River width/depth controls affect geometry and incision independently.
    narrow_cfg = TerrainSettings(seed=99, resolution=128, erosion_quality=1, river_width=4.0, river_depth=0.6)
    wide_cfg = TerrainSettings(**{**narrow_cfg.to_dict(), "river_width": 20.0, "river_depth": 3.5})
    narrow_river = generate_terrain(narrow_cfg)
    wide_river = generate_terrain(wide_cfg)
    assert wide_river.water.river_mask.sum() > narrow_river.water.river_mask.sum(), "river width control ineffective"
    assert wide_river.metadata["river_carved_volume_m3"] > narrow_river.metadata["river_carved_volume_m3"], "river depth control ineffective"

    # Explicit downhill check on a pipeline-stage river network: every D8
    # centerline edge must have a non-increasing water surface.
    stage_cfg = TerrainSettings(seed=42, resolution=128, erosion_quality=1)
    stage_n = stage_cfg.resolution
    stage_cell = stage_cfg.world_width / (stage_n - 1)
    coords = np.arange(stage_n) * stage_cell
    sgx, sgz = np.meshgrid(coords, coords)
    stage_h = (sample_height_field(sgx, sgz, stage_cfg) * stage_cfg.height_scale).astype(np.float32)
    stage_h, _, _ = hydraulic_erosion(stage_h, stage_cfg)
    stage_h, _, _ = thermal_erosion(stage_h, stage_cfg, stage_cell)
    stage_route = fill_depressions(stage_h, epsilon=0.0005)
    stage_drainage = d8_drainage(stage_route, stage_cell)
    stage_lakes = detect_lakes(stage_h, stage_cfg, stage_cell)
    _, stage_network = build_river_network(stage_h, stage_drainage, stage_lakes.mask, stage_cfg, stage_cell)
    center = stage_network.centerline.ravel()
    stage_mask = stage_network.mask.ravel()
    stage_surface = stage_network.surface.ravel()
    uphill_pairs = 0
    checked_pairs = 0
    for flat in np.flatnonzero(center):
        target = int(stage_drainage.receiver[flat])
        if target == flat or not center[target] or not stage_mask[flat]:
            continue
        checked_pairs += 1
        if float(stage_surface[target] - stage_surface[flat]) > 0.02:
            uphill_pairs += 1
    assert checked_pairs > 100, "not enough river route to validate"
    assert uphill_pairs == 0, f"{uphill_pairs}/{checked_pairs} river surfaces travel uphill"

    yy, xx = np.mgrid[0:41, 0:41]
    rdistance = np.hypot(xx - 20, yy - 20)
    bowl = (45.0 + 0.02 * xx + 0.02 * yy + rdistance * 0.25).astype(np.float32)
    bowl -= np.maximum(0, 10 - rdistance).astype(np.float32) * 2.5
    lake_settings = TerrainSettings(seed=3, height_scale=100, water_level=0.1, basin_lakes_enabled=True, min_lake_depth=1.0)
    lakes = detect_lakes(bowl, lake_settings, 10.0)
    assert lakes.mask.any() and lakes.surface[lakes.mask].max() > lakes.level + 0.1
    assert np.all(bowl[lakes.mask] <= lakes.surface[lakes.mask] + 1e-4)

    # --- Riverbed terrain contract ---
    # Rivers must incise the source heightfield and place water inside the
    # resulting channel. These checks are the ones the correction had to pass.
    from terrain.debug import riverbed_report, river_sections, render_river_sections
    for seed, res in ((42, 128), (99, 96), (7, 160)):
        cfg = TerrainSettings(seed=seed, resolution=res)
        rt = generate_terrain(cfg)
        riverbed = riverbed_report(rt)
        assert riverbed["has_rivers"], f"no rivers for seed {seed}"
        assert riverbed["water_spill_edges"] == 0, f"{riverbed['water_spill_edges']} river edges stand above dry ground"
        assert riverbed["bed_below_water_surface"] and riverbed["positive_water_depth"]
        assert riverbed["water_has_terrain_beneath"] and riverbed["terrain_finite_everywhere"]
        assert riverbed["surface_min_m"] > riverbed["bed_min_m"], "water surface not above the riverbed"
        assert riverbed["sections_all_enclosed"], "river cross-section not enclosed by banks"
        assert riverbed["sections_bed_below_surface"] and riverbed["sections_terrain_above_bed"]
        assert riverbed["bed_slope_p50"] <= 0.25, f"riverbed too steep: {riverbed['bed_slope_p50']}"
        assert riverbed["gently_sloped_bed_fraction"] >= 0.95, "riverbed not walkable"
        assert riverbed["carved_bed_cells"] > riverbed["river_cells"] > 0

        # 1. The carve is in the source heightfield, not only in a rendered mesh.
        off = generate_terrain(TerrainSettings(**{**cfg.to_dict(), "rivers_enabled": False}))
        carved = rt.layers["river_bed_mask"].astype(bool)
        assert carved.any(), "no terrain was incised"
        assert np.all(rt.heights[carved] < off.heights[carved] - 0.02), "bed not carved into source data"
        # 2. Rivers only lower terrain: no fill, no floating shelf.
        assert np.all(rt.heights <= off.heights + 1e-4), "river pass raised terrain"
        # 3. Lakes keep their beds and masks exactly; erosion stays untouched.
        np.testing.assert_array_equal(rt.water.lake_mask, off.water.lake_mask)
        lake = rt.water.lake_mask.astype(bool)
        np.testing.assert_allclose(rt.heights[lake], off.heights[lake], atol=1e-6)
        assert np.allclose(rt.layers["hydraulic_delta"], off.layers["hydraulic_delta"])
        assert np.allclose(rt.layers["thermal_delta"], off.layers["thermal_delta"])
        # 4. Water is separate geometry above a real bed, with banks above it.
        river_sel = rt.water.river_mask.astype(bool)
        assert np.all(rt.water.surface[river_sel] > rt.heights[river_sel]), "water not above its bed"
        for section in riverbed["section_list"]:
            assert section["water_enclosed"] and section["terrain_above_bed"]
            assert section["all_terrain_finite"] and section["wet_cells"] >= 1
            assert max(section["heights"]) > (section["water_surface"] or 0.0)
        assert "~" in render_river_sections(rt, 2)

    # 5. River channels continue across chunk boundaries and survive export.
    from terrain.world import FiniteWorld, load_world
    boundary_rivers = 0
    export_terrain = generate_terrain(TerrainSettings(seed=99, resolution=128))
    chunks_world = FiniteWorld(export_terrain, 256.0, 256.0)
    river_mask_world = export_terrain.water.river_mask
    for chunk in chunks_world.chunks:
        x0, z0, x1, z1 = chunk["rect"]
        for x in range(x0, x1 + 1):
            boundary_rivers += int(river_mask_world[z0, x] or river_mask_world[z1, x])
        for z in range(z0, z1 + 1):
            boundary_rivers += int(river_mask_world[z, x0] or river_mask_world[z, x1])
    assert boundary_rivers > 0, "test world has no river crossing a chunk boundary"
    with tempfile.TemporaryDirectory() as d:
        chunks_world.export(d)
        restored = load_world(d)
        np.testing.assert_array_equal(restored.terrain.heights, export_terrain.heights)
        np.testing.assert_array_equal(restored.terrain.layers["river_bed_mask"],
                                      export_terrain.layers["river_bed_mask"])
        np.testing.assert_array_equal(restored.terrain.water.river_mask, export_terrain.water.river_mask)
        np.testing.assert_allclose(restored.terrain.water.surface, export_terrain.water.surface, atol=1e-5)
    with tempfile.TemporaryDirectory() as d:
        river_json = os.path.join(d, "river.json")
        export_json(river_terrain, river_json)
        reloaded = load_json(river_json)
        assert np.array_equal(reloaded.water.river_mask, river_terrain.water.river_mask)
        assert np.allclose(reloaded.water.surface, river_terrain.water.surface, atol=1e-3)
        assert np.allclose(reloaded.water.depth, river_terrain.water.depth, atol=1e-3)
        assert np.allclose(reloaded.heights, river_terrain.heights, atol=1e-3)

    transect = transect_report(river_terrain)
    assert transect["has_water"] and transect["bed_below_surface"]
    assert "~" in render_ascii(river_terrain)

    fingerprints = []
    for seed in (1, 7, 42, 99, 512):
        variant = generate_terrain(TerrainSettings(seed=seed, resolution=96, erosion_quality=1))
        fingerprints.append((float(variant.heights.std()), int(variant.water.mask.sum()), int(variant.water.river_mask.sum())))
    assert len(set(fingerprints)) == len(fingerprints), f"seeds did not vary hydrology: {fingerprints}"

    # NumPy vectorized generation remains interactive at the typical 256 grid.
    import time
    start = time.perf_counter()
    performance_sample = generate_terrain(TerrainSettings(seed=314, resolution=256))
    elapsed = time.perf_counter() - start
    assert performance_sample.heights.shape == (256, 256)
    assert elapsed < 4.0, f"256x256 terrain generation too slow: {elapsed:.2f}s"

    print("all tests passed", a.metadata)
    print("transect:", {k: rep[k] for k in ("row", "continuous", "max_step", "max_shore_step", "max_depth", "lakebed_relief")})
    print("export check:", chk)
    print("range axis correlation delta:", round(float(np.mean(axis_diffs)), 3))
    print("256x256 generation seconds:", round(elapsed, 3))

if __name__ == "__main__":
    run()
