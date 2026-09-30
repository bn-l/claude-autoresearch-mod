// upstream tests/activation.test.mjs's harness scenarios, on the Node host: which sessions
// turn the mode on at start, what `/autoresearch`, `off`, `clear` and `dashboard` record
// and say, and log_experiment's discard reminder and limit stop. pi's session entries
// are the store here (F8): one decision per session and canonical workDir, latest wins.
// The pure rule (shouldAutoActivateAutoresearch) is covered by unit/activation.test.ts.

import assert from "node:assert/strict";
import { existsSync, promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { after, describe, test } from "node:test";

import { renderLogResult } from "../plugin/hooks/upstream/tool-render.ts";
import type { Theme } from "../plugin/hooks/upstream/dashboard-lines.ts";
import { Session, makeRepo, removeTempDir, writeFiles, type SessionOptions } from "./node-host.ts";

const dirs: string[] = [];
const sessions: Session[] = [];
after(async () => {
  for (const session of sessions) session.end();
  for (const dir of dirs) await removeTempDir(dir);
});

const plain: Theme = { fg: (_color, text) => text, bold: (text) => text };

const LOG = (name: string) =>
  [
    JSON.stringify({ type: "config", name, metricName: "runtime_ms", metricUnit: "ms", bestDirection: "lower" }),
    JSON.stringify({ run: 1, commit: "abcdef0", metric: 10, metrics: {}, status: "crash", description: "baseline", timestamp: Date.now() }),
  ].join("\n") + "\n";

async function tempDir(): Promise<string> {
  const dir = await makeRepo();
  dirs.push(dir);
  return dir;
}

/** cwd whose .auto/config.json points at workDir, which holds a log. */
async function redirected(extraConfig: Record<string, unknown> = {}) {
  const cwd = await tempDir();
  const workDir = await tempDir();
  await writeFiles(cwd, { ".auto/config.json": JSON.stringify({ workingDir: workDir, ...extraConfig }) + "\n" });
  await writeFiles(workDir, { ".auto/log.jsonl": LOG("Redirected research") });
  return { cwd, workDir };
}

async function sameCwd() {
  const cwd = await tempDir();
  await writeFiles(cwd, { ".auto/log.jsonl": LOG("Same-cwd research") });
  return cwd;
}

function open(cwd: string, options: SessionOptions = {}): Session {
  const session = new Session(cwd, { sessionId: `test:${cwd}`, timeScale: 0.05, ...options });
  sessions.push(session);
  return session;
}

/** The store as a previous `/autoresearch` in this session left it. */
function recorded(sessionId: string, workDir: string, active: boolean): Map<string, unknown> {
  return new Map([[`activation:${sessionId}:${workDir}`, { version: 1, workDir, active }]]);
}

const TOOLS = ["init_experiment", "log_experiment", "run_experiment"];

describe("session start", () => {
  test("a redirected workingDir stays off without an activation in this session", async () => {
    const { cwd } = await redirected();
    const session = await open(cwd).start();
    assert.equal(session.app.isModeOn(), false);
    assert.deepEqual(session.host.registered, []);
    assert.equal(session.host.view.mode, false);
  });

  test("a redirected workingDir turns on when this session activated it", async () => {
    const { cwd, workDir } = await redirected();
    const session = await open(cwd, { store: recorded(`test:${cwd}`, workDir, true) }).start();
    assert.equal(session.app.isModeOn(), true);
    assert.deepEqual(session.host.registered.map((tool) => tool.name).sort(), TOOLS);
    assert.equal(session.host.view.experiment?.name, "Redirected research");
  });

  test("a redirected workingDir stays off when the latest decision is off", async () => {
    const { cwd, workDir } = await redirected();
    const session = await open(cwd, { store: recorded(`test:${cwd}`, workDir, false) }).start();
    assert.equal(session.app.isModeOn(), false);
  });

  test("a same-cwd log turns the mode on", async () => {
    const cwd = await sameCwd();
    const session = await open(cwd).start();
    assert.equal(session.app.isModeOn(), true);
    assert.equal(session.host.view.experiment?.results.length, 1);
  });

  test("a same-cwd session stays off when a manual off is recorded", async () => {
    const cwd = await sameCwd();
    const session = await open(cwd, { store: recorded(`test:${cwd}`, cwd, false) }).start();
    assert.equal(session.app.isModeOn(), false);
  });

  test("without a log nothing turns on and no stale widget is drawn (F14: no history fallback)", async () => {
    const cwd = await tempDir();
    const session = await open(cwd).start();
    assert.equal(session.app.isModeOn(), false);
    assert.equal(session.host.view.experiment?.results.length, 0);
  });
});

describe("/autoresearch", () => {
  test("starting binds a redirected workingDir's activation to this session", async () => {
    const cwd = await tempDir();
    const workDir = await tempDir();
    await writeFiles(cwd, { ".auto/config.json": JSON.stringify({ workingDir: workDir }) + "\n" });
    const session = await open(cwd).start();
    await session.command("optimize runtime");

    assert.equal(session.app.isModeOn(), true);
    assert.deepEqual([...session.host.store.entries()], [
      [`activation:test:${cwd}:${workDir}`, { version: 1, workDir: await fsp.realpath(workDir), active: true }],
    ]);
    await session.host.waitFor(() => session.host.submitted.length === 1, 2000, "the kickoff");

    // Once a log exists there, this session starting again (a /resume back) turns it on.
    await writeFiles(workDir, { ".auto/log.jsonl": LOG("Redirected research") });
    const again = await open(cwd, { store: session.host.store }).start();
    assert.equal(again.app.isModeOn(), true);
  });

  test("without prompt.md the kickoff is the create skill, expanded, with the goal", async () => {
    const cwd = await tempDir();
    const session = await open(cwd).start();
    await session.command("optimize runtime");
    await session.host.waitFor(() => session.host.submitted.length === 1, 2000, "the kickoff");
    const kickoff = session.host.submitted[0]!;
    assert.match(kickoff, /^<skill name="autoresearch-create" location="[^"]+\/skills\/autoresearch-create\/SKILL\.md">/);
    assert.match(kickoff, /<\/skill>\n\noptimize runtime/);
  });

  test("off records a manual off for a same-cwd session", async () => {
    const cwd = await sameCwd();
    const session = await open(cwd).start();
    await session.command("off");
    assert.equal(session.app.isModeOn(), false);
    assert.deepEqual([...session.host.store.values()], [{ version: 1, workDir: await fsp.realpath(cwd), active: false }]);
    assert.deepEqual(session.host.notices.at(-1), { text: "Autoresearch mode OFF", level: "info" });
  });

  test("off in the middle of a turn aborts it", async () => {
    const cwd = await sameCwd();
    const session = await open(cwd).start();
    await session.turn(async (turnId) => {
      await session.command("off");
      assert.deepEqual(session.host.aborted, [turnId]);
    });
    assert.deepEqual(session.host.notices.at(-1), { text: "Autoresearch mode OFF — aborting current run", level: "info" });
  });

  test("dashboard explains that the fullscreen view needs a terminal", async () => {
    const cwd = await sameCwd();
    const session = await open(cwd, { terminal: false }).start();
    const outcome = await session.command("dashboard");
    assert.equal(outcome.openDashboard, undefined);
    assert.equal(session.host.notices.length, 1);
    assert.match(session.host.notices[0]!.text, /only available in TUI mode/i);
  });

  test("dashboard opens once there are runs, and says why not otherwise", async () => {
    const cwd = await sameCwd();
    const session = await open(cwd).start();
    assert.deepEqual(await session.command("dashboard"), { openDashboard: true });

    const empty = await open(await tempDir()).start();
    await empty.command("dashboard");
    assert.deepEqual(empty.host.notices.at(-1), { text: "Autoresearch mode is not active", level: "info" });
  });

  test("clear turns off, deletes the log and records a manual off", async () => {
    const cwd = await sameCwd();
    const session = await open(cwd).start();
    await session.command("clear");
    assert.equal(session.app.isModeOn(), false);
    assert.equal(existsSync(nodePath.join(cwd, ".auto", "log.jsonl")), false);
    assert.deepEqual([...session.host.store.values()], [{ version: 1, workDir: await fsp.realpath(cwd), active: false }]);
    assert.match(session.host.notices.at(-1)!.text, /^Deleted \.auto\/log\.jsonl and turned autoresearch mode OFF$/);
  });

  test("with no arguments it prints the help", async () => {
    const session = await open(await tempDir()).start();
    await session.command("");
    assert.match(session.host.notices[0]!.text, /^Usage: \/autoresearch \[off\|clear\|web\|export\|dashboard\|<text>\]/);
    assert.match(session.host.notices[0]!.text, /^web \(or export\) opens a local live dashboard/m);
  });
});

// Uncommitted work doesn't stop anything: keep and discard touch only what an experiment
// changed (I10, covered in loop.test.ts).
describe("uncommitted work (I10)", () => {
  test("/autoresearch starts over uncommitted changes", async () => {
    const cwd = await makeRepo({ "src.js": "one\n" }, { "src.js": "two\n", "notes.md": "wip\n" });
    dirs.push(cwd);
    const session = await open(cwd).start();
    await session.command("optimize runtime");

    assert.equal(session.app.isModeOn(), true);
    await session.host.waitFor(() => session.host.submitted.length === 1, 2000, "the kickoff");
  });

  test("a same-cwd log turns the mode on over uncommitted changes", async () => {
    const cwd = await sameCwd();
    await writeFiles(cwd, { "notes.md": "wip\n" });
    const session = await open(cwd).start();
    assert.equal(session.app.isModeOn(), true);
  });

  test("outside a git repository it starts as before", async () => {
    const cwd = await fsp.realpath(await fsp.mkdtemp(nodePath.join(tmpdir(), "ar-e2e-")));
    dirs.push(cwd);
    const session = await open(cwd).start();
    await session.command("optimize runtime");

    assert.equal(session.app.isModeOn(), true);
    await session.host.waitFor(() => session.host.submitted.length === 1, 2000, "the kickoff");
  });
});

describe("log_experiment's reminder and limit", () => {
  for (const status of ["keep", "discard", "crash", "checks_failed"]) {
    for (const limitReached of [false, true]) {
      test(`${status} ${limitReached ? "stops without" : "includes"} the discard reminder`, async () => {
        const cwd = await sameCwd();
        if (limitReached) await writeFiles(cwd, { ".auto/config.json": JSON.stringify({ maxIterations: 2 }) });
        const session = await open(cwd).start();

        await session.turn(async (turnId) => {
          const answer = await session.use("log_experiment", {
            commit: "abcdef0",
            metric: 9,
            status,
            description: "test experiment",
            metrics: {},
            asi: { hypothesis: "test hypothesis", revisits_run: 1 },
          });
          const text = answer.result;
          const details = answer.details?.tool === "log_experiment" ? answer.details.details : undefined;
          assert.match(renderLogResult(details, text, plain), /↻ Revisiting #1/);
          assert.equal(details?.experiment.asi?.revisits_run, 1);

          if (limitReached) {
            assert.match(text, /STOP the experiment loop now/);
            assert.doesNotMatch(text, /previous discard/);
            await session.host.waitFor(() => session.host.aborted.includes(turnId), 2000, "the abort");
          } else {
            assert.match(text, /invalidates a previous discard's rollback reason/);
            assert.match(text, /weigh a targeted retry against other candidates/);
            assert.match(text, /Don't revive a discarded idea without a changed assumption/);
            assert.match(text, /Verification reruns to resolve measurement noise are separate/);
            assert.doesNotMatch(text, /don't retry unchanged hypotheses/);
            await new Promise((resolve) => setTimeout(resolve, 400));
            assert.deepEqual(session.host.aborted, []);
          }
        });
      });
    }
  }
});
