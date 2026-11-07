"""Export / import of TerrainData.

JSON format (format_version 1) is shared with the web viewer and is the
canonical interchange format. Geometry exports (.obj) are convenience outputs;
renderers are expected to build meshes from the heightfield themselves.
"""
import json
import os
from typing import Any, Dict

import numpy as np

from .config import TerrainSettings
from .generator import TerrainData
from .water import WaterData

FORMAT_VERSION = 1


def to_dict(t: TerrainData) -> Dict[str, Any]:
    d = {
        "format_version": FORMAT_VERSION,
        "settings": t.settings.to_dict(),
        "metadata": t.metadata,
        "width": t.width,
        "depth": t.depth,
        "origin_x": t.origin_x,
        "origin_z": t.origin_z,
        "cell_size": t.cell_size,
        "spacing_x": t.spacing_x or t.cell_size,
        "spacing_z": t.spacing_z or t.cell_size,
        "heights": [round(float(v), 3) for v in t.heights.ravel()],
    }
    if t.water is not None:
        d["water"] = {
            "level": t.water.level,
            "mask": "".join("1" if v else "0" for v in t.water.mask.ravel()),
        }
        if t.water.surface is not None:
            d["water"]["surface"] = [round(float(v), 3) for v in t.water.surface.ravel()]
        if t.water.depth is not None:
            d["water"]["depth"] = [round(float(v), 3) for v in t.water.depth.ravel()]
        if t.water.lake_mask is not None:
            d["water"]["lake_mask"] = "".join("1" if v else "0" for v in t.water.lake_mask.ravel())
        if t.water.river_mask is not None:
            d["water"]["river_mask"] = "".join("1" if v else "0" for v in t.water.river_mask.ravel())
        d["water"]["lakes"] = t.water.lakes
        d["water"]["rivers"] = t.water.rivers
    return d


def export_json(t: TerrainData, path: str) -> None:
    with open(path, "w") as f:
        json.dump(to_dict(t), f)


def load_json(path: str) -> TerrainData:
    with open(path) as f:
        d = json.load(f)
    if d.get("format_version") != FORMAT_VERSION:
        raise ValueError(f"Unsupported format_version {d.get('format_version')}")
    heights = np.array(d["heights"], dtype=np.float32).reshape(d["depth"], d["width"])
    water = None
    if "water" in d:
        mask = np.frombuffer(d["water"]["mask"].encode(), dtype=np.uint8) == ord("1")
        wd = d["water"]
        shape = (d["depth"], d["width"])
        surface = np.array(wd["surface"], dtype=np.float32).reshape(shape) if "surface" in wd else None
        depth = np.array(wd["depth"], dtype=np.float32).reshape(shape) if "depth" in wd else None
        lake_mask = np.frombuffer(wd["lake_mask"].encode(), dtype=np.uint8) == ord("1") if "lake_mask" in wd else None
        river_mask = np.frombuffer(wd["river_mask"].encode(), dtype=np.uint8) == ord("1") if "river_mask" in wd else None
        water = WaterData(
            level=float(wd["level"]), mask=mask.reshape(shape), surface=surface, depth=depth,
            lake_mask=lake_mask.reshape(shape) if lake_mask is not None else None,
            river_mask=river_mask.reshape(shape) if river_mask is not None else None,
            lakes=wd.get("lakes", []), rivers=wd.get("rivers", []),
        )
    return TerrainData(
        heights=heights,
        origin_x=d["origin_x"],
        origin_z=d["origin_z"],
        cell_size=d["cell_size"],
        spacing_x=d.get("spacing_x", d["cell_size"]),
        spacing_z=d.get("spacing_z", d["cell_size"]),
        settings=TerrainSettings.from_dict(d["settings"]),
        metadata=d.get("metadata", {}),
        water=water,
    )


def export_npy(t: TerrainData, directory: str, stem: str = "terrain") -> None:
    os.makedirs(directory, exist_ok=True)
    np.save(os.path.join(directory, f"{stem}_heights.npy"), t.heights)
    if t.water is not None:
        np.save(os.path.join(directory, f"{stem}_water_mask.npy"), t.water.mask)
        if t.water.surface is not None:
            np.save(os.path.join(directory, f"{stem}_water_surface.npy"), t.water.surface)
        if t.water.depth is not None:
            np.save(os.path.join(directory, f"{stem}_water_depth.npy"), t.water.depth)
        if t.water.lake_mask is not None:
            np.save(os.path.join(directory, f"{stem}_lake_mask.npy"), t.water.lake_mask)
        if t.water.river_mask is not None:
            np.save(os.path.join(directory, f"{stem}_river_mask.npy"), t.water.river_mask)
    for name, layer in getattr(t, "layers", {}).items():
        np.save(os.path.join(directory, f"{stem}_{name}.npy"), layer)
    with open(os.path.join(directory, f"{stem}_meta.json"), "w") as f:
        json.dump({"settings": t.settings.to_dict(), "metadata": t.metadata,
                   "water_level": t.water.level if t.water else None}, f, indent=2)


