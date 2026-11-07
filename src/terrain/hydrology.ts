/** D8 drainage, Priority-Flood conditioning, and connected components. */

class MinHeap {
  private elev: Float64Array;
  private idx: Int32Array;
  size = 0;
  constructor(capacity: number) {
    this.elev = new Float64Array(capacity);
    this.idx = new Int32Array(capacity);
  }
  push(e: number, i: number) {
    let n = this.size++;
    this.elev[n] = e; this.idx[n] = i;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (this.elev[p] <= this.elev[n]) break;
      const eTmp = this.elev[p], iTmp = this.idx[p];
      this.elev[p] = this.elev[n]; this.idx[p] = this.idx[n];
      this.elev[n] = eTmp; this.idx[n] = iTmp;
      n = p;
    }
  }
  pop(): [number, number] {
    const e = this.elev[0], i = this.idx[0];
    const last = --this.size;
    if (last > 0) {
      this.elev[0] = this.elev[last]; this.idx[0] = this.idx[last];
      let n = 0;
      while (true) {
        const l = (n << 1) + 1;
        if (l >= last) break;
        const r = l + 1;
        let sm = l;
        if (r < last && this.elev[r] < this.elev[l]) sm = r;
        if (this.elev[n] <= this.elev[sm]) break;
        const eTmp = this.elev[n], iTmp = this.idx[n];
        this.elev[n] = this.elev[sm]; this.idx[n] = this.idx[sm];
        this.elev[sm] = eTmp; this.idx[sm] = iTmp;
        n = sm;
      }
    }
    return [e, i];
  }
}

export function connectedComponents(mask: Uint8Array, rows: number, cols: number): Int32Array[] {
  const total = rows * cols;
  const seen = new Uint8Array(total);
  const queue = new Int32Array(total);
  const comps: Int32Array[] = [];
  for (let start = 0; start < total; start++) {
    if (!mask[start] || seen[start]) continue;
    let head = 0, tail = 0;
    queue[tail++] = start; seen[start] = 1;
    while (head < tail) {
      const idx = queue[head++];
      const r = (idx / cols) | 0, c = idx - r * cols;
      const ns = [r > 0 ? idx - cols : -1, r < rows - 1 ? idx + cols : -1, c > 0 ? idx - 1 : -1, c < cols - 1 ? idx + 1 : -1];
      for (const n of ns) if (n >= 0 && mask[n] && !seen[n]) { seen[n] = 1; queue[tail++] = n; }
    }
    comps.push(queue.slice(0, tail));
  }
  return comps;
}

export function fillDepressions(heights: Float32Array, rows: number, cols: number, epsilon = 0): Float32Array {
  const filled = new Float32Array(heights);
  const seen = new Uint8Array(rows * cols);
  const heap = new MinHeap(rows * cols + 8);
  const seed = (idx: number) => { if (!seen[idx]) { seen[idx] = 1; heap.push(filled[idx], idx); } };
  for (let c = 0; c < cols; c++) { seed(c); seed((rows - 1) * cols + c); }
  for (let r = 0; r < rows; r++) { seed(r * cols); seed(r * cols + cols - 1); }
  while (heap.size > 0) {
    const [elev, idx] = heap.pop();
    const r = (idx / cols) | 0, c = idx - r * cols;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const ni = nr * cols + nc;
      if (seen[ni]) continue;
      seen[ni] = 1;
      const nElev = Math.max(filled[ni], elev) + epsilon;
      filled[ni] = nElev;
      heap.push(nElev, ni);
    }
  }
  return filled;
}

export interface DrainageData {
  receiver: Int32Array;
  accumulation: Float32Array;
  direction: Float32Array;
  slope: Float32Array;
  watershed: Float32Array;
  watershed_count: number;
  sink_count: number;
  max_accumulation: number;
}

export function d8Drainage(heights: Float32Array, rows: number, cols: number, cellSize: number): DrainageData {
  const total = rows * cols;
  const receiver = new Int32Array(total);
  const bestDrop = new Float64Array(total);
  const bestDist = new Float64Array(total);
  const diag = cellSize * Math.SQRT2;
  const offsets: [number, number, number][] = [
    [-1, 0, cellSize], [-1, 1, diag], [0, 1, cellSize], [1, 1, diag],
    [1, 0, cellSize], [1, -1, diag], [0, -1, cellSize], [-1, -1, diag],
  ];
  for (let i = 0; i < total; i++) { receiver[i] = i; bestDist[i] = 1; }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c;
    for (const [dr, dc, dist] of offsets) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const ni = nr * cols + nc;
      const drop = heights[i] - heights[ni];
      if (drop > bestDrop[i] + 1e-12) { bestDrop[i] = drop; receiver[i] = ni; bestDist[i] = dist; }
    }
  }
  const slope = new Float32Array(total);
  const direction = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    if (receiver[i] === i) { direction[i] = -1; slope[i] = 0; }
    else {
      const r = (i / cols) | 0, c = i - r * cols;
      const rr = (receiver[i] / cols) | 0, cc = receiver[i] - rr * cols;
      slope[i] = bestDrop[i] / Math.max(bestDist[i], 1e-9);
      direction[i] = (Math.atan2(rr - r, cc - c) + Math.PI) / (Math.PI * 2);
    }
  }
  const order = Array.from({ length: total }, (_, i) => i).sort((a, b) => heights[b] - heights[a] || a - b);
  const acc = new Float64Array(total).fill(1);
  for (let k = 0; k < total; k++) {
    const i = order[k], target = receiver[i];
    if (target !== i) acc[target] += acc[i];
  }
  let maxAcc = 0;
  for (let i = 0; i < total; i++) if (acc[i] > maxAcc) maxAcc = acc[i];
  // Watersheds by vectorized pointer jumping until each cell reaches its sink.
  const sink = new Int32Array(total);
  for (let i = 0; i < total; i++) sink[i] = i;
  for (let it = 0; it < 64; it++) {
    let changed = false;
    for (let i = 0; i < total; i++) {
      const nxt = sink[receiver[i]];
      if (nxt !== sink[i]) { sink[i] = nxt; changed = true; }
    }
    if (!changed) break;
  }
  const labels = new Int32Array(total);
  const labelBySink = new Map<number, number>();
  const watershed = new Float32Array(total);
  let nextLabel = 0;
  for (let i = 0; i < total; i++) {
    const s = sink[i];
    let l = labelBySink.get(s);
    if (l === undefined) { l = nextLabel++; labelBySink.set(s, l); }
    labels[i] = l;
    watershed[i] = l;
  }
  const counts = new Int32Array(nextLabel);
  for (let i = 0; i < total; i++) counts[labels[i]]++;
  let watershedCount = 0, sinkCount = 0;
  const minArea = Math.max(4, total * 0.0005);
  for (let i = 0; i < nextLabel; i++) if (counts[i] >= minArea) watershedCount++;
  for (let i = 0; i < total; i++) if (receiver[i] === i) sinkCount++;
  return {
    receiver, accumulation: Float32Array.from(acc), direction, slope, watershed,
    watershed_count: watershedCount, sink_count: sinkCount, max_accumulation: maxAcc,
  };
}
