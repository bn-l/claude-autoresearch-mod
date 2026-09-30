// The app's shared state and the lookups every part of it makes: upstream's
// AutoresearchRuntime (index.ts:178-190) plus the loop bookkeeping this port adds, and
// the session-file paths, config and working directory, each read through the Host where
// upstream read the disk directly.

import { posix as path } from "../upstream/vendor/path.js";
import { layoutProbePaths, sessionFilePath, hookScriptPath, type Exists, type SessionFileKind } from "../upstream/paths-core.ts";
import {
  createExperimentState,
  parseConfig,
  resolveWorkDir as resolveWorkDirFromConfig,
  type AutoresearchConfig,
  type ExperimentState,
} from "../upstream/experiment-core.ts";
import type { HookStage } from "../upstream/hooks-core.ts";
import type { Cancel, Host, LoopState, QuestionWait, View } from "./host.ts";
import type { TreeSnapshot } from "./snapshot.ts";

export interface Options {
  /** userConfig `autoApproveTools`: allow our tools without a prompt while the mode is on. */
  autoApproveTools: boolean;
  /** userConfig `compactAtPercent`: compact between iterations at this context fill (0: off). */
  compactAtPercent: number;
  /** userConfig `questionWaitMinutes`: how long a turn that asked the person waits for a reply (0: not at all). */
  questionWaitMinutes: number;
}

/** upstream AutoresearchRuntime (index.ts:178-190), timer handle apart. */
export interface AutoresearchRuntime {
  autoresearchMode: boolean;
  experimentsThisSession: number;
  autoResumeTurns: number;
  lastRunChecks: { pass: boolean; output: string; duration: number } | null;
  lastRunDuration: number | null;
  /** upstream's, plus the call's tool_use_id: the row that draws the live output. */
  runningExperiment: { startedAt: number; command: string; toolUseId?: string } | null;
  state: ExperimentState;
  /** Resume message to send when the pending timer fires. */
  pendingResumeMessage: string | null;
}

/** What upstream read from pi's context (isIdle, hasPendingMessages, the running turn). */
export interface TurnTracking {
  busy: boolean;
  turnId: string | null;
  pendingUserMessage: boolean;
}

export interface Ctx {
  host: Host;
  options: Options;
  sessionId: string;
  runtime: AutoresearchRuntime;
  turn: TurnTracking;
  toolNames: LoopState["toolNames"];
  /** Pending auto-resume timer (upstream `pendingResumeTimer`); module-local, lost on reload. */
  pendingResumeTimer: Cancel | null;
  /** The addendum text the prompt section last carried, to invalidate only on change. */
  addendum: string | null;
  /**
   * A compaction happened since the last turn started. The context figures only move
   * once a model response reports them, so until then they still read as before it.
   */
  compactedSinceTurn: boolean;
  /**
   * The before hook's output for the next iteration, as the last log_experiment (or
   * init_experiment) handed it to the model; cleared when a turn starts. A compaction
   * at the boundary drops that result, so the compaction resume carries it instead.
   */
  lastBeforeSteer: string | null;
  /**
   * The pending resume waits for the person's reply to a question the model asked (I9):
   * until when, and how long the wait was. Cleared when a turn or a prompt comes first.
   */
  questionWait: QuestionWait | null;
  /**
   * The working tree as the current iteration started (I10): what log_experiment commits
   * or reverts is what changed since. Null outside a git repository.
   */
  snapshot: TreeSnapshot | null;
}

export function createSessionRuntime(): AutoresearchRuntime {
  return {
    autoresearchMode: false,
    experimentsThisSession: 0,
    autoResumeTurns: 0,
    lastRunChecks: null,
    lastRunDuration: null,
    runningExperiment: null,
    state: createExperimentState(),
    pendingResumeMessage: null,
  };
}

export function createCtx(host: Host, options: Options): Ctx {
  return {
    host,
    options,
    sessionId: "",
    runtime: createSessionRuntime(),
    turn: { busy: false, turnId: null, pendingUserMessage: false },
    toolNames: null,
    pendingResumeTimer: null,
    addendum: null,
    compactedSinceTurn: false,
    lastBeforeSteer: null,
    questionWait: null,
    snapshot: null,
  };
}

