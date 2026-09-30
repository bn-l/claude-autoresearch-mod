// ported from pi-autoresearch@939ede8 tests/activation.test.mjs: the pure tests. The ones
// that drive the whole extension through a fake pi (session_start, /autoresearch on, off,
// clear, dashboard, the discard reminder) are ported to the engine-less e2e suite, which
// drives this port's app the same way (e2e/activation.test.ts).
import assert from "node:assert/strict";
import test from "node:test";

import { shouldAutoActivateAutoresearch } from "../plugin/hooks/upstream/experiment-core.ts";
import type { ExperimentResult, ExperimentState } from "../plugin/hooks/upstream/experiment-core.ts";
import { logRowDetails, renderLogResult } from "../plugin/hooks/upstream/tool-render.ts";
import type { Theme } from "../plugin/hooks/upstream/dashboard-lines.ts";

const plain: Theme = { fg: (_color, text) => text, bold: (text) => text };

test("same-cwd persisted logs still auto-activate autoresearch", () => {
  assert.equal(
    shouldAutoActivateAutoresearch("/repo", "/repo", true),
    true,
  );
});

test("missing persisted logs never auto-activate autoresearch", () => {
  assert.equal(
    shouldAutoActivateAutoresearch("/repo", "/repo", false),
    false,
  );
});

test("redirected workingDir logs require a pi-session activation", () => {
  assert.equal(
    shouldAutoActivateAutoresearch("/repo", "/other-worktree", true),
    false,
  );
  assert.equal(
    shouldAutoActivateAutoresearch("/repo", "/other-worktree", true, true),
    true,
  );
});

test("a recorded manual off keeps same-cwd sessions inactive despite a persisted log", () => {
  assert.equal(
    shouldAutoActivateAutoresearch("/repo", "/repo", true, false),
    false,
  );
});

test("a recorded activation reactivates a redirected off decision on later start", () => {
  assert.equal(
    shouldAutoActivateAutoresearch("/repo", "/other-worktree", true, false),
    false,
  );
  assert.equal(
    shouldAutoActivateAutoresearch("/repo", "/other-worktree", true, true),
    true,
  );
});

// staleLogExperimentEntry().message.details from the upstream test
function staleDetails(): { experiment: ExperimentResult; state: ExperimentState } {
  const experiment: ExperimentResult = {
    commit: "abcdef0",
    metric: 12,
    metrics: {},
    status: "crash",
    description: "stale run from deleted log",
    timestamp: Date.now(),
    segment: 0,
    confidence: null,
  };
  const state: ExperimentState = {
    results: [experiment],
    bestMetric: 12,
    bestDirection: "lower",
    metricName: "quote_field_usec",
    metricUnit: "µs",
    secondaryMetrics: [],
    name: "PickPeriod backend quote field optimization",
    currentSegment: 0,
    maxExperiments: null,
    confidence: null,
  };
  return { experiment, state };
}

test("log_experiment leaves ordinary results unchanged and ignores malformed revisit annotations", () => {
  const { experiment, state } = staleDetails();
  const render = (asi: Record<string, unknown> | undefined) =>
    renderLogResult(logRowDetails({ ...experiment, asi }, state, null), "", plain);
  const ordinaryResult = render(undefined);

  assert.doesNotMatch(ordinaryResult, /Revisiting/);
  for (const revisits_run of [undefined, null, "1", 0, -1, 1.5, true]) {
    assert.deepEqual(render({ revisits_run }), ordinaryResult);
  }
});

test("log_experiment shows the revisit label on its own line", () => {
  const { experiment, state } = staleDetails();
  const text = renderLogResult(logRowDetails({ ...experiment, asi: { revisits_run: 5 } }, state, null), "", plain);
  assert.match(text, /\n↻ Revisiting #5$/);
});
