// ported from pi-autoresearch@939ede8 hooks.ts:1-180. Constants, payload types,
// truncateAtBoundary, steerMessageFor and hookLogEntry are verbatim save Buffer →
// Uint8Array/TextEncoder. runHook's spawn, isExecutableFile and the jsonl append are
// I/O and live in app/iteration-hooks.ts; what is left of them here is pure:
// `capHookStdout` (runHook's 8 KiB cap) and `hookLogLineIfConfigured`
// (appendHookLogEntryIfConfigured with the file read and append lifted to the caller).

import { hasAutoresearchConfigHeader } from "./jsonl.ts";

export const TIMEOUT_MS = 30_000;
const STDOUT_MAX_BYTES = 8 * 1024;
const TRUNCATION_MARKER = "\n…[truncated: hook stdout exceeded 8KB]";

const NEWLINE = 0x0a;
const UTF8_CONT_MASK = 0xc0;
const UTF8_CONT = 0x80; // continuation byte: 10xxxxxx
const UTF8_LEAD = 0xc0; // multi-byte leader: 11xxxxxx

/** Trim at the last newline, falling back to the last complete UTF-8 character. */
function truncateAtBoundary(buf: Uint8Array): Uint8Array {
  const newlineEnd = buf.lastIndexOf(NEWLINE);
  if (newlineEnd >= 0) return buf.subarray(0, newlineEnd + 1);
  let end = buf.length;
  while (end > 0 && (buf[end - 1] & UTF8_CONT_MASK) === UTF8_CONT) end--;
  if (end > 0 && (buf[end - 1] & UTF8_CONT_MASK) === UTF8_LEAD) end--;
  return buf.subarray(0, end);
}

export type HookStage = "before" | "after";

export interface SessionSnapshot {
  metric_name: string;
  metric_unit: string;
  direction: "lower" | "higher";
  baseline_metric: number | null;
  best_metric: number | null;
  run_count: number;
  goal: string;
}

export interface BeforeHookPayload {
  event: "before";
  cwd: string;
  next_run: number;
  last_run: Record<string, unknown> | null;
  session: SessionSnapshot;
}

export interface AfterHookPayload {
  event: "after";
  cwd: string;
  run_entry: Record<string, unknown>;
  session: SessionSnapshot;
}

export type HookPayload = BeforeHookPayload | AfterHookPayload;

export interface HookResult {
  fired: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export const notFired: HookResult = {
  fired: false,
  stdout: "",
  stderr: "",
  exitCode: null,
  timedOut: false,
  durationMs: 0,
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

/**
 * runHook's stdout cap (hooks.ts:95-106), over the whole stdout as one chunk:
 * kept whole up to 8 KiB, else cut at a line or UTF-8 boundary with the marker.
 */
export function capHookStdout(stdout: Uint8Array): string {
  if (stdout.length <= STDOUT_MAX_BYTES) return decoder.decode(stdout);
  const kept = truncateAtBoundary(stdout.subarray(0, STDOUT_MAX_BYTES));
  return decoder.decode(kept) + TRUNCATION_MARKER;
}

export function steerMessageFor(stage: HookStage, result: HookResult): string | null {
  if (!result.fired) return null;
  if (result.timedOut) return `[${stage} hook timed out after ${TIMEOUT_MS / 1000}s]`;
  if (result.exitCode !== 0) {
    const parts = [`[${stage} hook exited ${result.exitCode}]`];
    const err = result.stderr.trim();
    const out = result.stdout.trim();
    if (err) parts.push(err);
    if (out) parts.push(out);
    return parts.join("\n");
  }
  return result.stdout.trim() || null;
}

export function hookLogEntry(stage: HookStage, result: HookResult): Record<string, unknown> {
  return {
    type: "hook",
    stage,
    exit_code: result.exitCode,
    duration_ms: result.durationMs,
    stdout_bytes: encoder.encode(result.stdout).length,
    timed_out: result.timedOut,
  };
}

/**
 * The line appendHookLogEntryIfConfigured would append, or null where it appends
 * nothing: the hook did not fire, or the log (its content, null when missing) has
 * no config header yet.
 */
export function hookLogLineIfConfigured(
  jsonlContent: string | null,
  stage: HookStage,
  result: HookResult,
): string | null {
  if (!result.fired) return null;
  if (jsonlContent === null || !hasAutoresearchConfigHeader(jsonlContent)) return null;
  return JSON.stringify(hookLogEntry(stage, result)) + "\n";
}
