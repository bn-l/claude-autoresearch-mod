// The loop's own momentum (PLAN §4.9, §4.10, I1-I3): when a resume prompt is sent and
// when it is not (chat-only turns, Esc, a person typing, the caps), compaction at the
// iteration boundary, the compaction resume, and a hot reload in the middle of it all.
// The resume window is upstream's 800 ms, scaled down 20x.

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import {
  IN_FLIGHT_RESUME_PREFIX,
  composeCompactionResumeMessage,
  composeResumeMessage,
} from "../plugin/hooks/upstream/experiment-core.ts";
import type { CompactMessage } from "../plugin/hooks/app/index.ts";
import { Session, makeRepo, removeTempDir, sleep, type FileSpec, type SessionOptions } from "./node-host.ts";

const dirs: string[] = [];
const sessions: Session[] = [];
after(async () => {
  for (const session of sessions) session.end();
  for (const dir of dirs) await removeTempDir(dir);
});

const WINDOW = 800 * 0.05;
const MEASURE = { text: '#!/bin/bash\necho "METRIC total_ms=10"\n', mode: 0o755 };
const LOG_TOOL = "mcp__autoresearch__log_experiment";
const RUN_TOOL = "mcp__autoresearch__run_experiment";

async function running(options: SessionOptions = {}, files: Record<string, string> = {}, auto: Record<string, FileSpec> = {}) {
  const dir = await makeRepo(files, { ".auto/prompt.md": "# Make it fast\n", ".auto/ideas.md": "- unroll\n", ".auto/measure.sh": MEASURE, ...auto });
  dirs.push(dir);
  const session = new Session(dir, { timeScale: 0.05, ...options });
  sessions.push(session);
  await session.start();
  await session.command("go");
  await session.host.waitFor(() => session.host.submitted.length === 1, 2000, "the kickoff");
  return session;
}

/** One iteration as the model runs it inside a turn. */
async function iteration(session: Session, status = "keep", metric = 10) {
  await session.use("run_experiment", { command: "bash .auto/measure.sh" });
  return session.use("log_experiment", { commit: "0000000", metric, status, description: `${status} ${metric}` });
}

const resumes = (session: Session) => session.host.submitted.slice(1);

describe("auto-resume", () => {
  test("a turn that logged an experiment is followed by the resume prompt", async () => {
    const session = await running();
    await session.turn(async () => {
      await session.use("init_experiment", { name: "t", metric_name: "total_ms" });
      await iteration(session);
    });
    assert.deepEqual(resumes(session), []);
    await session.host.waitFor(() => resumes(session).length === 1, 2000, "the resume");
    assert.equal(resumes(session)[0], composeResumeMessage());
    assert.equal(session.ctx.runtime.autoResumeTurns, 1);
  });

  test("a chat-only turn is not resumed", async () => {
    const session = await running();
    await session.turn(async () => undefined);
    await sleep(WINDOW * 4);
    assert.deepEqual(resumes(session), []);
  });

  test("Esc pauses the loop (I1); the next logged turn resumes it", async () => {
    const session = await running();
    await session.turn(async () => {
      await session.use("init_experiment", { name: "t", metric_name: "total_ms" });
      await iteration(session);
    }, { aborted: true });
    await sleep(WINDOW * 4);
    assert.deepEqual(resumes(session), []);

    // "continue", typed by the person: a turn that logs again.
    session.app.foreignPrompt();
    await session.turn(async () => {
      await iteration(session, "discard", 11);
    });
    await session.host.waitFor(() => resumes(session).length === 1, 2000, "the resume");
  });

  test("a person's prompt in the window holds the resume back", async () => {
    const session = await running();
    await session.turn(async () => {
      await session.use("init_experiment", { name: "t", metric_name: "total_ms" });
      await iteration(session);
    });
    session.app.foreignPrompt();
    await sleep(WINDOW * 4);
    assert.deepEqual(resumes(session), []);
    assert.notEqual(session.ctx.runtime.pendingResumeMessage, null);

    // Their prompt starts a turn; a chat reply, then the held resume goes out.
    await session.turn(async () => undefined);
    await session.host.waitFor(() => resumes(session).length === 1, 2000, "the held resume");
  });

  test("the 200-turn cap stops the loop with a notice", async () => {
    const session = await running();
    session.ctx.runtime.autoResumeTurns = 200;
    await session.turn(async () => {
      await session.use("init_experiment", { name: "t", metric_name: "total_ms" });
      await iteration(session);
    });
    await sleep(WINDOW * 4);
    assert.deepEqual(resumes(session), []);
    assert.match(session.host.notices.at(-1)!.text, /auto-resume limit reached \(200 turns\)/);
  });

  test("more than 20 discards and crashes in a row stop the loop", async () => {
    const session = await running();
    await session.turn(async () => {
      await session.use("init_experiment", { name: "t", metric_name: "total_ms" });
      await iteration(session, "keep", 10);
      for (let i = 0; i < 21; i++) {
        await session.use("log_experiment", { commit: "0000000", metric: 12, status: i % 2 ? "crash" : "discard", description: `bad ${i}` });
      }
    });
    await sleep(WINDOW * 4);
    assert.deepEqual(resumes(session), []);
    assert.match(session.host.notices.at(-1)!.text, /21 consecutive discards\/crashes/);
  });

  test("off stops a pending resume", async () => {
    const session = await running();
    await session.turn(async () => {
      await session.use("init_experiment", { name: "t", metric_name: "total_ms" });
      await iteration(session);
    });
    await session.command("off");
    await sleep(WINDOW * 4);
    assert.deepEqual(resumes(session), []);
  });
});

