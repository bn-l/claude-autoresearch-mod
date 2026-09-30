// Moving a session between pi and Claude Code (PLAN §7.2): the one place upstream is
// the oracle. Upstream's own extension (upstream/extensions/pi-autoresearch/index.ts, run
// on a minimal pi host like its tests' createHarness, with real git) writes a log that
// our app picks up and continues; a log our app wrote is picked up and continued by
// upstream's. Both sides must agree on runs, statuses, metrics, segments and baselines.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as nodePath from "node:path";
import { after, describe, test } from "node:test";
import { pathToFileURL } from "node:url";

import { REPO_ROOT, Session, logLines, makeRepo, removeTempDir, writeFiles } from "./node-host.ts";

const dirs: string[] = [];
const sessions: Session[] = [];
after(async () => {
  for (const session of sessions) session.end();
  for (const dir of dirs) await removeTempDir(dir);
});

const UPSTREAM = nodePath.join(REPO_ROOT, "upstream/extensions/pi-autoresearch");
// Loaded by URL so the type checker stays out of upstream's sources.
const upstreamIndex = pathToFileURL(nodePath.join(UPSTREAM, "index.ts")).href;
const upstreamJsonl = pathToFileURL(nodePath.join(UPSTREAM, "jsonl.ts")).href;

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** upstream tests/activation.test.mjs createHarness, with a pi.exec that runs for real. */
async function piHarness(cwd: string) {
  const { default: extension } = (await import(upstreamIndex)) as { default: (pi: Any) => void };
  const commands = new Map<string, Any>();
  const handlers = new Map<string, Any>();
  const tools = new Map<string, Any>();
  const branch: Any[] = [];
  let activeTools: string[] = [];
  const sent: string[] = [];

  extension({
    on: (name: string, handler: Any) => handlers.set(name, handler),
    appendEntry: (customType: string, data: Any) => branch.push({ type: "custom", customType, data }),
    registerTool: (tool: Any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: Any) => commands.set(name, command),
    registerShortcut: () => undefined,
    getActiveTools: () => activeTools,
    setActiveTools: (next: string[]) => (activeTools = [...next]),
    sendUserMessage: (content: string) => sent.push(content),
    exec: (command: string, args: string[], options: { cwd?: string; timeout?: number } = {}) =>
      new Promise((resolve) => {
        execFile(command, args, { cwd: options.cwd, timeout: options.timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
          const code = error ? ((error as { code?: unknown }).code as number | undefined) ?? 1 : 0;
          resolve({ code: typeof code === "number" ? code : 1, stdout, stderr, killed: Boolean(error && (error as { killed?: boolean }).killed) });
        });
      }),
  });

  const ctx = {
    cwd,
    mode: "tui",
    hasUI: false,
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort: () => undefined,
    sessionManager: { getSessionId: () => `pi:${cwd}`, getBranch: () => branch },
    ui: { setWidget: () => undefined, notify: () => undefined, custom: () => undefined },
  };

  let calls = 0;
  const call = async (name: string, params: Record<string, unknown>) => {
    const result = await tools.get(name).execute(`pi_call_${++calls}`, params, undefined, undefined, ctx);
    return result.content[0].text as string;
  };
  return {
    start: () => handlers.get("session_start")({}, ctx),
    command: (args: string) => commands.get("autoresearch").handler(args, ctx),
    call,
    activeTools: () => activeTools,
    sent,
  };
}

const MEASURE = { text: '#!/bin/bash\necho "METRIC total_ms=$(cat speed.txt)"\necho "METRIC mem_mb=12"\n', mode: 0o755 };

async function repo() {
  const dir = await makeRepo({ "speed.txt": "100\n" }, { ".auto/prompt.md": "# Make it fast\n", ".auto/measure.sh": MEASURE });
  dirs.push(dir);
  return dir;
}

