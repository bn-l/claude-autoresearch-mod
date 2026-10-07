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
// - I12: the pending resume is also kept in the store, so a restarted process carries on.
// - I13: a turn that dies on an exhausted usage limit resumes once the limit resets.

import {
  IN_FLIGHT_RESUME_PREFIX,
  SETTLED_WINDOW_MS,
  autoResumeLimitNotice,
  autoResumeStopReasonFor,
  composeCompactionResumeMessage,
  composeResumeMessage,
} from "../upstream/experiment-core.ts";
import { clockTime, publish, type AutoresearchRuntime, type Ctx } from "./context.ts";
import type { LimitWait, QuestionWait, SavedResume } from "./host.ts";
import { noteStash, offerUnstash } from "./stash.ts";

// index.ts:1117-1118
const isAgentSettled = (ctx: Ctx): boolean =>
  !ctx.turn.busy && !ctx.turn.pendingUserMessage;

const hasPendingResume = (runtime: AutoresearchRuntime): boolean =>
  runtime.pendingResumeMessage !== null;

/** What a pending resume waits for besides upstream's settle window. */
export interface ResumeWaits {
  questionWait?: QuestionWait | null;
  limitWait?: LimitWait | null;
}

export const pausePendingResume = (ctx: Ctx): void => {
  // Whatever holds the resume now (a turn, a prompt, a new schedule) ends a wait.
  ctx.questionWait = null;
  ctx.limitWait = null;
  if (!ctx.pendingResumeTimer) return;
  ctx.pendingResumeTimer.cancel();
  ctx.pendingResumeTimer = null;
};

export const cancelPendingResume = (ctx: Ctx): void => {
  pausePendingResume(ctx);
  ctx.runtime.pendingResumeMessage = null;
  forgetSavedResume(ctx);
};

// ---------------------------------------------------------------------------
// I12: the running loop in the store, for a restart of the process
// ---------------------------------------------------------------------------

const SAVED_RESUME_PREFIX = "resume:";
/** A saved loop not seen alive for longer than this when the session starts again is dropped. */
export const SAVED_RESUME_GRACE_MS = 60 * 60_000;
/** Saved loops of other sessions are dropped after this long. */
const SAVED_RESUME_EXPIRY_MS = 24 * 60 * 60_000;

/** The restart text for a loop turn the process died in. */
export const RESTART_RESUME_LEAD =
  "Claude Code restarted while the loop was running. If the last iteration was not logged, finish it first (log or revert it).";

const savedResumeKey = (sessionId: string): string => `${SAVED_RESUME_PREFIX}${sessionId}`;

/** Store writes for the saved loop, one after another, so a forget never lands after a later save. */
function persist(ctx: Ctx, sessionId: string, saved: SavedResume | null): void {
  if (!sessionId) return;
  const key = savedResumeKey(sessionId);
  ctx.savedResume = sessionId === ctx.sessionId ? saved : ctx.savedResume;
  ctx.storeWrites = ctx.storeWrites
    .then(() => (saved ? ctx.host.storeSet(key, saved) : ctx.host.storeDelete(key)))
    .catch(() => undefined);
}

function saveResume(ctx: Ctx, dueAt: number): void {
  const message = ctx.runtime.pendingResumeMessage;
  if (message === null) return;
  persist(ctx, ctx.sessionId, {
    message,
    dueAt,
    activeAt: Date.now(),
    inFlight: false,
    questionWait: ctx.questionWait,
    limitWait: ctx.limitWait,
    autoResumeTurns: ctx.runtime.autoResumeTurns,
  });
}

/** A loop turn was just sent (a resume or the kickoff): if the process dies in it, carry on. */
export function saveLoopInFlight(ctx: Ctx): void {
  const now = Date.now();
  // The loop runs again: the next stop or pause says where stashed changes are (I19).
  ctx.stashNoted = false;
  persist(ctx, ctx.sessionId, {
    message: `${RESTART_RESUME_LEAD}\n\n${composeResumeMessage()}`,
    dueAt: now,
    activeAt: now,
    inFlight: true,
    questionWait: null,
    limitWait: null,
    autoResumeTurns: ctx.runtime.autoResumeTurns,
  });
}

/** One of our tools ran: the loop turn in flight is alive. */
export function touchSavedResume(ctx: Ctx): void {
  if (ctx.savedResume?.inFlight) persist(ctx, ctx.sessionId, { ...ctx.savedResume, activeAt: Date.now() });
}

/** Drops the saved loop of `sessionId` (default: this session's). */
export function forgetSavedResume(ctx: Ctx, sessionId = ctx.sessionId): void {
  if (sessionId === ctx.sessionId && ctx.savedResume === null) return;
  persist(ctx, sessionId, null);
}

