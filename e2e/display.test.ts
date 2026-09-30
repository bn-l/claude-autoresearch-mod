// What the band and the pane are handed (D12): Claude Code refuses a `$.state` value over
// 4 MiB of JSON, so the experiment is published as drawn (no `asi`, descriptions cut),
// and a long session's log still draws. The app's own state keeps everything.

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import {
  DRAWN_DESCRIPTION_CHARS,
  DRAWN_DESCRIPTION_CHARS_TIGHT,
  DRAWN_STATE_MAX_CHARS,
  drawnState,
} from "../plugin/hooks/app/context.ts";
import { createExperimentState, type ExperimentResult } from "../plugin/hooks/upstream/experiment-core.ts";
import { Session, makeRepo, removeTempDir, writeFiles } from "./node-host.ts";

const dirs: string[] = [];
const sessions: Session[] = [];
after(async () => {
  for (const session of sessions) session.end();
  for (const dir of dirs) await removeTempDir(dir);
});

const result = (run: number, description: string, asi?: Record<string, unknown>): ExperimentResult => ({
  commit: "abc1234",
  metric: run,
  metrics: {},
  status: "discard",
  description,
  timestamp: run,
  segment: 0,
  confidence: null,
  ...(asi ? { asi } : {}),
});

describe("the drawn experiment", () => {
  test("a log over 4 MiB is still drawn, every run of it", async () => {
    const dir = await makeRepo({}, { ".auto/prompt.md": "# Rules\n" });
    dirs.push(dir);
    const lines = [JSON.stringify({ type: "config", name: "big", metricName: "total_ms", metricUnit: "ms", bestDirection: "lower" })];
    for (let run = 1; run <= 3000; run++) {
      const description = run === 3000 ? "the very last run" : `try ${run} ${"d".repeat(1000)}`;
      lines.push(JSON.stringify({ ...result(run, description, { note: "n".repeat(600) }), run }));
    }
    const log = lines.join("\n") + "\n";
    assert.ok(log.length > 4 * 1024 * 1024);
    await writeFiles(dir, { ".auto/log.jsonl": log });

    const session = new Session(dir);
    sessions.push(session);
    await session.start();

    assert.deepEqual(session.host.refusedViews, []);
    const drawn = session.host.view.experiment!;
    assert.equal(drawn.results.length, 3000);
    assert.equal(drawn.results.at(-1)!.description, "the very last run");
    assert.equal(drawn.results[0]!.description.length, DRAWN_DESCRIPTION_CHARS);
    assert.ok(drawn.results.every((run) => !("asi" in run)));
    // the app keeps the whole log
    assert.equal(session.ctx.runtime.state.results[0]!.description.length, 1000 + "try 1 ".length);
    assert.equal(session.ctx.runtime.state.results[0]!.asi?.note, "n".repeat(600));
  });

  test("tens of thousands of runs fall back to a tighter cut", () => {
    const state = createExperimentState();
    for (let run = 1; run <= 20_000; run++) state.results.push(result(run, `run ${run} `.padEnd(300, "x")));
    const drawn = drawnState(state);
    assert.ok(JSON.stringify(drawn).length <= DRAWN_STATE_MAX_CHARS);
    assert.equal(drawn.results.length, 20_000);
    assert.equal(drawn.results[0]!.description.length, DRAWN_DESCRIPTION_CHARS_TIGHT);
  });

  test("a cut never ends on half of an emoji, and a short state is unchanged", () => {
    const state = createExperimentState();
    const description = "a".repeat(DRAWN_DESCRIPTION_CHARS - 1) + "😀 after";
    state.results.push(result(1, description), result(2, "short"));
    const drawn = drawnState(state);
    assert.equal(drawn.results[0]!.description, "a".repeat(DRAWN_DESCRIPTION_CHARS - 1));
    assert.deepEqual(drawn.results[1], state.results[1]);
    assert.equal(state.results[0]!.description, description);
  });
});