describe("pi and the mod share a session", () => {
  test("a session pi started resumes in the mod, and continues there", async () => {
    const dir = await repo();
    const pi = await piHarness(dir);
    await pi.start();
    await pi.command("go");
    await pi.call("init_experiment", { name: "sort speed", metric_name: "total_ms", metric_unit: "ms", direction: "lower" });
    await pi.call("run_experiment", { command: "bash .auto/measure.sh" });
    await pi.call("log_experiment", { commit: "0000000", metric: 100, status: "keep", description: "baseline", metrics: { mem_mb: 12 } });
    await writeFiles(dir, { "speed.txt": "90\n" });
    await pi.call("run_experiment", { command: "bash .auto/measure.sh" });
    await pi.call("log_experiment", {
      commit: "0000000",
      metric: 90,
      status: "keep",
      description: "faster",
      metrics: { mem_mb: 12 },
      asi: { hypothesis: "cache the pivot" },
    });
    await writeFiles(dir, { "speed.txt": "95\n" });
    await pi.call("log_experiment", { commit: "0000000", metric: 95, status: "discard", description: "slower", metrics: { mem_mb: 13 } });

    const session = new Session(dir);
    sessions.push(session);
    await session.start();
    const state = session.ctx.runtime.state;
    assert.equal(session.app.isModeOn(), true);
    assert.equal(state.name, "sort speed");
    assert.deepEqual(state.results.map((r) => [r.status, r.metric, r.metrics.mem_mb]), [["keep", 100, 12], ["keep", 90, 12], ["discard", 95, 13]]);
    assert.equal(state.bestMetric, 100);
    assert.deepEqual(state.secondaryMetrics.map((m) => m.name), ["mem_mb"]);
    assert.equal(state.results[1]!.asi?.hypothesis, "cache the pivot");

    // The mod carries on where pi left off: run #4, same secondary metric rules.
    const missing = await session.use("log_experiment", { commit: "0000000", metric: 80, status: "keep", description: "x" });
    assert.match(missing.result, /Missing secondary metrics: mem_mb/);
    await writeFiles(dir, { "speed.txt": "80\n" });
    await session.use("run_experiment", { command: "bash .auto/measure.sh" });
    const logged = await session.use("log_experiment", { commit: "0000000", metric: 80, status: "keep", description: "radix", metrics: { mem_mb: 12 } });
    assert.match(logged.result, /^Logged #4: keep — radix/);
    assert.match(logged.result, /-20\.0%/);
  });

  test("a session the mod started resumes in pi, and continues there", async () => {
    const dir = await repo();
    const session = new Session(dir);
    sessions.push(session);
    await session.start();
    await session.command("go");
    await session.use("init_experiment", { name: "sort speed", metric_name: "total_ms", metric_unit: "ms", direction: "lower" });
    await session.use("run_experiment", { command: "bash .auto/measure.sh" });
    await session.use("log_experiment", { commit: "0000000", metric: 100, status: "keep", description: "baseline", metrics: { mem_mb: 12 } });
    await session.use("log_experiment", { commit: "0000000", metric: 0, status: "crash", description: "segfault", metrics: { mem_mb: 0 } });
    // A new segment, as a changed target starts one.
    await session.use("init_experiment", { name: "sort memory", metric_name: "mem_mb", metric_unit: "MB", direction: "lower" });
    await session.use("log_experiment", { commit: "0000000", metric: 12, status: "keep", description: "memory baseline" });

    const { reconstructJsonlState } = (await import(upstreamJsonl)) as { reconstructJsonlState: (text: string) => Any };
    const { readFile } = await import("node:fs/promises");
    const theirs = reconstructJsonlState(await readFile(nodePath.join(dir, ".auto/log.jsonl"), "utf8"));
    const ours = session.ctx.runtime.state;
    assert.equal(theirs.name, ours.name);
    assert.equal(theirs.metricName, "mem_mb");
    assert.equal(theirs.currentSegment, 1);
    assert.deepEqual(
      theirs.results.map((r: Any) => [r.status, r.metric, r.segment]),
      ours.results.map((r) => [r.status, r.metric, r.segment]),
    );

    // pi picks the session up (same cwd, a log: on) and logs run #4 against segment 1's baseline.
    const pi = await piHarness(dir);
    await pi.start();
    assert.deepEqual(pi.activeTools().sort(), ["init_experiment", "log_experiment", "run_experiment"]);
    const text = await pi.call("log_experiment", { commit: "0000000", metric: 10, status: "keep", description: "smaller buffers" });
    assert.match(text, /^Logged #4: keep — smaller buffers/);
    assert.match(text, /Baseline mem_mb: 12/);
    const lines = await logLines(dir);
    assert.deepEqual(lines.filter((line) => line.run).map((line) => line.run), [1, 2, 3, 4]);
  });
});