// ---------------------------------------------------------------------------
// Compaction at the boundary and after it
// ---------------------------------------------------------------------------

/** An iteration as the engine's transcript holds it: the run, the log, the model's close. */
function transcriptOfIteration(n: number, logged = true): CompactMessage[] {
  const run = `toolu_run_${n}`;
  const log = `toolu_log_${n}`;
  const messages: CompactMessage[] = [
    { role: "assistant", text: `Trying idea ${n}.`, toolUses: [{ tool_use_id: `toolu_edit_${n}`, tool: "Edit", input: { file_path: "sort.js" }, text: "ok" }], handle: `h${n}a` },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: `toolu_edit_${n}`, text: "ok" }], handle: `h${n}b` },
    { role: "assistant", text: "", toolUses: [{ tool_use_id: run, tool: RUN_TOOL, input: { command: "bash .auto/measure.sh" }, text: "✅ PASSED" }], handle: `h${n}c` },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: run, text: "✅ PASSED in 0.1s" }], handle: `h${n}d` },
  ];
  if (logged) {
    messages.push(
      { role: "assistant", text: "", toolUses: [{ tool_use_id: log, tool: LOG_TOOL, input: { status: "keep" }, text: `Logged #${n}: keep` }], handle: `h${n}e` },
      { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: log, text: `Logged #${n}: keep — idea ${n}` }], handle: `h${n}f` },
      { role: "assistant", text: `Idea ${n} kept.`, toolUses: [], handle: `h${n}g` },
    );
  }
  return messages;
}

describe("a question to the person (I9)", () => {
  const ASKING = "Two things need your call: the small-array fallback, and the -0 bug.";
  // 0.1 minutes is 6 s, scaled to 300 ms: well past the settle window.
  const WAIT = { questionWaitMinutes: 0.1 };

  async function asked(options: SessionOptions = WAIT) {
    const session = await running(options);
    await session.turn(async () => {
      await session.use("init_experiment", { name: "t", metric_name: "total_ms" });
      await iteration(session);
    }, { answer: ASKING });
    return session;
  }

  test("holds the resume for questionWaitMinutes, then tells the model nobody replied", async () => {
    const session = await asked();
    assert.deepEqual(session.host.notices.at(-1), {
      text: "The model asked you something. The loop carries on in 0.1 min unless you reply.",
      level: "info",
    });
    assert.equal(session.host.view.loop?.questionWait?.minutes, 0.1);
    await sleep(WINDOW * 4);
    assert.deepEqual(resumes(session), []);

    await session.host.waitFor(() => resumes(session).length === 1, 2000, "the resume after the wait");
    assert.equal(resumes(session)[0], `No reply from the person within 0.1 minutes: make the call yourself, say what you chose, and carry on.\n\n${composeResumeMessage()}`);
    assert.equal(session.host.view.loop?.questionWait, null);
  });

  test("a reply within the wait goes first; the resume after it is the usual one", async () => {
    const session = await asked();
    session.app.foreignPrompt();
    assert.equal(session.host.view.loop?.questionWait, null);
    await session.turn(async () => undefined, { answer: "Understood: adding the fallback next." });
    await session.host.waitFor(() => resumes(session).length === 1, 2000, "the resume");
    assert.equal(resumes(session)[0], composeResumeMessage());
  });

  test("with questionWaitMinutes at 0 a question is resumed at once, as upstream", async () => {
    const session = await asked({ questionWaitMinutes: 0 });
    await session.host.waitFor(() => resumes(session).length === 1, 2000, "the resume");
    assert.equal(resumes(session)[0], composeResumeMessage());
  });

  test("a hot reload during the wait keeps it", async () => {
    const session = await asked();
    const loop = session.host.loop;
    const store = session.host.store;
    session.host.dispose();

    const reloaded = new Session(session.host.cwd, { timeScale: 0.05, loop, store, ...WAIT });
    sessions.push(reloaded);
    await reloaded.start();
    await sleep(WINDOW * 4);
    assert.deepEqual(reloaded.host.submitted, []);
    await reloaded.host.waitFor(() => reloaded.host.submitted.length === 1, 2000, "the resume after the wait");
    assert.match(reloaded.host.submitted[0]!, /^No reply from the person within 0\.1 minutes/);
  });
});

