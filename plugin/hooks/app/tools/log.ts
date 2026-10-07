// ported from pi-autoresearch@939ede8 index.ts:2221-2500 (log_experiment's execute).
// git runs through host.run, which in the mod is $.process.run: repo hooks off (F11).
// Hook output is returned as the result's `context` (F3), after then before. On the
// limit, pi's ctx.abort() is a turn abort a moment later, once this result is recorded.

import {
  GIT_TEXT,
  REVERT_SCRIPT,
  REVISIT_DISCARDS_TEXT,
  buildSessionSnapshot,
  checksFailedKeepText,
  computeConfidence,
  currentResults,
  findBaselineMetric,
  inferSecondaryUnit,
  jsonlWriteFailedText,
  keepCommitMessage,
  limitReachedText,
  logSummaryText,
  missingMetricsText,
  newMetricsText,
  validateWorkDir,
  workDirErrorText,
  type ASI,
  type ExperimentResult,
} from "../../upstream/experiment-core.ts";
import { logRowDetails } from "../../upstream/tool-render.ts";
import { resolveWorkDir, sessionFilesOf, type Ctx } from "../context.ts";
import { recordAutoresearchActivation, setAutoresearchMode, updateWidget } from "../activation.ts";
import { fireHook } from "../iteration-hooks.ts";
import { broadcastDashboardUpdate } from "../export.ts";
import type { ToolAnswer } from "./answer.ts";

export interface LogParams {
  commit: string;
  metric: number;
  status: ExperimentResult["status"];
  description: string;
  metrics?: Record<string, number>;
  force?: boolean;
  asi?: Record<string, unknown>;
}

/** How long after the limit's result the turn is ended (the result is recorded first). */
const LIMIT_ABORT_DELAY_MS = 250;

