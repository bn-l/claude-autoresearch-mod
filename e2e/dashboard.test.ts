// The browser dashboard (PLAN §4.16): `/autoresearch export` starts the helper
// (plugin/server/dashboard-server.mjs) through the same app code the mod runs, and the
// checks are behaviour, not looks: the page and the log are served, an SSE event follows
// each logged experiment, /notify wants the token, and the helper never outlives the
// mode, the session or its parent. Run under node, and under bun when bun is installed.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "node:http";
import * as nodePath from "node:path";
import { after, describe, test } from "node:test";

import { dashboardServerOf } from "../plugin/hooks/app/export.ts";
import { PLUGIN_ROOT, Session, makeRepo, removeTempDir, sh, sleep } from "./node-host.ts";

const dirs: string[] = [];
const sessions: Session[] = [];
after(async () => {
  for (const session of sessions) session.end();
  for (const dir of dirs) await removeTempDir(dir);
});

const SERVER = nodePath.join(PLUGIN_ROOT, "server/dashboard-server.mjs");
const LOG =
  [
    JSON.stringify({ type: "config", name: "Sort <speed> & more", metricName: "total_ms", metricUnit: "ms", bestDirection: "lower" }),
    JSON.stringify({ run: 1, commit: "abc1234", metric: 10, metrics: {}, status: "keep", description: "baseline", timestamp: 1, segment: 0, confidence: null }),
  ].join("\n") + "\n";

function http(port: number, path: string, method = "GET", body = ""): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** Opens /events and collects what arrives. */
function events(port: number) {
  const received: string[] = [];
  const req = request({ host: "127.0.0.1", port, path: "/events" }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => received.push(chunk));
  });
  req.on("error", () => undefined);
  req.end();
  return { received, close: () => req.destroy() };
}

async function isListening(port: number): Promise<boolean> {
  try {
    await http(port, "/");
    return true;
  } catch {
    return false;
  }
}

async function exported() {
  const dir = await makeRepo({ "speed.txt": "10\n" }, {
    ".auto/log.jsonl": LOG,
    ".auto/measure.sh": { text: '#!/bin/bash\necho "METRIC total_ms=$(cat speed.txt)"\n', mode: 0o755 },
  });
  dirs.push(dir);
  const session = new Session(dir);
  sessions.push(session);
  await session.start();
  await session.command("export");
  const server = dashboardServerOf(session.ctx);
  assert.ok(server, JSON.stringify(session.host.notices));
  return { dir, session, ...server };
}

