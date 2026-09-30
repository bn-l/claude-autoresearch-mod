// ported from pi-autoresearch@939ede8 index.ts:1206-1221 and 1506-1513: while the mode
// is on, a compaction of the main conversation is answered with upstream's deterministic
// summary (compaction.ts), no model call. What is kept after it is this port's (I3): pi
// kept its token-based cut; here the kept tail is the current iteration, every message
// after the last log_experiment result, handed back with its engine handle, so a
// run_experiment result not yet logged survives. The tail is cut on message boundaries
// that never separate a tool call from its result, and capped in size.

import { autoresearchSummaryPathsFor, buildAutoresearchCompactionSummary } from "../upstream/compaction-core.ts";
import { resolveWorkDir, sessionFilesOf, type Ctx } from "./context.ts";
import { afterCompaction, pausePendingResume } from "./resume.ts";

/** One message as `session.compact` hands it (SessionMessage). */
export interface CompactMessage {
  role: "user" | "assistant";
  text: string;
  toolUses: { tool_use_id: string; tool: string; input?: unknown; result?: unknown; text?: string; isError?: boolean }[];
  toolResults?: { tool_use_id: string; text?: string; isError?: boolean; result?: unknown }[];
  handle?: string;
}

export interface CompactInput {
  trigger: "manual" | "auto" | "plugin" | "precompute";
  agentId?: string;
  messages: readonly CompactMessage[];
}

export type CompactAnswer = { messages: CompactMessage[] } | { skip: string };

/** Past this much text the kept tail loses its oldest messages. */
export const TAIL_MAX_CHARS = 200_000;

const LOG_TOOL = /^mcp__[\w-]*autoresearch[\w-]*__log_experiment$/;
const RUN_TOOL = /^mcp__[\w-]*autoresearch[\w-]*__run_experiment$/;
/** Tools whose use in the kept tail means the iteration changed something not yet logged. */
const WORK_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]);

function sizeOf(message: CompactMessage): number {
  let size = message.text.length;
  for (const use of message.toolUses) {
    size += JSON.stringify(use.input ?? null).length + (use.text?.length ?? 0);
  }
  for (const result of message.toolResults ?? []) size += result.text?.length ?? 0;
  return size;
}

/** A message the tail may start at: not a user message answering an earlier tool call. */
function isCleanStart(message: CompactMessage): boolean {
  return !(message.role === "user" && (message.toolResults?.length ?? 0) > 0);
}

/** The current iteration: the messages after the last log_experiment result. */
export function keptTail(
  messages: readonly CompactMessage[],
  maxChars: number = TAIL_MAX_CHARS,
): { tail: CompactMessage[]; hasInFlightWork: boolean } {
  const logUseIds = new Set<string>();
  let lastLogIndex = -1;
  // A log_experiment call that was refused ("❌ Missing secondary metrics", the checks
  // gate) logged nothing: the iteration is still open.
  const logged = (text: string | undefined) => text === undefined || text.startsWith("Logged #");
  messages.forEach((message, index) => {
    for (const use of message.toolUses) {
      if (LOG_TOOL.test(use.tool) && logged(use.text)) {
        logUseIds.add(use.tool_use_id);
        // Where the result lives is the next message; fall back to it if no row says.
        lastLogIndex = Math.max(lastLogIndex, Math.min(index + 1, messages.length - 1));
      }
    }
    for (const result of message.toolResults ?? []) {
      if (logUseIds.has(result.tool_use_id) && logged(result.text)) lastLogIndex = Math.max(lastLogIndex, index);
    }
  });

  let start = lastLogIndex + 1;
  while (start < messages.length && !isCleanStart(messages[start])) start++;

  let total = 0;
  for (let i = start; i < messages.length; i++) total += sizeOf(messages[i]);
  while (total > maxChars && start < messages.length) {
    total -= sizeOf(messages[start]);
    start++;
    while (start < messages.length && !isCleanStart(messages[start])) {
      total -= sizeOf(messages[start]);
      start++;
    }
  }

  const tail = messages.slice(start);
  const hasInFlightWork = tail.some((message) =>
    message.toolUses.some((use) => RUN_TOOL.test(use.tool) || WORK_TOOLS.has(use.tool)),
  );
  return { tail, hasInFlightWork };
}

/** The session.compact answer, or null to leave the compaction to Claude Code. */
export async function compactionAnswer(ctx: Ctx, e: CompactInput): Promise<CompactAnswer | null> {
  if (e.agentId !== undefined) return null;
  if (!ctx.runtime.autoresearchMode) return null;
  if (e.trigger === "precompute") return { skip: "autoresearch builds its own summary" };

  pausePendingResume(ctx);

  const host = ctx.host;
  const workDir = await resolveWorkDir(host, await host.sessionCwd());
  const files = await sessionFilesOf(host, workDir);
  const paths = autoresearchSummaryPathsFor(workDir, files.exists);
  const summary = buildAutoresearchCompactionSummary(paths, {
    jsonl: (await host.readText(paths.jsonlPath).catch(() => null)) ?? "",
    md: (await host.readText(paths.mdPath).catch(() => null)) ?? "",
    ideas: (await host.readText(paths.ideasPath).catch(() => null)) ?? "",
  });

  const { tail, hasInFlightWork } = keptTail(e.messages);
  afterCompaction(ctx, hasInFlightWork);

  return { messages: [{ role: "user", text: summary, toolUses: [] }, ...tail] };
}
