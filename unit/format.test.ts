// The two upstream display bugs this port fixes (DEVIATIONS I7, I8): numbers rounded
// apart from their integer part or grouped with their sign, and run numbers from 100 on
// running into the commit column.
import assert from "node:assert/strict";
import test from "node:test";

import { commas, createExperimentState, fmtNum, formatNum, type ExperimentResult } from "../plugin/hooks/upstream/experiment-core.ts";
import { overlaySpinnerLine, renderDashboardLines, type Theme } from "../plugin/hooks/upstream/dashboard-lines.ts";

const plain: Theme = { fg: (_color, text) => text, bold: (text) => text };

test("a fraction that rounds up carries into the integer part", () => {
  assert.equal(fmtNum(1.995, 2), "2.00");
  assert.equal(fmtNum(0.999, 2), "1.00");
  assert.equal(fmtNum(12345.999, 2), "12,346.00");
  assert.equal(fmtNum(999999.996, 2), "1,000,000.00");
  assert.equal(fmtNum(-1.999, 2), "-2.00");
  assert.equal(formatNum(9.999, "ms"), "10.00ms");
});

test("what upstream already got right stays as it was", () => {
  assert.equal(fmtNum(1.2345, 2), "1.23");
  assert.equal(fmtNum(2.5, 2), "2.50");
  assert.equal(fmtNum(-0.001, 2), "-0.00");
  assert.equal(formatNum(15586, "µs"), "15,586µs");
  assert.equal(formatNum(null, "ms"), "—");
  assert.equal(commas(-2.5), "-2");
  assert.equal(commas(-0.4), "0");
});

test("negative numbers are grouped without the sign", () => {
  assert.equal(commas(-123), "-123");
  assert.equal(commas(-123456), "-123,456");
  assert.equal(commas(-1234), "-1,234");
  assert.equal(formatNum(-123, "ms"), "-123ms");
});

const result = (run: number): ExperimentResult => ({
  commit: `c${String(run).padStart(6, "0")}`,
  metric: 100 - run / 100,
  metrics: {},
  status: "keep",
  description: `run ${run}`,
  timestamp: run,
  segment: 0,
  confidence: null,
});

test("run numbers from 100 on keep a space before the commit", () => {
  for (const runs of [99, 100, 1000, 12345]) {
    const state = createExperimentState();
    state.metricName = "total_ms";
    state.metricUnit = "ms";
    for (let run = 1; run <= runs; run++) state.results.push(result(run));
    state.bestMetric = state.results[0]!.metric;
    const lines = renderDashboardLines(state, 140, plain, 3);
    const last = lines.find((line) => line.includes(`run ${runs}`));
    assert.ok(last, `row ${runs} drawn`);
    assert.match(last, new RegExp(`^  ${runs} +c${String(runs).padStart(6, "0")} `), last);
    const header = lines.find((line) => line.includes("commit"))!;
    assert.equal(header.indexOf("commit"), last.indexOf("c" + String(runs).padStart(6, "0")), "the header lines up");
  }
});

test("the dashboard's running row keeps a space after a long run number", () => {
  assert.match(overlaySpinnerLine(7, 0, 1000, 80, plain), /^ {2}7 {2}\S/);
  assert.match(overlaySpinnerLine(100, 0, 1000, 80, plain), /^ {2}100 \S/);
});
