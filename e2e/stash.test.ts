// Changes `/autoresearch` stashed before the loop (I10) are offered back when it stops
// (I19): the dialog when the loop clearly stops, a line after Esc or a turn the loop doesn't
// carry on from, a reminder in a new session. Real git; the resume window scaled down 20x.

import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import * as nodePath from "node:path";
import { after, describe, test } from "node:test";

import { UNCOMMITTED_STASH } from "../plugin/hooks/app/uncommitted.ts";
import {
  UNSTASH_ANYWAY,
  UNSTASH_HEADER,
  UNSTASH_MYSELF,
  UNSTASH_MYSELF_RECOMMENDED,
  UNSTASH_NOW,
} from "../plugin/hooks/app/stash.ts";
import { Session, git, makeRepo, removeTempDir, sleep, type FileSpec, type SessionOptions } from "./node-host.ts";

const dirs: string[] = [];
const sessions: Session[] = [];
after(async () => {
  for (const session of sessions) void session.end();
  for (const dir of dirs) await removeTempDir(dir);
});

const WINDOW = 800 * 0.05;
const MEASURE = { text: '#!/bin/bash\necho "METRIC total_ms=10"\n', mode: 0o755 };

/** A repo with a.js edited and notes.md new, uncommitted; `/autoresearch go` stashes them. */
async function stashedLoop(options: SessionOptions = {}, auto: Record<string, FileSpec> = {}) {
  const cwd = await makeRepo({ "a.js": "one\n", "b.js": "two\n" }, {
    "a.js": "one, edited\n",
    "notes.md": "mine\n",
    ".auto/prompt.md": "# goal\n",
    ".auto/measure.sh": MEASURE,
    ...auto,
  });
  dirs.push(cwd);
  const session = new Session(cwd, { timeScale: 0.05, canAsk: true, ...options });
  sessions.push(session);
  await session.start();
  session.host.answers.push(UNCOMMITTED_STASH);
  await session.command("go");
  await session.host.waitFor(() => session.host.submitted.length === 1, 2000, "the kickoff");
  assert.equal(await git(cwd, "stash", "list", "--format=%s"), "On main: autoresearch: uncommitted changes set aside before the loop started");
  return { cwd, session };
}

async function iteration(session: Session, status = "keep") {
  if (session.ctx.runtime.state.results.length === 0) await session.use("init_experiment", { name: "t", metric_name: "total_ms" });
  await session.use("run_experiment", { command: "bash .auto/measure.sh" });
  return session.use("log_experiment", { commit: "0000000", metric: 10, status, description: status });
}

const read = (cwd: string, file: string) => fsp.readFile(nodePath.join(cwd, file), "utf8").catch(() => null);
const unstashQuestions = (session: Session) => session.host.questions.filter((q) => q.header === UNSTASH_HEADER);

