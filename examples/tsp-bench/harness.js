// Runs solve() from tour.js in a worker thread, so a solver that never returns can be
// stopped. Do not edit: this is part of the measuring stick.
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

// One line for an exception: its message and where in tour.js it came from.
function describe(thrown) {
  if (!(thrown instanceof Error)) return `threw ${String(thrown)}`;
  const where = thrown.stack?.match(/tour\.js:\d+:\d+/)?.[0];
  return `${thrown.name}: ${thrown.message}${where ? ` (${where})` : ""}`;
}

if (!isMainThread && workerData?.cases) {
  const { solve } = await import("./tour.js");
  for (const { xs, ys, budgetMs } of workerData.cases) {
    const t0 = performance.now();
    let tour;
    let error;
    try {
      tour = solve(xs, ys, budgetMs);
    } catch (thrown) {
      error = describe(thrown);
    }
    const ms = performance.now() - t0;
    if (tour !== null && typeof tour === "object" && typeof tour.length === "number") tour = Array.from(tour);
    else if (error === undefined) error = `solve() returned ${typeof tour}, not a list of cities`;
    parentPort.postMessage({ tour, ms, error });
  }
}

// Solves each case ({ xs, ys, budgetMs }) in turn. Resolves to one { tour, ms, error } per
// case that finished, and `stopped` if the worker was still running after limitMs.
export function run(cases, limitMs) {
  return new Promise((resolve) => {
    const results = [];
    const worker = new Worker(new URL(import.meta.url), { workerData: { cases } });
    const timer = setTimeout(() => {
      worker.terminate();
      resolve({ results, stopped: true });
    }, limitMs);
    worker.on("message", (result) => results.push(result));
    worker.on("error", (error) => {
      clearTimeout(timer);
      resolve({ results, error: describe(error) });
    });
    worker.on("exit", () => {
      clearTimeout(timer);
      resolve({ results });
    });
  });
}
