// What the app needs from the world. Two implementations: register.tsx builds one from
// the engine's `$` (the only place `$` is spelled), e2e/node-host.ts one from Node, so
// the engine-less end-to-end suite runs this same app code.

import type { ExperimentState } from "../upstream/experiment-core.ts";
import type { LogRowDetails, RunRowDetails } from "../upstream/tool-render.ts";

export type NoticeLevel = "info" | "warning" | "error";

export type Cancel = { cancel: () => void };

export type ProcessResult = { exitCode: number; stdout: string; stderr: string };

export type SpawnChunk = { stream: "stdout" | "stderr"; text: string };

export type SpawnEnd = { code: number | null; signal: string | null };

/** A running child: iterate its output; `result` settles once it is read to the end. */
export interface Spawned extends AsyncIterable<SpawnChunk> {
  readonly result: Promise<SpawnEnd>;
}

export type FileKind = "file" | "directory" | "other";

/** The mode, the experiment and the run, as the band, the pane and the tool rows draw them. */
export interface RunningView {
  startedAt: number;
  command: string;
  /** The run_experiment call's tool_use_id: the engine's `isRunning` stays false for our rows (E2). */
  toolUseId?: string;
}

export interface RunTailView {
  toolUseId: string;
  elapsed: string;
  /** The last lines of the output so far (upstream's partial update, cut to what a row shows). */
  tail: string;
}

export type ToolDetails =
  | { tool: "init_experiment" }
  | { tool: "run_experiment"; details: RunRowDetails }
  | { tool: "log_experiment"; details: LogRowDetails };

/** The loop's bookkeeping, kept by the host across hot reloads. */
export interface LoopState {
  sessionId: string;
  mode: boolean;
  busy: boolean;
  turnId: string | null;
  pendingUserMessage: boolean;
  pendingResumeMessage: string | null;
  experimentsThisSession: number;
  autoResumeTurns: number;
  lastRunChecks: { pass: boolean; output: string; duration: number } | null;
  lastRunDuration: number | null;
  /** The names the tools are served under, once registered this session. */
  toolNames: Record<"init_experiment" | "run_experiment" | "log_experiment", string> | null;
  /** The pending resume waits for a reply to the model's question (I9). */
  questionWait: QuestionWait | null;
  /** The pending resume waits for a usage limit to reset (I13). */
  limitWait: LimitWait | null;
}

/** A resume held back for the person's reply: until when (ms since the epoch), and for how long. */
export interface QuestionWait {
  until: number;
  minutes: number;
}

/** A resume held back until a usage limit resets: until when (ms since the epoch). */
export interface LimitWait {
  until: number;
}

/** One usage-limit window, as Claude Code reports it. */
export interface RateLimit {
  kind: string;
  /** 0 to 100 (past 100 on an exceeded spend limit). */
  percentUsed: number;
  /** When the window resets, in ms since the epoch; null when not reported. */
  resetsAt: number | null;
}

/**
 * The running loop as kept in the store under the session id (I12), so that a process
 * that dies mid-loop carries on when the session starts again: a resume waiting to be
 * sent, or a loop turn in flight.
 */
export interface SavedResume {
  /** What to send: the pending resume's text, or the restart text for a turn in flight. */
  message: string;
  /** When it is due, in ms since the epoch (for a turn in flight: when it was sent). */
  dueAt: number;
  /** The last time the loop was seen alive: saved, or one of our tools called. */
  activeAt: number;
  inFlight: boolean;
  questionWait: QuestionWait | null;
  limitWait: LimitWait | null;
  autoResumeTurns: number;
}

export interface View {
  mode: boolean;
  experiment: ExperimentState;
  running: RunningView | null;
  runTail: RunTailView | null;
  loop: LoopState;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface Host {
  /** The plugin's own folder, absolute. */
  readonly pluginRoot: string;

  // -- session ---------------------------------------------------------------
  sessionCwd(): Promise<string>;
  sessionId(): Promise<string>;
  /** Whether a terminal draws this session (the fullscreen dashboard's precondition). */
  hasTerminal(): Promise<boolean>;
  tmpDir(): Promise<string>;
  /** The Claude Code process id, for the dashboard helper's parent watch. */
  parentPid(): Promise<string | undefined>;
  /** How full the context window is, 0-100, or null when unknown. */
  contextPercent(): Promise<number | null>;
  /** The usage-limit windows; empty off a subscription or before the first reading. */
  rateLimits(): Promise<RateLimit[]>;
  /**
   * Compacts the conversation between turns as the person's `/compact` does, which
   * raises our session.compact hook; resolves once it is done or was refused.
   */
  compact(): Promise<void>;

  // -- files -----------------------------------------------------------------
  /** The file's text, or null when it is missing (any size). */
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  appendText(path: string, text: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  kind(path: string): Promise<FileKind | null>;
  realPath(path: string): Promise<string | null>;
  isExecutable(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;

  // -- processes -------------------------------------------------------------
  /** Runs to completion; rejects when it cannot start or runs past timeoutMs. */
  run(argv: readonly string[], init: { cwd: string; stdin?: string; timeoutMs?: number }): Promise<ProcessResult>;
  /** Streams a child; leaving the loop, or `signal` aborting, kills it. */
  spawn(argv: readonly string[], init: { cwd: string; env?: Record<string, string>; signal?: AbortSignal }): Spawned;

  // -- time ------------------------------------------------------------------
  after(ms: number, fn: () => void): Cancel;
  every(ms: number, fn: () => void): Cancel;

  // -- the person ------------------------------------------------------------
  notify(text: string, level: NoticeLevel): void;
  /** One line in the transcript, which stays (a toast fades); the model doesn't read it. */
  log(text: string): void;
  /** Pins one line under the prompt until replaced; null removes it. */
  setStatus(text: string | null): void;
  /** Whether anyone can be asked: false where nothing draws the session (`-p`, the SDK). */
  canAsk(): Promise<boolean>;
  /**
   * Asks the person to pick one of `options` (2-4) in Claude Code's own question dialog,
   * `header` its chip; the label picked, the text typed under its "Other", or null when
   * they dismissed it or it failed.
   */
  ask(question: string, options: readonly string[], header?: string): Promise<string | null>;
  /** Closes the fullscreen dashboard if it is open. */
  closeDashboard(): void;

  // -- the model -------------------------------------------------------------
  /** Queues a prompt that starts a turn of its own once the session is idle, read as the person's. */
  submit(text: string): void;
  abortTurn(turnId: string): Promise<void>;
  registerTool(spec: ToolSpec): Promise<string>;
  /** Drops the cached tool placements. */
  invalidate(event: "tool.describe"): void;

  // -- state -----------------------------------------------------------------
  publish(view: Partial<View>): void;
  setToolDetails(toolUseId: string, details: ToolDetails): void;
  loadLoop(): Promise<LoopState | undefined>;
  storeGet(key: string): Promise<unknown>;
  storeSet(key: string, value: unknown): Promise<void>;
  storeKeys(): Promise<string[]>;
  storeDelete(key: string): Promise<void>;

  // -- the browser dashboard -------------------------------------------------
  post(url: string, body: string): Promise<{ status: number }>;
  openUrl(url: string): Promise<void>;
}
