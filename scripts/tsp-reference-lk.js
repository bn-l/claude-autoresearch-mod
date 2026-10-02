// Reference solver for examples/tsp-bench: tour.js as an autoresearch session left it at its
// run 13 (commit 815b273 of the demo recorded in demo/tsp-dark.cast), unchanged below. Run it
// with a long budget through scripts/tsp-reference.mjs NAME SECONDS scripts/tsp-reference-lk.js.

// The function under optimization: returns a short closed tour through every city, as the
// order to visit them in (each index 0..n-1 exactly once). City i is at (xs[i], ys[i]), and
// solve() may take up to budgetMs milliseconds.
// Greedy nearest-neighbour start, then 2-opt + Or-opt over K-nearest neighbour lists with
// don't-look bits, then iterated local search with segment-local double-bridge kicks.
const K = 10;
const THR = 1; // acceptance threshold, in average edge lengths

export function solve(xs, ys, budgetMs) {
  const start = performance.now();
  const deadline = start + budgetMs * 0.95;
  const n = xs.length;
  if (n <= 3) return Array.from({ length: n }, (_, i) => i);

  let span = 0;
  for (let i = 0; i < n; i++) span = Math.max(span, Math.abs(xs[i] - xs[0]), Math.abs(ys[i] - ys[0]));
  const EPS = 1e-9 * (span || 1);
  const d = (a, b) => { const dx = xs[a] - xs[b], dy = ys[a] - ys[b]; return Math.sqrt(dx * dx + dy * dy); };

  // K nearest neighbours via a uniform grid.
  const k = Math.min(K, n - 1);
  const neigh = buildNeighbours(xs, ys, k);

  // Nearest-neighbour start using the grid neighbours, falling back to a scan.
  const tour = new Int32Array(n);
  const pos = new Int32Array(n);
  {
    const visited = new Uint8Array(n);
    let cur = 0;
    visited[0] = 1;
    tour[0] = 0;
    for (let i = 1; i < n; i++) {
      let best = -1;
      for (let j = 0; j < k; j++) {
        const c = neigh[cur * k + j];
        if (!visited[c]) { best = c; break; }
      }
      if (best < 0) {
        let bd = Infinity;
        for (let c = 0; c < n; c++) {
          if (visited[c]) continue;
          const dd = (xs[c] - xs[cur]) ** 2 + (ys[c] - ys[cur]) ** 2;
          if (dd < bd) { bd = dd; best = c; }
        }
      }
      visited[best] = 1;
      tour[i] = best;
      cur = best;
    }
    for (let i = 0; i < n; i++) pos[tour[i]] = i;
  }

  const next = (c) => tour[pos[c] + 1 === n ? 0 : pos[c] + 1];
  const prev = (c) => tour[pos[c] === 0 ? n - 1 : pos[c] - 1];

  // Reverse the tour path from position i to j (inclusive, cyclic), reversing the shorter side.
  function reverse(i, j) {
    let len = j - i;
    if (len < 0) len += n;
    len += 1;
    if (len * 2 > n) {
      const ni = j + 1 === n ? 0 : j + 1;
      const nj = i === 0 ? n - 1 : i - 1;
      i = ni; j = nj; len = n - len;
    }
    for (let s = 0; s < len >> 1; s++) {
      const a = tour[i], b = tour[j];
      tour[i] = b; pos[b] = i;
      tour[j] = a; pos[a] = j;
      if (++i === n) i = 0;
      if (--j < 0) j = n - 1;
    }
  }

  let gain = 0;
  const queue = new Int32Array(n);
  const inQueue = new Uint8Array(n);
  let qh = 0, qt = 0, qs = 0;
  const push = (c) => {
    if (inQueue[c]) return;
    inQueue[c] = 1; queue[qt] = c; qt = qt + 1 === n ? 0 : qt + 1; qs++;
  };

  // Sequential 3-opt as a chain of two 2-opt moves with t1 fixed, both evaluated without
  // touching the tour: remove (t1,f),(cp,c), add (f,c),(t1,cp); if that doesn't close an
  // improvement, cp becomes the free end of a second 2-opt in the virtual post-move tour.
  const B1 = 5, B2 = 5;
  function lk(t1) {
    for (let dir = 0; dir < 2; dir++) {
      const sc = dir === 0 ? next : prev, pr = dir === 0 ? prev : next;
      const f = sc(t1);
      const g0 = d(t1, f);
      const sf = sc(f);
      const pf = pos[f];
      for (let j0 = 0; j0 < B1 && j0 < k; j0++) {
        const c = neigh[f * k + j0];
        const g1 = g0 - d(f, c);
        if (g1 <= EPS) break;
        if (c === t1 || c === sf) continue;
        const cp = pr(c);
        const G1 = g1 + d(cp, c);
        if (G1 - d(t1, cp) > EPS) {
          apply1(dir, f, cp);
          gain -= G1 - d(t1, cp);
          push(t1); push(f); push(c); push(cp);
          return true;
        }
        // Virtual tour after the first move: t1, cp, pr(cp), ..., f, c, sc(c), ...
        let lenS = dir === 0 ? pos[cp] - pf : pf - pos[cp];
        if (lenS < 0) lenS += n;
        const scCp = cp === f ? c : pr(cp);
        for (let j1 = 0; j1 < B2 && j1 < k; j1++) {
          const c2 = neigh[cp * k + j1];
          const g2 = G1 - d(cp, c2);
          if (g2 <= EPS) break;
          if (c2 === t1 || c2 === scCp) continue;
          let cp2;
          if (c2 === c) cp2 = f;
          else {
            let off = dir === 0 ? pos[c2] - pf : pf - pos[c2];
            if (off < 0) off += n;
            cp2 = off <= lenS ? sc(c2) : pr(c2);
          }
          const close = g2 + d(cp2, c2) - d(t1, cp2);
          if (close > EPS) {
            apply1(dir, f, cp);
            const dr = next(t1) === cp ? 0 : 1;
            if (dr === 0) reverse(pos[cp], pos[cp2]); else reverse(pos[cp2], pos[cp]);
            gain -= close;
            push(t1); push(f); push(c); push(cp); push(c2); push(cp2);
            return true;
          }
        }
      }
    }
    return false;
  }
  function apply1(dir, f, cp) {
    if (dir === 0) reverse(pos[f], pos[cp]); else reverse(pos[cp], pos[f]);
  }

  // Try improving moves around city a. Returns true if improved.
  function improveCity(a) {
    if (lk(a)) return true;
    for (let dir = 0; dir < 2; dir++) {
      const an = dir === 0 ? next(a) : prev(a);
      const dA = d(a, an);
      for (let j = 0; j < k; j++) {
        const c = neigh[a * k + j];
        const dAC = d(a, c);
        if (dAC >= dA) break;
        const cn = dir === 0 ? next(c) : prev(c);
        if (c === an || cn === a) continue;
        const delta = dAC + d(an, cn) - dA - d(c, cn);
        if (delta < -EPS) {
          // 2-opt: edges (a,an),(c,cn) -> (a,c),(an,cn)
          gain += delta;
          if (dir === 0) reverse(pos[an], pos[c]);
          else reverse(pos[c], pos[an]);
          push(a); push(an); push(c); push(cn);
          return true;
        }
      }
    }
    // Or-opt: move segment starting at a of length 1..3 to between c and its neighbour.
    for (let segLen = 1; segLen <= 3; segLen++) {
      // segment s1..s2 in forward direction, s1 = a
      let s2 = a;
      for (let t = 1; t < segLen; t++) s2 = next(s2);
      const p = prev(a), q = next(s2);
      if (q === a || p === s2 || q === p) break;
      const removeGain = d(p, a) + d(s2, q) - d(p, q);
      if (removeGain <= EPS) continue;
      for (let end = 0; end < 2; end++) {
        const e = end === 0 ? a : s2; // endpoint to connect near c
        for (let j = 0; j < k; j++) {
          const c = neigh[e * k + j];
          const dEC = d(e, c);
          if (dEC >= removeGain) break;
          // skip if c in segment
          let inSeg = false;
          let x = a;
          for (let t = 0; t < segLen; t++) { if (x === c) { inSeg = true; break; } x = next(x); }
          if (inSeg) continue;
          for (let side = 0; side < 2; side++) {
            const c2 = side === 0 ? next(c) : prev(c);
            let inSeg2 = false;
            x = a;
            for (let t = 0; t < segLen; t++) { if (x === c2) { inSeg2 = true; break; } x = next(x); }
            if (inSeg2) continue;
            const other = e === a ? s2 : a;
            const addCost = dEC + d(other, c2) - d(c, c2);
            if (addCost - removeGain < -EPS) {
              gain += addCost - removeGain;
              doOrMove(a, s2, segLen, c, c2, e);
              push(p); push(q); push(a); push(s2); push(c); push(c2);
              return true;
            }
          }
        }
      }
    }
    return false;
  }

  // Move segment a..s2 (forward) to between c and c2 (adjacent), with e adjacent to c.
  // Implement via reversals: realise as or-3opt using up to 3 reversals.
  function doOrMove(a, s2, segLen, c, c2, e) {
    // Build simple approach: rebuild positions by extracting segment, using array splice
    // on the shorter region between segment and insertion point.
    const seg = [];
    let x = a;
    for (let t = 0; t < segLen; t++) { seg.push(x); x = next(x); }
    // orient: after insertion, path is ... c, e, ..., other, c2 ... if c2 = next(c)
    // or ... c2, other, ..., e, c ... if c2 = prev(c)
    let ins = seg;
    const forwardC = c2 === next(c);
    // desired order going forward between (first,last) of [c,c2] in forward order
    const first = forwardC ? c : c2;
    // if forwardC: c, e..other; else c2, other..e  -> sequence after `first`
    if (forwardC) ins = e === a ? seg : seg.slice().reverse();
    else ins = e === a ? seg.slice().reverse() : seg;
    // Remove segment and insert after `first`. Work on cyclic positions via shifting the
    // region between them.
    const ps = pos[a];
    const pf = pos[first];
    // distance forward from segment end to first
    let fwd = pf - (ps + segLen - 1); if (fwd < 0) fwd += n;
    let bwd = ps - pf; if (bwd < 0) bwd += n;
    if (fwd <= bwd) {
      // shift elements after segment up to `first` backwards by segLen
      let src = ps + segLen; if (src >= n) src -= n;
      let dst = ps;
      for (let t = 0; t < fwd; t++) {
        const v = tour[src]; tour[dst] = v; pos[v] = dst;
        if (++src === n) src = 0; if (++dst === n) dst = 0;
      }
      for (let t = 0; t < segLen; t++) {
        const v = ins[t]; tour[dst] = v; pos[v] = dst; if (++dst === n) dst = 0;
      }
    } else {
      // shift elements after `first` up to segment start forwards by segLen
      let src = ps - 1; if (src < 0) src += n;
      let dst = ps + segLen - 1; if (dst >= n) dst -= n;
      const cnt = bwd - 1;
      for (let t = 0; t < cnt; t++) {
        const v = tour[src]; tour[dst] = v; pos[v] = dst;
        if (--src < 0) src = n - 1; if (--dst < 0) dst = n - 1;
      }
      for (let t = segLen - 1; t >= 0; t--) {
        const v = ins[t]; tour[dst] = v; pos[v] = dst; if (--dst < 0) dst = n - 1;
      }
    }
  }

  let steps = 0;
  function localSearch() {
    while (qs > 0) {
      if ((++steps & 127) === 0 && performance.now() > deadline) { break; }
      const a = queue[qh]; qh = qh + 1 === n ? 0 : qh + 1; qs--; inQueue[a] = 0;
      while (improveCity(a)) { /* keep improving */ }
    }
  }

  for (let i = 0; i < n; i++) push(tour[i]);
  localSearch();

  const tourLen = () => {
    let s = 0;
    for (let i = 0; i < n; i++) s += d(tour[i], tour[i + 1 === n ? 0 : i + 1]);
    return s;
  };

  // Iterated local search: segment-local double-bridge, keep if not worse.
  let curLen = tourLen();
  const curTour = new Int32Array(tour), curPos = new Int32Array(pos);
  const bestTour = new Int32Array(tour);
  let bestLen = curLen;
  const avgEdge = curLen / n;
  const t0 = performance.now();
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
  const L = Math.max(4, n >> 2); // kick window: segments up to a quarter of the tour
  const tmp = new Int32Array(L);
  while (performance.now() < deadline) {
    const base = (rnd() * n) | 0;
    const o1 = 1 + ((rnd() * (L - 3)) | 0);
    const o2 = o1 + 1 + ((rnd() * (L - o1 - 2)) | 0);
    const o3 = o2 + 1 + ((rnd() * (L - o2 - 1)) | 0);
    const idx = (o) => (base + o) % n;
    const a1 = tour[idx(o1 - 1)], b1 = tour[idx(o1)], b2 = tour[idx(o2 - 1)];
    const c1 = tour[idx(o2)], c2 = tour[idx(o3 - 1)], d1 = tour[idx(o3)];
    const lenB = o2 - o1, lenC = o3 - o2;
    for (let t = 0; t < lenC; t++) tmp[t] = tour[idx(o2 + t)];
    for (let t = 0; t < lenB; t++) tmp[lenC + t] = tour[idx(o1 + t)];
    for (let t = 0; t < lenB + lenC; t++) { const p = idx(o1 + t); const v = tmp[t]; tour[p] = v; pos[v] = p; }
    gain = d(a1, c1) + d(c2, b1) + d(b2, d1) - d(a1, b1) - d(b2, c1) - d(c2, d1);
    push(a1); push(b1); push(b2); push(c1); push(c2); push(d1);
    localSearch();
    // Threshold acceptance: allow slightly worse tours, threshold shrinking to 0 by the deadline.
    const frac = 1 - (performance.now() - t0) / (deadline - t0);
    const thr = THR * avgEdge * frac;
    if (gain < thr && qs === 0) {
      curLen += gain;
      curTour.set(tour); curPos.set(pos);
      if (curLen < bestLen - EPS) { bestLen = curLen; bestTour.set(tour); }
    } else {
      while (qs > 0) { const c = queue[qh]; qh = qh + 1 === n ? 0 : qh + 1; qs--; inQueue[c] = 0; }
      tour.set(curTour); pos.set(curPos);
    }
  }
  return Array.from(bestTour);
}

