"""python3 -m terrain.test_world: 4x4 export/reconstruction and topology tests."""
import json
import tempfile
import time
import unittest
from collections import Counter
from pathlib import Path

import numpy as np

from .config import TerrainSettings
from .world import generate_world, load_world, balance_lods


class WorldTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.started = time.perf_counter()
        cls.world = generate_world(TerrainSettings(seed=42, resolution=129))

    def test_deterministic_source_and_layout(self):
        second = generate_world(TerrainSettings(seed=42, resolution=129))
        self.assertEqual((self.world.columns, self.world.rows), (4, 4))
        self.assertEqual(second.id, self.world.id)
        self.assertEqual(second.chunks, self.world.chunks)
        np.testing.assert_array_equal(second.terrain.heights, self.world.terrain.heights)
        np.testing.assert_array_equal(second.terrain.water.mask, self.world.terrain.water.mask)

    def test_all_lod_meshes_are_conforming(self):
        w = self.world
        for c in w.chunks:
            for lod in range(3):
                m = w.mesh(c, lod)
                a, b, d = [m.samples[m.indices[:, k]].astype(np.float64) for k in range(3)]
                twice_area = (b[:, 0] - a[:, 0]) * (d[:, 1] - a[:, 1]) - (d[:, 0] - a[:, 0]) * (b[:, 1] - a[:, 1])
                self.assertTrue((twice_area > 0).all())
                x0, z0, x1, z1 = c["rect"]
                self.assertEqual(float(twice_area.sum()) / 2, (x1 - x0) * (z1 - z0))
                edges = Counter(tuple(sorted((int(tri[k]), int(tri[(k + 1) % 3])))) for tri in m.indices for k in range(3))
                for (i, j), count in edges.items():
                    self.assertLessEqual(count, 2)
                    if count == 1:
                        (ax, az), (bx, bz) = m.samples[[i, j]]
                        self.assertTrue((ax == bx and ax in (x0, x1)) or (az == bz and az in (z0, z1)), "interior crack/T-junction")
                        self.assertEqual(abs(ax - bx) + abs(az - bz), 1)
                np.testing.assert_allclose(np.linalg.norm(m.normals, axis=1), 1, atol=1e-6)
                samples = {(int(x), int(z)): m.positions[i, 1] for i, (x, z) in enumerate(m.samples) if x == int(x) and z == int(z)}
                for z in range(z0, z1 + 1):
                    for x in range(x0, x1 + 1):
                        if w.terrain.water.mask[z, x]:
                            self.assertEqual(samples[x, z], w.terrain.heights[z, x])

    def test_shared_vertices_normals_and_water_all_levels(self):
        w = self.world
        crossings = {"river_mask": 0, "lake_mask": 0}
        for c in w.chunks:
            for side, axis in (("east", 0), ("south", 1)):
                neighbor = c["neighbors"][side]
                if neighbor is None:
                    continue
                other = next(n for n in w.chunks if n["id"] == neighbor)
                value = c["rect"][axis + 2]
                def edge(mesh):
                    return {float(mesh.samples[i, 1 - axis]): i for i in range(len(mesh.positions)) if mesh.samples[i, axis] == value}
                for a in range(3):
                    for b in range(3):
                        if abs(a - b) > 1:
                            continue
                        ma, mb = w.mesh(c, a), w.mesh(other, b)
                        ea, eb = edge(ma), edge(mb)
                        self.assertEqual(set(ea), set(eb))
                        for v in ea:
                            np.testing.assert_array_equal(ma.positions[ea[v]], mb.positions[eb[v]])
                            np.testing.assert_array_equal(ma.normals[ea[v]], mb.normals[eb[v]])
                            np.testing.assert_array_equal(ma.uvs[ea[v]], mb.uvs[eb[v]])
                ma, mb = w.mesh(c, water=True), w.mesh(other, water=True)
                ea, eb = edge(ma), edge(mb)
                for v in set(ea) & set(eb):
                    np.testing.assert_array_equal(ma.positions[ea[v]], mb.positions[eb[v]])
                    np.testing.assert_array_equal(ma.normals[ea[v]], mb.normals[eb[v]])
                for kind in crossings:
                    field = getattr(w.terrain.water, kind)
                    values = [field[v, value] if axis == 0 else field[value, v] for v in range(c["rect"][1 - axis], c["rect"][3 - axis] + 1)]
                    crossings[kind] += int(any(values))
        self.assertGreaterEqual(crossings["river_mask"], 2)
        self.assertGreaterEqual(crossings["lake_mask"], 2)

    def test_export_16_chunks_and_exact_reconstruction(self):
        with tempfile.TemporaryDirectory() as directory:
            self.world.export(directory)
            self.assertEqual(len(list((Path(directory) / "chunks").glob("*.json"))), 16)
            restored = load_world(directory)
            np.testing.assert_array_equal(restored.terrain.heights, self.world.terrain.heights)
            np.testing.assert_array_equal(restored.normals, self.world.normals)
            np.testing.assert_array_equal(restored.water_surface, self.world.water_surface)
            for key in ("mask", "surface", "depth", "river_mask", "lake_mask"):
                np.testing.assert_array_equal(getattr(restored.terrain.water, key), getattr(self.world.terrain.water, key))
            for c in self.world.chunks:
                for lod in range(3):
                    for key in ("positions", "normals", "indices", "uvs"):
                        np.testing.assert_array_equal(getattr(restored.mesh(c, lod), key), getattr(self.world.mesh(c, lod), key))
            path = Path(directory) / "chunks/c_1_0.json"
            p = json.loads(path.read_text()); p["source"]["heights"][0] += 1; path.write_text(json.dumps(p))
            with self.assertRaisesRegex(ValueError, "boundary mismatch"):
                load_world(directory)

    def test_balancing_and_partial_edges(self):
        plan = balance_lods(self.world.chunks, {c["id"]: (0 if c["id"] == "c_0_0" else 2) for c in self.world.chunks})
        for c in self.world.chunks:
            for n in c["neighbors"].values():
                if n:
                    self.assertLessEqual(abs(plan[n] - plan[c["id"]]), 1)
        w = generate_world(TerrainSettings(seed=17, resolution=65, world_width=1234.5, world_depth=813.75, origin_x=-2000, origin_z=1000), 260, 190)
        self.assertEqual(w.header()["dimensions"], [1234.5, 813.75])
        self.assertLess(w.chunks[-1]["rect"][2] - w.chunks[-1]["rect"][0], w.chunk_cells[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)