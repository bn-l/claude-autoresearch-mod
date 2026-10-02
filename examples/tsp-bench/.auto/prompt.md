# Autoresearch: shorten the tours tour.js finds

## Objective
Minimise how much longer the tours `solve()` in `tour.js` finds are than the best known
tours, on the benchmark's three travelling salesman instances (2,000 to 3,000 cities,
uniform and clustered), with 1 second per instance.

## Metrics
- **Primary**: gap_pct (%, lower is better): the mean gap to the best known tour lengths

## How to Run
`./.auto/measure.sh` outputs `METRIC gap_pct=<number>`.

## Files in Scope
- `tour.js`: the solver.

## Off Limits
- `bench.js`, `harness.js`, `instances.js`, `test.js`, `.auto/measure.sh`, `.auto/checks.sh`.

## Constraints
- `solve(xs, ys, budgetMs)` returns each city index exactly once and finishes within
  `budgetMs` (`.auto/checks.sh`).
- It solves the instance it's given: no tours or tuning computed ahead of time for the
  benchmark's instances.
- No dependencies.

## What's Been Tried
Nothing yet.