function buildNeighbours(xs, ys, k) {
  const n = xs.length;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    if (xs[i] < minX) minX = xs[i]; if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i]; if (ys[i] > maxY) maxY = ys[i];
  }
  const g = Math.max(1, Math.floor(Math.sqrt(n / 2)));
  const w = (maxX - minX) / g || 1, h = (maxY - minY) / g || 1;
  const cell = new Int32Array(n);
  const cnt = new Int32Array(g * g + 1);
  for (let i = 0; i < n; i++) {
    const cx = Math.min(g - 1, ((xs[i] - minX) / w) | 0);
    const cy = Math.min(g - 1, ((ys[i] - minY) / h) | 0);
    cell[i] = cy * g + cx; cnt[cell[i] + 1]++;
  }
  for (let i = 0; i < g * g; i++) cnt[i + 1] += cnt[i];
  const items = new Int32Array(n);
  const fill = cnt.slice();
  for (let i = 0; i < n; i++) items[fill[cell[i]]++] = i;
  const neigh = new Int32Array(n * k);
  const cd = new Float64Array(n), ci = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const cx = cell[i] % g, cy = (cell[i] / g) | 0;
    let r = 1, m = 0;
    for (;;) {
      m = 0;
      for (let y = Math.max(0, cy - r); y <= Math.min(g - 1, cy + r); y++)
        for (let x = Math.max(0, cx - r); x <= Math.min(g - 1, cx + r); x++) {
          const c = y * g + x;
          for (let t = cnt[c]; t < cnt[c + 1]; t++) {
            const j = items[t]; if (j === i) continue;
            ci[m] = j; cd[m] = (xs[j] - xs[i]) ** 2 + (ys[j] - ys[i]) ** 2; m++;
          }
        }
      // valid if we have k points within distance r*min(w,h)
      const rad = r * Math.min(w, h);
      let inside = 0;
      for (let t = 0; t < m; t++) if (cd[t] <= rad * rad) inside++;
      if (inside >= k || (cx - r <= 0 && cy - r <= 0 && cx + r >= g - 1 && cy + r >= g - 1)) break;
      r++;
    }
    const order = Array.from({ length: m }, (_, t) => t).sort((p, q) => cd[p] - cd[q]);
    for (let t = 0; t < k; t++) neigh[i * k + t] = ci[order[t]];
  }
  return neigh;
}
