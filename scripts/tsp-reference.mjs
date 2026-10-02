// Finds the best known tour lengths for examples/tsp-bench (`best` in its instances.js): a
// long iterated local search on one instance, with 2-opt and Or-opt moves over neighbour
// lists and segment double-bridge kicks. It lives here, outside the example, so the model
// being demoed can't copy it.
//   node scripts/tsp-reference.mjs NAME SECONDS            prints the shortest tour length found
//   node scripts/tsp-reference.mjs NAME SECONDS SOLVER.js  the same from SOLVER.js's solve(),
//                                                          given SECONDS as its budget
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { INSTANCES, problem, tourLength } from "../examples/tsp-bench/instances.js";

const [name, seconds = "60", solver] = process.argv.slice(2);
const instance = INSTANCES.find((candidate) => candidate.name === name);
if (!instance) {
  console.error(`usage: tsp-reference.mjs NAME SECONDS [SOLVER.js], NAME one of ${INSTANCES.map((i) => i.name).join(", ")}`);
  process.exit(2);
}
const { xs, ys } = instance;
const n = xs.length;

if (solver) {
  const { solve } = await import(pathToFileURL(resolve(solver)).href);
  const tour = Array.from(solve(xs, ys, Number(seconds) * 1000));
  const issue = problem(tour, n);
  if (issue) throw new Error(issue);
  console.log(`${name} ${tourLength(xs, ys, tour).toFixed(3)} (${solver}, ${seconds} s)`);
  process.exit(0);
}
const K = 10;
const EPSILON = 1e-7;
const dist = (a, b) => Math.sqrt((xs[a] - xs[b]) ** 2 + (ys[a] - ys[b]) ** 2);

// Each city's K nearest cities, nearest first.
const neighbours = [];
for (let a = 0; a < n; a++) {
  const distances = new Float64Array(n);
  for (let b = 0; b < n; b++) distances[b] = b === a ? Infinity : dist(a, b);
  const order = Int32Array.from({ length: n }, (_, b) => b).sort((p, q) => distances[p] - distances[q]);
  neighbours.push(order.slice(0, K));
}

// The tour as positions: tour[i] is the i-th city, pos[city] its position.
const tour = new Int32Array(n);
const pos = new Int32Array(n);
{
  const visited = new Uint8Array(n);
  let current = 0;
  visited[0] = 1;
  for (let i = 1; i < n; i++) {
    let best = -1;
    for (let b = 0; b < n; b++) if (!visited[b] && (best < 0 || dist(current, b) < dist(current, best))) best = b;
    visited[best] = 1;
    tour[i] = current = best;
  }
  for (let i = 0; i < n; i++) pos[tour[i]] = i;
}
const next = (c) => tour[pos[c] + 1 === n ? 0 : pos[c] + 1];
const prev = (c) => tour[pos[c] === 0 ? n - 1 : pos[c] - 1];
const at = (i) => tour[((i % n) + n) % n];
const inSegment = (c, i, length) => (pos[c] - i + n) % n < length;

// Reverses the m cities from position i on, wrapping around the end.
function reverse(i, m) {
  let a = i % n;
  let b = (i + m - 1) % n;
  for (let t = 0; t < m >> 1; t++) {
    const ca = tour[a];
    const cb = tour[b];
    tour[a] = cb;
    pos[cb] = a;
    tour[b] = ca;
    pos[ca] = b;
    a = a + 1 === n ? 0 : a + 1;
    b = b === 0 ? n - 1 : b - 1;
  }
}

// 2-opt: edges (a, next a) and (c, next c) become (a, c) and (next a, next c).
function twoOpt(a, c) {
  const b = next(a);
  const inner = (pos[c] - pos[b] + n) % n + 1;
  if (inner <= n - inner) reverse(pos[b], inner);
  else reverse(pos[next(c)], n - inner);
}

// Or-opt: the `length` cities from position i move between c and next c, reversed or not.
function orOpt(i, length, c, reversed) {
  const after = (pos[c] - (i + length) + 2 * n) % n + 1;
  const before = n - length - after;
  if (after <= before) {
    // p [S][nx..c] e  ->  p [nx..c][S] e
    reverse(i, length + after);
    reverse(i, after);
    if (!reversed) reverse(i + after, length);
  } else {
    // c [e..p][S] nx  ->  c [S][e..p] nx
    const start = pos[c] + 1;
    reverse(start, before + length);
    reverse(start + length, before);
    if (!reversed) reverse(start, length);
  }
}

