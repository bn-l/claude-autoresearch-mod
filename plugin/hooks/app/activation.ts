// ported from pi-autoresearch@939ede8 index.ts:1092-1115 (setAutoresearchMode,
// recordAutoresearchActivation), 545-559 (recordedActivationDecision), 1232-1248
// (hasAutoresearchRules, readJsonlLines, readLastRun) and 1309-1467 (reconstructState,
// updateWidget).
//
// - Mode gating (F2): pi flips its active tool set. Here the tools are registered the
//   first time the mode turns on in a session; after that they stay registered, deferred
//   behind ToolSearch while the mode is off (tool.describe) and refused (tool.call).
// - Activation decisions (F8): pi appends custom entries to the session branch. Here each
//   is a `$.store` value keyed by session id and canonical workDir; the latest wins.
// - updateWidget becomes publish: the band, pane and rows draw from `$.state`.
// - F14: upstream's fallback that rebuilds state from pre-JSONL session history is gone.

import {
  computeConfidence,
  findBaselineMetric,
  readMaxExperiments,
  shouldAutoActivateAutoresearch,
  createExperimentState,
  type ExperimentState,
} from "../upstream/experiment-core.ts";
import { isAutoresearchRunEntry, parseJsonlEntry, reconstructJsonlState } from "../upstream/jsonl.ts";
import { TOOL_SCHEMAS } from "../upstream/schemas.ts";
import { TOOLS } from "../upstream/experiment-core.ts";
import type { LoopState } from "./host.ts";
import { uncommittedChanges, uncommittedWarning } from "./uncommitted.ts";
import {
  canonicalPath,
  publish,
  readConfig,
  resolveWorkDir,
  sessionFilesOf,
  type Ctx,
} from "./context.ts";
import { cancelPendingResume, reschedulePendingResume } from "./resume.ts";
import { refreshAddendum } from "./system-prompt.ts";

const ACTIVATION_KEY_PREFIX = "activation:";
const ACTIVATION_KEYS_KEPT = 400;

/** Registers the three tools once per session; resolves the names they are served as. */
export async function registerTools(ctx: Ctx): Promise<void> {
  if (ctx.toolNames) return;
  const names: Partial<NonNullable<LoopState["toolNames"]>> = {};
  for (const tool of TOOLS) {
    names[tool.name] = await ctx.host.registerTool({
      name: tool.name,
      description: tool.description,
      inputSchema: TOOL_SCHEMAS[tool.name],
    });
  }
  ctx.toolNames = names as NonNullable<LoopState["toolNames"]>;
}

