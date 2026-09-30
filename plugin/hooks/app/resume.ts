// ported from pi-autoresearch@939ede8 index.ts:1117-1205 and 1481-1520: the auto-resume
// machinery, same names, same order. pi's ctx.isIdle / hasPendingMessages are the turn
// tracking below (turn.start, turn.complete, prompt.submit); pi's sendUserMessage is
// host.submit; setTimeout is host.after. Two departures, both in DEVIATIONS.md:
// - I1: a turn the person interrupted (Esc) cancels the pending resume instead of
//   scheduling one; the loop waits for a message that leads to a logged experiment.
// - I2: right before a resume is sent, a context at or past `compactAtPercent` is
//   compacted first, and the compaction's own resume carries on.
// - I9: a turn that ends by asking the person something holds its resume back for
//   `questionWaitMinutes`; a reply comes first, or the model is told there was none.

import {
  IN_FLIGHT_RESUME_PREFIX,
  SETTLED_WINDOW_MS,
  autoResumeLimitNotice,
  autoResumeStopReasonFor,
  composeCompactionResumeMessage,
  composeResumeMessage,
} from "../upstream/experiment-core.ts";
import { publish, type AutoresearchRuntime, type Ctx } from "./context.ts";
import type { QuestionWait } from "./host.ts";

// index.ts:1117-1118
const isAgentSettled = (ctx: Ctx): boolean =>
  !ctx.turn.busy && !ctx.turn.pendingUserMessage;

const hasPendingResume = (runtime: AutoresearchRuntime): boolean =>
  runtime.pendingResumeMessage !== null;

export const pausePendingResume = (ctx: Ctx): void => {
  // Whatever holds the resume now (a turn, a prompt, a new schedule) ends a question's wait.
  ctx.questionWait = null;
  if (!ctx.pendingResumeTimer) return;
  ctx.pendingResumeTimer.cancel();
  ctx.pendingResumeTimer = null;
};

export const cancelPendingResume = (ctx: Ctx): void => {
  pausePendingResume(ctx);
  ctx.runtime.pendingResumeMessage = null;
};

const markAutoResumeSent = (runtime: AutoresearchRuntime): void => {
  runtime.autoResumeTurns++;
};

const sendPendingResumeIfReady = async (ctx: Ctx): Promise<void> => {
  const runtime = ctx.runtime;
  const message = runtime.pendingResumeMessage;
  // I9: this resume waited out a question the person didn't answer.
  const unanswered = ctx.questionWait;

  if (!message) return;
  if (!runtime.autoresearchMode) {
    cancelPendingResume(ctx);
    return;
  }
  if (!isAgentSettled(ctx)) return;
  const stopReason = autoResumeStopReasonFor(runtime);
  if (stopReason !== null) {
    cancelPendingResume(ctx);
    notifyAutoResumeLimitReached(ctx, stopReason);
    publish(ctx, ["loop"]);
    return;
  }

  // I2: compact at the iteration boundary; our session.compact hook, which answers the
  // compaction, schedules the compaction resume.
  if (await shouldCompactFirst(ctx)) {
    cancelPendingResume(ctx);
    publish(ctx, ["loop"]);
    await ctx.host.compact().catch(() => undefined);
    if (hasPendingResume(runtime)) {
      if (unanswered) runtime.pendingResumeMessage = noReplyLead(unanswered, runtime.pendingResumeMessage!);
      return;
    }
    // Our hook did not answer (the compaction was refused, or went to Claude Code's own
    // summary): resume as if it had not been asked for.
    runtime.pendingResumeMessage = message;
  }

  cancelPendingResume(ctx);
  markAutoResumeSent(runtime);
  publish(ctx, ["loop"]);
  ctx.host.submit(unanswered ? noReplyLead(unanswered, message) : message);
};

async function shouldCompactFirst(ctx: Ctx): Promise<boolean> {
  const threshold = ctx.options.compactAtPercent;
  if (!(threshold > 0)) return false;
  // Right after a compaction the usage still reads as before it: compacting again on
  // that figure would loop. The next turn's response brings the real one.
  if (ctx.compactedSinceTurn) return false;
  const percent = await ctx.host.contextPercent().catch(() => null);
  return percent !== null && percent >= threshold;
}

/** Schedules the resume: upstream's settle window, or until a question's wait ends (I9). */
export const schedulePendingResume = (ctx: Ctx, message: string, questionWait: QuestionWait | null = null): void => {
  pausePendingResume(ctx);
  ctx.runtime.pendingResumeMessage = message;
  ctx.questionWait = questionWait;
  const delayMs = questionWait ? Math.max(0, questionWait.until - Date.now()) : SETTLED_WINDOW_MS;
  ctx.pendingResumeTimer = ctx.host.after(delayMs, () => {
    ctx.pendingResumeTimer = null;
    void sendPendingResumeIfReady(ctx);
  });
  publish(ctx, ["loop"]);
};

export const reschedulePendingResume = (ctx: Ctx, questionWait: QuestionWait | null = null): void => {
  if (!hasPendingResume(ctx.runtime)) return;
  schedulePendingResume(ctx, ctx.runtime.pendingResumeMessage!, questionWait);
};

const hasRunExperimentsThisSession = (runtime: AutoresearchRuntime): boolean =>
  runtime.experimentsThisSession > 0;

// Why the experiment gate: a chat-only turn would otherwise loop forever,
// because every agent_end would re-prompt the agent, which would chat again.
export const shouldAutoResumeAfterTurn = (runtime: AutoresearchRuntime): boolean =>
  runtime.autoresearchMode && hasRunExperimentsThisSession(runtime);

export const shouldAutoResumeAfterCompact = (runtime: AutoresearchRuntime): boolean =>
  runtime.autoresearchMode;