// Don't-look bits: only cities next to a recent change are searched again.
const active = new Uint8Array(n);
let queue = [];
const activate = (...cities) => {
  for (const c of cities) {
    if (!active[c]) {
      active[c] = 1;
      queue.push(c);
    }
  }
};

function improveTwoOpt(a) {
  for (const forward of [true, false]) {
    const b = forward ? next(a) : prev(a);
    const dab = dist(a, b);
    for (const c of neighbours[a]) {
      const dac = dist(a, c);
      if (dac >= dab) break;
      const d = forward ? next(c) : prev(c);
      if (c === b || d === a) continue;
      const delta = dac + dist(b, d) - dab - dist(c, d);
      if (delta < -EPSILON) {
        if (forward) twoOpt(a, c);
        else twoOpt(b, d);
        activate(a, b, c, d);
        return delta;
      }
    }
  }
  return 0;
}

function improveOrOpt(a) {
  for (let length = 1; length <= 3; length++) {
    for (const i of length === 1 ? [pos[a]] : [pos[a], (pos[a] - length + 1 + n) % n]) {
      const s1 = at(i);
      const s2 = at(i + length - 1);
      const p = at(i - 1);
      const nx = at(i + length);
      if (p === nx) continue;
      const gain = dist(p, s1) + dist(s2, nx) - dist(p, nx);
      if (gain <= EPSILON) continue;
      for (const end of [s1, s2]) {
        for (const c of neighbours[end]) {
          if (dist(end, c) >= gain) break;
          if (inSegment(c, i, length)) continue;
          for (const [x, y] of [[c, next(c)], [prev(c), c]]) {
            if (inSegment(x, i, length) || inSegment(y, i, length)) continue;
            const dxy = dist(x, y);
            const forwardCost = dist(x, s1) + dist(s2, y) - dxy;
            const reversedCost = dist(x, s2) + dist(s1, y) - dxy;
            const cost = Math.min(forwardCost, reversedCost);
            if (cost - gain < -EPSILON) {
              orOpt(i, length, x, reversedCost < forwardCost);
              activate(p, nx, s1, s2, x, y);
              return cost - gain;
            }
          }
        }
      }
    }
  }
  return 0;
}

function localSearch() {
  let change = 0;
  for (let head = 0; head < queue.length; head++) {
    const a = queue[head];
    active[a] = 0;
    change += improveTwoOpt(a) || improveOrOpt(a);
  }
  queue = [];
  return change;
}

activate(...tour);
let length = tourLength(xs, ys, tour) + localSearch();
const saved = tour.slice();
const deadline = Date.now() + Number(seconds) * 1000;
const randomInt = (m) => Math.floor(Math.random() * m);
let kicks = 0;
let accepted = 0;
while (Date.now() < deadline) {
  for (let round = 0; round < 200; round++, kicks++) {
    // Segment double bridge: neighbouring blocks B and C swap places, A B C D -> A C B D.
    const i = randomInt(n);
    const l1 = 1 + randomInt(50);
    const l2 = 1 + randomInt(50);
    if (l1 + l2 + 2 > n) continue;
    const [a, b1, b2, c1, c2, e] = [at(i), at(i + 1), at(i + l1), at(i + l1 + 1), at(i + l1 + l2), at(i + l1 + l2 + 1)];
    const kick = dist(a, c1) + dist(c2, b1) + dist(b2, e) - dist(a, b1) - dist(b2, c1) - dist(c2, e);
    reverse(i + 1, l1 + l2);
    reverse(i + 1, l2);
    reverse(i + 1 + l2, l1);
    activate(a, b1, b2, c1, c2, e);
    const candidate = length + kick + localSearch();
    if (candidate < length - EPSILON) {
      length = candidate;
      saved.set(tour);
      accepted++;
    } else {
      tour.set(saved);
      for (let p = 0; p < n; p++) pos[tour[p]] = p;
    }
  }
}

const issue = problem(Array.from(saved), n);
if (issue) throw new Error(issue);
console.log(`${name} ${tourLength(xs, ys, saved).toFixed(3)} (${kicks} kicks, ${accepted} kept)`);