def build_terrain_mesh(t: TerrainData):
    """Indexed triangle mesh (positions Nx3, indices Mx3) in world space.

    Always covers the FULL W×D grid — including lakebed vertices below the
    water level — so exported geometry retains the underwater ground. Water
    is exported separately via build_water_mesh().
    """
    gx, gz = t.world_coords()
    positions = np.stack([gx.ravel(), t.heights.ravel().astype(np.float64), gz.ravel()], axis=1)
    w, d = t.width, t.depth
    idx = np.arange(w * d).reshape(d, w)
    a = idx[:-1, :-1].ravel()
    b = idx[:-1, 1:].ravel()
    c = idx[1:, :-1].ravel()
    e = idx[1:, 1:].ravel()
    indices = np.concatenate([np.stack([a, c, b], 1), np.stack([b, c, e], 1)], axis=0)
    return positions, indices


def build_water_mesh(t: TerrainData):
    """Per-vertex water surface restricted to the water mask.

    Lake surfaces may vary by basin and rivers follow their descending
    centre-line surface. The mesh is separate from terrain; no terrain face is
    removed or displaced by this function.
    """
    if t.water is None or not t.water.mask.any():
        return np.zeros((0, 3)), np.zeros((0, 3), dtype=np.int64)
    gx, gz = t.world_coords()
    w, d = t.width, t.depth
    mask = t.water.mask
    surface = t.water.surface if t.water.surface is not None else np.full((d, w), t.water.level)
    # Water surface at vertices; extend over the dry one-cell shoreline ring
    # used by quads that straddle the mask edge.
    y = np.where(mask, surface, np.nan)
    for _ in range(2):
        padded = np.pad(y, 1, mode="constant", constant_values=np.nan)
        stack = np.stack([padded[:-2, 1:-1], padded[2:, 1:-1], padded[1:-1, :-2], padded[1:-1, 2:]], axis=0)
        with np.errstate(all="ignore"):
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                neighbor = np.nanmax(stack, axis=0)
        y = np.where(np.isnan(y), neighbor, y)
    fallback = float(t.water.level)
    y = np.where(np.isnan(y), fallback, y)

    active = np.zeros((d - 1, w - 1), dtype=bool)
    active = mask[:-1, :-1] | mask[:-1, 1:] | mask[1:, :-1] | mask[1:, 1:]
    corner_idx = np.stack([
        np.arange(w * d).reshape(d, w)[:-1, :-1],
        np.arange(w * d).reshape(d, w)[:-1, 1:],
        np.arange(w * d).reshape(d, w)[1:, :-1],
        np.arange(w * d).reshape(d, w)[1:, 1:],
    ], axis=-1)[active]
    unique_vertices, inverse = np.unique(corner_idx, return_inverse=True)
    if unique_vertices.size == 0:
        return np.zeros((0, 3)), np.zeros((0, 3), dtype=np.int64)
    rr, cc = np.divmod(unique_vertices, w)
    positions = np.stack([gx.ravel()[unique_vertices], y.ravel()[unique_vertices], gz.ravel()[unique_vertices]], axis=1)
    face_corners = inverse.reshape(-1, 4)
    a, b, c, e = face_corners[:, 0], face_corners[:, 1], face_corners[:, 2], face_corners[:, 3]
    indices = np.concatenate([np.stack([a, c, b], 1), np.stack([b, c, e], 1)], axis=0)
    return positions, indices

def export_obj(t: TerrainData, path: str, water: bool = False) -> None:
    positions, indices = build_water_mesh(t) if water else build_terrain_mesh(t)
    with open(path, "w") as f:
        f.write(f"# procedural terrain seed={t.settings.seed}\n")
        for p in positions:
            f.write(f"v {p[0]:.3f} {p[1]:.3f} {p[2]:.3f}\n")
        for tri in indices:
            f.write(f"f {tri[0] + 1} {tri[1] + 1} {tri[2] + 1}\n")
