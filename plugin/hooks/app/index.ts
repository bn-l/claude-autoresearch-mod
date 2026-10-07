// The app: pi-autoresearch@939ede8 index.ts's extension, as handlers the engine wiring
// (register.tsx) and the engine-less e2e suite (e2e/node-host.ts) call. Each handler is
// the counterpart of a pi event or registration; see the modules it calls into.

import type { Host } from "./host.ts";
import { createCtx, publish, type Ctx, type Options } from "./context.ts";
import { reconstructState, restoreAfterReload } from "./activation.ts";
import {
  forgetSavedResume,
  onForeignPrompt,
  onTurnComplete,
  onTurnStart,
  pausePendingResume,
  restoreSavedResume,
  touchSavedResume,
} from "./resume.ts";
import { refuseSubagent, spawnDecision, type SpawnDecision, type SpawnFacts } from "./agents.ts";
import { remindStash } from "./stash.ts";
import { addendumSection, refreshAddendum } from "./system-prompt.ts";
import { runAutoresearchCommand, openFullscreenDashboard, turnAutoresearchOff, type CommandOutcome } from "./command.ts";
import { exportDashboard, stopDashboardServer } from "./export.ts";
import { compactionAnswer, type CompactAnswer, type CompactInput } from "./compaction.ts";
import { executeInit, type InitParams } from "./tools/init.ts";
import { executeRun, type RunParams } from "./tools/run.ts";
import { executeLog, type LogParams } from "./tools/log.ts";
import type { ToolAnswer } from "./tools/answer.ts";

export type { Ctx, Options } from "./context.ts";
export type { ToolAnswer } from "./tools/answer.ts";
export type { SpawnDecision, SpawnFacts } from "./agents.ts";
export type { CommandOutcome } from "./command.ts";
export { argumentSuggestions } from "./command.ts";
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
  /**
   * session.end (pi session_shutdown) for `reason` (`prompt_input_exit`, `logout`,
   * `other`); resolves once what must outlive the process is written.
   */
  sessionEnd(reason?: string): Promise<void>;
  turnStart(turnId: string): void;
  /** `answer`: the turn's final visible text; `failed`: an API error ended it. */
  turnComplete(isAborted: boolean, answer?: string, failed?: boolean): void;
  /** A prompt submitted by anyone but this plugin. */
  foreignPrompt(): void;
  /** Every prompt: keep the system prompt addendum current. */
  promptSubmitted(): Promise<void>;
  /** The system prompt section this mod adds (F13), or null while the mode is off. */
  promptSection(): Promise<string | null>;
  isModeOn(): boolean;
  /** agent.spawn while the loop may be running (I14). */
  spawnDecision(spawn: SpawnFacts): SpawnDecision;
  /**
   * tool.call for one of ours; `deny` while the mode is off, and in a subagent's loop
   * (`agentId` set, I14).
   */
  callTool(
    name: ToolName,
    input: Record<string, unknown>,
    toolUseId: string,
    signal?: AbortSignal,
    agentId?: string,
  ): Promise<ToolAnswer | { deny: string }>;
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
        // A new process: a loop it was running when it died carries on (I12); otherwise
        // changes an earlier loop stashed are still there, and the person is told (I19).
        await reconstructState(ctx);
        if (!(await restoreSavedResume(ctx))) await remindStash(ctx);
      }
    },

    async sessionSwitched() {
      host.closeDashboard();
      // The session left behind won't be resumed by this process.
      forgetSavedResume(ctx);
      ctx.sessionId = await host.sessionId();
      ctx.turn = { busy: false, turnId: null, pendingUserMessage: false };
      ctx.savedResume = null;
      ctx.stashReminded = false;
      await reconstructState(ctx);
      if (!(await restoreSavedResume(ctx))) await remindStash(ctx);
    },

    async sessionEnd(reason) {
      pausePendingResume(ctx);
      stopDashboardServer(ctx);
      host.closeDashboard();
      // The person ended the session: the loop ends with it. Any other end (a crash, a
      // restart) leaves the saved loop for the next process (I12).
      if (reason === "prompt_input_exit" || reason === "logout") forgetSavedResume(ctx);
      await ctx.storeWrites;
    },

    turnStart(turnId) {
      onTurnStart(ctx, turnId);
    },

    turnComplete(isAborted, answer, failed) {
      onTurnComplete(ctx, isAborted, answer, failed);
    },

    foreignPrompt() {
      onForeignPrompt(ctx);
    },

    async promptSubmitted() {
      await refreshAddendum(ctx);
    },

    promptSection() {
      return addendumSection(ctx);
    },

    isModeOn() {
      return ctx.runtime.autoresearchMode;
    },

    spawnDecision(spawn) {
      return spawnDecision(ctx, spawn);
    },

    async callTool(name, input, toolUseId, signal, agentId) {
      if (!ctx.runtime.autoresearchMode) return { deny: MODE_OFF_DENY };
      if (agentId !== undefined) return refuseSubagent(ctx, name, agentId);
      touchSavedResume(ctx);
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
