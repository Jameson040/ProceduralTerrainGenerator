"""Finite-world views, shared normals, conforming LOD and independent exports.

Generation and hydrology run once, before this module is called. Chunk cells
have one owner; shared vertices are copied from a single global dataset.
LOD preserves every boundary sample and all wet cells. Transition-cell fans
join coarse interiors to those rings without skirts or T-junctions.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path
import json
import math
import numpy as np

from .generator import TerrainData, generate_terrain
from .config import TerrainSettings
from .water import WaterData

WORLD_VERSION = "1.0.0"


def global_normals(h, sx, sz):
    dz, dx = np.gradient(np.asarray(h, dtype=np.float64), sz, sx)
    n = np.stack([-dx, np.ones_like(h), -dz], axis=-1)
    out = (n / np.linalg.norm(n, axis=-1, keepdims=True)).astype(np.float32)
    out[out == 0] = 0.0
    return out


def resolved_water(t):
    if t.water is None:
        return t.heights.copy()
    y = np.where(t.water.mask, t.water.surface if t.water.surface is not None else t.water.level, np.nan).astype(np.float32)
    for _ in range(2):
        p = np.pad(y, 1, constant_values=np.nan)
        ns = np.stack([p[1:-1, :-2], p[1:-1, 2:], p[:-2, 1:-1], p[2:, 1:-1]])
        count = np.isfinite(ns).sum(axis=0)
        mean = np.nansum(ns.astype(np.float64), axis=0) / np.maximum(count, 1)
        y = np.where(np.isnan(y) & (count > 0), mean, y).astype(np.float32)
    return np.where(np.isfinite(y), y, t.heights).astype(np.float32)


def source_hash(t):
    h = 2166136261
    arrays = [np.asarray(t.heights, dtype="<f4")]
    if t.water is not None:
        arrays.extend([np.asarray(t.water.surface, dtype="<f4"), np.asarray(t.water.mask, dtype=np.uint8)])
    for array in arrays:
        for byte in array.tobytes():
            h = ((h ^ byte) * 16777619) & 0xFFFFFFFF
    return f"{h:08x}"


@dataclass
class MeshBuffers:
    positions: np.ndarray
    normals: np.ndarray
    uvs: np.ndarray
    indices: np.ndarray
    samples: np.ndarray

    def to_dict(self):
        return {k: getattr(self, k).ravel().tolist() for k in ("positions", "normals", "uvs", "indices", "samples")}


class FiniteWorld:
    def __init__(self, terrain: TerrainData, chunk_width=256.0, chunk_depth=256.0):
        if not all(math.isfinite(v) and v > 0 for v in (chunk_width, chunk_depth)):
            raise ValueError("Chunk dimensions must be positive and finite")
        # Legacy heightfield exports stored just one water level and a mask.
        if terrain.water is not None and terrain.water.surface is None:
            old = terrain.water
            surface = np.where(old.mask, old.level, terrain.heights).astype(np.float32)
            terrain = replace(terrain, water=WaterData(old.level, old.mask, surface,
                np.maximum(surface - terrain.heights, 0).astype(np.float32),
                old.mask.copy(), np.zeros_like(old.mask), old.lakes, old.rivers))
        self.terrain = terrain
        self.sx, self.sz = terrain.spacing_x or terrain.cell_size, terrain.spacing_z or terrain.cell_size
        w, d = terrain.width, terrain.depth
        cx = max(1, min(w - 1, int(math.floor(chunk_width / self.sx + 0.5))))
        cz = max(1, min(d - 1, int(math.floor(chunk_depth / self.sz + 0.5))))
        self.chunk_cells = [cx, cz]
        self.columns, self.rows = math.ceil((w - 1) / cx), math.ceil((d - 1) / cz)
        if self.columns * self.rows > 4096:
            raise ValueError("Use larger chunks: at most 4096 chunks are supported")
        self.layout = {"chunk_width": chunk_width, "chunk_depth": chunk_depth}
        self.id = f"world-{terrain.settings.seed}-{w}x{d}-{source_hash(terrain)}"
        self.normals = global_normals(terrain.heights, self.sx, self.sz)
        self.water_surface = resolved_water(terrain)
        self.water_normals = global_normals(self.water_surface, self.sx, self.sz)
        self.water_cells = np.zeros((d - 1, w - 1), dtype=bool)
        if terrain.water is not None:
            m = terrain.water.mask
            self.water_cells = m[:-1, :-1] | m[:-1, 1:] | m[1:, :-1] | m[1:, 1:]
        # Riverbeds and their banks are incised source geometry: coarse LOD must
        # not flatten the channel, so the carved footprint is protected as well.
        self.protected_cells = self.water_cells.copy()
        bed = terrain.layers.get("river_bed_mask") if terrain.layers else None
        if bed is not None:
            b = np.asarray(bed) > 0.5
            self.protected_cells = self.protected_cells | b[:-1, :-1] | b[:-1, 1:] | b[1:, :-1] | b[1:, 1:]
        self.prefix = np.pad(self.protected_cells.astype(np.int64).cumsum(0).cumsum(1), ((1, 0), (1, 0)))
        self.chunks = []
        self.meshes = {}
        def cid(x, z):
            return f"c_{x}_{z}" if 0 <= x < self.columns and 0 <= z < self.rows else None
        for z in range(self.rows):
            for x in range(self.columns):
                self.chunks.append({
                    "id": cid(x, z), "coord": [x, z],
                    "rect": [x * cx, z * cz, min((x + 1) * cx, w - 1), min((z + 1) * cz, d - 1)],
                    "neighbors": {"north": cid(x, z - 1), "east": cid(x + 1, z), "south": cid(x, z + 1), "west": cid(x - 1, z)},
                })

    def header(self):
        t = self.terrain
        return {
            "id": self.id, "source_shape": [t.width, t.depth], "origin": [t.origin_x, t.origin_z],
            "spacing": [self.sx, self.sz], "dimensions": [(t.width - 1) * self.sx, (t.depth - 1) * self.sz],
            "chunk_grid": [self.columns, self.rows], "chunk_cells": self.chunk_cells,
            "layout": self.layout, "settings": t.settings.to_dict(), "metadata": {**t.metadata, "source": "python"},
            "water_info": {"level": t.water.level, "lakes": t.water.lakes, "rivers": t.water.rivers} if t.water else None,
            "coordinates": "global-x-y-z-metres", "winding": "clockwise-from-above-left-handed-y-up",
            "normals": "global-source-central-differences", "stitching": "pinned-source-boundary-and-conforming-transition-fans-no-skirts",
        }

    def mesh(self, chunk, lod=0, water=False):
        if isinstance(chunk, str):
            chunk = next(c for c in self.chunks if c["id"] == chunk)
        if lod not in (0, 1, 2):
            raise ValueError("LOD must be 0, 1 or 2")
        key = f"{chunk['id']}:{'water' if water else lod}"
        if key in self.meshes:
            return self.meshes[key]
        t = self.terrain
        x0, z0, x1, z1 = chunk["rect"]
        positions, normals, uvs, samples, indices = [], [], [], [], []
        vertex_map = {}
        field = self.water_surface if water else t.heights
        nf = self.water_normals if water else self.normals
        def sample(a, x, z):
            u, v = int(x), int(z)
            r, b = min(t.width - 1, u + 1), min(t.depth - 1, v + 1)
            fx, fz = x - u, z - v
            return (a[v, u].astype(np.float64) * (1 - fx) + a[v, r] * fx) * (1 - fz) + (a[b, u].astype(np.float64) * (1 - fx) + a[b, r] * fx) * fz
        def vert(x, z):
            if (x, z) in vertex_map:
                return vertex_map[x, z]
            index = len(positions)
            vertex_map[x, z] = index
            positions.append([t.origin_x + x * self.sx, sample(field, x, z), t.origin_z + z * self.sz])
            if float(x).is_integer() and float(z).is_integer():
                normal = nf[int(z), int(x)]
            else:
                normal = sample(nf, x, z)
                normal /= np.linalg.norm(normal)
            normals.append(normal)
            uvs.append([x / (t.width - 1), z / (t.depth - 1)])
            samples.append([x, z])
            return index
        def quad(x, z, r, b):
            a, e, c, f = vert(x, z), vert(r, z), vert(x, b), vert(r, b)
            indices.extend([[a, e, c], [e, f, c]])
        if water:
            for z in range(z0, z1):
                for x in range(x0, x1):
                    if self.water_cells[z, x]:
                        quad(x, z, x + 1, z + 1)
        else:
            stride = 2 ** lod
            horizontal, vertical, cells = {}, {}, []
            def point(x, z):
                horizontal.setdefault(z, set()).add(x)
                vertical.setdefault(x, set()).add(z)
            def add(x, z, r, b):
                cells.append((x, z, r, b))
                for u, v in ((x, z), (r, z), (x, b), (r, b)):
                    point(u, v)
            for z in range(z0, z1, stride):
                for x in range(x0, x1, stride):
                    r, b = min(x1, x + stride), min(z1, z + stride)
                    p = self.prefix
                    wet = p[b, r] - p[z, r] - p[b, x] + p[z, x] > 0
                    if stride > 1 and wet:
                        for v in range(z, b):
                            for u in range(x, r):
                                add(u, v, u + 1, v + 1)
                    else:
                        add(x, z, r, b)
            for x in range(x0, x1 + 1):
                point(x, z0)
                point(x, z1)
            for z in range(z0, z1 + 1):
                point(x0, z)
                point(x1, z)
            for x, z, r, b in cells:
                ring = [(x, z)] + [(u, z) for u in range(x + 1, r) if u in horizontal[z]] + [(r, z)]
                ring += [(r, v) for v in range(z + 1, b) if v in vertical[r]] + [(r, b)]
                ring += [(u, b) for u in range(r - 1, x, -1) if u in horizontal[b]] + [(x, b)]
                ring += [(x, v) for v in range(b - 1, z, -1) if v in vertical[x]]
                if len(ring) == 4:
                    quad(x, z, r, b)
                else:
                    center = vert((x + r) / 2, (z + b) / 2)
                    perimeter = [vert(u, v) for u, v in ring]
                    indices.extend([[center, perimeter[k], perimeter[(k + 1) % len(ring)]] for k in range(len(ring))])
        mesh = MeshBuffers(
            np.asarray(positions, dtype=np.float32).reshape(-1, 3), np.asarray(normals, dtype=np.float32).reshape(-1, 3),
            np.asarray(uvs, dtype=np.float32).reshape(-1, 2), np.asarray(indices, dtype=np.uint32).reshape(-1, 3),
            np.asarray(samples, dtype=np.float32).reshape(-1, 2),
        )
        self.meshes[key] = mesh
        return mesh

    def extract(self, chunk):
        if isinstance(chunk, str):
            chunk = next(c for c in self.chunks if c["id"] == chunk)
        x0, z0, x1, z1 = chunk["rect"]
        sl = np.s_[z0:z1 + 1, x0:x1 + 1]
        t = self.terrain
        def values(a):
            return a[sl].ravel().tolist()
        water = None
        if t.water:
            wt = t.water
            water = {"mask": values(wt.mask.astype(np.uint8)), "surface": values(wt.surface), "depth": values(wt.depth),
                     "lake_mask": values(wt.lake_mask.astype(np.uint8)), "river_mask": values(wt.river_mask.astype(np.uint8))}
        return {
            "kind": "terrain-chunk", "version": WORLD_VERSION, "world": self.header(), "chunk": chunk,
            "source": {"shape": [x1 - x0 + 1, z1 - z0 + 1], "heights": values(t.heights), "normals": values(self.normals),
                       "water_mesh_surface": values(self.water_surface), "water_normals": values(self.water_normals),
                       "water": water, "layers": {k: values(v) for k, v in t.layers.items()}},
            "lods": [{"level": l, "interior_stride": 2 ** l, "boundary_stride": 1, "water_refinement": True,
                      "mesh": self.mesh(chunk, l).to_dict()} for l in range(3)],
            "water_mesh": self.mesh(chunk, 0, True).to_dict(),
        }

    def export_chunk(self, chunk, path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.extract(chunk), separators=(",", ":")), encoding="utf-8")
        return path

    def export(self, directory):
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        manifest = {"kind": "terrain-world", "version": WORLD_VERSION, "world": self.header(), "chunks": []}
        for c in self.chunks:
            file = f"chunks/{c['id']}.json"
            self.export_chunk(c, directory / file)
            manifest["chunks"].append({**c, "file": file})
        (directory / "world.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        return directory / "world.json"


def generate_world(settings, chunk_width=256.0, chunk_depth=256.0):
    return FiniteWorld(generate_terrain(settings), chunk_width, chunk_depth)


def balance_lods(chunks, requested):
    levels = dict(requested)
    changed = True
    while changed:
        changed = False
        for c in chunks:
            for n in c["neighbors"].values():
                if n in levels and c["id"] in levels and levels[c["id"]] > levels[n] + 1:
                    levels[c["id"]] = levels[n] + 1
                    changed = True
    return levels


def load_world(directory):
    """Reconstruct exported source data; never runs formation or erosion."""
    directory = Path(directory)
    manifest = json.loads((directory / "world.json").read_text())
    if manifest.get("kind") != "terrain-world" or manifest.get("version") != WORLD_VERSION:
        raise ValueError("Unsupported world manifest")
    header = manifest["world"]
    w, d = header["source_shape"]
    if w * d > 1_100_000:
        raise ValueError("World exceeds source-sample limit")
    h = np.zeros((d, w), dtype=np.float32)
    n = np.zeros((d, w, 3), dtype=np.float32)
    ws = np.zeros_like(h)
    wn = np.zeros_like(n)
    seen = np.zeros((d, w), dtype=bool)
    layers, packets = {}, []
    water = None
    if header["water_info"]:
        info = header["water_info"]
        water = WaterData(info["level"], np.zeros((d, w), dtype=bool), h.copy(), h.copy(),
                          np.zeros((d, w), dtype=bool), np.zeros((d, w), dtype=bool), info["lakes"], info["rivers"])
    for desc in manifest["chunks"]:
        p = json.loads((directory / desc["file"]).read_text())
        if p["version"] != WORLD_VERSION or p["world"]["id"] != header["id"]:
            raise ValueError("Chunk belongs to a different world/version")
        packets.append(p)
        x0, z0, x1, z1 = p["chunk"]["rect"]
        sl = np.s_[z0:z1 + 1, x0:x1 + 1]
        shape = (z1 - z0 + 1, x1 - x0 + 1)
        def assign(target, values, components=1):
            a = np.asarray(values, dtype=target.dtype).reshape((*shape, components) if components > 1 else shape)
            if not np.isfinite(a).all() or not np.array_equal(target[sl][seen[sl]], a[seen[sl]]):
                raise ValueError("Invalid data or shared source boundary mismatch")
            target[sl] = a
        assign(h, p["source"]["heights"])
        assign(n, p["source"]["normals"], 3)
        assign(ws, p["source"]["water_mesh_surface"])
        assign(wn, p["source"]["water_normals"], 3)
        if water:
            for k in ("mask", "surface", "depth", "lake_mask", "river_mask"):
                assign(getattr(water, k), p["source"]["water"][k])
        for k, v in p["source"]["layers"].items():
            if k not in layers:
                layers[k] = np.zeros_like(h)
            assign(layers[k], v)
        seen[sl] = True
    if not seen.all():
        raise ValueError("Missing source samples in complete world")
    t = TerrainData(h, *header["origin"], min(header["spacing"]), TerrainSettings.from_dict(header["settings"]),
                    header["metadata"], water, layers, *header["spacing"])
    world = FiniteWorld(t, **header["layout"])
    if world.id != header["id"]:
        raise ValueError("Complete-world source fingerprint mismatch")
    world.id, world.normals, world.water_surface, world.water_normals = header["id"], n, ws, wn
    for p in packets:
        for level, m in [(str(l["level"]), l["mesh"]) for l in p["lods"]] + [("water", p["water_mesh"])]:
            world.meshes[f"{p['chunk']['id']}:{level}"] = MeshBuffers(
                *[np.array(m[k], dtype=np.uint32 if k == "indices" else np.float32).reshape(-1, size)
                  for k, size in (("positions", 3), ("normals", 3), ("uvs", 2), ("indices", 3), ("samples", 2))])
    return world