// ported from pi-autoresearch@939ede8 index.ts:1582-1669 (init_experiment's execute).

import {
  buildSessionSnapshot,
  initResultText,
  jsonlWriteFailedText,
  readMaxExperiments,
  validateWorkDir,
  workDirErrorText,
} from "../../upstream/experiment-core.ts";
import { publish, readConfig, resolveWorkDir, sessionFilesOf, type Ctx } from "../context.ts";
import { readLastRun, recordAutoresearchActivation, setAutoresearchMode, updateWidget } from "../activation.ts";
import { fireHook } from "../iteration-hooks.ts";
import { broadcastDashboardUpdate } from "../export.ts";
import type { ToolAnswer } from "./answer.ts";

export interface InitParams {
  name: string;
  metric_name: string;
  metric_unit?: string;
  direction?: string;
}

export async function executeInit(ctx: Ctx, params: InitParams): Promise<ToolAnswer> {
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

  const isReinit = state.results.length > 0;

  state.name = params.name;
  state.metricName = params.metric_name;
  state.metricUnit = params.metric_unit ?? "";
  if (params.direction === "lower" || params.direction === "higher") {
    state.bestDirection = params.direction;
  }
  // Start a new segment — keep history for dashboard, but reset baseline tracking.
  // Old results remain accessible (filtered by segment in rendering).
  if (isReinit) {
    state.currentSegment++;
  }
  state.bestMetric = null;
  state.secondaryMetrics = [];
  state.confidence = null;

  // Read max experiments from config file (config always in ctx.cwd)
  state.maxExperiments = readMaxExperiments(await readConfig(host, cwd));

  // Write config header to jsonl (append for re-init, create for first)
  try {
    const files = await sessionFilesOf(host, workDir);
    const jsonlPath = files.path("log");
    const config = JSON.stringify({
      type: "config",
      name: state.name,
      metricName: state.metricName,
      metricUnit: state.metricUnit,
      bestDirection: state.bestDirection,
    });
    if (await host.exists(jsonlPath)) {
      await host.appendText(jsonlPath, config + "\n");
    } else {
      await host.writeText(jsonlPath, config + "\n");
    }
    broadcastDashboardUpdate(ctx, workDir);
  } catch (e) {
    return { result: jsonlWriteFailedText(e instanceof Error ? e.message : String(e)) };
  }

  const wasInactive = !runtime.autoresearchMode;
  await recordAutoresearchActivation(ctx, workDir, true);
  await setAutoresearchMode(ctx, true);
  updateWidget(ctx);

  const context: string[] = [];
  if (wasInactive) {
    const steer = await fireHook(host, {
      event: "before",
      cwd: workDir,
      next_run: state.results.length + 1,
      last_run: await readLastRun(ctx, workDir),
      session: buildSessionSnapshot(state),
    });
    if (steer) context.push(steer);
    ctx.lastBeforeSteer = steer;
  }

  publish(ctx, ["experiment"]);
  return {
    result: initResultText(state, isReinit, workDir, cwd),
    context,
    details: { tool: "init_experiment" },
  };
}
