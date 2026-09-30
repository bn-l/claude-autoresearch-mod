// The app: pi-autoresearch@939ede8 index.ts's extension, as handlers the engine wiring
// (register.tsx) and the engine-less e2e suite (e2e/node-host.ts) call. Each handler is
// the counterpart of a pi event or registration; see the modules it calls into.

import type { Host } from "./host.ts";
import { createCtx, publish, type Ctx, type Options } from "./context.ts";
import { reconstructState, restoreAfterReload } from "./activation.ts";
import { onForeignPrompt, onTurnComplete, onTurnStart, cancelPendingResume } from "./resume.ts";
import { refreshAddendum, sectionWithAddendum } from "./system-prompt.ts";
import { runAutoresearchCommand, openFullscreenDashboard, turnAutoresearchOff, type CommandOutcome } from "./command.ts";
import { exportDashboard, stopDashboardServer } from "./export.ts";
import { compactionAnswer, type CompactAnswer, type CompactInput } from "./compaction.ts";
import { executeInit, type InitParams } from "./tools/init.ts";
import { executeRun, type RunParams } from "./tools/run.ts";
import { executeLog, type LogParams } from "./tools/log.ts";
import type { ToolAnswer } from "./tools/answer.ts";

export type { Ctx, Options } from "./context.ts";
export type { ToolAnswer } from "./tools/answer.ts";
export type { CommandOutcome } from "./command.ts";
export type { CompactAnswer, CompactInput, CompactMessage } from "./compaction.ts";

export type ToolName = "init_experiment" | "run_experiment" | "log_experiment";

/** Our tool's base name, from the name the model called it by (F1). */
export function toolNameOf(ctx: Ctx, served: string): ToolName | null {
  if (ctx.toolNames) {
    for (const [base, name] of Object.entries(ctx.toolNames)) if (name === served) return base as ToolName;
  }
  const match = /^mcp__[\w-]*autoresearch[\w-]*__(init|run|log)_experiment$/.exec(served);
  return match ? (`${match[1]}_experiment` as ToolName) : null;
}

/** tool.call's refusal while the mode is off (F2). */
export const MODE_OFF_DENY = "autoresearch mode is off — run /autoresearch <goal> to start";

export interface App {
  ctx: Ctx;
  /** session.start: a new session, or this one again after a hot reload. */
  sessionStart(): Promise<void>;
  /** After /clear or /resume: another session in the same process (pi session_start). */
  sessionSwitched(): Promise<void>;
  /** session.end (pi session_shutdown). */
  sessionEnd(): void;
  turnStart(turnId: string): void;
  /** `answer`: the turn's final visible text. */
  turnComplete(isAborted: boolean, answer?: string): void;
  /** A prompt submitted by anyone but this plugin. */
  foreignPrompt(): void;
  /** Every prompt: keep the system prompt addendum current. */
  promptSubmitted(): Promise<void>;
  sectionText(base: string | null): Promise<string | null>;
  isModeOn(): boolean;
  /** tool.call for one of ours; `deny` while the mode is off. */
  callTool(name: ToolName, input: Record<string, unknown>, toolUseId: string, signal?: AbortSignal): Promise<ToolAnswer | { deny: string }>;
  command(args: string): Promise<CommandOutcome>;
  dashboardCommand(): Promise<CommandOutcome>;
  exportCommand(): Promise<void>;
  offCommand(): Promise<void>;
  compact(e: CompactInput): Promise<CompactAnswer | null>;
}

export function createApp(host: Host, options: Options): App {
  const ctx = createCtx(host, options);

  return {
    ctx,

    async sessionStart() {
      ctx.sessionId = await host.sessionId();
      const loop = await host.loadLoop().catch(() => undefined);
      if (loop && loop.sessionId === ctx.sessionId) {
        await restoreAfterReload(ctx, loop);
      } else {
        await reconstructState(ctx);
      }
    },

    async sessionSwitched() {
      host.closeDashboard();
      ctx.sessionId = await host.sessionId();
      ctx.turn = { busy: false, turnId: null, pendingUserMessage: false };
      await reconstructState(ctx);
    },

    sessionEnd() {
      cancelPendingResume(ctx);
      stopDashboardServer(ctx);
      host.closeDashboard();
    },

    turnStart(turnId) {
      onTurnStart(ctx, turnId);
    },

    turnComplete(isAborted, answer) {
      onTurnComplete(ctx, isAborted, answer);
    },

    foreignPrompt() {
      onForeignPrompt(ctx);
    },

    async promptSubmitted() {
      await refreshAddendum(ctx);
    },

    sectionText(base) {
      return sectionWithAddendum(ctx, base);
    },

    isModeOn() {
      return ctx.runtime.autoresearchMode;
    },

    async callTool(name, input, toolUseId, signal) {
      if (!ctx.runtime.autoresearchMode) return { deny: MODE_OFF_DENY };
      let answer: ToolAnswer;
      if (name === "init_experiment") answer = await executeInit(ctx, input as unknown as InitParams);
      else if (name === "run_experiment") answer = await executeRun(ctx, input as unknown as RunParams, toolUseId, signal);
      else answer = await executeLog(ctx, input as unknown as LogParams);
      if (answer.details) host.setToolDetails(toolUseId, answer.details);
      publish(ctx, ["loop"]);
      return answer;
    },

    command(args) {
      return runAutoresearchCommand(ctx, args);
    },

    dashboardCommand() {
      return openFullscreenDashboard(ctx);
    },

    exportCommand() {
      return exportDashboard(ctx);
    },

    offCommand() {
      return turnAutoresearchOff(ctx);
    },

    compact(e) {
      return compactionAnswer(ctx, e);
    },
  };
}
