// Correctness checks for solve(): every city exactly once, within the budget, on small and
// awkward inputs, and a real tour (no longer than nearest neighbour's) on instances the
// benchmark never shows. Exits 1 on the first failure.
import { run } from "./harness.js";
import { clustered, problem, tourLength, uniform } from "./instances.js";

const GRACE_MS = 100;

const line = (n) => ({ xs: Float64Array.from({ length: n }, (_, i) => i * 1000), ys: new Float64Array(n) });
const onePlace = (n) => ({ xs: new Float64Array(n).fill(500000), ys: new Float64Array(n).fill(500000) });
const twice = ({ xs, ys }) => ({ xs: Float64Array.from([...xs, ...xs]), ys: Float64Array.from([...ys, ...ys]) });

const cases = [
  { name: "no cities", ...uniform(0, 1), budgetMs: 50 },
  { name: "one city", ...uniform(1, 2), budgetMs: 50 },
  { name: "two cities", ...uniform(2, 3), budgetMs: 50 },
  { name: "three cities", ...uniform(3, 4), budgetMs: 50 },
  { name: "eight cities", ...uniform(8, 5), budgetMs: 50 },
  { name: "40 cities on a line", ...line(40), budgetMs: 50 },
  { name: "40 cities in one place", ...onePlace(40), budgetMs: 50 },
  { name: "every city twice", ...twice(uniform(300, 6)), budgetMs: 100 },
  { name: "unseen uniform-1500", ...uniform(1500, 101), budgetMs: 300, unseen: true },
  { name: "unseen clustered-1500", ...clustered(1500, 8, 102), budgetMs: 300, unseen: true },
];

// The length of the nearest-neighbour tour from city 0: any real solver does at least this well.
function nearestNeighbourLength(xs, ys) {
  const n = xs.length;
  const visited = new Uint8Array(n);
  const tour = [0];
  visited[0] = 1;
  for (let step = 1; step < n; step++) {
    const current = tour[tour.length - 1];
    let nearest = -1;
    for (let city = 0; city < n; city++) {
      if (visited[city]) continue;
      if (nearest < 0 || (xs[city] - xs[current]) ** 2 + (ys[city] - ys[current]) ** 2 < (xs[nearest] - xs[current]) ** 2 + (ys[nearest] - ys[current]) ** 2) nearest = city;
    }
    visited[nearest] = 1;
    tour.push(nearest);
  }
  return tourLength(xs, ys, tour);
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const limitMs = cases.reduce((sum, { budgetMs }) => sum + budgetMs, 0) + 5000;
const { results, stopped, error } = await run(cases.map(({ xs, ys, budgetMs }) => ({ xs, ys, budgetMs })), limitMs);
for (const [index, { name, xs, ys, budgetMs, unseen }] of cases.entries()) {
  const result = results[index];
  if (!result) fail(`${name}: solve() didn't return${stopped ? ", stopped" : ""}${error ? `: ${error}` : ""}`);
  if (result.error) fail(`${name}: ${result.error}`);
  const issue = problem(result.tour, xs.length);
  if (issue) fail(`${name}: solve() ${issue}`);
  if (result.ms > budgetMs + GRACE_MS) fail(`${name}: took ${result.ms.toFixed(0)} ms, over its ${budgetMs} ms budget`);
  if (unseen) {
    const ratio = tourLength(xs, ys, result.tour) / nearestNeighbourLength(xs, ys);
    if (ratio > 1 + 1e-9) fail(`${name}: the tour is ${((ratio - 1) * 100).toFixed(1)}% longer than nearest neighbour's`);
  }
}
console.log(`ok: ${cases.length} cases`);
