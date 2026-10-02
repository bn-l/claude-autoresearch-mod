// The function under optimization: returns a short closed tour through every city, as the
// order to visit them in (each index 0..n-1 exactly once). City i is at (xs[i], ys[i]), and
// solve() may take up to budgetMs milliseconds. Deliberately simple: nearest neighbour, which
// ignores the budget.
export function solve(xs, ys, budgetMs) {
  const n = xs.length;
  if (n === 0) return [];
  const visited = new Uint8Array(n);
  const tour = [0];
  visited[0] = 1;
  let current = 0;
  for (let step = 1; step < n; step++) {
    let nearest = -1;
    let nearestDistance = Infinity;
    for (let city = 0; city < n; city++) {
      if (visited[city]) continue;
      const distance = (xs[city] - xs[current]) ** 2 + (ys[city] - ys[current]) ** 2;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = city;
      }
    }
    visited[nearest] = 1;
    tour.push(nearest);
    current = nearest;
  }
  return tour;
}
