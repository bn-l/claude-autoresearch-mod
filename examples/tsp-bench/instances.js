// The cities: fixed, seeded instances, the best known tour lengths, and the helpers that
// score and check a tour. Do not edit: this is part of the measuring stick.

// mulberry32: a small seeded generator, so every run sees the same cities.
function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// n cities spread evenly over a 1,000,000 × 1,000,000 square, at whole coordinates.
export function uniform(n, seed) {
  const random = generator(seed);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = Math.floor(random() * 1e6);
    ys[i] = Math.floor(random() * 1e6);
  }
  return { xs, ys };
}

// n cities in towns: each city is near one of `towns` random centres.
export function clustered(n, towns, seed) {
  const random = generator(seed);
  const centres = Array.from({ length: towns }, () => [random() * 1e6, random() * 1e6]);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const [cx, cy] = centres[Math.floor(random() * towns)];
    // Box-Muller: a normal offset with a spread of 40,000.
    const radius = 40000 * Math.sqrt(-2 * Math.log(1 - random()));
    const angle = 2 * Math.PI * random();
    xs[i] = Math.min(999999, Math.max(0, Math.floor(cx + radius * Math.cos(angle))));
    ys[i] = Math.min(999999, Math.max(0, Math.floor(cy + radius * Math.sin(angle))));
  }
  return { xs, ys };
}

// The benchmark. `best` is the shortest tour found for each by a long reference run.
export const INSTANCES = [
  { name: "uniform-2000", ...uniform(2000, 1), best: 32287446.441 },
  { name: "clustered-2000", ...clustered(2000, 12, 2), best: 17898180.291 },
  { name: "uniform-3000", ...uniform(3000, 3), best: 39749459.418 },
];

// The length of the closed tour: back to the first city at the end.
export function tourLength(xs, ys, tour) {
  let length = 0;
  for (let i = 0; i < tour.length; i++) {
    const a = tour[i];
    const b = tour[(i + 1) % tour.length];
    length += Math.sqrt((xs[a] - xs[b]) ** 2 + (ys[a] - ys[b]) ** 2);
  }
  return length;
}

// What's wrong with a tour of n cities, or null: it must hold each index 0..n-1 exactly once.
export function problem(tour, n) {
  if (tour === null || typeof tour !== "object" || typeof tour.length !== "number") return `returned ${typeof tour}, not a list of cities`;
  if (tour.length !== n) return `returned ${tour.length} cities, not ${n}`;
  const seen = new Uint8Array(n);
  for (const city of tour) {
    if (!Number.isInteger(city) || city < 0 || city >= n) return `returned ${city}, which isn't a city index`;
    if (seen[city]) return `visits city ${city} twice`;
    seen[city] = 1;
  }
  return null;
}