export async function executeLog(ctx: Ctx, params: LogParams): Promise<ToolAnswer> {
  const host = ctx.host;
  const runtime = ctx.runtime;
  const state = runtime.state;
  const cwd = await host.sessionCwd();

  // Validate working directory exists
  const workDir = await resolveWorkDir(host, cwd);
  const workDirError = validateWorkDir(cwd, workDir, await host.kind(workDir));
  if (workDirError) {
    return { result: workDirErrorText(workDirError) };
  }
  const secondaryMetrics = params.metrics ?? {};

  // Gate: prevent "keep" when last run's checks failed
  if (params.status === "keep" && runtime.lastRunChecks && !runtime.lastRunChecks.pass) {
    return { result: checksFailedKeepText(runtime.lastRunChecks.output) };
  }

  // Validate secondary metrics consistency (after first experiment establishes them)
  if (state.secondaryMetrics.length > 0) {
    const knownNames = new Set(state.secondaryMetrics.map((m) => m.name));
    const providedNames = new Set(Object.keys(secondaryMetrics));

    // Check for missing metrics
    const missing = [...knownNames].filter((n) => !providedNames.has(n));
    if (missing.length > 0) {
      return { result: missingMetricsText(missing, knownNames, providedNames) };
    }

    // Check for new metrics not yet tracked
    const newMetrics = [...providedNames].filter((n) => !knownNames.has(n));
    if (newMetrics.length > 0 && !params.force) {
      return { result: newMetricsText(newMetrics, knownNames) };
    }
  }

  // ASI: agent-supplied free-form diagnostics
  const mergedASI = (params.asi && Object.keys(params.asi).length > 0)
    ? params.asi as ASI
    : undefined;

  const experiment: ExperimentResult = {
    commit: params.commit.slice(0, 7),
    metric: params.metric,
    metrics: secondaryMetrics,
    status: params.status,
    description: params.description,
    timestamp: Date.now(),
    segment: state.currentSegment,
    confidence: null,
    asi: mergedASI,
  };

  state.results.push(experiment);
  runtime.experimentsThisSession++;

  // Register any new secondary metric names
  for (const name of Object.keys(secondaryMetrics)) {
    if (!state.secondaryMetrics.find((m) => m.name === name)) {
      state.secondaryMetrics.push({ name, unit: inferSecondaryUnit(name) });
    }
  }

  // Baseline = first run in current segment
  state.bestMetric = findBaselineMetric(state.results, state.currentSegment);

  // Compute confidence score (best improvement as multiple of noise floor)
  state.confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection);
  experiment.confidence = state.confidence;

  // Build response text
  const segmentCount = currentResults(state.results, state.currentSegment).length;
  let text = logSummaryText(state, experiment, params, secondaryMetrics, mergedASI);

  // Auto-commit only on keep — discards/crashes get reverted anyway
  if (params.status === "keep") {
    try {
      const commitMsg = keepCommitMessage(params.description, params.status, state.metricName, params.metric, secondaryMetrics);

      const execOpts = { cwd: workDir, timeoutMs: 10000 };
      const addResult = await host.run(["git", "add", "-A"], execOpts);
      if (addResult.exitCode !== 0) {
        const addErr = (addResult.stdout + addResult.stderr).trim();
        throw new Error(GIT_TEXT.addFailed(addResult.exitCode, addErr));
      }

      const diffResult = await host.run(["git", "diff", "--cached", "--quiet"], execOpts);
      if (diffResult.exitCode === 0) {
        text += GIT_TEXT.nothingToCommit;
      } else {
        const gitResult = await host.run(["git", "commit", "-m", commitMsg], execOpts);
        const gitOutput = (gitResult.stdout + gitResult.stderr).trim();
        if (gitResult.exitCode === 0) {
          const firstLine = gitOutput.split("\n")[0] || "";
          text += GIT_TEXT.committed(firstLine);

          try {
            const shaResult = await host.run(["git", "rev-parse", "--short=7", "HEAD"], { cwd: workDir, timeoutMs: 5000 });
            const newSha = (shaResult.stdout || "").trim();
            if (newSha && newSha.length >= 7) {
              experiment.commit = newSha;
            }
          } catch {
            // Keep the original commit hash if rev-parse fails
          }
        } else {
          text += GIT_TEXT.commitFailed(gitResult.exitCode, gitOutput);
        }
      }
    } catch (e) {
      text += GIT_TEXT.commitError(e instanceof Error ? e.message : String(e));
    }
  }

  const jsonlEntry: Record<string, unknown> = {
    run: state.results.length,
    ...experiment,
  };
  if (!mergedASI) delete jsonlEntry.asi;
  const jsonlLine = JSON.stringify(jsonlEntry);

  try {
    const jsonlPath = (await sessionFilesOf(host, workDir)).path("log");
    await host.appendText(jsonlPath, jsonlLine + "\n");
    broadcastDashboardUpdate(ctx, workDir);
  } catch (e) {
    text += `\n${jsonlWriteFailedText(e instanceof Error ? e.message : String(e))}`;
  }

  if (params.status !== "keep") {
    try {
      await host.run(["bash", "-c", REVERT_SCRIPT], { cwd: workDir, timeoutMs: 10000 });
      text += GIT_TEXT.reverted(params.status);
    } catch (e) {
      text += GIT_TEXT.revertFailed(e instanceof Error ? e.message : String(e));
    }
  }

  const context: string[] = [];
  ctx.lastBeforeSteer = null;
  const afterSteer = await fireHook(host, {
    event: "after",
    cwd: workDir,
    run_entry: jsonlEntry,
    session: buildSessionSnapshot(state),
  });
  if (afterSteer) context.push(afterSteer);

  const wallClockSeconds = runtime.lastRunDuration;
  runtime.runningExperiment = null;
  runtime.lastRunChecks = null;
  runtime.lastRunDuration = null;

  const limitReached = state.maxExperiments !== null && segmentCount >= state.maxExperiments;
  if (limitReached) {
    text += limitReachedText(state.maxExperiments);
    await recordAutoresearchActivation(ctx, workDir, false);
    await setAutoresearchMode(ctx, false);
    const turnId = ctx.turn.turnId;
    if (turnId) {
      host.after(LIMIT_ABORT_DELAY_MS, () => {
        if (ctx.turn.turnId === turnId) void host.abortTurn(turnId).catch(() => undefined);
      });
    }
  } else if (runtime.autoresearchMode) {
    text += REVISIT_DISCARDS_TEXT;
    const beforeSteer = await fireHook(host, {
      event: "before",
      cwd: workDir,
      next_run: state.results.length + 1,
      last_run: jsonlEntry,
      session: buildSessionSnapshot(state),
    });
    if (beforeSteer) context.push(beforeSteer);
    ctx.lastBeforeSteer = beforeSteer;
  }

  updateWidget(ctx);

  return {
    result: text,
    context,
    details: { tool: "log_experiment", details: logRowDetails(experiment, state, wallClockSeconds) },
  };
}
