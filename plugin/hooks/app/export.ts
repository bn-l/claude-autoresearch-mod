// ported from pi-autoresearch@939ede8 index.ts:2767-2990 (Export: local live dashboard).
// pi served the page from its own process (node:http). A mod has no server API (F9), so
// server/dashboard-server.mjs does upstream's serving under node or bun, whichever is on
// PATH, in a spawn loop that lives until it is stopped; broadcastDashboardUpdate becomes
// a POST to the helper's /notify with the token it printed.

import { posix as path } from "../upstream/vendor/path.js";
import { extractAutoresearchSessionName } from "../upstream/jsonl.ts";
import { NOTICES } from "../upstream/experiment-core.ts";
import type { Host, Spawned } from "./host.ts";
import { resolveWorkDir, sessionFilesOf, type Ctx } from "./context.ts";

interface DashboardServer {
  workDir: string;
  port: number;
  token: string;
  stop: () => void;
}

/** One helper per session, reused per workDir (upstream: one server per workDir). */
const servers = new WeakMap<Ctx, DashboardServer>();

/** Picks node, else bun, and runs the helper with it; says so when neither is there. */
const LAUNCH = [
  'if command -v node >/dev/null 2>&1; then exec node "$@"; fi',
  'if command -v bun >/dev/null 2>&1; then exec bun "$@"; fi',
  'echo \'{"error":"the browser dashboard needs node (18 or newer) or bun on PATH"}\'',
  "exit 127",
].join("\n");

async function readFirstLine(child: Spawned, onRest: () => void): Promise<string> {
  const iterator = child[Symbol.asyncIterator]();
  let buffer = "";
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    buffer += next.value.text;
    const newline = buffer.indexOf("\n");
    if (newline !== -1) {
      // Keep draining so the helper never blocks on a full pipe.
      void (async () => {
        try {
          for (;;) {
            const more = await iterator.next();
            if (more.done) break;
          }
        } catch {
          // stopped
        }
        onRest();
      })();
      return buffer.slice(0, newline);
    }
  }
  onRest();
  return buffer;
}

async function startStaticServer(ctx: Ctx, workDir: string, jsonlPath: string, title: string): Promise<number> {
  const host = ctx.host;
  const resolvedWorkDir = path.resolve(workDir);
  const running = servers.get(ctx);

  if (running && running.workDir === resolvedWorkDir) {
    await host.post(`http://127.0.0.1:${running.port}/page?token=${running.token}`, JSON.stringify({ title, jsonlPath })).catch(() => undefined);
    return running.port;
  }

  stopDashboardServer(ctx);

  const parentPid = await host.parentPid();
  const stopper = new AbortController();
  const child = host.spawn(
    [
      "bash",
      "-c",
      LAUNCH,
      "autoresearch-dashboard",
      `${host.pluginRoot}/server/dashboard-server.mjs`,
      "--jsonl", jsonlPath,
      "--template", `${host.pluginRoot}/assets/template.html`,
      "--logo", `${host.pluginRoot}/assets/logo.webp`,
      "--title", title,
      ...(parentPid ? ["--parent-pid", parentPid] : []),
    ],
    { cwd: resolvedWorkDir, signal: stopper.signal },
  );

  let exited = false;
  let token = "";
  const firstLine = await readFirstLine(child, () => {
    exited = true;
    if (servers.get(ctx)?.token === token) servers.delete(ctx);
  });
  let parsed: { port?: unknown; token?: unknown; error?: unknown };
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    stopper.abort();
    throw new Error(firstLine.trim() || "the dashboard helper did not start");
  }
  if (typeof parsed.error === "string") {
    stopper.abort();
    throw new Error(parsed.error);
  }
  if (typeof parsed.port !== "number" || typeof parsed.token !== "string") {
    stopper.abort();
    throw new Error("Failed to bind dashboard server");
  }
  token = parsed.token;
  if (exited) throw new Error("the dashboard helper exited");

  servers.set(ctx, { workDir: resolvedWorkDir, port: parsed.port, token, stop: () => stopper.abort() });
  return parsed.port;
}

export function stopDashboardServer(ctx: Ctx): void {
  const running = servers.get(ctx);
  if (!running) return;
  servers.delete(ctx);
  running.stop();
}

export function broadcastDashboardUpdate(ctx: Ctx, workDir: string): void {
  const running = servers.get(ctx);
  if (!running || running.workDir !== path.resolve(workDir)) return;
  void ctx.host.post(`http://127.0.0.1:${running.port}/notify?token=${running.token}`, "").catch(() => undefined);
}

export async function exportDashboard(ctx: Ctx): Promise<void> {
  const host: Host = ctx.host;
  const workDir = await resolveWorkDir(host, await host.sessionCwd());
  const files = await sessionFilesOf(host, workDir);
  const jsonlPath = files.path("log");

  if (!(await host.exists(jsonlPath))) {
    host.notify(NOTICES.noLog(path.basename(jsonlPath)), "error");
    return;
  }

  try {
    const jsonlContent = ((await host.readText(jsonlPath)) ?? "").trim();
    const sessionName = extractAutoresearchSessionName(jsonlContent);
    const port = await startStaticServer(ctx, workDir, jsonlPath, sessionName);
    const url = `http://127.0.0.1:${port}`;
    await host.openUrl(url).catch(() => undefined);
    host.notify(NOTICES.dashboardAt(url), "info");
  } catch (error) {
    host.notify(NOTICES.exportFailed(error instanceof Error ? error.message : String(error)), "error");
  }
}

/** For tests: the running helper's address. */
export function dashboardServerOf(ctx: Ctx): { port: number; token: string; workDir: string } | null {
  const running = servers.get(ctx);
  return running ? { port: running.port, token: running.token, workDir: running.workDir } : null;
}
