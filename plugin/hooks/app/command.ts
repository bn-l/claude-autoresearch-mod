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
import { cancelPendingResume, saveLoopInFlight } from "./resume.ts";
import { offerUnstash, rememberStash, remindStash } from "./stash.ts";
import { exportDashboard, stopDashboardServer } from "./export.ts";
import { fireHook } from "./iteration-hooks.ts";
import {
  UNCOMMITTED_CHOICES,
  UNCOMMITTED_HEADER,
  UNCOMMITTED_START,
  UNCOMMITTED_STASH,
  stashChanges,
  uncommittedChanges,
  uncommittedQuestion,
  uncommittedWarning,
} from "./uncommitted.ts";

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
  // I19: the loop has stopped; changes stashed before it are offered back.
  await offerUnstash(ctx);
}

async function skillKickoff(ctx: Ctx, trimmedArgs: string): Promise<string> {
  const baseDir = `${ctx.host.pluginRoot}/skills/autoresearch-create`;
  const filePath = `${baseDir}/SKILL.md`;
  const command = skillKickoffCommand(trimmedArgs);
  const skillMd = await ctx.host.readText(filePath);
  if (skillMd === null) return command;
  return expandSkillCommand(command, { name: "autoresearch-create", filePath, baseDir, skillMd });
}

/** `/autoresearch`'s arguments, as the prompt box offers them. */
const ARGUMENTS: readonly (readonly [string, string])[] = [
  ["off", "Turn autoresearch mode off"],
  ["clear", "Delete the session log and turn the mode off"],
  ["web", "Open the live dashboard in your browser"],
  ["export", "Open the live dashboard in your browser (as web)"],
  ["dashboard", "Open the fullscreen dashboard"],
];

/**
 * The prompt box's rows for the word being typed (`token`) after `before`: the arguments
 * it starts, once `before` is `/autoresearch `; none for anything else.
 */
export function argumentSuggestions(before: string, token: string): { text: string; description: string }[] {
  if (!/^\s*\/autoresearch\s+$/.test(before)) return [];
  const typed = token.toLowerCase();
  return ARGUMENTS.filter(([name]) => name.startsWith(typed) && name !== typed).map(([text, description]) => ({ text, description }));
}

export const CLEAR_DELETE = "Delete it";
export const CLEAR_KEEP = "Keep it";
export const CLEAR_KEPT = "Nothing deleted; autoresearch mode is unchanged";
export const NOT_STARTED = "Not started; the uncommitted changes are as they were";
export const CLEAR_HEADER = "Clear log";

/**
 * I16: deleting the log can't be undone, so `clear` asks first where someone can answer.
 * Where no one can (`-p`, the SDK) the command itself is the decision, as upstream.
 */
async function confirmClear(ctx: Ctx, workDir: string, logPaths: string[]): Promise<boolean> {
  const host = ctx.host;
  const existing: string[] = [];
  for (const logPath of logPaths) if (await host.exists(logPath)) existing.push(path.relative(workDir, logPath) || path.basename(logPath));
  if (existing.length === 0 || !(await host.canAsk())) return true;
  const runs = ctx.runtime.state.results.length;
  const what = `${existing.join(" and ")}${runs > 0 ? ` (${runs} run${runs === 1 ? "" : "s"})` : ""}`;
  const answer = await host.ask(`This can't be undone. Delete ${what} and turn autoresearch mode off?`, [CLEAR_DELETE, CLEAR_KEEP], CLEAR_HEADER);
  return answer === CLEAR_DELETE;
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

  // With a goal held back by the uncommitted-changes warning, a bare /autoresearch starts (I10).
  if (!trimmedArgs && ctx.pendingStart === null) {
    host.notify(autoresearchHelp(), "info");
    return {};
  }

  if (command === "off") {
    ctx.pendingStart = null;
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
    ctx.pendingStart = null;
    const workDir = await resolveWorkDir(host, await host.sessionCwd());
    const jsonlPaths = sessionFileCandidates(workDir, "log");
    if (!(await confirmClear(ctx, workDir, Object.values(jsonlPaths)))) {
      host.notify(CLEAR_KEPT, "info");
      return {};
    }
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
    await offerUnstash(ctx);
    return {};
  }

  if (runtime.autoresearchMode) {
    host.notify(NOTICES.alreadyActive, "info");
    return {};
  }

  // I19: changes an earlier loop stashed are still there; say so before starting another.
  await remindStash(ctx);
  const workDir = await resolveWorkDir(host, await host.sessionCwd());
  // Not in upstream (I10): over uncommitted changes, say what they are and what may happen
  // to them, and ask what to do: stash them and start, start anyway, or don't start. Where
  // no one can be asked (`-p`, the SDK), list them and start only when run again.
  if (ctx.pendingStart === null) {
    const changes = await uncommittedChanges(host, workDir);
    if (changes?.length) {
      if (!(await host.canAsk())) {
        ctx.pendingStart = trimmedArgs;
        host.notify(uncommittedWarning(changes, "command"), "warning");
        return {};
      }
      const choice = await host.ask(uncommittedQuestion(changes), UNCOMMITTED_CHOICES, UNCOMMITTED_HEADER);
      if (choice === UNCOMMITTED_STASH) {
        const stashed = await stashChanges(host, workDir);
        if ("error" in stashed) {
          host.notify(`Couldn't stash the uncommitted changes, so the loop didn't start: ${stashed.error}`, "error");
          return {};
        }
        // I19: offered back when the loop stops.
        await rememberStash(ctx, workDir, { ...stashed, changes: changes.length, stashedAt: Date.now() });
        host.notify(
          `Stashed ${changes.length} uncommitted change${changes.length === 1 ? "" : "s"}; you'll be asked about ${changes.length === 1 ? "it" : "them"} when the loop stops`,
          "info",
        );
      } else if (choice !== UNCOMMITTED_START) {
        host.notify(NOT_STARTED, "info");
        return {};
      }
    }
  }
  const goal = trimmedArgs || ctx.pendingStart || "";
  ctx.pendingStart = null;
  await recordAutoresearchActivation(ctx, workDir, true);
  await setAutoresearchMode(ctx, true);
  runtime.autoResumeTurns = 0;
  publish(ctx, ["loop"]);
  const rulesLoaded = await hasAutoresearchRules(ctx);
  // No .auto/prompt.md yet — load the create skill so the agent follows the
  // setup guidelines. `/skill:<name>` is expanded to the full SKILL.md, and trailing
  // args are appended as the session goal. Hook output is not prepended to it.
  const kickoff = rulesLoaded
    ? rulesKickoff(goal)
    : await skillKickoff(ctx, goal);

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
  saveLoopInFlight(ctx);
  return {};
}
