// ported from pi-autoresearch@939ede8 index.ts:2587-2607 (openFullscreenDashboard's
// preconditions), 2996-3016 (turnAutoresearchOff) and 3018-3123 (/autoresearch).
//
// - pi's notify is host.notify (a toast, or a log line for the multi-line help: F7).
// - The kickoff is submitted a tick later, outside the command's dispatch, where
//   $.prompt.submit is allowed; Claude Code queues it until the session is idle (pi's
//   sendWhenReady followUp). With no prompt.md, pi expands `/skill:autoresearch-create`
//   into the skill block before the model reads it; expandSkillCommand does the same.
// - The pane itself is opened by register.tsx, from inside the command's hook, where
//   an open counts as the person's own and is placed at any width.

import { posix as path } from "../upstream/vendor/path.js";
import { sessionFileCandidates } from "../upstream/paths-core.ts";
import {
  NOTICES,
  autoresearchHelp,
  buildSessionSnapshot,
  createExperimentState,
  expandSkillCommand,
  rulesKickoff,
  skillKickoffCommand,
} from "../upstream/experiment-core.ts";
import { publish, resolveWorkDir, type Ctx } from "./context.ts";
import {
  hasAutoresearchRules,
  readLastRun,
  recordAutoresearchActivation,
  setAutoresearchMode,
  updateWidget,
} from "./activation.ts";
import { cancelPendingResume } from "./resume.ts";
import { snapshotWorkTree } from "./snapshot.ts";
import { exportDashboard, stopDashboardServer } from "./export.ts";
import { fireHook } from "./iteration-hooks.ts";

export interface CommandOutcome {
  /** Open the fullscreen dashboard pane (its preconditions held). */
  openDashboard?: boolean;
}

const clearSessionUi = (ctx: Ctx): void => {
  ctx.host.closeDashboard();
  updateWidget(ctx);
};

export async function openFullscreenDashboard(ctx: Ctx): Promise<CommandOutcome> {
  if (!(await ctx.host.hasTerminal())) {
    ctx.host.notify(NOTICES.tuiOnly, "info");
    return {};
  }

  const runtime = ctx.runtime;
  const state = runtime.state;
  if (!runtime.autoresearchMode) {
    ctx.host.notify(NOTICES.notActive, "info");
    return {};
  }
  if (state.results.length === 0) {
    ctx.host.notify(NOTICES.noExperiments, "info");
    return {};
  }
  return { openDashboard: true };
}

export async function turnAutoresearchOff(ctx: Ctx): Promise<void> {
  const runtime = ctx.runtime;
  const wasRunning = ctx.turn.busy;
  const turnId = ctx.turn.turnId;
  const workDir = await resolveWorkDir(ctx.host, await ctx.host.sessionCwd());

  await recordAutoresearchActivation(ctx, workDir, false);
  await setAutoresearchMode(ctx, false);
  runtime.autoResumeTurns = 0;
  runtime.experimentsThisSession = 0;
  runtime.lastRunChecks = null;
  runtime.lastRunDuration = null;
  runtime.runningExperiment = null;
  cancelPendingResume(ctx);
  stopDashboardServer(ctx);
  clearSessionUi(ctx);
  if (wasRunning && turnId) await ctx.host.abortTurn(turnId).catch(() => undefined);
  ctx.host.notify(NOTICES.off(wasRunning), "info");
}

async function skillKickoff(ctx: Ctx, trimmedArgs: string): Promise<string> {
  const baseDir = `${ctx.host.pluginRoot}/skills/autoresearch-create`;
  const filePath = `${baseDir}/SKILL.md`;
  const command = skillKickoffCommand(trimmedArgs);
  const skillMd = await ctx.host.readText(filePath);
  if (skillMd === null) return command;
  return expandSkillCommand(command, { name: "autoresearch-create", filePath, baseDir, skillMd });
}