describe("/autoresearch export", () => {
  test("without a log it says so and starts nothing", async () => {
    const dir = await makeRepo();
    dirs.push(dir);
    const session = new Session(dir);
    sessions.push(session);
    await session.start();
    await session.command("export");
    assert.deepEqual(session.host.notices, [{ text: "No log.jsonl found — run some experiments first", level: "error" }]);
    assert.equal(dashboardServerOf(session.ctx), null);
  });

  test("serves the page with the title and logo, and the log; opens the browser", async () => {
    const { session, port } = await exported();
    const url = `http://127.0.0.1:${port}`;
    assert.deepEqual(session.host.openedUrls, [url]);
    assert.deepEqual(session.host.notices.at(-1), { text: `Dashboard at ${url} (live updates)`, level: "info" });

    const page = await http(port, "/");
    assert.equal(page.status, 200);
    assert.match(page.text, /Sort &lt;speed&gt; &amp; more/);
    assert.match(page.text, /data:image\/webp;base64,/);
    assert.doesNotMatch(page.text, /__AUTORESEARCH_(TITLE|LOGO)__/);
    assert.equal((await http(port, "/autoresearch.jsonl")).text, LOG);
    assert.equal((await http(port, "/../../etc/passwd")).status, 404);
  });

  test("each logged experiment reaches the page as an SSE event", async () => {
    const { session, port } = await exported();
    const stream = events(port);
    await sleep(200);
    assert.match(stream.received.join(""), /^retry: 1000\n\n/);
    await session.use("run_experiment", { command: "bash .auto/measure.sh" });
    await session.use("log_experiment", { commit: "0000000", metric: 9, status: "keep", description: "faster" });
    await sleep(300);
    assert.match(stream.received.join(""), /event: jsonl-updated\ndata: \d+\n\n/);
    assert.match((await http(port, "/autoresearch.jsonl")).text, /"description":"faster"/);
    stream.close();
  });

  test("/notify and /page refuse a request without the token", async () => {
    const { port, token } = await exported();
    assert.equal((await http(port, "/notify", "POST")).status, 403);
    assert.equal((await http(port, "/notify?token=wrong", "POST")).status, 403);
    assert.equal((await http(port, "/page", "POST", JSON.stringify({ title: "x" }))).status, 403);
    assert.equal((await http(port, `/notify?token=${token}`, "POST")).status, 204);
  });

  test("/autoresearch web is the same command (D13)", async () => {
    const { session, port } = await exported();
    await session.command("web");
    assert.equal(dashboardServerOf(session.ctx)?.port, port);
    assert.equal(session.host.openedUrls.length, 2);
    assert.equal((await http(port, "/")).status, 200);
  });

  test("a second export reuses the helper", async () => {
    const { session, port } = await exported();
    await session.command("export");
    assert.equal(dashboardServerOf(session.ctx)?.port, port);
  });

  for (const how of ["off", "clear", "the session ending"] as const) {
    test(`the helper is gone after ${how}`, async () => {
      const { session, port } = await exported();
      assert.equal(await isListening(port), true);
      if (how === "the session ending") session.app.sessionEnd();
      else await session.command(how);
      await sleep(500);
      assert.equal(await isListening(port), false);
      assert.equal(dashboardServerOf(session.ctx), null);
    });
  }
});

// ---------------------------------------------------------------------------
// The helper on its own, under each runtime
// ---------------------------------------------------------------------------

function startHelper(runtime: string, extra: string[] = []) {
  const child = spawn(runtime, [
    SERVER,
    "--jsonl", nodePath.join(PLUGIN_ROOT, "..", "e2e", "missing.jsonl"),
    "--template", nodePath.join(PLUGIN_ROOT, "assets/template.html"),
    "--logo", nodePath.join(PLUGIN_ROOT, "assets/logo.webp"),
    "--title", "helper",
    ...extra,
  ], { stdio: ["ignore", "pipe", "inherit"] });
  const first = new Promise<{ port: number; token: string }>((resolve, reject) => {
    let buffer = "";
    child.stdout!.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline !== -1) resolve(JSON.parse(buffer.slice(0, newline)));
    });
    child.on("error", reject);
  });
  return { child, first };
}

const runtimes = ["node"];
if ((await sh("/", ["bash", "-c", "command -v bun"])).code === 0) runtimes.push("bun");

describe("the helper", () => {
  for (const runtime of runtimes) {
    test(`under ${runtime}: serves, streams, and exits when its parent pid is gone`, async () => {
      const parent = spawn("sleep", ["2"]);
      const { child, first } = startHelper(runtime, ["--parent-pid", String(parent.pid)]);
      const { port, token } = await first;
      assert.equal((await http(port, "/")).status, 200);
      assert.equal((await http(port, "/autoresearch.jsonl")).status, 404);
      const stream = events(port);
      await sleep(200);
      assert.equal((await http(port, `/notify?token=${token}`, "POST")).status, 204);
      await sleep(200);
      assert.match(stream.received.join(""), /event: jsonl-updated/);
      stream.close();

      const exited = new Promise((resolve) => child.on("exit", resolve));
      await Promise.race([exited, sleep(6000).then(() => assert.fail("the helper outlived its parent"))]);
      assert.equal(await isListening(port), false);
    });
  }

  test("a bad invocation answers with an error line", async () => {
    const child = spawn("node", [SERVER, "--jsonl", "x"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout!.on("data", (chunk) => (out += chunk));
    await new Promise((resolve) => child.on("exit", resolve));
    assert.deepEqual(JSON.parse(out), { error: "missing --template" });
  });
});
