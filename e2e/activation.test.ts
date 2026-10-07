// upstream tests/activation.test.mjs's harness scenarios, on the Node host: which sessions
// turn the mode on at start, what `/autoresearch`, `off`, `clear` and `dashboard` record
// and say, and log_experiment's discard reminder and limit stop. pi's session entries
// are the store here (F8): one decision per session and canonical workDir, latest wins.
// The pure rule (shouldAutoActivateAutoresearch) is covered by unit/activation.test.ts.

import assert from "node:assert/strict";
import { existsSync, promises as fsp } from "node:fs";
import * as nodePath from "node:path";
import { after, describe, test } from "node:test";

import { renderLogResult } from "../plugin/hooks/upstream/tool-render.ts";
import type { Theme } from "../plugin/hooks/upstream/dashboard-lines.ts";
import { NOT_STARTED } from "../plugin/hooks/app/command.ts";
import {
  STASH_MESSAGE,
  UNCOMMITTED_CANCEL,
  UNCOMMITTED_HEADER,
  UNCOMMITTED_START,
  UNCOMMITTED_STASH,
} from "../plugin/hooks/app/uncommitted.ts";
import { Session, git, makeRepo, removeTempDir, writeFiles, type SessionOptions } from "./node-host.ts";

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
    assert.deepEqual([...session.host.store.entries()].filter(([key]) => key.startsWith("activation:")), [
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

// Upstream's keep and discard commit or undo whatever is uncommitted; the person is told
// first, by file (I10). A session that had turned the mode on resumes on (I11).
describe("uncommitted changes (I10) and a resumed session (I11)", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
  const warnings = (session: Session) => session.host.notices.filter((notice) => notice.level === "warning").map((notice) => notice.text);

  /** A repo with a.js and b.js committed, then a.js edited, b.js deleted, notes.md and scratch/ (2 files) new. */
  async function dirty(): Promise<string> {
    const cwd = await makeRepo({ "a.js": "one\n", "b.js": "two\n" }, {
      "a.js": "one, edited\n",
      "notes.md": "mine\n",
      "scratch/x.txt": "x\n",
      "scratch/y.txt": "y\n",
      ".auto/prompt.md": "# goal\n",
    });
    dirs.push(cwd);
    await fsp.rm(nodePath.join(cwd, "b.js"));
    return cwd;
  }

  test("/autoresearch over uncommitted changes lists them and doesn't start", async () => {
    const session = await open(await dirty()).start();
    await session.command("optimize runtime");
    await settle();

    assert.equal(session.app.isModeOn(), false);
    assert.deepEqual(session.host.submitted, []);
    assert.deepEqual(warnings(session), [
      [
        "⚠ 4 uncommitted changes:",
        "  Edited:   a.js",
        "  New:      notes.md, scratch/ (2 files)",
        "  Deleted:  b.js",
        "",
        "Autoresearch commits and reverts with git, so these may end up in its commits or be permanently undone.",
        "",
        "Commit or stash them first (git stash -u), or run /autoresearch again to start anyway.",
      ].join("\n"),
    ]);
  });

  test("running /autoresearch again starts with the goal given first", async () => {
    const session = await open(await dirty()).start();
    await session.command("optimize runtime");
    await session.command("");

    assert.equal(session.app.isModeOn(), true);
    await session.host.waitFor(() => session.host.submitted.length === 1, 2000, "the kickoff");
    assert.match(session.host.submitted[0]!, /optimize runtime/);
  });

  test("a goal given the second time replaces the first", async () => {
    const session = await open(await dirty()).start();
    await session.command("optimize runtime");
    await session.command("shrink the bundle");

    await session.host.waitFor(() => session.host.submitted.length === 1, 2000, "the kickoff");
    assert.match(session.host.submitted[0]!, /shrink the bundle/);
    assert.doesNotMatch(session.host.submitted[0]!, /optimize runtime/);
  });

  test("off after the warning forgets the goal", async () => {
    const session = await open(await dirty()).start();
    await session.command("optimize runtime");
    await session.command("off");
    await session.command("");

    assert.equal(session.app.isModeOn(), false);
    assert.match(session.host.notices.at(-1)!.text, /^Usage: \/autoresearch/);
  });

  test("session files and ignored files don't count", async () => {
    const cwd = await makeRepo({ ".gitignore": "out/\n" }, {
      ".auto/prompt.md": "# goal\n",
      "autoresearch.ideas.md": "- idea\n",
      "out/build.log": "ignored\n",
    });
    dirs.push(cwd);
    const session = await open(cwd).start();
    await session.command("optimize runtime");

    assert.equal(session.app.isModeOn(), true);
    assert.deepEqual(warnings(session), []);
  });

  test("long lists are cut short", async () => {
    const files = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`n${i}.txt`, "x\n"]));
    const cwd = await makeRepo({}, files);
    dirs.push(cwd);
    const session = await open(cwd).start();
    await session.command("optimize runtime");
    assert.match(warnings(session)[0]!, /^  New: {6}n0\.txt, n1\.txt, n2\.txt, n3\.txt, n4\.txt and 3 more$/m);
  });

  // Where someone can answer (a surface draws the session), /autoresearch asks instead.
  describe("asked in Claude Code's question dialog", () => {
    async function asking(answer: string | null, cwd?: string) {
      const dir = cwd ?? (await dirty());
      const session = await open(dir, { canAsk: true }).start();
      session.host.answers.push(answer);
      await session.command("optimize runtime");
      await settle();
      return { cwd: dir, session };
    }
    const read = (cwd: string, file: string) => fsp.readFile(nodePath.join(cwd, file), "utf8").catch(() => null);

    test("names the changes and offers to stash them, start anyway, or not start", async () => {
      const { session } = await asking(UNCOMMITTED_CANCEL);
      assert.deepEqual(session.host.questions, [
        {
          question:
            "4 uncommitted changes (a.js, b.js, notes.md, scratch/ (2 files)) may end up in autoresearch's commits or be permanently undone. What should happen to them before the loop starts?",
          options: [UNCOMMITTED_STASH, UNCOMMITTED_START, UNCOMMITTED_CANCEL],
          header: UNCOMMITTED_HEADER,
        },
      ]);
      assert.deepEqual(warnings(session), []);
    });

    test("stashing sets aside exactly what was listed, renames whole, and starts", async () => {
      const cwd = await dirty();
      await writeFiles(cwd, { "c.js": "three\n" });
      await git(cwd, "add", "--", "c.js");
      await git(cwd, "commit", "-q", "-m", "c");
      await git(cwd, "mv", "c.js", "d.js");
      const { session } = await asking(UNCOMMITTED_STASH, cwd);

      assert.equal(session.app.isModeOn(), true);
      await session.host.waitFor(() => session.host.submitted.length === 1, 2000, "the kickoff");
      assert.equal(session.host.notices.at(-2)?.text, "Stashed 5 uncommitted changes; you'll be asked about them when the loop stops");
      assert.equal(await git(cwd, "status", "--porcelain", "--untracked-files=all"), "?? .auto/prompt.md");
      assert.match(await git(cwd, "stash", "list"), new RegExp(STASH_MESSAGE));
      assert.equal(await read(cwd, ".auto/prompt.md"), "# goal\n");

      await git(cwd, "stash", "pop", "-q");
      assert.equal(await read(cwd, "a.js"), "one, edited\n");
      assert.equal(await read(cwd, "b.js"), null);
      assert.equal(await read(cwd, "d.js"), "three\n");
      assert.equal(await read(cwd, "scratch/y.txt"), "y\n");
    });

    test("starting anyway leaves the changes as they are", async () => {
      const { cwd, session } = await asking(UNCOMMITTED_START);
      assert.equal(session.app.isModeOn(), true);
      await session.host.waitFor(() => session.host.submitted.length === 1, 2000, "the kickoff");
      assert.equal(await read(cwd, "a.js"), "one, edited\n");
      assert.equal(await git(cwd, "stash", "list"), "");
    });

    for (const answer of [UNCOMMITTED_CANCEL, null, "wait, let me commit first"]) {
      const what = answer === null ? "a dismissal" : `"${answer}"`;
      test(`${what} doesn't start, and the next /autoresearch asks again`, async () => {
        const { cwd, session } = await asking(answer);
        assert.equal(session.app.isModeOn(), false);
        assert.deepEqual(session.host.submitted, []);
        assert.equal(session.host.notices.at(-1)?.text, NOT_STARTED);
        assert.equal(await read(cwd, "a.js"), "one, edited\n");

        session.host.answers.push(UNCOMMITTED_CANCEL);
        await session.command("");
        assert.match(session.host.notices.at(-1)!.text, /^Usage: \/autoresearch/);
        await session.command("optimize runtime");
        assert.equal(session.host.questions.length, 2);
      });
    }
  });

  test("a same-cwd log turns the mode on and warns, without asking", async () => {
    const cwd = await sameCwd();
    await writeFiles(cwd, { "notes.md": "mine\n" });
    const session = await open(cwd).start();

    assert.equal(session.app.isModeOn(), true);
    assert.match(warnings(session)[0]!, /^⚠ 1 uncommitted change:$/m);
    assert.match(warnings(session)[0]!, /^Commit or stash them before continuing \(git stash -u\)\.$/m);
  });

  test("a session that turned the mode on resumes on, before any run was logged (I11)", async () => {
    const cwd = await tempDir();
    const session = await open(cwd, { store: recorded(`test:${cwd}`, cwd, true) }).start();
    assert.equal(session.app.isModeOn(), true);
    assert.deepEqual(session.host.registered.map((tool) => tool.name).sort(), TOOLS);
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