// The one place mode flips: gated tools follow the flag, never drifting from it.
export const setAutoresearchMode = async (ctx: Ctx, enabled: boolean): Promise<void> => {
  const changed = ctx.runtime.autoresearchMode !== enabled;
  ctx.runtime.autoresearchMode = enabled;
  if (enabled && !ctx.toolNames) {
    try {
      await registerTools(ctx);
    } catch (error) {
      ctx.host.notify(
        `Could not register the autoresearch tools: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }
  if (changed) ctx.host.invalidate("tool.describe");
  await refreshAddendum(ctx);
  publish(ctx, ["mode", "loop"]);
};

const activationKey = (sessionId: string, canonicalWorkDir: string): string =>
  `${ACTIVATION_KEY_PREFIX}${sessionId}:${canonicalWorkDir}`;

export const recordAutoresearchActivation = async (ctx: Ctx, workDir: string, active: boolean): Promise<void> => {
  const canonicalWorkDir = await canonicalPath(ctx.host, workDir);
  try {
    await ctx.host.storeSet(activationKey(ctx.sessionId, canonicalWorkDir), {
      version: 1,
      workDir: canonicalWorkDir,
      active,
    });
    await pruneActivationKeys(ctx);
  } catch {
    // A full store loses the decision; the default rule applies next time.
  }
};

async function pruneActivationKeys(ctx: Ctx): Promise<void> {
  const keys = (await ctx.host.storeKeys()).filter((key) => key.startsWith(ACTIVATION_KEY_PREFIX));
  for (const key of keys.slice(0, Math.max(0, keys.length - ACTIVATION_KEYS_KEPT))) {
    await ctx.host.storeDelete(key);
  }
}

export async function recordedActivationDecision(ctx: Ctx, workDir: string): Promise<boolean | null> {
  const canonicalWorkDir = await canonicalPath(ctx.host, workDir);
  const data = (await ctx.host.storeGet(activationKey(ctx.sessionId, canonicalWorkDir)).catch(() => undefined)) as
    | { workDir?: unknown; active?: unknown }
    | undefined;
  if (typeof data?.workDir !== "string") return null;
  return data.active === true;
}

export const hasAutoresearchRules = async (ctx: Ctx): Promise<boolean> => {
  const workDir = await resolveWorkDir(ctx.host, await ctx.host.sessionCwd());
  const files = await sessionFilesOf(ctx.host, workDir);
  return ctx.host.exists(files.path("prompt"));
};

const readJsonlLines = async (ctx: Ctx, workDir: string): Promise<string[]> => {
  const files = await sessionFilesOf(ctx.host, workDir);
  const content = await ctx.host.readText(files.path("log"));
  if (content === null) return [];
  return content.split("\n").filter(Boolean);
};

export const readLastRun = async (ctx: Ctx, workDir: string): Promise<Record<string, unknown> | null> => {
  const lines = await readJsonlLines(ctx, workDir);
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseJsonlEntry(lines[i]);
    if (isAutoresearchRunEntry(entry)) return entry;
  }
  return null;
};

/** The experiment state from the log (reconstructState's primary path). */
export async function loadExperimentState(
  ctx: Ctx,
  workDir: string,
): Promise<{ state: ExperimentState; hasPersistedLog: boolean }> {
  const state = createExperimentState();
  const files = await sessionFilesOf(ctx.host, workDir);
  const jsonlPath = files.path("log");
  const hasPersistedLog = files.exists(jsonlPath);
  try {
    if (hasPersistedLog) {
      const reconstructed = reconstructJsonlState((await ctx.host.readText(jsonlPath)) ?? "");
      state.name = reconstructed.name;
      state.metricName = reconstructed.metricName;
      state.metricUnit = reconstructed.metricUnit;
      state.bestDirection = reconstructed.bestDirection;
      state.currentSegment = reconstructed.currentSegment;
      state.results = reconstructed.results.map((result) => ({
        ...result,
        metrics: { ...result.metrics },
      }));
      state.secondaryMetrics = reconstructed.secondaryMetrics.map((metric) => ({ ...metric }));

      if (state.results.length > 0) {
        state.bestMetric = findBaselineMetric(state.results, state.currentSegment);
        state.confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection);
      }
    }
  } catch {
    // upstream fell through to session history here (F14: dropped)
  }
  return { state, hasPersistedLog };
}

// index.ts:1309-1397
export const reconstructState = async (ctx: Ctx): Promise<void> => {
  const runtime = ctx.runtime;
  cancelPendingResume(ctx);
  runtime.lastRunChecks = null;
  runtime.lastRunDuration = null;
  runtime.runningExperiment = null;
  runtime.experimentsThisSession = 0;
  runtime.autoResumeTurns = 0;
  runtime.state = createExperimentState();

  // Resolve effective working directory (config stays in ctx.cwd, files in workDir)
  const cwd = await ctx.host.sessionCwd();
  const workDir = await resolveWorkDir(ctx.host, cwd);

  const { state, hasPersistedLog } = await loadExperimentState(ctx, workDir);
  runtime.state = state;

  // Read max experiments from config file
  state.maxExperiments = readMaxExperiments(await readConfig(ctx.host, cwd));

  // Auto-enter autoresearch mode only when a persisted experiment log exists.
  // A recorded `/autoresearch on|off` in this session wins; otherwise same-cwd
  // sessions default on and redirected workingDir sessions default off, so
  // unrelated chats launched from a shared cwd never activate it.
  const recorded = await recordedActivationDecision(ctx, workDir);
  // Not in upstream (I11): a session that turned the mode on here comes back on, even
  // when the loop was stopped before it logged anything.
  const activate =
    (!hasPersistedLog && recorded === true) ||
    shouldAutoActivateAutoresearch(
      await canonicalPath(ctx.host, cwd),
      await canonicalPath(ctx.host, workDir),
      hasPersistedLog,
      recorded,
    );
  ctx.pendingStart = null;
  await setAutoresearchMode(ctx, activate);
  // Not in upstream (I10): say what is uncommitted and what may happen to it.
  if (activate) {
    const changes = await uncommittedChanges(ctx.host, workDir);
    if (changes?.length) ctx.host.notify(uncommittedWarning(changes, "session"), "warning");
  }

  updateWidget(ctx);
};

/**
 * A hot reload of the mod in the same session: the module's variables are new, the
 * host's state is not. Rebuild the experiment from the log as reconstructState does and
 * take the loop's bookkeeping (mode, counters, checks gate, pending resume) from `loop`.
 */
export async function restoreAfterReload(ctx: Ctx, loop: LoopState): Promise<void> {
  const runtime = ctx.runtime;
  const cwd = await ctx.host.sessionCwd();
  const workDir = await resolveWorkDir(ctx.host, cwd);
  const { state } = await loadExperimentState(ctx, workDir);
  runtime.state = state;
  state.maxExperiments = readMaxExperiments(await readConfig(ctx.host, cwd));

  runtime.experimentsThisSession = loop.experimentsThisSession;
  runtime.autoResumeTurns = loop.autoResumeTurns;
  runtime.lastRunChecks = loop.lastRunChecks;
  runtime.lastRunDuration = loop.lastRunDuration;
  runtime.pendingResumeMessage = loop.pendingResumeMessage;
  ctx.turn.busy = loop.busy;
  ctx.turn.turnId = loop.turnId;
  ctx.turn.pendingUserMessage = loop.pendingUserMessage;

  // A reload drops the plugin's registrations with its environment: register again.
  if (loop.toolNames) {
    ctx.toolNames = null;
    await registerTools(ctx).catch(() => undefined);
  }
  await setAutoresearchMode(ctx, loop.mode);
  if (runtime.pendingResumeMessage !== null && !ctx.turn.busy) reschedulePendingResume(ctx, loop.questionWait ?? null);
  updateWidget(ctx);
}

// index.ts:1399-1467: the widget reads the published state (ui/band.tsx draws it)
export const updateWidget = (ctx: Ctx): void => {
  publish(ctx, ["mode", "experiment", "running", "loop"]);
};
