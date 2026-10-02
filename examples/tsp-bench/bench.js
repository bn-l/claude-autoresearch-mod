// Gives solve() 1 s on each benchmark instance and prints the mean gap to the best known
// tours as `METRIC gap_pct=<percent>`. Do not edit: this is the measuring stick.
import { run } from "./harness.js";
import { INSTANCES, problem, tourLength } from "./instances.js";

const BUDGET_MS = 1000;
const GRACE_MS = 100;

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const cases = INSTANCES.map(({ xs, ys }) => ({ xs, ys, budgetMs: BUDGET_MS }));
const { results, stopped, error } = await run(cases, INSTANCES.length * BUDGET_MS + 5000);
let total = 0;
for (const [index, { name, xs, ys, best }] of INSTANCES.entries()) {
  const result = results[index];
  if (!result) fail(`${name}: solve() didn't return${stopped ? ", stopped" : ""}${error ? `: ${error}` : ""}`);
  if (result.error) fail(`${name}: ${result.error}`);
  const issue = problem(result.tour, xs.length);
  if (issue) fail(`${name}: solve() ${issue}`);
  if (result.ms > BUDGET_MS + GRACE_MS) fail(`${name}: took ${result.ms.toFixed(0)} ms, over its ${BUDGET_MS} ms budget`);
  const gap = (tourLength(xs, ys, result.tour) / best - 1) * 100;
  total += gap;
  console.log(`${name}: gap ${gap.toFixed(2)}% in ${result.ms.toFixed(0)} ms`);
}
console.log(`METRIC gap_pct=${(total / INSTANCES.length).toFixed(3)}`);