const notifyAutoResumeLimitReached = (ctx: Ctx, reason?: string | null): void => {
  ctx.host.notify(autoResumeLimitNotice(reason), "info");
};

// index.ts:1487-1504
export const ensurePendingResume = (
  ctx: Ctx,
  gate: (runtime: AutoresearchRuntime) => boolean,
  composeMessage: () => string = composeResumeMessage,
  questionWait: QuestionWait | null = null,
): void => {
  const runtime = ctx.runtime;
  if (hasPendingResume(runtime)) {
    reschedulePendingResume(ctx, questionWait);
    return;
  }
  if (!gate(runtime)) return;
  const stopReason = autoResumeStopReasonFor(runtime);
  if (stopReason !== null) {
    notifyAutoResumeLimitReached(ctx, stopReason);
    return;
  }
  schedulePendingResume(ctx, composeMessage(), questionWait);
};

// ---------------------------------------------------------------------------
// I9: a turn that asks the person something
// ---------------------------------------------------------------------------

/** Words that hand a decision to the person, as the model phrases it when it wants one. */
const ASKS_PERSON =
  /\b(?:your (?:call|decision|input|go-ahead|approval|preference|answer)|needs? your|let me know|would you (?:like|prefer)|do you (?:want|prefer)|should I|shall I|want me to|up to you|please (?:confirm|advise|choose|decide)|waiting (?:for|on) you)\b/i;

/**
 * Whether a turn's final text asks the person something: a question mark ending one of
 * its last three lines, or words that hand a decision over. Only the end of the text is read,
 * where a question to the person sits; a heuristic, so it errs on the side of waiting.
 */
export function asksThePerson(answer: string): boolean {
  const tail = answer.trimEnd().slice(-1200);
  if (!tail) return false;
  const lastLines = tail.split("\n").map((line) => line.replace(/[\s*_`)\]]+$/, "")).filter(Boolean).slice(-3);
  if (lastLines.some((line) => line.endsWith("?"))) return true;
  return ASKS_PERSON.test(tail);
}

/** The first line of a resume sent after nobody answered the model's question (I9). */
export const noReplyLead = (wait: QuestionWait, message: string): string =>
  `No reply from the person within ${wait.minutes} minute${wait.minutes === 1 ? "" : "s"}: make the call yourself, say what you chose, and carry on.\n\n${message}`;

/** The wait for a turn that asked something, or null when there is none to make. */
function questionWaitFor(ctx: Ctx, answer: string): QuestionWait | null {
  const minutes = ctx.options.questionWaitMinutes;
  if (!(minutes > 0) || !asksThePerson(answer)) return null;
  return { minutes, until: Date.now() + minutes * 60_000 };
}

/**
 * pi session_compact (index.ts:1511-1513): resume with the compaction message once the
 * session is idle. I3: when the kept tail holds unlogged work, the message says to finish
 * it first. A compaction in the middle of a turn schedules nothing; the turn carries on.
 */
export function afterCompaction(ctx: Ctx, hasInFlightWork: boolean): void {
  ctx.compactedSinceTurn = true;
  if (ctx.turn.busy) return;
  ensurePendingResume(ctx, shouldAutoResumeAfterCompact, () => {
    const message = composeCompactionResumeMessage();
    if (hasInFlightWork) return `${IN_FLIGHT_RESUME_PREFIX} ${message}`;
    // At a boundary the last log result went with the compaction, and with it the before
    // hook's steer for this iteration: lead with it, as the kickoff does.
    return ctx.lastBeforeSteer ? `${ctx.lastBeforeSteer}\n\n${message}` : message;
  });
}

// ---------------------------------------------------------------------------
// Turn events (pi agent_start / agent_end; the idle and pending-message flags)
// ---------------------------------------------------------------------------

/** turn.start of the main loop (pi agent_start, index.ts:1481-1485). */
export function onTurnStart(ctx: Ctx, turnId: string): void {
  ctx.turn.busy = true;
  ctx.turn.turnId = turnId;
  ctx.compactedSinceTurn = false;
  ctx.lastBeforeSteer = null;
  ctx.turn.pendingUserMessage = false;
  ctx.runtime.experimentsThisSession = 0;
  pausePendingResume(ctx);
  publish(ctx, ["loop"]);
}

/**
 * A prompt the person (or a peer, a channel, the SDK) submitted: while a turn runs it
 * waits behind it (pi hasPendingMessages); while idle it starts a turn of its own, so a
 * resume timer must not fire in between.
 */
export function onForeignPrompt(ctx: Ctx): void {
  ctx.turn.pendingUserMessage = true;
  pausePendingResume(ctx);
  publish(ctx, ["loop"]);
}

/** turn.complete of the main loop (pi agent_end, index.ts:1515-1520); `answer` is its final text. */
export function onTurnComplete(ctx: Ctx, isAborted: boolean, answer = ""): void {
  ctx.turn.busy = false;
  ctx.turn.turnId = null;
  ctx.runtime.runningExperiment = null;
  if (isAborted) {
    // I1: Esc pauses the loop. The mode and the dashboard stay; the next turn that
    // logs an experiment starts the resume chain again.
    cancelPendingResume(ctx);
    publish(ctx, ["running", "loop"]);
    return;
  }
  ensurePendingResume(ctx, shouldAutoResumeAfterTurn, composeResumeMessage, questionWaitFor(ctx, answer));
  if (ctx.questionWait) {
    const { minutes } = ctx.questionWait;
    ctx.host.notify(`The model asked you something. The loop carries on in ${minutes} min unless you reply.`, "info");
  }
  publish(ctx, ["running", "loop"]);
}
