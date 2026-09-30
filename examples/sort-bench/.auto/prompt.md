# Autoresearch: make sort.js faster

## Objective
Minimise the time `sort()` in `sort.js` takes on the benchmark's integer arrays
(six arrays of 2,500 to 3,500 integers between -10,000 and 10,000).

## Metrics
- **Primary**: total_ms (ms, lower is better): median over 7 rounds

## How to Run
`./.auto/measure.sh` outputs `METRIC total_ms=<number>`.

## Files in Scope
- `sort.js`: the sort implementation.

## Off Limits
- `bench.js`, `test.js`, `.auto/measure.sh`, `.auto/checks.sh`.

## Constraints
- `sort()` must sort in place, ascending, and return the same array (`.auto/checks.sh`).
- No dependencies.

## What's Been Tried
Nothing yet.