function isSavedResume(value: unknown): value is SavedResume {
  const saved = value as SavedResume | null;
  return typeof saved?.message === "string" && typeof saved.dueAt === "number" && typeof saved.activeAt === "number";
}

/** After a hot reload: what the store holds for this session, so it is kept and forgotten as before. */
export async function loadSavedResume(ctx: Ctx): Promise<void> {
  const saved = await ctx.host.storeGet(savedResumeKey(ctx.sessionId)).catch(() => undefined);
  ctx.savedResume = isSavedResume(saved) ? saved : null;
}

/**
 * A new process for a session whose loop the store holds: the process died with a resume
 * pending or a loop turn in flight (a crash, a restart of a background session). A
 * person's own exit, Esc and `/autoresearch off` forget it, so this only picks up a loop
 * that was cut off. Saved loops of other sessions that have long expired are dropped.
 */
export async function restoreSavedResume(ctx: Ctx): Promise<boolean> {
  const host = ctx.host;
  const now = Date.now();
  let saved: unknown;
  try {
    for (const key of await host.storeKeys()) {
      if (!key.startsWith(SAVED_RESUME_PREFIX) || key === savedResumeKey(ctx.sessionId)) continue;
      const other = await host.storeGet(key);
      if (!isSavedResume(other) || Math.max(other.activeAt, other.dueAt) < now - SAVED_RESUME_EXPIRY_MS) {
        await host.storeDelete(key);
      }
    }
    saved = await host.storeGet(savedResumeKey(ctx.sessionId));
  } catch {
    return false;
  }
  if (!isSavedResume(saved)) return false;
  ctx.savedResume = saved;
  const lastAlive = Math.max(saved.activeAt, saved.dueAt);
  if (!ctx.runtime.autoresearchMode || lastAlive < now - SAVED_RESUME_GRACE_MS || hasPendingResume(ctx.runtime)) {
    forgetSavedResume(ctx);
    return false;
  }
  ctx.runtime.autoResumeTurns = saved.autoResumeTurns;
  const questionWait = saved.questionWait && saved.questionWait.until > now ? saved.questionWait : null;
  const limitWait = saved.limitWait && saved.limitWait.until > now ? saved.limitWait : null;
  // A question's wait that ran out while the process was down: nobody replied.
  const message = saved.questionWait && !questionWait ? noReplyLead(saved.questionWait, saved.message) : saved.message;
  schedulePendingResume(ctx, message, { questionWait, limitWait });
  // Toasts already carry the plugin's name.
  host.notify("Claude Code restarted while the loop was running; carrying on.", "info");
  return true;
}

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

  pausePendingResume(ctx);
  runtime.pendingResumeMessage = null;
  markAutoResumeSent(runtime);
  saveLoopInFlight(ctx);
  publish(ctx, ["loop"]);
  ctx.host.submit(unanswered ? noReplyLead(unanswered, message) : message);
};