describe("the loop stops: the dialog (I19)", () => {
  test("unstashing brings the changes back and forgets the stash", async () => {
    const { cwd, session } = await stashedLoop();
    session.host.answers.push(UNSTASH_NOW);
    await session.command("off");

    assert.deepEqual(unstashQuestions(session), [
      {
        question: "Your 2 changes from before the loop are stashed. Bring them back now?",
        options: [UNSTASH_NOW, UNSTASH_MYSELF],
        header: UNSTASH_HEADER,
      },
    ]);
    assert.equal(await read(cwd, "a.js"), "one, edited\n");
    assert.equal(await read(cwd, "notes.md"), "mine\n");
    assert.equal(await git(cwd, "stash", "list"), "");
    assert.equal(session.host.notices.at(-1)?.text, "Unstashed your 2 changes from before the loop");
    assert.deepEqual([...session.host.store.entries()].filter(([key]) => key.startsWith("stash:")).map(([, value]) => value), [[]]);
  });

  test("doing it yourself prints the command and leaves the stash", async () => {
    const { cwd, session } = await stashedLoop();
    session.host.answers.push(UNSTASH_MYSELF);
    await session.command("off");

    assert.equal(
      session.host.logs.at(-1),
      "Your 2 changes from before the loop are in the stash. To bring them back, run `git stash pop stash@{0}`.",
    );
    assert.equal(await read(cwd, "a.js"), "one\n");
    assert.match(await git(cwd, "stash", "list"), /autoresearch: uncommitted changes set aside/);
  });

  test("when the loop changed a stashed file, doing it yourself is recommended, and why", async () => {
    const { session } = await stashedLoop();
    await session.turn(async () => {
      await fsp.writeFile(nodePath.join(session.host.cwd, "a.js"), "one, by the loop\n");
      await iteration(session, "keep");
    });
    session.host.answers.push(UNSTASH_MYSELF_RECOMMENDED);
    await session.command("off");

    assert.deepEqual(unstashQuestions(session), [
      {
        question: "Your 2 changes from before the loop are stashed, but the loop also changed a.js, so unstashing may conflict. Bring them back now anyway?",
        options: [UNSTASH_MYSELF_RECOMMENDED, UNSTASH_ANYWAY],
        header: UNSTASH_HEADER,
      },
    ]);
  });

  test("on another branch, the command switches back first", async () => {
    const { cwd, session } = await stashedLoop();
    await git(cwd, "switch", "-q", "-c", "autoresearch/go");
    session.host.answers.push(UNSTASH_MYSELF_RECOMMENDED);
    await session.command("off");

    assert.match(unstashQuestions(session)[0]!.question, /but the loop is on autoresearch\/go, not main, where they came from\./);
    assert.equal(
      session.host.logs.at(-1),
      "Your 2 changes from before the loop are in the stash. To bring them back once you're done with autoresearch/go, run `git switch main && git stash pop stash@{0}`.",
    );
  });

  test("unstashing anyway into a conflict keeps the stash and says how to finish", async () => {
    const { cwd, session } = await stashedLoop();
    await session.turn(async () => {
      await fsp.writeFile(nodePath.join(cwd, "a.js"), "one, by the loop\n");
      await iteration(session, "keep");
    });
    session.host.answers.push(UNSTASH_ANYWAY);
    await session.command("off");

    assert.match(session.host.logs.at(-1)!, /^Unstashing hit conflicts, so git kept the stash\. Resolve them, then run `git stash drop stash@\{0\}`\.$/);
    assert.match(await git(cwd, "stash", "list"), /autoresearch: uncommitted changes set aside/);
  });

  test("where no one can be asked, the command is printed", async () => {
    const { session } = await stashedLoop();
    session.host.canAskValue = false;
    await session.command("off");

    assert.deepEqual(unstashQuestions(session), []);
    assert.equal(
      session.host.logs.at(-1),
      "The loop has stopped. Your 2 changes from before the loop are in the stash. To bring them back, run `git stash pop stash@{0}`.",
    );
  });

  test("the iteration cap offers it once the turn ends", async () => {
    const { session } = await stashedLoop({}, { ".auto/config.json": '{ "maxIterations": 1 }\n' });
    session.host.answers.push(UNSTASH_MYSELF);
    await session.turn(async () => {
      await iteration(session);
      assert.deepEqual(unstashQuestions(session), []);
    });
    await session.host.waitFor(() => unstashQuestions(session).length === 1, 2000, "the offer");
  });

  test("a stash the person already popped is forgotten, and nothing is asked", async () => {
    const { cwd, session } = await stashedLoop();
    await git(cwd, "stash", "pop", "-q");
    await session.command("off");
    assert.deepEqual(unstashQuestions(session), []);
    assert.deepEqual([...session.host.store.entries()].filter(([key]) => key.startsWith("stash:")).map(([, value]) => value), [[]]);
  });
});

describe("a pause or a turn the loop doesn't carry on from: a line (I19)", () => {
  test("Esc says where the changes are, once", async () => {
    const { session } = await stashedLoop();
    await session.turn(async () => iteration(session), { aborted: true });
    const paused =
      "Paused. Your 2 changes from before the loop are still stashed; you'll be asked about them when the loop stops, or run `git stash pop stash@{0}` yourself.";
    await session.host.waitFor(() => session.host.logs.includes(paused), 2000, "the line");
    await session.turn(async () => undefined, { aborted: true });
    await sleep(WINDOW * 2);
    assert.equal(session.host.logs.filter((line) => line === paused).length, 1);
    assert.deepEqual(unstashQuestions(session), []);
  });

  test("a turn the loop doesn't carry on from says so, once, and again after the loop runs", async () => {
    const { session } = await stashedLoop();
    const line =
      "The loop isn't carrying on. Your 2 changes from before the loop are in the stash. To bring them back, run `git stash pop stash@{0}`.";
    await session.turn(async () => iteration(session));
    await session.host.waitFor(() => session.host.submitted.length === 2, 2000, "the resume");
    await session.turn(async () => undefined);
    await session.host.waitFor(() => session.host.logs.includes(line), 2000, "the line");
    await session.turn(async () => undefined);
    await sleep(WINDOW * 2);
    assert.equal(session.host.logs.filter((l) => l === line).length, 1);

    // The person's message leads to a logged run: the loop runs again, and stops again.
    await session.turn(async () => iteration(session, "discard"));
    await session.host.waitFor(() => session.host.submitted.length === 3, 2000, "the resume");
    await session.turn(async () => undefined);
    await session.host.waitFor(() => session.host.logs.filter((l) => l === line).length === 2, 2000, "the second line");
  });

  test("a new session in the folder says the changes are still stashed", async () => {
    const { cwd, session } = await stashedLoop();
    await session.end("prompt_input_exit");
    const again = new Session(cwd, { timeScale: 0.05, store: session.host.store, canAsk: true });
    sessions.push(again);
    await again.start();
    assert.deepEqual(again.host.logs, [
      "Your 2 changes from before an earlier loop are in the stash. To bring them back, run `git stash pop stash@{0}`.",
    ]);
    assert.deepEqual(again.host.questions, []);
  });
});