describe("compaction", () => {
  test("past compactAtPercent the boundary compacts first, then the compaction resume goes out (I2)", async () => {
    const session = await running({ contextPercent: 75 });
    session.transcript = [...transcriptOfIteration(1), ...transcriptOfIteration(2)];
    await session.turn(async () => {
      await session.use("init_experiment", { name: "t", metric_name: "total_ms" });
      await iteration(session);
    });
    await session.host.waitFor(() => resumes(session).length === 1, 2000, "the resume");
    // The usage still reads 75% after it (the engine updates it on the next response):
    // one compaction, not a loop of them.
    await sleep(WINDOW * 4);
    assert.equal(session.host.compactions, 1);
    assert.equal(resumes(session).length, 1);
    assert.equal(resumes(session)[0], composeCompactionResumeMessage());

    const answer = session.compactAnswers[0] as { messages: CompactMessage[] };
    assert.equal(answer.messages[0]!.role, "user");
    assert.match(answer.messages[0]!.text, /# Make it fast/);
    assert.match(answer.messages[0]!.text, /- unroll/);
    // Only the model's closing message follows the last logged run.
    assert.deepEqual(answer.messages.slice(1).map((message) => message.handle), ["h2g"]);
  });

  test("the before hook's steer, compacted away with the log result, leads the compaction resume", async () => {
    const session = await running({ contextPercent: 75 }, {}, {
      ".auto/hooks/before.sh": { text: "#!/bin/bash\necho 'STEER: try radix next'\n", mode: 0o755 },
    });
    session.transcript = transcriptOfIteration(1);
    await session.turn(async () => {
      await session.use("init_experiment", { name: "t", metric_name: "total_ms" });
      const logged = await iteration(session);
      assert.deepEqual(logged.context, ["STEER: try radix next"]);
    });
    await session.host.waitFor(() => resumes(session).length === 1, 2000, "the resume");
    assert.equal(resumes(session)[0], `STEER: try radix next\n\n${composeCompactionResumeMessage()}`);
  });

  test("below the threshold, or with it at 0, nothing compacts", async () => {
    for (const options of [{ contextPercent: 50 }, { contextPercent: 99, compactAtPercent: 0 }]) {
      const session = await running(options);
      await session.turn(async () => {
        await session.use("init_experiment", { name: "t", metric_name: "total_ms" });
        await iteration(session);
      });
      await session.host.waitFor(() => resumes(session).length === 1, 2000, "the resume");
      assert.equal(session.host.compactions, 0);
      assert.equal(resumes(session)[0], composeResumeMessage());
    }
  });

  test("a compaction Claude Code refuses leaves the normal resume", async () => {
    const session = await running({ contextPercent: 90 });
    session.host.compactHook = null; // e.g. a classic PreCompact hook blocked it
    await session.turn(async () => {
      await session.use("init_experiment", { name: "t", metric_name: "total_ms" });
      await iteration(session);
    });
    await session.host.waitFor(() => resumes(session).length === 1, 2000, "the resume");
    assert.equal(session.host.compactions, 1);
    assert.equal(resumes(session)[0], composeResumeMessage());
  });

  test("a manual /compact mid-iteration keeps the unlogged run and says to finish it (I3)", async () => {
    const session = await running();
    await session.turn(async () => {
      await session.use("init_experiment", { name: "t", metric_name: "total_ms" });
      await iteration(session);
    });
    await session.host.waitFor(() => resumes(session).length === 1, 2000, "the resume");

    const messages = [...transcriptOfIteration(1), ...transcriptOfIteration(2, false)];
    const answer = await session.app.compact({ trigger: "manual", messages });
    assert.ok(answer && "messages" in answer);
    // Everything after the last logged run: the model's close of #1, then the open #2.
    assert.deepEqual(answer.messages.slice(1).map((message) => message.handle), ["h1g", "h2a", "h2b", "h2c", "h2d"]);
    await session.host.waitFor(() => resumes(session).length === 2, 2000, "the compaction resume");
    assert.equal(resumes(session)[1], `${IN_FLIGHT_RESUME_PREFIX} ${composeCompactionResumeMessage()}`);
  });

  test("an automatic compaction in the middle of a turn schedules nothing of its own", async () => {
    const session = await running();
    await session.turn(async () => {
      await session.use("init_experiment", { name: "t", metric_name: "total_ms" });
      await iteration(session);
      await session.app.compact({ trigger: "auto", messages: transcriptOfIteration(1) });
      await sleep(WINDOW * 3);
      assert.deepEqual(resumes(session), []);
    });
    await session.host.waitFor(() => resumes(session).length === 1, 2000, "the resume");
    assert.equal(resumes(session)[0], composeResumeMessage());
  });

  test("a subagent's compaction and any compaction while off are left to Claude Code", async () => {
    const session = await running();
    assert.equal(await session.app.compact({ trigger: "auto", agentId: "agent-1", messages: transcriptOfIteration(1) }), null);
    await session.command("off");
    assert.equal(await session.app.compact({ trigger: "manual", messages: transcriptOfIteration(1) }), null);
    assert.equal(await session.app.compact({ trigger: "precompute", messages: transcriptOfIteration(1) }), null);
  });
});

describe("hot reload and session switches", () => {
  test("a reload mid-loop keeps the mode, the counters, the checks gate and the pending resume", async () => {
    const session = await running({}, {});
    await session.turn(async () => {
      await session.use("init_experiment", { name: "t", metric_name: "total_ms" });
      await iteration(session);
    });
    session.ctx.runtime.lastRunChecks = { pass: false, output: "3 failed", duration: 1 };
    session.app.foreignPrompt(); // hold the resume so the reload finds it pending
    assert.notEqual(session.host.loop.value?.pendingResumeMessage, null);
    const loop = session.host.loop;
    const store = session.host.store;
    session.host.dispose(); // the old module's timers and children go with it

    // The module loads afresh; the engine's state and store are what they were.
    const reloaded = new Session(session.host.cwd, { timeScale: 0.05, loop, store });
    sessions.push(reloaded);
    await reloaded.start();
    assert.equal(reloaded.app.isModeOn(), true);
    assert.deepEqual(reloaded.host.registered.map((tool) => tool.name).sort(), ["init_experiment", "log_experiment", "run_experiment"]);
    assert.equal(reloaded.ctx.runtime.autoResumeTurns, 0);
    assert.equal(reloaded.ctx.runtime.state.results.length, 1);
    const refused = await reloaded.use("log_experiment", { commit: "0000000", metric: 9, status: "keep", description: "x" });
    assert.match(refused.result, /Cannot keep/);

    // The person's prompt started a turn after all; once it ends the held resume goes out.
    await reloaded.turn(async () => undefined);
    await reloaded.host.waitFor(() => reloaded.host.submitted.length === 1, 2000, "the resume");
  });

  test("/clear to a new session rebuilds from the log for that session", async () => {
    const session = await running();
    await session.turn(async () => {
      await session.use("init_experiment", { name: "t", metric_name: "total_ms" });
      await iteration(session);
    });
    await session.command("off");
    session.host.sessionIdValue = "session-2";
    await session.app.sessionSwitched();
    // The off was recorded for session-1; session-2 starts from the default rule.
    assert.equal(session.app.isModeOn(), true);
    assert.equal(session.ctx.runtime.state.results.length, 1);
    assert.equal(session.ctx.runtime.pendingResumeMessage, null);
  });
});
