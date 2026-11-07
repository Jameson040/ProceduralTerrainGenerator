"""Terrain-aware drainage analysis.

All routing is computed on the actual (eroded) heightfield. D8 receivers are
only accepted for strictly lower neighbours, so flow accumulation and river
routing can never travel uphill. Sinks are retained as legitimate endpoints;
lakes are detected separately in their actual topographic basins.
"""
from __future__ import annotations

import heapq
from dataclasses import dataclass
from typing import Dict

import numpy as np


@dataclass
class DrainageData:
    receiver: np.ndarray          # int32 flat receiver index; self for sinks
    accumulation: np.ndarray      # upstream cell count * rainfall (float32)
    direction: np.ndarray         # normalized angle, -1 at sinks (float32)
    slope: np.ndarray             # downhill slope to receiver (float32)
    watershed: np.ndarray         # int-like watershed labels (float32)
    order: np.ndarray             # descending-height processing order
    watershed_count: int

    def summary(self) -> Dict[str, float]:
        return {
            "flow_cells": int(self.accumulation.size),
            "sink_count": int(np.count_nonzero(self.receiver == np.arange(self.accumulation.size))),
            "watershed_count": int(self.watershed_count),
            "max_flow_accumulation": int(self.accumulation.max()),
        }


def d8_drainage(heights: np.ndarray, cell_size: float) -> DrainageData:
    """Compute strictly-downhill D8 directions, accumulation and watersheds."""
    h = np.asarray(heights, dtype=np.float64)
    rows, cols = h.shape
    total = rows * cols
    receiver = np.arange(total, dtype=np.int64)
    best_drop = np.zeros(total, dtype=np.float64)
    best_dist = np.ones(total, dtype=np.float64)
    diag = cell_size * np.sqrt(2.0)
    offsets = (
        (-1, 0, cell_size), (-1, 1, diag), (0, 1, cell_size), (1, 1, diag),
        (1, 0, cell_size), (1, -1, diag), (0, -1, cell_size), (-1, -1, diag),
    )

    for dr, dc, distance in offsets:
        r0, r1 = max(0, -dr), min(rows, rows - dr)
        c0, c1 = max(0, -dc), min(cols, cols - dc)
        if r0 >= r1 or c0 >= c1:
            continue
        src = (slice(r0, r1), slice(c0, c1))
        dst = (slice(r0 + dr, r1 + dr), slice(c0 + dc, c1 + dc))
        drop = h[src] - h[dst]
        src_flat = (np.arange(r0, r1)[:, None] * cols + np.arange(c0, c1)[None, :])
        dst_flat = ((np.arange(r0, r1)[:, None] + dr) * cols + (np.arange(c0, c1)[None, :] + dc))
        take = drop.ravel() > best_drop[src_flat.ravel()] + 1e-12
        if not take.any():
            continue
        receiver[src_flat.ravel()[take]] = dst_flat.ravel()[take]
        best_drop[src_flat.ravel()[take]] = drop.ravel()[take]
        best_dist[src_flat.ravel()[take]] = distance

    slope = np.where(receiver != np.arange(total), best_drop / np.maximum(best_dist, 1e-9), 0.0)
    # Accumulation in descending height order. Strictly downhill receivers mean
    # every upstream cell is processed before its downstream receiver.
    order = np.argsort(-h.ravel(), kind="stable")
    acc = np.ones(total, dtype=np.float64)
    receiver_flat = receiver.ravel()
    for idx in order:
        target = receiver_flat[idx]
        if target != idx:
            acc[target] += acc[idx]

    rr = receiver_flat // cols
    cc = receiver_flat - rr * cols
    idx_r = np.arange(total) // cols
    idx_c = np.arange(total) - idx_r * cols
    angle = np.arctan2(rr - idx_r, cc - idx_c)
    direction = ((angle + np.pi) / (2.0 * np.pi)).astype(np.float32)
    direction[receiver_flat == np.arange(total)] = -1.0

    # Watersheds: follow downhill pointers until a sink. Pointer jumping keeps
    # this vectorized and independent of path length.
    sink = np.arange(total, dtype=np.int64)
    for _ in range(64):
        nxt = sink[receiver_flat]
        if np.array_equal(nxt, sink):
            break
        sink = nxt
    _, labels = np.unique(sink, return_inverse=True)
    watershed = labels.reshape(rows, cols).astype(np.float32)
    basin_sizes = np.bincount(labels)
    watershed_count = int(np.count_nonzero(basin_sizes >= max(4, total * 0.0005)))

    return DrainageData(
        receiver=receiver_flat.astype(np.int64),
        accumulation=acc.reshape(rows, cols).astype(np.float32),
        direction=direction.reshape(rows, cols),
        slope=slope.reshape(rows, cols).astype(np.float32),
        watershed=watershed,
        order=order,
        watershed_count=watershed_count,
    )


def fill_depressions(heights: np.ndarray, epsilon: float = 0.0) -> np.ndarray:
    """Priority-Flood pit filling used for actual lake-basin discovery.

    Unlike standard hydrologic conditioning, the returned surface is only a
    diagnostic: the real terrain keeps its depressions and is never levelled.
    """
    h = np.asarray(heights, dtype=np.float64)
    rows, cols = h.shape
    filled = h.copy()
    visited = np.zeros((rows, cols), dtype=bool)
    heap: list[tuple[float, int, int]] = []

    for r in range(rows):
        for c in (0, cols - 1):
            if not visited[r, c]:
                visited[r, c] = True
                heapq.heappush(heap, (float(filled[r, c]), r, c))
    for c in range(cols):
        for r in (0, rows - 1):
            if not visited[r, c]:
                visited[r, c] = True
                heapq.heappush(heap, (float(filled[r, c]), r, c))

    while heap:
        elev, r, c = heapq.heappop(heap)
        for nr, nc in ((r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1)):
            if nr < 0 or nr >= rows or nc < 0 or nc >= cols or visited[nr, nc]:
                continue
            visited[nr, nc] = True
            n_elev = max(float(filled[nr, nc]), elev) + epsilon
            filled[nr, nc] = n_elev
            heapq.heappush(heap, (n_elev, nr, nc))
    return filled


def connected_components(mask: np.ndarray) -> list[np.ndarray]:
    """4-connected flat index components of a boolean mask."""
    rows, cols = mask.shape
    visited = np.zeros(rows * cols, dtype=bool)
    flat_mask = mask.ravel()
    components: list[np.ndarray] = []
    for start in np.flatnonzero(flat_mask):
        s = int(start)
        if visited[s]:
            continue
        visited[s] = True
        q = [s]
        head = 0
        comp: list[int] = []
        while head < len(q):
            i = q[head]
            head += 1
            comp.append(i)
            r, c = divmod(i, cols)
            for nr, nc in ((r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1)):
                if 0 <= nr < rows and 0 <= nc < cols:
                    ni = nr * cols + nc
                    if flat_mask[ni] and not visited[ni]:
                        visited[ni] = True
                        q.append(ni)
        components.append(np.asarray(comp, dtype=np.int64))
    return components
