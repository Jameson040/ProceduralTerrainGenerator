"""Terrain material system, mirroring src/terrain/materials.ts.

Materials are a derived field over the finished source grid: elevation, slope,
aspect, flow, curvature, water proximity and the carved river-bed mask decide the
mix. Nothing here changes the heightfield, so materials can be re-tuned or
re-exported without rerunning formation, erosion or hydrology.

Snow, sand, gravel, soil and rock are all plain registry entries; a new material
only needs an albedo plus a weight function (see `MATERIALS`).
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Callable, Dict, List, Sequence

import numpy as np

from .noise import fbm

MATERIAL_FORMAT_VERSION = 1

# Channel order. Index in this list is the channel in every weights array.
MATERIAL_IDS: Sequence[str] = ("sand", "gravel", "grass", "dry_grass", "soil", "rock", "snow")


@dataclass
class MaterialSettings:
    rock_slope: float = 0.30
    sand_shore_m: float = 5.0
    snow_line: float = 0.78
    soil_bias: float = 0.35
    variation: float = 0.55
    texture_scale_m: float = 9.0
    quality: int = 2

    def to_dict(self) -> Dict[str, float]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Dict[str, float] | None) -> "MaterialSettings":
        if not d:
            return cls()
        known = {k: v for k, v in d.items() if k in cls.__dataclass_fields__}
        return cls(**known)


@dataclass
class WaterVisual:
    opacity: float = 0.86
    lake_shallow: Sequence[float] = (0.44, 0.70, 0.66)
    lake_deep: Sequence[float] = (0.10, 0.30, 0.42)
    river_shallow: Sequence[float] = (0.46, 0.68, 0.60)
    river_deep: Sequence[float] = (0.11, 0.32, 0.36)
    depth_scale_m: float = 2.2
    motion: float = 0.35
    wave_scale_m: float = 14.0
    gloss: float = 0.72

    def to_dict(self) -> Dict[str, object]:
        return {k: (list(v) if isinstance(v, tuple) else v) for k, v in asdict(self).items()}

    @classmethod
    def from_dict(cls, d: Dict[str, object] | None) -> "WaterVisual":
        if not d:
            return cls()
        known = {k: (tuple(v) if isinstance(v, (list, tuple)) else v) for k, v in d.items() if k in cls.__dataclass_fields__}
        return cls(**known)


def smooth(edge0, edge1, x):
    """Array-safe smoothstep. Reversed edges are allowed (edge1 < edge0)."""
    e0 = np.asarray(edge0, dtype=np.float64)
    e1 = np.asarray(edge1, dtype=np.float64)
    v = np.asarray(x, dtype=np.float64)
    denom = e1 - e0
    safe = np.where(denom == 0, 1.0, denom)
    t = np.where(denom == 0, (v >= e0).astype(np.float64), (v - e0) / safe)
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def srgb_to_linear(c):
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


# --------------------------------------------------------------------------- rules
@dataclass
class MaterialDef:
    id: str
    label: str
    albedo: Sequence[float]
    roughness: float
    specular: float
    weight: Callable[[Dict[str, np.ndarray], MaterialSettings], np.ndarray]


def _sand(s, m):
    return ((1 - s["submerged"]) * (1 - smooth(m.sand_shore_m * 0.45, m.sand_shore_m, s["height_above_water"]))
            * (1 - smooth(0.22, 0.5, s["slope"])) * smooth(0.1, 0.42, s["wetness"]))


def _gravel(s, m):
    return (0.85 * s["river_bed"] + 0.8 * s["submerged"]
            + 0.55 * smooth(0.45, 0.95, s["flow"]) * (1 - smooth(0.42, 0.7, s["slope"]))
            + 0.35 * smooth(0.1, 0.35, s["curvature"]) * (1 - smooth(0.3, 0.6, s["slope"]))
            + 0.12 * s["detail"])


def _grass(s, m):
    return ((1 - s["submerged"]) * (1 - smooth(0.42, 0.72, s["elevation"]))
            * (1 - smooth(0.24, 0.52, s["slope"])) * (1 - 0.8 * s["river_bed"])
            * (1 - 0.7 * m.soil_bias * smooth(-0.2, 0.5, s["variation"]))
            * (1 + 0.25 * s["detail"]))


def _dry_grass(s, m):
    return ((1 - s["submerged"]) * smooth(0.25, 0.6, s["elevation"])
            * (1 - smooth(0.3, 0.62, s["slope"]))
            * (0.35 + 0.65 * smooth(-0.3, 0.6, s["aspect"]))
            * (0.45 + 0.55 * m.soil_bias) * (1 - 0.6 * s["river_bed"]))


def _soil(s, m):
    return ((1 - s["submerged"]) * smooth(0.18, 0.34, s["slope"])
            * (1 - smooth(0.5, 0.78, s["slope"])) * (0.35 + 0.65 * m.soil_bias)
            * (1 - 0.5 * s["river_bed"]) * (0.6 + 0.4 * smooth(0.05, 0.5, -s["curvature"])))


def _rock(s, m):
    steep = smooth(m.rock_slope * 0.72, m.rock_slope * 1.25, s["slope"])
    cliff = smooth(0.12, 0.42, s["curvature"])
    high = smooth(0.42, 0.82, s["elevation"])
    alpine = high * smooth(0.08, 0.34, s["slope"])
    return steep * (0.75 + 0.35 * high) + 0.45 * cliff * (0.4 + 0.6 * steep) + 0.75 * alpine


def _snow(s, m):
    line = m.snow_line + 0.06 * s["variation"]
    return (1 - s["submerged"]) * smooth(line - 0.1, line + 0.07, s["elevation"]) * (1 - smooth(0.5, 0.82, s["slope"]))


MATERIALS: List[MaterialDef] = [
    MaterialDef("sand", "Sand", (0.78, 0.71, 0.55), 0.82, 0.06, _sand),
    MaterialDef("gravel", "Gravel", (0.55, 0.53, 0.48), 0.74, 0.10, _gravel),
    MaterialDef("grass", "Grass", (0.33, 0.47, 0.21), 0.90, 0.03, _grass),
    MaterialDef("dry_grass", "Dry grass", (0.56, 0.55, 0.31), 0.92, 0.03, _dry_grass),
    MaterialDef("soil", "Soil", (0.40, 0.30, 0.21), 0.88, 0.04, _soil),
    MaterialDef("rock", "Rock", (0.45, 0.43, 0.41), 0.58, 0.22, _rock),
    MaterialDef("snow", "Snow", (0.94, 0.95, 0.98), 0.45, 0.14, _snow),
]


@dataclass
class MaterialField:
    ids: List[str]
    weights: np.ndarray  # (n, k) normalised
    albedo: np.ndarray   # (n, 3) linear
    settings: MaterialSettings

    def to_export(self, shape) -> Dict[str, object]:
        """Per-source-sample masks as the chunk format stores them (u8-linear-v1)."""
        return {
            "format": "u8-linear-v1", "version": MATERIAL_FORMAT_VERSION, "ids": list(self.ids),
            "weights": np.round(np.clip(self.weights, 0, 1) * 255).astype(np.uint8).ravel().tolist(),
            "albedo": np.round(np.clip(self.albedo, 0, 1) * 255).astype(np.uint8).ravel().tolist(),
            "shape": [int(shape[0]), int(shape[1])],
        }


def material_inputs(terrain, normals: np.ndarray | None = None) -> Dict[str, np.ndarray]:
    """Every continuous terrain property the rules read."""
    t = terrain
    h = np.asarray(t.heights, dtype=np.float64)
    sx, sz = getattr(t, "spacing_x", t.cell_size), getattr(t, "spacing_z", t.cell_size)
    if normals is None:
        dz, dx = np.gradient(h, sz, sx)
        n = np.stack([-dx, np.ones_like(h), -dz], axis=-1)
        n /= np.linalg.norm(n, axis=-1, keepdims=True)
        normals = n
    lo = float(t.metadata.get("min_height", h.min()))
    hi = float(t.metadata.get("max_height", h.max()))
    relief = max(1e-3, hi - lo)
    level = float(t.water.level) if t.water is not None else lo

    mask = np.asarray(t.water.mask, dtype=np.float64) if t.water is not None else np.zeros_like(h)
    surface = np.asarray(t.water.surface, dtype=np.float64) if t.water is not None else np.full_like(h, level)
    local_surface = np.where(mask > 0, surface, level)
    above = h - local_surface

    laplacian = (np.roll(h, 1, 0) + np.roll(h, -1, 0) + np.roll(h, 1, 1) + np.roll(h, -1, 1) - 4 * h) / (2 * (sx + sz))
    laplacian[0, :] = laplacian[1, :]
    laplacian[-1, :] = laplacian[-2, :]
    laplacian[:, 0] = laplacian[:, 1]
    laplacian[:, -1] = laplacian[:, -2]

    flow = np.asarray(t.layers.get("flow_accumulation"), dtype=np.float64) if t.layers and "flow_accumulation" in t.layers else None
    if flow is not None:
        flow = np.log1p(flow) / max(1e-6, np.log1p(flow.max()))
    bed = np.asarray(t.layers["river_bed_mask"], dtype=np.float64) if t.layers and "river_bed_mask" in t.layers else np.zeros_like(h)

    # Shore halo: 0.55 one cell inland, ~0.30 two cells inland, then nothing.
    halo = mask.copy()
    for _ in range(2):
        prev = halo.copy()
        best = prev.copy()
        best[1:, :] = np.maximum(best[1:, :], prev[:-1, :])
        best[:-1, :] = np.maximum(best[:-1, :], prev[1:, :])
        best[:, 1:] = np.maximum(best[:, 1:], prev[:, :-1])
        best[:, :-1] = np.maximum(best[:, :-1], prev[:, 1:])
        halo = np.maximum(prev, best * 0.55)
    # One 3x3 blur turns the halo into a gradual gradient instead of a step.
    padded = np.pad(halo, 1, mode="edge")
    halo = sum(padded[1 + dz:padded.shape[0] - 1 + dz, 1 + dx:padded.shape[1] - 1 + dx]
               for dz in (-1, 0, 1) for dx in (-1, 0, 1)) / 9.0

    seed = int(getattr(t.settings, "seed", 0)) & 0xFFFFFFFF
    yy, xx = np.meshgrid(np.arange(t.depth), np.arange(t.width), indexing="ij")
    wx = t.origin_x + xx * sx
    wz = t.origin_z + yy * sz
    variation = np.vectorize(lambda a, b: fbm(a, b, seed ^ 0x9E37, 2), otypes=[np.float64])(wx / 140.0, wz / 140.0)
    detail = np.vectorize(lambda a, b: fbm(a, b, seed ^ 0x51ED, 2), otypes=[np.float64])(wx / 26.0, wz / 26.0)

    return {
        "elevation": np.clip((h - lo) / relief, 0, 1),
        "height_above_water": above,
        "slope": np.clip(1 - normals[..., 1], 0, 1),
        "aspect": normals[..., 2],
        "flow": flow if flow is not None else np.zeros_like(h),
        "curvature": np.clip(laplacian / (relief * 0.08), -1, 1),
        "river_bed": np.clip(bed, 0, 1),
        "wetness": halo,
        "submerged": smooth(0.6, -0.6, above),
        "variation": variation,
        "detail": detail,
    }


def compute_materials(terrain, settings: MaterialSettings | None = None, normals: np.ndarray | None = None) -> MaterialField:
    m = settings or MaterialSettings()
    s = material_inputs(terrain, normals)
    raw = []
    for definition in MATERIALS:
        value = definition.weight(s, m) * (1 + 0.35 * m.variation * s["variation"])
        raw.append(np.clip(np.nan_to_num(value), 0, None))
    stack = np.stack(raw, axis=-1)
    total = stack.sum(axis=-1, keepdims=True)
    empty = total[..., 0] <= 1e-6
    weights = np.where(empty[..., None], np.zeros_like(stack), stack / np.maximum(total, 1e-9))
    if empty.any():
        weights[..., MATERIAL_IDS.index("grass")][empty] = 1.0
    albedo_srgb = weights @ np.asarray([d.albedo for d in MATERIALS], dtype=np.float64)
    return MaterialField(list(MATERIAL_IDS), weights, srgb_to_linear(albedo_srgb), m)


def material_stats(terrain, field: MaterialField, normals: np.ndarray | None = None) -> Dict[str, object]:
    if normals is None:
        slope = material_inputs(terrain)["slope"]
    else:
        slope = np.clip(1 - np.asarray(normals)[..., 1], 0, 1)
    fractions = {mid: float(field.weights[..., i].mean()) for i, mid in enumerate(field.ids)}
    bands = {}
    for name, lo, hi in (("plains", 0.0, 0.16), ("hills", 0.16, 0.4), ("mountains", 0.4, 2.0)):
        sel = (slope >= lo) & (slope < hi)
        bands[name] = {mid: float(field.weights[..., i][sel].mean()) if sel.any() else 0.0 for i, mid in enumerate(field.ids)}
    # Transitions are measured on dry ground: the waterline itself is a real
    # physical edge, not a colour band.
    dry = np.ones(field.weights.shape[:2], dtype=bool)
    if terrain.water is not None:
        dry = np.asarray(terrain.water.mask) == 0
    jumps = []
    for axis in (0, 1):
        a = np.take(field.weights, range(field.weights.shape[axis] - 1), axis=axis)
        b = np.take(field.weights, range(1, field.weights.shape[axis]), axis=axis)
        both = np.take(dry, range(dry.shape[axis] - 1), axis=axis) & np.take(dry, range(1, dry.shape[axis]), axis=axis)
        if both.any():
            jumps.append(np.abs(a - b).max(axis=-1)[both])
    pooled = np.concatenate(jumps) if jumps else np.zeros(1)
    jump = float(pooled.max())
    dominant = field.weights.argmax(axis=-1)
    dx = (dominant[:, 1:] != dominant[:, :-1]) & dry[:, 1:] & dry[:, :-1]
    dz = (dominant[1:, :] != dominant[:-1, :]) & dry[1:, :] & dry[:-1, :]
    transitions = float((dx.mean() + dz.mean()) / 2)
    steep = slope > 0.45
    flat = slope < 0.15
    rock = field.weights[..., field.ids.index("rock")]
    grass = field.weights[..., field.ids.index("grass")]
    return {
        "samples": int(field.weights.shape[0]),
        "fractions": fractions,
        "bands": bands,
        "max_neighbour_jump": jump,
        "jump_p50": float(np.percentile(pooled, 50)),
        "jump_p95": float(np.percentile(pooled, 95)),
        "transition_fraction": transitions,
        "rock_on_steep": float(rock[steep].mean()) if steep.any() else 0.0,
        "grass_on_flat": float(grass[flat].mean()) if flat.any() else 0.0,
        "classes": len(field.ids),
    }


def render_material_report(terrain, settings: MaterialSettings | None = None) -> str:
    field = compute_materials(terrain, settings)
    stats = material_stats(terrain, field)
    lines = [
        f"materials.classes            {stats['classes']}",
        f"materials.samples            {stats['samples']}",
        "materials.fractions          " + " ".join(f"{k}={v:.3f}" for k, v in stats["fractions"].items()),
    ]
    for band, values in stats["bands"].items():
        lines.append(f"materials.{band:<10}       " + " ".join(f"{k}={v:.3f}" for k, v in values.items()))
    lines += [
        f"materials.max_step           {stats['max_neighbour_jump']:.3f}",
        f"materials.step_p50/p95       {stats['jump_p50']:.3f} / {stats['jump_p95']:.3f}",
        f"materials.transition_fraction {stats['transition_fraction']:.3f}",
        f"materials.rock_on_steep      {stats['rock_on_steep']:.3f}",
        f"materials.grass_on_flat      {stats['grass_on_flat']:.3f}",
    ]
    return "\n".join(lines)


# --------------------------------------------------------------------- shading
def _bilerp(a: np.ndarray, samples: np.ndarray) -> np.ndarray:
    """Bilinear sample of a (depth, width, ...) field at fractional grid coords."""
    depth, width = a.shape[0], a.shape[1]
    x = np.clip(samples[:, 0], 0, width - 1)
    z = np.clip(samples[:, 1], 0, depth - 1)
    x0 = np.floor(x).astype(np.int64)
    z0 = np.floor(z).astype(np.int64)
    x1 = np.minimum(width - 1, x0 + 1)
    z1 = np.minimum(depth - 1, z0 + 1)
    fx = (x - x0)[:, None]
    fz = (z - z0)[:, None]
    top = a[z0, x0] * (1 - fx) + a[z0, x1] * fx
    bottom = a[z1, x0] * (1 - fx) + a[z1, x1] * fx
    return top * (1 - fz) + bottom * fz


def vertex_colors(field: MaterialField, samples: np.ndarray) -> np.ndarray:
    """Per-mesh-vertex RGBA from the blended material albedo (opaque)."""
    albedo = _bilerp(field.albedo.reshape(-1, 1, 3), samples)
    return np.concatenate([albedo, np.ones((albedo.shape[0], 1))], axis=1)


def water_vertex_colors(terrain, samples: np.ndarray, visual: WaterVisual | None = None) -> np.ndarray:
    """Per-vertex water RGBA: depth tint, lake/river mix, shoreline fade."""
    v = visual or WaterVisual()
    w = terrain.water
    if w is None:
        return np.zeros((samples.shape[0], 4))
    depth = _bilerp(np.asarray(w.depth, dtype=np.float64)[..., None], samples)[:, 0]
    lake = _bilerp(np.asarray(w.lake_mask, dtype=np.float64)[..., None], samples)[:, 0]
    river = _bilerp(np.asarray(w.river_mask, dtype=np.float64)[..., None], samples)[:, 0]
    mask = _bilerp(np.asarray(w.mask, dtype=np.float64)[..., None], samples)[:, 0]
    total = lake + river
    mix = np.where(total > 1e-6, river / np.maximum(total, 1e-9), 0.0)
    k = smooth(0, max(0.1, v.depth_scale_m), np.maximum(0.0, depth))
    shallow = np.asarray(v.lake_shallow) * (1 - mix[:, None]) + np.asarray(v.river_shallow) * mix[:, None]
    deep = np.asarray(v.lake_deep) * (1 - mix[:, None]) + np.asarray(v.river_deep) * mix[:, None]
    rgb = shallow * (1 - k[:, None]) + deep * k[:, None]
    alpha = v.opacity * (0.5 + 0.5 * k) * (1 - 0.12 * mix)
    fade = np.clip(mask, 0, 1) * 0.85 + 0.15
    return np.concatenate([rgb, (alpha * fade)[:, None]], axis=1)