/** The loop state as the host keeps it across reloads. */
export function loopStateOf(ctx: Ctx): LoopState {
  const { runtime, turn } = ctx;
  return {
    sessionId: ctx.sessionId,
    mode: runtime.autoresearchMode,
    busy: turn.busy,
    turnId: turn.turnId,
    pendingUserMessage: turn.pendingUserMessage,
    pendingResumeMessage: runtime.pendingResumeMessage,
    experimentsThisSession: runtime.experimentsThisSession,
    autoResumeTurns: runtime.autoResumeTurns,
    lastRunChecks: runtime.lastRunChecks,
    lastRunDuration: runtime.lastRunDuration,
    toolNames: ctx.toolNames,
    questionWait: ctx.questionWait,
  };
}

/**
 * Claude Code refuses a `$.state` value over 4 MiB of JSON text; the drawn state stays
 * under this, with room to spare.
 */
export const DRAWN_STATE_MAX_CHARS = 3.5 * 1024 * 1024;
/** A run's description as drawn: a row shows `width - 45` columns of it at most (D12). */
export const DRAWN_DESCRIPTION_CHARS = 200;
/** The cut when even that is over DRAWN_STATE_MAX_CHARS (tens of thousands of runs). */
export const DRAWN_DESCRIPTION_CHARS_TIGHT = 40;

function cutDescription(text: string, max: number): string {
  if (text.length <= max) return text;
  // never end on half of a surrogate pair
  return text.slice(0, /[\uD800-\uDBFF]/.test(text[max - 1]!) ? max - 1 : max);
}

/**
 * The experiment as the band and the pane draw it (D12): each run without `asi` and
 * with its description cut, which no drawing shows. The full state stays in memory and
 * in `.auto/log.jsonl`.
 */
export function drawnState(state: ExperimentState): ExperimentState {
  const cut = (max: number): ExperimentState => ({
    ...state,
    results: state.results.map(({ asi: _asi, ...result }) => ({
      ...result,
      description: cutDescription(result.description, max),
    })),
  });
  const drawn = cut(DRAWN_DESCRIPTION_CHARS);
  return JSON.stringify(drawn).length > DRAWN_STATE_MAX_CHARS ? cut(DRAWN_DESCRIPTION_CHARS_TIGHT) : drawn;
}

/** Pushes what the band, pane and rows draw, and the loop state, to the host. */
export function publish(ctx: Ctx, parts: (keyof View)[] = ["mode", "experiment", "running", "loop"]): void {
  const view: Partial<View> = {};
  for (const part of parts) {
    if (part === "mode") view.mode = ctx.runtime.autoresearchMode;
    if (part === "experiment") view.experiment = drawnState(ctx.runtime.state);
    if (part === "running") view.running = ctx.runtime.runningExperiment;
    if (part === "loop") view.loop = loopStateOf(ctx);
  }
  ctx.host.publish(view);
}

// ---------------------------------------------------------------------------
// Session files, config and working directory
// ---------------------------------------------------------------------------

/** paths.ts's existence checks for `dir`, answered in one pass. */
export async function layoutOf(host: Host, dir: string): Promise<Exists> {
  const probes = layoutProbePaths(dir);
  const found = await Promise.all(probes.map((probe) => host.exists(probe)));
  const present = new Set(probes.filter((_, index) => found[index]));
  return (filePath) => present.has(filePath);
}

export interface SessionFiles {
  dir: string;
  exists: Exists;
  path(kind: SessionFileKind): string;
  hook(stage: HookStage): string;
}

export async function sessionFilesOf(host: Host, dir: string): Promise<SessionFiles> {
  const exists = await layoutOf(host, dir);
  return {
    dir,
    exists,
    path: (kind) => sessionFilePath(dir, kind, exists),
    hook: (stage) => hookScriptPath(dir, stage, exists),
  };
}

/** upstream readConfig(cwd): the config file under the session cwd. */
export async function readConfig(host: Host, cwd: string): Promise<AutoresearchConfig> {
  const files = await sessionFilesOf(host, cwd);
  try {
    return parseConfig(await host.readText(files.path("config")));
  } catch {
    return {};
  }
}

/** upstream resolveWorkDir(ctx.cwd). */
export async function resolveWorkDir(host: Host, cwd: string): Promise<string> {
  return resolveWorkDirFromConfig(cwd, await readConfig(host, cwd));
}

/** upstream canonicalPath: the real path, else the path resolved. */
export async function canonicalPath(host: Host, existingPath: string): Promise<string> {
  return (await host.realPath(existingPath)) ?? path.resolve(existingPath);
}