const delayFor = (waits: ResumeWaits): number => {
  const until = waits.questionWait?.until ?? waits.limitWait?.until;
  return until === undefined ? SETTLED_WINDOW_MS : Math.max(0, until - Date.now());
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

/**
 * Schedules the resume: upstream's settle window, or until a question's wait (I9) or a
 * usage limit's (I13) ends. Kept in the store too, for a restart of the process (I12).
 */
export const schedulePendingResume = (ctx: Ctx, message: string, waits: ResumeWaits = {}): void => {
  pausePendingResume(ctx);
  ctx.runtime.pendingResumeMessage = message;
  ctx.questionWait = waits.questionWait ?? null;
  ctx.limitWait = waits.limitWait ?? null;
  ctx.paused = false;
  const delayMs = delayFor(waits);
  ctx.pendingResumeTimer = ctx.host.after(delayMs, () => {
    ctx.pendingResumeTimer = null;
    void sendPendingResumeIfReady(ctx);
  });
  saveResume(ctx, Date.now() + delayMs);
  publish(ctx, ["loop"]);
};

export const reschedulePendingResume = (ctx: Ctx, waits: ResumeWaits = {}): void => {
  if (!hasPendingResume(ctx.runtime)) return;
  schedulePendingResume(ctx, ctx.runtime.pendingResumeMessage!, waits);
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
  // I19: the loop has stopped; changes stashed before it are offered back.
  void offerUnstash(ctx);
};

// index.ts:1487-1504
export const ensurePendingResume = (
  ctx: Ctx,
  gate: (runtime: AutoresearchRuntime) => boolean,
  composeMessage: () => string = composeResumeMessage,
  waits: ResumeWaits = {},
): void => {
  const runtime = ctx.runtime;
  if (hasPendingResume(runtime)) {
    reschedulePendingResume(ctx, waits);
    return;
  }
  if (!gate(runtime)) return;
  const stopReason = autoResumeStopReasonFor(runtime);
  if (stopReason !== null) {
    notifyAutoResumeLimitReached(ctx, stopReason);
    return;
  }
  schedulePendingResume(ctx, composeMessage(), waits);
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

// ---------------------------------------------------------------------------
// I13: a turn that dies on a usage limit
// ---------------------------------------------------------------------------

/** The first line of the resume sent once the usage limit that stopped the loop has reset. */
export const LIMIT_RESUME_LEAD =
  "The usage limit that stopped the last turn has reset. If the last iteration was not logged, finish it first (log or revert it).";
/** How long after a limit's reset time the resume goes out. */
export const LIMIT_RESET_MARGIN_MS = 60_000;

/** The latest reset time among the exhausted usage limits; null when none is exhausted. */
async function exhaustedLimitResetsAt(ctx: Ctx): Promise<number | null> {
  const limits = await ctx.host.rateLimits().catch(() => []);
  const now = Date.now();
  let latest: number | null = null;
  for (const limit of limits) {
    if (limit.percentUsed < 100 || limit.resetsAt === null || limit.resetsAt <= now) continue;
    latest = Math.max(latest ?? 0, limit.resetsAt);
  }
  return latest;
}

/** A turn that ended on an API error: on an exhausted usage limit, resume once it resets. */
async function afterFailedTurn(ctx: Ctx, answer: string): Promise<void> {
  const resetsAt = ctx.runtime.autoresearchMode ? await exhaustedLimitResetsAt(ctx) : null;
  // A turn started while the limits were read: it decides.
  if (ctx.turn.busy) return;
  if (resetsAt === null) {
    afterAnsweredTurn(ctx, answer);
    return;
  }
  const stopReason = autoResumeStopReasonFor(ctx.runtime);
  if (stopReason !== null) {
    cancelPendingResume(ctx);
    notifyAutoResumeLimitReached(ctx, stopReason);
    publish(ctx, ["loop"]);
    return;
  }
  const until = resetsAt + LIMIT_RESET_MARGIN_MS;
  schedulePendingResume(ctx, `${LIMIT_RESUME_LEAD}\n\n${composeResumeMessage()}`, { limitWait: { until } });
  ctx.host.notify(`Usage limit reached. The loop carries on at ${clockTime(until)}.`, "warning");
}

/** A turn that ended with an answer: upstream's resume, held back for a question (I9). */
function afterAnsweredTurn(ctx: Ctx, answer: string): void {
  const questionWait = questionWaitFor(ctx, answer);
  ensurePendingResume(ctx, shouldAutoResumeAfterTurn, composeResumeMessage, { questionWait });
  if (!hasPendingResume(ctx.runtime)) {
    // The loop stops here: a restart must not bring it back (I12).
    forgetSavedResume(ctx);
    // I19: say where changes stashed before the loop are (once; nothing is asked).
    if (ctx.runtime.autoresearchMode) void noteStash(ctx, "not-continuing");
  }
  if (questionWait && ctx.questionWait === questionWait) {
    ctx.host.notify(`The model asked you something. The loop carries on in ${questionWait.minutes} min unless you reply.`, "info");
  }
  publish(ctx, ["running", "loop"]);
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
  ctx.paused = false;
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

/**
 * turn.complete of the main loop (pi agent_end, index.ts:1515-1520); `answer` is its final
 * text, `failed` says an API error ended it.
 */
export function onTurnComplete(ctx: Ctx, isAborted: boolean, answer = "", failed = false): void {
  ctx.turn.busy = false;
  ctx.turn.turnId = null;
  ctx.runtime.runningExperiment = null;
  // I19: the iteration cap stopped the loop in this turn; the offer to unstash comes now.
  const offerDue = ctx.unstashOfferDue;
  ctx.unstashOfferDue = false;
  if (offerDue) void offerUnstash(ctx);
  if (isAborted) {
    // I1: Esc pauses the loop. The mode and the dashboard stay; the next turn that
    // logs an experiment starts the resume chain again.
    cancelPendingResume(ctx);
    ctx.paused = ctx.runtime.autoresearchMode;
    if (ctx.paused) void noteStash(ctx, "paused");
    publish(ctx, ["running", "loop"]);
    return;
  }
  if (failed) {
    publish(ctx, ["running", "loop"]);
    void afterFailedTurn(ctx, answer);
    return;
  }
  afterAnsweredTurn(ctx, answer);
}