// Without `expandPromptTemplates` a `/skill:<name>` kickoff reaches the model as literal text.
const sendWhenReady = (ctx: Ctx, message: string): void => {
  ctx.host.after(0, () => ctx.host.submit(message));
};

export async function runAutoresearchCommand(ctx: Ctx, args: string): Promise<CommandOutcome> {
  const host = ctx.host;
  const runtime = ctx.runtime;
  const trimmedArgs = (args ?? "").trim();
  const command = trimmedArgs.toLowerCase();

  if (!trimmedArgs) {
    host.notify(autoresearchHelp(), "info");
    return {};
  }

  if (command === "off") {
    await turnAutoresearchOff(ctx);
    return {};
  }

  // `web` is this port's name for it (D13); `export` is upstream's.
  if (command === "export" || command === "web") {
    await exportDashboard(ctx);
    return {};
  }

  if (command === "dashboard") {
    return openFullscreenDashboard(ctx);
  }

  if (command === "clear") {
    const workDir = await resolveWorkDir(host, await host.sessionCwd());
    const jsonlPaths = sessionFileCandidates(workDir, "log");
    await recordAutoresearchActivation(ctx, workDir, false);
    await setAutoresearchMode(ctx, false);
    runtime.autoResumeTurns = 0;
    runtime.experimentsThisSession = 0;
    runtime.lastRunChecks = null;
    runtime.lastRunDuration = null;
    runtime.runningExperiment = null;
    cancelPendingResume(ctx);
    runtime.state = createExperimentState();
    stopDashboardServer(ctx);
    updateWidget(ctx);

    const deletedPaths: string[] = [];
    for (const jsonlPath of Object.values(jsonlPaths)) {
      if (!(await host.exists(jsonlPath))) continue;
      try {
        await host.remove(jsonlPath);
        deletedPaths.push(path.relative(workDir, jsonlPath) || path.basename(jsonlPath));
      } catch (error) {
        host.notify(
          NOTICES.deleteFailed(
            path.relative(workDir, jsonlPath) || path.basename(jsonlPath),
            error instanceof Error ? error.message : String(error),
          ),
          "error",
        );
        return {};
      }
    }

    if (deletedPaths.length > 0) {
      host.notify(NOTICES.cleared(deletedPaths), "info");
    } else {
      host.notify(NOTICES.noLogCleared, "info");
    }
    return {};
  }

  if (runtime.autoresearchMode) {
    host.notify(NOTICES.alreadyActive, "info");
    return {};
  }

  const workDir = await resolveWorkDir(host, await host.sessionCwd());
  // Not in upstream (I10): the first iteration starts from the tree as it is now.
  await snapshotWorkTree(ctx, workDir);
  await recordAutoresearchActivation(ctx, workDir, true);
  await setAutoresearchMode(ctx, true);
  runtime.autoResumeTurns = 0;
  publish(ctx, ["loop"]);
  const rulesLoaded = await hasAutoresearchRules(ctx);
  // No .auto/prompt.md yet — load the create skill so the agent follows the
  // setup guidelines. `/skill:<name>` is expanded to the full SKILL.md, and trailing
  // args are appended as the session goal. Hook output is not prepended to it.
  const kickoff = rulesLoaded
    ? rulesKickoff(trimmedArgs)
    : await skillKickoff(ctx, trimmedArgs);

  host.notify(NOTICES.activated(rulesLoaded), "info");

  const state = runtime.state;
  const activationSteer = await fireHook(host, {
    event: "before",
    cwd: workDir,
    next_run: state.results.length + 1,
    last_run: await readLastRun(ctx, workDir),
    session: buildSessionSnapshot(state),
  });

  // Prepend hook output only when prompt.md exists; otherwise the message
  // must stay the create skill's own kickoff.
  const message = activationSteer && rulesLoaded ? `${activationSteer}\n\n${kickoff}` : kickoff;
  sendWhenReady(ctx, message);
  return {};
}
