// The experiment loop on real git and bash (PLAN §7.2): what the model is told, what the
// log holds, what git and the tree look like, and which processes are left, after the
// three tools run the way the model calls them, including the ways benchmarks break.

import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import * as nodePath from "node:path";
import { after, describe, test } from "node:test";

import {
  Session,
  git,
  logLines,
  makeRepo,
  processesWith,
  removeTempDir,
  sh,
  sleep,
  writeFiles,
  type FileSpec,
} from "./node-host.ts";

const dirs: string[] = [];
const sessions: Session[] = [];
after(async () => {
  for (const session of sessions) session.end();
  for (const dir of dirs) await removeTempDir(dir);
});

const MEASURE = '#!/bin/bash\necho "sorting..."\necho "METRIC total_ms=$(cat speed.txt)"\n';

/** A repo with a benchmark reading speed.txt, and a session in it with the mode on. */
async function loopIn(files: Record<string, FileSpec> = {}, auto: Record<string, FileSpec> = {}) {
  const dir = await makeRepo({ "speed.txt": "100\n", "sort.js": "// v1\n", ...files }, {
    ".auto/prompt.md": "# Make the sort fast\n",
    ".auto/measure.sh": { text: MEASURE, mode: 0o755 },
    ...auto,
  });
  dirs.push(dir);
  const session = new Session(dir, { timeScale: 0.05 });
  sessions.push(session);
  await session.start();
  await session.command("make the sort fast");
  await session.use("init_experiment", { name: "sort speed", metric_name: "total_ms", metric_unit: "ms", direction: "lower" });
  return { dir, session };
}

/** A session whose measure.sh is `body`: the benchmark the model must run. */
const benchmark = (body: string) => loopIn({}, { ".auto/measure.sh": { text: `#!/bin/bash\n${body}\n`, mode: 0o755 } });
const MEASURE_CMD = { command: "bash .auto/measure.sh" };

const read = (dir: string, relative: string) => fsp.readFile(nodePath.join(dir, relative), "utf8");
const exists = (dir: string, relative: string) =>
  fsp.stat(nodePath.join(dir, relative)).then(
    () => true,
    () => false,
  );

