// ported from pi-autoresearch@939ede8 hooks.ts:64-130 (runHook, isExecutableFile) and
// index.ts:1260-1264 (fireHook), onto the Host. The script runs under `bash` in the
// payload's cwd with the payload as one JSON line on stdin, as upstream's spawn did;
// `host.run` rejecting after the 30 s timeout is the timeout (upstream: child.killed).

import {
  TIMEOUT_MS,
  capHookStdout,
  hookLogLineIfConfigured,
  notFired,
  steerMessageFor,
  type HookPayload,
  type HookResult,
} from "../upstream/hooks-core.ts";
import type { Host } from "./host.ts";
import { sessionFilesOf } from "./context.ts";

const encoder = new TextEncoder();

async function isExecutableFile(host: Host, filePath: string): Promise<boolean> {
  try {
    return (await host.isExecutable(filePath)) && (await host.kind(filePath)) === "file";
  } catch {
    return false;
  }
}

export async function runHook(host: Host, payload: HookPayload): Promise<HookResult> {
  const files = await sessionFilesOf(host, payload.cwd);
  const script = files.hook(payload.event);
  if (!(await isExecutableFile(host, script))) return notFired;

  const t0 = Date.now();
  try {
    const result = await host.run(["bash", script], {
      cwd: payload.cwd,
      stdin: JSON.stringify(payload),
      timeoutMs: TIMEOUT_MS,
    });
    return {
      fired: true,
      stdout: capHookStdout(encoder.encode(result.stdout)),
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: false,
      durationMs: Date.now() - t0,
    };
  } catch (error) {
    const durationMs = Date.now() - t0;
    const timedOut = durationMs >= TIMEOUT_MS;
    return {
      fired: true,
      stdout: "",
      stderr: timedOut ? "" : error instanceof Error ? error.message : String(error),
      exitCode: null,
      timedOut,
      durationMs,
    };
  }
}

/**
 * I18: a hook's output is text from outside (a web search, a file), so a tag that Claude
 * Code uses to speak to the model is defused before the model reads it, as Claude Code
 * does with its own hooks' output.
 */
export function escapeReminderTags(text: string): string {
  return text.replace(/<(\/?)(system-reminder)\b/gi, "&lt;$1$2");
}

/** index.ts:1260-1264: run the hook, record it in the log, return its steer text. */
export async function fireHook(host: Host, payload: HookPayload): Promise<string | null> {
  const result = await runHook(host, payload);
  try {
    const files = await sessionFilesOf(host, payload.cwd);
    const jsonlPath = files.path("log");
    const line = hookLogLineIfConfigured(await host.readText(jsonlPath), payload.event, result);
    if (line !== null) await host.appendText(jsonlPath, line);
  } catch {
    // appendHookLogEntryIfConfigured swallows write failures
  }
  const steer = steerMessageFor(payload.event, result);
  return steer === null ? null : escapeReminderTags(steer);
}
