// The compaction answer over realistic transcripts (PLAN §4.10, I3): which messages are
// kept after upstream's summary, where the cut may fall, the size cap, and what the
// summary holds, read from the session files on disk.

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { TAIL_MAX_CHARS, keptTail, type CompactMessage } from "../plugin/hooks/app/compaction.ts";
import { Session, makeRepo, removeTempDir, writeFiles } from "./node-host.ts";

const dirs: string[] = [];
const sessions: Session[] = [];
after(async () => {
  for (const session of sessions) session.end();
  for (const dir of dirs) await removeTempDir(dir);
});

const LOG = "mcp__plugin_autoresearch_autoresearch__log_experiment";
const RUN = "mcp__plugin_autoresearch_autoresearch__run_experiment";

let handles = 0;
const assistant = (text: string, ...uses: { id: string; tool: string; text?: string; input?: unknown }[]): CompactMessage => ({
  role: "assistant",
  text,
  toolUses: uses.map((use) => ({ tool_use_id: use.id, tool: use.tool, input: use.input ?? {}, text: use.text })),
  handle: `h${++handles}`,
});
const results = (...pairs: [id: string, text: string][]): CompactMessage => ({
  role: "user",
  text: "",
  toolUses: [],
  toolResults: pairs.map(([id, text]) => ({ tool_use_id: id, text })),
  handle: `h${++handles}`,
});
const person = (text: string): CompactMessage => ({ role: "user", text, toolUses: [], handle: `h${++handles}` });

describe("the kept tail", () => {
  test("starts after the last logged run and never on a tool result", () => {
    const messages = [
      person("go"),
      assistant("", { id: "r1", tool: RUN }),
      results(["r1", "✅ PASSED"]),
      assistant("", { id: "l1", tool: LOG, text: "Logged #1: keep — base" }),
      results(["l1", "Logged #1: keep — base"]),
      // The next iteration's edit and a Bash call answered in one user message.
      assistant("Next: unroll.", { id: "e2", tool: "Edit" }, { id: "b2", tool: "Bash" }),
      results(["e2", "ok"], ["b2", "ok"]),
    ];
    const { tail, hasInFlightWork } = keptTail(messages);
    assert.deepEqual(tail, messages.slice(5));
    assert.equal(hasInFlightWork, true);
  });

  test("a refused log is not a boundary: the iteration is still open", () => {
    const messages = [
      assistant("", { id: "l1", tool: LOG, text: "Logged #1: keep — base" }),
      results(["l1", "Logged #1: keep — base"]),
      assistant("", { id: "r2", tool: RUN }),
      results(["r2", "✅ PASSED"]),
      assistant("", { id: "l2", tool: LOG, text: "❌ Missing secondary metrics: mem_mb" }),
      results(["l2", "❌ Missing secondary metrics: mem_mb"]),
    ];
    const { tail, hasInFlightWork } = keptTail(messages);
    assert.deepEqual(tail, messages.slice(2));
    assert.equal(hasInFlightWork, true, "the unlogged run result is kept and flagged");
  });

  test("right after a log only the model's close is kept, and nothing is in flight", () => {
    const messages = [
      assistant("", { id: "l1", tool: LOG, text: "Logged #1: keep" }),
      results(["l1", "Logged #1: keep"]),
      assistant("Kept. Moving on."),
    ];
    const { tail, hasInFlightWork } = keptTail(messages);
    assert.deepEqual(tail, messages.slice(2));
    assert.equal(hasInFlightWork, false);
  });

  test("with no log yet the whole conversation is the iteration", () => {
    const messages = [person("go"), assistant("", { id: "r1", tool: RUN }), results(["r1", "✅"])];
    assert.deepEqual(keptTail(messages).tail, messages);
  });

  test("an oversized tail keeps its newest part, cut on a clean boundary", () => {
    const big = "x".repeat(60_000);
    const messages: CompactMessage[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(assistant(`step ${i}`, { id: `b${i}`, tool: "Bash", input: { command: "noisy" } }));
      messages.push(results([`b${i}`, big]));
    }
    const { tail } = keptTail(messages);
    const size = tail.reduce((sum, m) => sum + m.text.length + (m.toolResults ?? []).reduce((s, r) => s + (r.text?.length ?? 0), 0), 0);
    assert.ok(size <= TAIL_MAX_CHARS, `${size}`);
    assert.equal(tail[0]!.role, "assistant", "never starts with an orphaned tool result");
    assert.equal(tail.at(-1), messages.at(-1));
    assert.ok(tail.length >= 2);
  });
});

describe("the summary", () => {
  test("holds the rules, the ideas and the last 50 runs, read from the files", async () => {
    const lines = [JSON.stringify({ type: "config", name: "sort speed", metricName: "total_ms", metricUnit: "ms", bestDirection: "lower" })];
    for (let run = 1; run <= 60; run++) {
      lines.push(JSON.stringify({ run, commit: `c${run}`, metric: 200 - run, metrics: {}, status: run % 3 ? "keep" : "discard", description: `idea number ${run}`, timestamp: run, segment: 0, confidence: null }));
    }
    const dir = await makeRepo({}, {
      ".auto/log.jsonl": lines.join("\n") + "\n",
      ".auto/prompt.md": "# Rules\nNever touch the tests.\n",
      ".auto/ideas.md": "- radix sort\n",
    });
    dirs.push(dir);
    const session = new Session(dir);
    sessions.push(session);
    await session.start();

    const answer = await session.app.compact({ trigger: "manual", messages: [person("hi")] });
    assert.ok(answer && "messages" in answer);
    const summary = answer.messages[0]!.text;
    assert.match(summary, /Never touch the tests\./);
    assert.match(summary, /radix sort/);
    assert.match(summary, /idea number 60/);
    assert.match(summary, /idea number 11\b/);
    assert.doesNotMatch(summary, /idea number 10\b/);
  });

  test("a log over 4 MiB is read whole", async () => {
    const dir = await makeRepo({}, { ".auto/prompt.md": "# Rules\n" });
    dirs.push(dir);
    const lines = [JSON.stringify({ type: "config", name: "big", metricName: "total_ms", metricUnit: "ms", bestDirection: "lower" })];
    const padding = "p".repeat(2000);
    for (let run = 1; run <= 2500; run++) {
      lines.push(JSON.stringify({ run, commit: "c", metric: run, metrics: {}, status: "keep", description: run === 2500 ? "the very last run" : `r${run}`, timestamp: run, segment: 0, confidence: null, asi: { note: padding } }));
    }
    await writeFiles(dir, { ".auto/log.jsonl": lines.join("\n") + "\n" });
    const session = new Session(dir);
    sessions.push(session);
    await session.start();
    assert.equal(session.ctx.runtime.state.results.length, 2500);
    const answer = await session.app.compact({ trigger: "manual", messages: [person("hi")] });
    assert.ok(answer && "messages" in answer);
    assert.match(answer.messages[0]!.text, /the very last run/);
  });
});
