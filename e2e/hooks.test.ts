// Iteration hooks (.auto/hooks/before.sh, after.sh) on real bash (PLAN §4.11, §7.2): what
// the model reads after log_experiment (after, then before, each its own context entry),
// what the scripts get on stdin, what the log records, and the ways hooks break.

import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import * as nodePath from "node:path";
import { after, describe, test } from "node:test";

import { Session, logLines, makeRepo, removeTempDir, type FileSpec } from "./node-host.ts";

const dirs: string[] = [];
const sessions: Session[] = [];
after(async () => {
  for (const session of sessions) session.end();
  for (const dir of dirs) await removeTempDir(dir);
});

const MEASURE = { text: '#!/bin/bash\necho "METRIC total_ms=10"\n', mode: 0o755 };
const hook = (body: string, mode = 0o755): FileSpec => ({ text: `#!/bin/bash\n${body}\n`, mode });

async function sessionWith(hooks: Record<string, FileSpec>) {
  const dir = await makeRepo({}, { ".auto/prompt.md": "# rules\n", ".auto/measure.sh": MEASURE, ...hooks });
  dirs.push(dir);
  const session = new Session(dir, { timeScale: 0.05 });
  sessions.push(session);
  await session.start();
  await session.command("go");
  await session.use("init_experiment", { name: "hooks", metric_name: "total_ms", metric_unit: "ms" });
  await session.use("run_experiment", { command: "bash .auto/measure.sh" });
  return { dir, session };
}

const logOnce = (session: Session, status = "keep") =>
  session.use("log_experiment", { commit: "0000000", metric: 10, status, description: "baseline" });

describe("iteration hooks", () => {
  test("after then before reach the model as separate context, with their payloads", async () => {
    const { dir, session } = await sessionWith({
      ".auto/hooks/after.sh": hook('cat > "$PWD/.auto/after-payload.json"\necho "after says: run $(jq -r .run_entry.run < .auto/after-payload.json 2>/dev/null || echo 1) logged"'),
      ".auto/hooks/before.sh": hook('cat > "$PWD/.auto/before-payload.json"\necho "before says: try loop unrolling next"'),
    });
    const logged = await logOnce(session);
    assert.equal(logged.context?.length, 2);
    assert.match(logged.context![0]!, /^after says: run 1 logged$/);
    assert.equal(logged.context![1], "before says: try loop unrolling next");

    const afterPayload = JSON.parse(await fsp.readFile(nodePath.join(dir, ".auto/after-payload.json"), "utf8"));
    assert.equal(afterPayload.event, "after");
    assert.equal(afterPayload.cwd, dir);
    assert.equal(afterPayload.run_entry.status, "keep");
    assert.equal(afterPayload.session.metric_name, "total_ms");
    const beforePayload = JSON.parse(await fsp.readFile(nodePath.join(dir, ".auto/before-payload.json"), "utf8"));
    assert.equal(beforePayload.event, "before");
    assert.equal(beforePayload.next_run, 2);
    assert.equal(beforePayload.last_run.run, 1);

    const hookLines = (await logLines(dir)).filter((line) => line.type === "hook");
    assert.deepEqual(hookLines.map((line) => [line.stage, line.exit_code, line.timed_out]), [
      ["after", 0, false],
      ["before", 0, false],
    ]);
  });

  test("a hook that is not executable does not fire", async () => {
    const { dir, session } = await sessionWith({ ".auto/hooks/after.sh": hook("echo never", 0o644) });
    const logged = await logOnce(session);
    assert.deepEqual(logged.context, []);
    assert.deepEqual((await logLines(dir)).filter((line) => line.type === "hook"), []);
  });

  test("a failing hook's status, stderr and stdout reach the model", async () => {
    const { session } = await sessionWith({ ".auto/hooks/after.sh": hook("echo partial\necho 'lint broke' >&2\nexit 2") });
    const logged = await logOnce(session);
    assert.equal(logged.context?.[0], "[after hook exited 2]\nlint broke\npartial");
  });

  test("a huge stdout is cut at 8 KiB on a character boundary", async () => {
    // 8191 ASCII bytes, then a 3-byte character straddling the 8 KiB cut, then more.
    const { session } = await sessionWith({
      ".auto/hooks/after.sh": hook("head -c 8191 /dev/zero | tr '\\0' 'a'\nprintf '€'\nhead -c 20000 /dev/zero | tr '\\0' 'b'"),
    });
    const logged = await logOnce(session);
    const steer = logged.context?.[0] ?? "";
    assert.ok(steer.endsWith("…[truncated: hook stdout exceeded 8KB]"), steer.slice(-80));
    assert.ok(!steer.includes("�"), "no broken character");
    assert.ok(!steer.includes("b"), "nothing past the cut");
    assert.equal(steer.split("\n")[0]!.length, 8191);
  });

  test("the before hook's output leads the kickoff when prompt.md exists", async () => {
    const dir = await makeRepo({}, {
      ".auto/prompt.md": "# rules\n",
      ".auto/hooks/before.sh": hook('echo "remember: the sort must stay stable"'),
    });
    dirs.push(dir);
    const session = new Session(dir);
    sessions.push(session);
    await session.start();
    await session.command("go");
    await session.host.waitFor(() => session.host.submitted.length === 1, 3000, "the kickoff");
    assert.match(session.host.submitted[0]!, /^remember: the sort must stay stable\n\nAutoresearch mode active\./);
  });

  test("a hook running past 30 s is reported as timed out", { timeout: 60_000 }, async () => {
    const { dir, session } = await sessionWith({ ".auto/hooks/after.sh": hook("sleep 40") });
    const t0 = Date.now();
    const logged = await logOnce(session);
    assert.ok(Date.now() - t0 >= 30_000);
    assert.equal(logged.context?.[0], "[after hook timed out after 30s]");
    const hookLines = (await logLines(dir)).filter((line) => line.type === "hook");
    assert.equal(hookLines[0]!.timed_out, true);
  });
});