describe("keep and discard", () => {
  test("a baseline, a kept improvement and a discarded regression", async () => {
    const { dir, session } = await loopIn();

    const baseline = await session.use("run_experiment", { command: "bash .auto/measure.sh" });
    assert.match(baseline.result, /✅ PASSED/);
    assert.match(baseline.result, /total_ms=100/);
    const logged1 = await session.use("log_experiment", { commit: "0000000", metric: 100, status: "keep", description: "baseline" });
    assert.match(logged1.result, /^Logged #1: keep — baseline/);

    await writeFiles(dir, { "speed.txt": "80\n", "sort.js": "// v2\n" });
    const faster = await session.use("run_experiment", { command: "bash .auto/measure.sh" });
    assert.match(faster.result, /total_ms=80/);
    assert.match(faster.result, /metric: 80/);
    const logged2 = await session.use("log_experiment", { commit: "0000000", metric: 80, status: "keep", description: "use insertion sort for small runs" });
    assert.match(logged2.result, /Logged #2: keep/);
    assert.match(logged2.result, /-20\.0%/);
    assert.match(logged2.result, /📝 Git: committed/);

    const message = await git(dir, "log", "-1", "--format=%B");
    assert.match(message, /^use insertion sort for small runs\n\nResult: \{"status":"keep","total_ms":80\}/);
    const head = await git(dir, "rev-parse", "--short=7", "HEAD");

    // A regression, with an untracked file and folder, an edit inside .auto/ and a
    // nested legacy session file: the revert takes the first three back only.
    await writeFiles(dir, {
      "speed.txt": "120\n",
      "sort.js": "// v3\n",
      "scratch.txt": "tmp\n",
      "build/out.o": "bin\n",
      ".auto/ideas.md": "- try radix\n",
      "pkg/autoresearch.notes.md": "nested legacy\n",
    });
    await session.use("run_experiment", { command: "bash .auto/measure.sh" });
    const logged3 = await session.use("log_experiment", { commit: head, metric: 120, status: "discard", description: "quicksort everywhere" });
    assert.match(logged3.result, /📝 Git: reverted changes \(discard\) — autoresearch files preserved/);

    assert.equal(await read(dir, "speed.txt"), "80\n");
    assert.equal(await read(dir, "sort.js"), "// v2\n");
    assert.equal(await exists(dir, "scratch.txt"), false);
    assert.equal(await exists(dir, "build"), false);
    assert.equal(await read(dir, ".auto/ideas.md"), "- try radix\n");
    assert.equal(await read(dir, "pkg/autoresearch.notes.md"), "nested legacy\n");
    assert.equal(await read(dir, ".auto/prompt.md"), "# Make the sort fast\n");
    assert.equal(await git(dir, "rev-parse", "--short=7", "HEAD"), head);

    const lines = await logLines(dir);
    assert.deepEqual(lines.map((line) => line.type ?? line.status), ["config", "keep", "keep", "discard"]);
    assert.deepEqual(lines.slice(1).map((line) => [line.run, line.metric]), [[1, 100], [2, 80], [3, 120]]);
    assert.equal(lines[2]!.commit, head);
    assert.equal(session.ctx.runtime.state.bestMetric, 100);
  });

  test("a keep with nothing to change says so and still logs", async () => {
    const { dir, session } = await loopIn();
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "session files");
    await session.use("run_experiment", { command: "bash .auto/measure.sh" });
    const logged = await session.use("log_experiment", { commit: "0000000", metric: 100, status: "keep", description: "baseline" });
    assert.match(logged.result, /nothing to commit/);
    assert.equal((await logLines(dir)).length, 2);
  });

  test("a keep commits past a failing pre-commit hook (repo hooks are off, F11)", async () => {
    const { dir, session } = await loopIn();
    await writeFiles(dir, { ".git/hooks/pre-commit": { text: "#!/bin/sh\necho blocked >&2\nexit 1\n", mode: 0o755 } });
    await writeFiles(dir, { "sort.js": "// v2\n" });
    await session.use("run_experiment", { command: "bash .auto/measure.sh" });
    const logged = await session.use("log_experiment", { commit: "0000000", metric: 100, status: "keep", description: "baseline" });
    assert.match(logged.result, /📝 Git: committed/);
    assert.equal(await git(dir, "log", "-1", "--format=%s"), "baseline");
  });
});

// pi's keep runs `git add -A` and its discard `git checkout -- .` and `git clean -fd`,
// which would commit or erase the person's uncommitted work. Here both touch only what
// changed since the iteration started (I10).
describe("the person's uncommitted work (I10)", () => {
  const LINES = Array.from({ length: 10 }, (_, i) => `${i + 1}\n`).join("");
  /** `text` with line `line` (from 1) replaced by `to`. */
  const edit = (line: number, to: string, text = LINES) => text.split("\n").map((l, i) => (i === line - 1 ? to : l)).join("\n");

  /** A session over a tree with work in progress: `work` written, `deleted` removed, `staged` added. */
  async function loopOver(work: Record<string, FileSpec>, { deleted = [], staged = [] }: { deleted?: string[]; staged?: string[] } = {}) {
    const dir = await makeRepo({ "speed.txt": "100\n", "sort.js": "// v1\n", "a.txt": LINES, "gone.txt": "tracked\n" }, {
      ".auto/prompt.md": "# Make the sort fast\n",
      ".auto/measure.sh": { text: MEASURE, mode: 0o755 },
      ...work,
    });
    dirs.push(dir);
    for (const file of deleted) await fsp.rm(nodePath.join(dir, file));
    if (staged.length > 0) await git(dir, "add", "--", ...staged);
    const session = new Session(dir, { timeScale: 0.05 });
    sessions.push(session);
    await session.start();
    await session.command("make the sort fast");
    await session.use("init_experiment", { name: "sort speed", metric_name: "total_ms", metric_unit: "ms", direction: "lower" });
    return { dir, session };
  }

  /** `git status` outside the session files, which the log appends to after a keep. */
  const status = async (dir: string) =>
    (await sh(dir, ["git", "status", "--porcelain", "--untracked-files=all"])).stdout
      .split("\n")
      .filter((line) => line && !line.includes(".auto/"))
      .sort();
  const committedFiles = async (dir: string) => (await git(dir, "show", "--name-only", "--format=", "HEAD")).split("\n").filter(Boolean).sort();

  test("a discard undoes the experiment and leaves earlier work alone", async () => {
    const { dir, session } = await loopOver(
      { "a.txt": edit(1, "1 wip"), "notes.md": "mine\n", "scratch/x.txt": "mine\n" },
      { deleted: ["gone.txt"] },
    );
    const before = await status(dir);

    await writeFiles(dir, { "speed.txt": "120\n", "sort.js": "// v2\n", "new.txt": "exp\n", "newdir/deep/y.txt": "exp\n" });
    await fsp.rm(nodePath.join(dir, "README.md"));
    await session.use("run_experiment", MEASURE_CMD);
    const logged = await session.use("log_experiment", { commit: "0000000", metric: 120, status: "discard", description: "slower" });
    assert.match(logged.result, /📝 Git: reverted changes \(discard\) — autoresearch files preserved/);

    assert.equal(await read(dir, "sort.js"), "// v1\n");
    assert.equal(await read(dir, "speed.txt"), "100\n");
    assert.equal(await read(dir, "README.md"), "fixture\n");
    assert.equal(await exists(dir, "new.txt"), false);
    assert.equal(await exists(dir, "newdir"), false);
    assert.equal(await read(dir, "a.txt"), edit(1, "1 wip"));
    assert.equal(await read(dir, "notes.md"), "mine\n");
    assert.equal(await read(dir, "scratch/x.txt"), "mine\n");
    assert.equal(await exists(dir, "gone.txt"), false);
    assert.deepEqual(await status(dir), before);
  });

  test("a discard puts a file with earlier edits back as the person left it", async () => {
    const { dir, session } = await loopOver({ "a.txt": edit(1, "1 wip") });
    await writeFiles(dir, { "a.txt": edit(10, "10 exp", edit(1, "1 wip")) });
    await session.use("run_experiment", MEASURE_CMD);
    await session.use("log_experiment", { commit: "0000000", metric: 120, status: "discard", description: "slower" });
    assert.equal(await read(dir, "a.txt"), edit(1, "1 wip"));
  });

  test("a keep commits the experiment and the session files, nothing else", async () => {
    const { dir, session } = await loopOver({ "notes.md": "mine\n", "b.txt": "staged by the person\n" }, { staged: ["b.txt"] });
    await writeFiles(dir, { "speed.txt": "80\n", "sort.js": "// v2\n", "new.txt": "exp\n" });
    await session.use("run_experiment", MEASURE_CMD);
    const logged = await session.use("log_experiment", { commit: "0000000", metric: 80, status: "keep", description: "faster" });
    assert.match(logged.result, /📝 Git: committed/);
    assert.doesNotMatch(logged.result, /⚠️/);

    assert.deepEqual(await committedFiles(dir), [".auto/log.jsonl", ".auto/measure.sh", ".auto/prompt.md", "new.txt", "sort.js", "speed.txt"]);
    assert.deepEqual(await status(dir), ["?? notes.md", "A  b.txt"]);
    assert.equal(await git(dir, "log", "-1", "--format=%s"), "faster");
  });

  test("a keep in a file with earlier edits commits only the experiment's lines", async () => {
    const { dir, session } = await loopOver({ "a.txt": edit(1, "1 wip") });
    await writeFiles(dir, { "a.txt": edit(10, "10 exp", edit(1, "1 wip")) });
    await session.use("run_experiment", MEASURE_CMD);
    const logged = await session.use("log_experiment", { commit: "0000000", metric: 80, status: "keep", description: "faster" });
    assert.doesNotMatch(logged.result, /⚠️/);

    assert.equal(await git(dir, "show", "HEAD:a.txt"), edit(10, "10 exp").trimEnd());
    assert.equal(await read(dir, "a.txt"), edit(10, "10 exp", edit(1, "1 wip")));
    assert.deepEqual(await status(dir), [" M a.txt"]);
  });

  test("edits that overlap the person's are committed whole, and the result says so", async () => {
    const { dir, session } = await loopOver({ "a.txt": edit(1, "1 wip") });
    await writeFiles(dir, { "a.txt": edit(1, "1 exp") });
    await session.use("run_experiment", MEASURE_CMD);
    const logged = await session.use("log_experiment", { commit: "0000000", metric: 80, status: "keep", description: "faster" });
    assert.match(logged.result, /⚠️ Git: a\.txt already had uncommitted edits that overlap this experiment's, so the commit includes them/);
    assert.equal(await git(dir, "show", "HEAD:a.txt"), edit(1, "1 exp").trimEnd());
  });

  test("a hot reload in the middle of an iteration keeps its starting point", async () => {
    const { dir, session } = await loopOver({ "a.txt": edit(1, "1 wip") });
    await writeFiles(dir, { "sort.js": "// v2\n" });
    const { loop, store } = session.host;
    session.host.dispose();

    const reloaded = new Session(dir, { timeScale: 0.05, loop, store });
    sessions.push(reloaded);
    await reloaded.start();
    await reloaded.use("run_experiment", MEASURE_CMD);
    await reloaded.use("log_experiment", { commit: "0000000", metric: 120, status: "discard", description: "slower" });
    assert.equal(await read(dir, "sort.js"), "// v1\n");
    assert.equal(await read(dir, "a.txt"), edit(1, "1 wip"));
  });
});

describe("checks", () => {
  test("failing checks block a keep until the run is logged as checks_failed", async () => {
    const { dir, session } = await loopIn({}, {
      ".auto/checks.sh": { text: '#!/bin/bash\necho "3 tests failed" >&2\nexit 1\n', mode: 0o755 },
    });
    await writeFiles(dir, { "sort.js": "// broken\n" });
    const run = await session.use("run_experiment", { command: "bash .auto/measure.sh" });
    assert.match(run.result, /💥 CHECKS FAILED/);
    assert.match(run.result, /3 tests failed/);

    const refused = await session.use("log_experiment", { commit: "0000000", metric: 100, status: "keep", description: "broken" });
    assert.match(refused.result, /^❌ Cannot keep — \.auto\/checks\.sh failed\./);
    assert.equal((await logLines(dir)).length, 1);

    const logged = await session.use("log_experiment", { commit: "0000000", metric: 100, status: "checks_failed", description: "broken" });
    assert.match(logged.result, /Logged #1: checks_failed/);
    assert.equal(await read(dir, "sort.js"), "// v1\n");
  });

  test("checks that pass let the keep through", async () => {
    const { session } = await loopIn({}, { ".auto/checks.sh": { text: "#!/bin/bash\necho ok\n", mode: 0o755 } });
    const run = await session.use("run_experiment", { command: "bash .auto/measure.sh" });
    assert.match(run.result, /✅ Checks passed/);
    const logged = await session.use("log_experiment", { commit: "0000000", metric: 100, status: "keep", description: "baseline" });
    assert.match(logged.result, /Logged #1: keep/);
  });

  test("checks that time out are killed and block the keep", async () => {
    const { session } = await loopIn({}, {
      ".auto/checks.sh": { text: "#!/bin/bash\nsleep 3171\n", mode: 0o755 },
    });
    const run = await session.use("run_experiment", { command: "bash .auto/measure.sh", checks_timeout_seconds: 1 });
    assert.match(run.result, /⏰ CHECKS TIMEOUT/);
    const refused = await session.use("log_experiment", { commit: "0000000", metric: 100, status: "keep", description: "x" });
    assert.match(refused.result, /Cannot keep/);
    await sleep(200);
    assert.deepEqual(await processesWith(/^sleep 3171$/), []);
  });
});

describe("benchmarks that break", () => {
  test("a crash is reported with its exit code", async () => {
    const { session } = await benchmark("echo boom >&2; exit 3");
    const run = await session.use("run_experiment", MEASURE_CMD);
    assert.match(run.result, /💥 FAILED \(exit code 3\)/);
    assert.match(run.result, /boom/);
  });

  test("a hang past the timeout is killed, grandchildren and all", async () => {
    const { session } = await benchmark("(sleep 3172 &) ; sleep 3173 & sleep 3174; wait");
    const t0 = Date.now();
    const run = await session.use("run_experiment", { ...MEASURE_CMD, timeout_seconds: 1 });
    assert.match(run.result, /⏰ TIMEOUT after/);
    assert.ok(Date.now() - t0 < 5000, "TERM was enough");
    await sleep(300);
    assert.deepEqual(await processesWith(/^sleep 317\d$/), []);
  });

  test("a benchmark that ignores TERM is killed 5 s later", async () => {
    const { session } = await benchmark("trap '' TERM; sleep 3175 & wait; sleep 3175");
    const t0 = Date.now();
    const run = await session.use("run_experiment", { ...MEASURE_CMD, timeout_seconds: 1 });
    const took = Date.now() - t0;
    assert.match(run.result, /⏰ TIMEOUT after/);
    assert.ok(took >= 5500 && took < 9000, `took ${took} ms`);
    await sleep(300);
    assert.deepEqual(await processesWith(/^sleep 3175$/), []);
  });

  test("Esc mid-benchmark kills the group and the loop stays paused", async () => {
    const { session } = await benchmark("sleep 3176 & sleep 3177; wait");
    await session.host.waitFor(() => session.host.submitted.length === 1, 2000, "the kickoff");
    const abort = new AbortController();
    const turn = session.turn(
      async () => {
        const call = session.call("run_experiment", MEASURE_CMD, abort.signal);
        await session.host.waitFor(() => session.ctx.runtime.runningExperiment !== null, 5000, "the run to start");
        await sleep(300);
        abort.abort();
        await assert.rejects(call, /aborted/);
      },
      { aborted: true },
    );
    await turn;
    await sleep(500);
    assert.deepEqual(await processesWith(/^sleep 317\d$/), []);
    assert.equal(session.ctx.runtime.runningExperiment, null);
    await sleep(200);
    assert.equal(session.host.submitted.length, 1, "only the kickoff: no resume after Esc");
    assert.equal(session.ctx.runtime.pendingResumeMessage, null);
  });

  test("output past 50 KiB keeps the full log; the model sees the tail", async () => {
    const { session } = await benchmark('for i in $(seq 1 20000); do echo "line $i of noise"; done; echo METRIC total_ms=7');
    const run = await session.use("run_experiment", MEASURE_CMD);
    const full = /Full output: (\S+?)\]/.exec(run.result)?.[1];
    assert.ok(full, run.result.slice(-300));
    const text = await fsp.readFile(full, "utf8");
    assert.match(text, /^line 1 of noise\n/);
    assert.match(text, /METRIC total_ms=7\n$/);
    assert.match(run.result, /metric: 7/);
    await fsp.rm(full, { force: true });
  });

  test("output past 4 MiB still runs to the end", async () => {
    const { session } = await benchmark("head -c 5000000 /dev/zero | tr '\\0' 'x' | fold -w 100; echo; echo METRIC total_ms=9");
    const run = await session.use("run_experiment", { ...MEASURE_CMD, timeout_seconds: 60 });
    assert.match(run.result, /✅ PASSED/);
    assert.match(run.result, /metric: 9/);
    const full = /Full output: (\S+?)\]/.exec(run.result)?.[1];
    assert.ok(full);
    assert.ok((await fsp.stat(full)).size > 5_000_000);
    await fsp.rm(full, { force: true });
  });

  test("malformed, duplicate, non-finite, __proto__ and non-UTF-8 METRIC lines", async () => {
    const { session } = await benchmark(
      [
        "echo 'METRIC total_ms=12'",
        "echo 'METRIC total_ms=11'",
        "echo 'METRIC broken'",
        "echo 'METRIC nan_ms=NaN'",
        "echo 'METRIC inf_ms=Infinity'",
        "echo 'METRIC __proto__=5'",
        "printf 'METRIC bytes_kb=3\\n\\xff\\xfe garbage\\n'",
      ].join("\n"),
    );
    const run = await session.use("run_experiment", MEASURE_CMD);
    assert.match(run.result, /✅ PASSED/);
    assert.match(run.result, /metric: 11/);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "5"), false);
    assert.ok(!run.result.includes("NaN,"));
    const logged = await session.use("log_experiment", { commit: "0000000", metric: 11, status: "keep", description: "baseline", metrics: { bytes_kb: 3 } });
    assert.match(logged.result, /Logged #1/);
  });
});

describe("guards and limits", () => {
  test("with measure.sh present only it may be run", async () => {
    const { session } = await loopIn();
    const refused = await session.use("run_experiment", { command: "node bench.js" });
    assert.match(refused.result, /measure\.sh/);
    assert.doesNotMatch(refused.result, /PASSED|FAILED/);
    const allowed = await session.use("run_experiment", { command: "time bash .auto/measure.sh" });
    assert.match(allowed.result, /✅ PASSED/);
  });

  test("secondary metrics: missing is refused, new needs force", async () => {
    const { dir, session } = await loopIn();
    await session.use("run_experiment", { command: "bash .auto/measure.sh" });
    await session.use("log_experiment", { commit: "0000000", metric: 100, status: "keep", description: "baseline", metrics: { mem_mb: 30 } });

    const missing = await session.use("log_experiment", { commit: "0000000", metric: 90, status: "discard", description: "x" });
    assert.match(missing.result, /^❌ Missing secondary metrics: mem_mb/);
    const unknown = await session.use("log_experiment", { commit: "0000000", metric: 90, status: "discard", description: "x", metrics: { mem_mb: 31, gc_ms: 2 } });
    assert.match(unknown.result, /^❌ New secondary metric not previously tracked: gc_ms/);
    const forced = await session.use("log_experiment", { commit: "0000000", metric: 90, status: "discard", description: "x", metrics: { mem_mb: 31, gc_ms: 2 }, force: true });
    assert.match(forced.result, /Logged #2/);
    assert.equal((await logLines(dir)).length, 3);
  });

  test("maxIterations stops the loop: mode off, and the turn ends after the result", async () => {
    const { dir, session } = await loopIn({}, { ".auto/config.json": JSON.stringify({ maxIterations: 2 }) });
    assert.equal(session.ctx.runtime.state.maxExperiments, 2);
    await session.turn(async (turnId) => {
      await session.use("run_experiment", { command: "bash .auto/measure.sh" });
      await session.use("log_experiment", { commit: "0000000", metric: 100, status: "keep", description: "baseline" });
      await session.use("run_experiment", { command: "bash .auto/measure.sh" });
      const last = await session.use("log_experiment", { commit: "0000000", metric: 100, status: "discard", description: "again" });
      assert.match(last.result, /🛑 Maximum experiments reached \(2\)/);
      assert.equal(session.app.isModeOn(), false);
      await session.host.waitFor(() => session.host.aborted.includes(turnId), 3000, "the turn abort");
      const refused = await session.call("run_experiment", { command: "bash .auto/measure.sh" });
      assert.ok("deny" in refused);
    });
    assert.equal((await logLines(dir)).filter((line) => line.run).length, 2);
  });

  test("re-init starts a new segment with its own baseline", async () => {
    const { dir, session } = await loopIn();
    await session.use("run_experiment", { command: "bash .auto/measure.sh" });
    await session.use("log_experiment", { commit: "0000000", metric: 100, status: "keep", description: "baseline" });
    const reinit = await session.use("init_experiment", { name: "sort memory", metric_name: "mem_mb", metric_unit: "MB", direction: "lower" });
    assert.match(reinit.result, /segment|re-init|Re-init/i);
    await session.use("log_experiment", { commit: "0000000", metric: 50, status: "keep", description: "memory baseline" });
    assert.equal(session.ctx.runtime.state.currentSegment, 1);
    assert.equal(session.ctx.runtime.state.bestMetric, 50);
    const lines = await logLines(dir);
    assert.deepEqual(lines.map((line) => line.type ?? line.segment), ["config", 0, "config", 1]);
  });
});

describe("layouts and working directories", () => {
  test("a legacy flat layout is read and appended to", async () => {
    const dir = await makeRepo({}, {
      "autoresearch.md": "# legacy rules\n",
      "autoresearch.sh": { text: '#!/bin/bash\necho "METRIC total_ms=5"\n', mode: 0o755 },
      "autoresearch.jsonl": JSON.stringify({ type: "config", name: "legacy", metricName: "total_ms", metricUnit: "ms", bestDirection: "lower" }) + "\n",
    });
    dirs.push(dir);
    const session = new Session(dir);
    sessions.push(session);
    await session.start();
    assert.equal(session.app.isModeOn(), true);
    await session.use("run_experiment", { command: "bash autoresearch.sh" });
    await session.use("log_experiment", { commit: "0000000", metric: 5, status: "keep", description: "baseline" });
    assert.equal((await logLines(dir, "autoresearch.jsonl")).length, 2);
    assert.equal(await exists(dir, ".auto/log.jsonl"), false);
  });

  test("a redirected workingDir keeps the session files there", async () => {
    const dir = await makeRepo({ "sub/speed.txt": "100\n" }, {
      ".auto/config.json": JSON.stringify({ workingDir: "sub" }),
      "sub/.auto/measure.sh": { text: MEASURE, mode: 0o755 },
    });
    dirs.push(dir);
    const session = new Session(dir);
    sessions.push(session);
    await session.start();
    await session.command("go");
    await session.use("init_experiment", { name: "sub", metric_name: "total_ms" });
    const run = await session.use("run_experiment", { command: "bash .auto/measure.sh" });
    assert.match(run.result, /total_ms=100/);
    await session.use("log_experiment", { commit: "0000000", metric: 100, status: "keep", description: "baseline" });
    assert.equal((await logLines(dir, "sub/.auto/log.jsonl")).length, 2);
    assert.equal(await exists(dir, ".auto/log.jsonl"), false);
  });

  test("a workingDir that does not exist is reported by every tool", async () => {
    const dir = await makeRepo({}, { ".auto/config.json": JSON.stringify({ workingDir: "missing" }) });
    dirs.push(dir);
    const session = new Session(dir);
    sessions.push(session);
    await session.start();
    await session.command("go");
    for (const [name, input] of [
      ["init_experiment", { name: "x", metric_name: "m" }],
      ["run_experiment", { command: "true" }],
      ["log_experiment", { commit: "0", metric: 1, status: "keep", description: "x" }],
    ] as const) {
      const answer = await session.use(name, input);
      assert.match(answer.result, /^❌ workingDir ".*missing" \(from \.auto\/config\.json\) does not exist\./, name);
    }
  });
});
