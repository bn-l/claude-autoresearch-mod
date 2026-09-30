// The pure half of pi-autoresearch@939ede8 extensions/pi-autoresearch/index.ts: its types,
// maths, formatting, guards and every string the model or the person reads. Each block
// names the upstream lines it came from. Blocks marked "I/O lifted" take as arguments
// what upstream read from disk; blocks under "Result texts" are strings upstream built
// inline in the tools' execute bodies, extracted into functions with the same output.

import { posix as path } from "./vendor/path.js";
import { formatSize, type TruncationResult } from "./vendor/truncate.ts";
import { AUTO_DIR } from "./paths-core.ts";
import type { SessionSnapshot } from "./hooks-core.ts";

// ported from pi-autoresearch@939ede8 index.ts:57-61
// ---------------------------------------------------------------------------
// Experiment output limits (sent to LLM — keep small to save context)
// ---------------------------------------------------------------------------
export const EXPERIMENT_MAX_LINES = 10;
export const EXPERIMENT_MAX_BYTES = 4 * 1024; // 4KB

// ported from pi-autoresearch@939ede8 index.ts:63-112
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Actionable Side Information (ASI) — free-form diagnostics per experiment run.
 * The agent decides what to record. Any key/value pair is valid.
 */
export interface ASI {
  [key: string]: unknown;
}

export interface ExperimentResult {
  commit: string;
  metric: number;
  /** Additional tracked metrics: { name: value } */
  metrics: Record<string, number>;
  status: "keep" | "discard" | "crash" | "checks_failed";
  description: string;
  timestamp: number;
  /** Segment index — increments on each config header. Current segment = highest. */
  segment: number;
  /** Session-level confidence score at the time this result was logged. null if insufficient data. */
  confidence: number | null;
  /** Actionable Side Information — structured diagnostics for this run */
  asi?: ASI;
}

export interface MetricDef {
  name: string;
  unit: string;
}

export interface ExperimentState {
  results: ExperimentResult[];
  /** Baseline primary metric (from first experiment in current segment) */
  bestMetric: number | null;
  bestDirection: "lower" | "higher";
  metricName: string;
  metricUnit: string;
  /** Definitions for secondary metrics (order preserved) */
  secondaryMetrics: MetricDef[];
  name: string | null;
  /** Current segment index (incremented on each init_experiment) */
  currentSegment: number;
  /** Maximum number of experiments before auto-stopping. null = unlimited. */
  maxExperiments: number | null;
  /** Current session confidence score (best improvement / noise floor). null if insufficient data. */
  confidence: number | null;
}

// ported from pi-autoresearch@939ede8 index.ts:114-147
export const AUTORESUME_TURN_LIMIT = 200;
export const CONSECUTIVE_FAILURE_OVERRIDE_LIMIT = 20;

export type AutoResumeGuardState = Pick<ExperimentState, "results" | "currentSegment">;
export type AutoResumeGuardRuntime = {
  autoResumeTurns: number;
  state: AutoResumeGuardState;
};

/** Count trailing discard/crash results in the current segment. */
export function countConsecutiveDiscardOrCrashResults(state: AutoResumeGuardState): number {
  let count = 0;
  for (let i = state.results.length - 1; i >= 0; i--) {
    const result = state.results[i];
    if (result.segment !== state.currentSegment) break;
    if (result.status === "discard" || result.status === "crash") {
      count++;
      continue;
    }
    break;
  }
  return count;
}

export function autoResumeStopReasonFor(runtime: AutoResumeGuardRuntime): string | null {
  if (runtime.autoResumeTurns >= AUTORESUME_TURN_LIMIT) {
    return `Autoresearch auto-resume limit reached (${AUTORESUME_TURN_LIMIT} turns)`;
  }
  const failures = countConsecutiveDiscardOrCrashResults(runtime.state);
  if (failures > CONSECUTIVE_FAILURE_OVERRIDE_LIMIT) {
    return `Autoresearch auto-resume stopped — ${failures} consecutive discards/crashes`;
  }
  return null;
}

// ported from pi-autoresearch@939ede8 index.ts:149-176
export interface RunDetails {
  command: string;
  exitCode: number | null;
  durationSeconds: number;
  passed: boolean;
  crashed: boolean;
  timedOut: boolean;
  tailOutput: string;
  /** null = checks not run (no file or benchmark failed), true/false = ran */
  checksPass: boolean | null;
  checksTimedOut: boolean;
  checksOutput: string;
  checksDuration: number;
  /** Metrics parsed from METRIC lines in output. null if none found. */
  parsedMetrics: Record<string, number> | null;
  /** Primary metric value extracted from parsedMetrics (matching metricName). null if not found. */
  parsedPrimary: number | null;
  /** Name of the primary metric (for display) */
  metricName: string;
  metricUnit: string;

}

export interface LogDetails {
  experiment: ExperimentResult;
  state: ExperimentState;
  wallClockSeconds: number | null;
}

// ported from pi-autoresearch@939ede8 index.ts:273-333
/** Prefix for structured metric output lines: `METRIC name=value` */
export const METRIC_LINE_PREFIX = "METRIC";

/**
 * Parse structured METRIC lines from command output.
 * Format: METRIC name=value (one per line)
 * Example:
 *   METRIC total_µs=15200
 *   METRIC compile_µs=4200
 *
 * Names must be word chars, dots, or µ (rejects `=` and other specials).
 * Values must be finite numbers (rejects Infinity, NaN, hex, etc.).
 * Duplicate names: last occurrence wins (allows scripts to refine values).
 * Returns a Map preserving insertion order of first occurrence per key.
 */
/** Metric names that could cause prototype pollution if used as object keys */
export const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export function parseMetricLines(output: string): Map<string, number> {
  const metrics = new Map<string, number>();
  const regex = new RegExp(`^${METRIC_LINE_PREFIX}\\s+([\\w.µ]+)=(\\S+)\\s*$`, "gm");
  let match;
  while ((match = regex.exec(output)) !== null) {
    const name = match[1];
    if (DENIED_METRIC_NAMES.has(name)) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) {
      metrics.set(name, value);
    }
  }
  return metrics;
}

// Changed from upstream (I7): upstream grouped the sign with the digits, so -123 read
// "-,123", and rounded the fraction apart from the integer, so 1.999 read "1.00". The
// digits are grouped without the sign, and the number is rounded whole before it is split.

/** Format a number with comma-separated thousands: 15586 → "15,586" */
export function commas(n: number): string {
  const rounded = Math.round(n);
  const s = String(Math.abs(rounded));
  const parts: string[] = [];
  for (let i = s.length; i > 0; i -= 3) {
    parts.unshift(s.slice(Math.max(0, i - 3), i));
  }
  return (rounded < 0 ? "-" : "") + parts.join(",");
}

/** Format number with commas, preserving one decimal for fractional values */
export function fmtNum(n: number, decimals: number = 0): string {
  if (decimals > 0) {
    const fixed = Math.abs(n).toFixed(decimals); // "2.00"
    const dot = fixed.indexOf(".");
    if (dot === -1) return (n < 0 ? "-" : "") + fixed; // past 1e21 toFixed gives an exponent
    return (n < 0 ? "-" : "") + commas(Number(fixed.slice(0, dot))) + fixed.slice(dot);
  }
  return commas(n);
}

export function formatNum(value: number | null, unit: string): string {
  if (value === null) return "—";
  const u = unit || "";
  // Integers: no decimals
  if (value === Math.round(value)) return fmtNum(value) + u;
  // Fractional: 2 decimal places
  return fmtNum(value, 2) + u;
}

// ported from pi-autoresearch@939ede8 index.ts:347-354
/** Format elapsed milliseconds as "Xm XXs" or "XXs" */
export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

// ported from pi-autoresearch@939ede8 index.ts:369-462
/**
 * Check if a command's primary purpose is running the benchmark script.
 *
 * Strategy: strip common harmless prefixes (env vars, env/time/nice wrappers)
 * then check that the core command is the benchmark script invoked via a known
 * pattern. Rejects chaining tricks like "evil.py; measure.sh" because we require
 * the benchmark script to be the *first* real command.
 */
export function isAutoresearchShCommand(command: string): boolean {
  let cmd = command.trim();

  // Strip leading env variable assignments: FOO=bar BAZ="qux" ...
  cmd = cmd.replace(/^(?:\w+=\S*\s+)+/, "");

  // Strip known harmless command wrappers (env, time, nice, nohup) repeatedly
  // Allows flags and their numeric values: e.g. "nice -n 10 time env ..."
  let prev: string;
  do {
    prev = cmd;
    cmd = cmd.replace(/^(?:env|time|nice|nohup)(?:\s+-\S+(?:\s+\d+)?)*\s+/, "");
  } while (cmd !== prev);

  // Now the core command must be the benchmark script via a known invocation.
  // Current layout requires the `.auto/measure.sh` path; legacy `autoresearch.sh`
  // is still accepted for in-flight sessions. An optional path prefix allows
  //   ./.auto/measure.sh, /abs/path/.auto/measure.sh, bash [-flags] autoresearch.sh, etc.
  return /^(?:(?:bash|sh|source)\s+(?:-\w+\s+)*)?(?:\/|\.{1,2}\/|[\w.-]+\/)*(?:autoresearch\.sh|\.auto\/measure\.sh)(?:\s|$)/.test(cmd);
}

export function isBetter(
  current: number,
  best: number,
  direction: "lower" | "higher"
): boolean {
  return direction === "lower" ? current < best : current > best;
}

/** Compute the median of a numeric array (returns 0 for empty arrays) */
export function sortedMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Compute confidence score for the best improvement vs. session noise floor.
 *
 * Uses Median Absolute Deviation (MAD) of all metric values in the current
 * segment as a robust noise estimator. Returns `|best_delta| / MAD`, where
 * best_delta is the improvement of the best kept metric over baseline.
 *
 * Returns null when there are fewer than 3 data points (insufficient data)
 * or when MAD is 0 (all values identical — no measurable noise).
 */
export function computeConfidence(
  results: ExperimentResult[],
  segment: number,
  direction: "lower" | "higher"
): number | null {
  const cur = currentResults(results, segment).filter((r) => r.metric > 0);
  if (cur.length < 3) return null;

  const values = cur.map((r) => r.metric);
  const median = sortedMedian(values);
  const deviations = values.map((v) => Math.abs(v - median));
  const mad = sortedMedian(deviations);

  if (mad === 0) return null;

  const baseline = findBaselineMetric(results, segment);
  if (baseline === null) return null;

  // Find best kept metric in current segment
  let bestKept: number | null = null;
  for (const r of cur) {
    if (r.status === "keep" && r.metric > 0) {
      if (bestKept === null || isBetter(r.metric, bestKept, direction)) {
        bestKept = r.metric;
      }
    }
  }
  if (bestKept === null || bestKept === baseline) return null;

  const delta = Math.abs(bestKept - baseline);
  return delta / mad;
}

/** Get results in the current segment only */
export function currentResults(results: ExperimentResult[], segment: number): ExperimentResult[] {
  return results.filter((r) => r.segment === segment);
}

// ported from pi-autoresearch@939ede8 index.ts:464-499 (readConfig/resolveWorkDir: I/O lifted)
export interface AutoresearchConfig {
  maxIterations?: number;
  workingDir?: string;
}

/**
 * Read the config file (.auto/config.json, legacy autoresearch.config.json) from the given directory (always ctx.cwd)
 *
 * Lifted: `content` is the file's text, null when it is missing. A file holding JSON that
 * is not an object reads as `{}` (upstream threw on `null` a line later).
 */
export function parseConfig(content: string | null): AutoresearchConfig {
  try {
    if (content === null) return {};
    const parsed: unknown = JSON.parse(content);
    return parsed !== null && typeof parsed === "object" ? (parsed as AutoresearchConfig) : {};
  } catch {
    return {};
  }
}

/** Read maxExperiments from the config file (if it exists) */
export function readMaxExperiments(config: AutoresearchConfig): number | null {
  return (typeof config.maxIterations === "number" && config.maxIterations > 0)
    ? Math.floor(config.maxIterations)
    : null;
}

/**
 * Resolve the effective working directory.
 * Reads workingDir from the config file (.auto/config.json) in ctxCwd.
 * Returns ctxCwd if not set. Supports relative (resolved against ctxCwd) and absolute paths.
 */
export function resolveWorkDir(ctxCwd: string, config: AutoresearchConfig): string {
  if (!config.workingDir) return ctxCwd;
  return path.isAbsolute(config.workingDir)
    ? config.workingDir
    : path.resolve(ctxCwd, config.workingDir);
}

// ported from pi-autoresearch@939ede8 index.ts:501-534 (canonicalPath: I/O lifted)
/** Lifted: the caller canonicalizes both (realpath, else path.resolve) before asking. */
function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

export const AUTORESEARCH_ACTIVATION_ENTRY = "pi-autoresearch.activation";

export interface AutoresearchActivationEntryData {
  version?: number;
  workDir?: string;
  active?: boolean;
}

export function shouldAutoActivateAutoresearch(
  ctxCwd: string,
  workDir: string,
  hasPersistedLog: boolean,
  recordedDecision: boolean | null = null,
): boolean {
  if (!hasPersistedLog) return false;
  // An explicit `/autoresearch on|off` in this session always wins, so a manual
  // off survives /tree, compaction, and reloads instead of snapping back on.
  if (recordedDecision !== null) return recordedDecision;
  // With no recorded decision, same-cwd sessions default on (a log implies intent);
  // redirected workingDir sessions default off until this session opts in.
  return samePath(ctxCwd, workDir);
}

// ported from pi-autoresearch@939ede8 index.ts:561-596 (validateWorkDir: I/O lifted)
/**
 * Validate that the resolved working directory exists.
 * Returns an error message if it doesn't exist, or null if OK.
 */
export function validateWorkDir(ctxCwd: string, workDir: string, workDirKind: string | null): string | null {
  if (workDir === ctxCwd) return null;
  if (workDirKind === null) {
    return `workingDir "${workDir}" (from .auto/config.json) does not exist.`;
  }
  if (workDirKind !== "directory") {
    return `workingDir "${workDir}" (from .auto/config.json) is not a directory.`;
  }
  return null;
}

/** Baseline = first experiment in current segment */
export function findBaselineMetric(results: ExperimentResult[], segment: number): number | null {
  const cur = currentResults(results, segment);
  return cur.length > 0 ? cur[0].metric : null;
}

/** Best = optimal metric across kept experiments in current segment (min for lower, max for higher) */
export function findBestMetric(
  results: ExperimentResult[],
  segment: number,
  direction: "lower" | "higher",
): number | null {
  const kept = currentResults(results, segment)
    .filter((r) => r.status === "keep")
    .map((r) => r.metric);
  if (kept.length === 0) return null;
  return direction === "lower" ? Math.min(...kept) : Math.max(...kept);
}

// ported from pi-autoresearch@939ede8 index.ts:609-660
export function findBaselineRunNumber(results: ExperimentResult[], segment: number): number | null {
  const index = results.findIndex((result) => result.segment === segment);
  return index >= 0 ? index + 1 : null;
}

/**
 * Find secondary metric baselines from the first experiment in current segment.
 * For metrics that didn't exist at baseline time, falls back to the first
 * occurrence of that metric in the current segment.
 */
export function findBaselineSecondary(
  results: ExperimentResult[],
  segment: number,
  knownMetrics?: MetricDef[]
): Record<string, number> {
  const cur = currentResults(results, segment);
  const base: Record<string, number> = cur.length > 0
    ? { ...(cur[0].metrics ?? {}) }
    : {};

  // Fill in any known metrics missing from baseline with their first occurrence
  if (knownMetrics) {
    for (const sm of knownMetrics) {
      if (base[sm.name] === undefined) {
        for (const r of cur) {
          const val = (r.metrics ?? {})[sm.name];
          if (val !== undefined) {
            base[sm.name] = val;
            break;
          }
        }
      }
    }
  }

  return base;
}

export function cloneExperimentState(state: ExperimentState): ExperimentState {
  return {
    ...state,
    results: state.results.map((result) => ({
      ...result,
      metrics: { ...result.metrics },
    })),
    secondaryMetrics: state.secondaryMetrics.map((metric) => ({ ...metric })),
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ported from pi-autoresearch@939ede8 index.ts:711-724
export function createExperimentState(): ExperimentState {
  return {
    results: [],
    bestMetric: null,
    bestDirection: "lower",
    metricName: "metric",
    metricUnit: "",
    secondaryMetrics: [],
    name: null,
    currentSegment: 0,
    maxExperiments: null,
    confidence: null,
  };
}

// ---------------------------------------------------------------------------
// Constants and messages the extension function held (hoisted, verbatim)
// ---------------------------------------------------------------------------

// ported from pi-autoresearch@939ede8 index.ts:1069-1074
export const BENCHMARK_GUARDRAIL =
  "Be careful not to overfit to the benchmarks and do not cheat on the benchmarks.";

// Outlasts pi's internal retry (setTimeout 0) and compaction-continue
// (setTimeout 100); see badlogic/pi-mono#2023, #2110.
export const SETTLED_WINDOW_MS = 800;

// ported from pi-autoresearch@939ede8 index.ts:1077-1085 (no chord can be configured
// here, so always the `/autoresearch dashboard` variants)
export const dashboardHintVariants = (): string[] => {
  return ["/autoresearch dashboard fullscreen", "/autoresearch dashboard"];
};

// ported from pi-autoresearch@939ede8 index.ts:1184-1186
export const autoResumeLimitNotice = (reason?: string | null): string =>
  reason ?? `Autoresearch auto-resume limit reached`;

// ported from pi-autoresearch@939ede8 index.ts:1188-1205
export const composeResumeMessage = (): string => {
  return [
    "Run the next iteration now.",
    "Use the persisted autoresearch state as needed, pick the most promising hypothesis, then call run_experiment + log_experiment.",
    BENCHMARK_GUARDRAIL,
  ].join(" ");
};

export const composeCompactionResumeMessage = (): string => {
  // The compaction summary already contains the rules, ideas, and recent
  // runs — so this resume message just kicks the loop forward.
  return [
    "Run the next iteration now.",
    "Pick the most promising hypothesis from the ideas backlog or the latest `next:` hints in recent runs, then call run_experiment + log_experiment.",
    "Do not re-read .auto/prompt.md or .auto/log.jsonl — the compaction summary already contains them.",
    BENCHMARK_GUARDRAIL,
  ].join(" ");
};

/** Not in upstream (I3): leads the compaction resume when the kept tail holds unlogged work. */
export const IN_FLIGHT_RESUME_PREFIX =
  "Finish the in-flight iteration shown above first (log or revert it).";

// ported from pi-autoresearch@939ede8 index.ts:1287-1303
export const autoresearchHelp = () =>
  [
    "Usage: /autoresearch [off|clear|export|dashboard|<text>]",
    "",
    "<text> enters autoresearch mode and starts or resumes the loop.",
    "off leaves autoresearch mode.",
    "clear deletes the session log (.auto/log.jsonl) and turns autoresearch mode off.",
    "export opens a local live dashboard for the session log in your browser.",
    "dashboard opens the fullscreen dashboard overlay in the terminal.",

    "",
    "Examples:",
    "  /autoresearch optimize unit test runtime, monitor correctness",
    "  /autoresearch model training, run 5 minutes of train.py and note the loss ratio as optimization target",
    "  /autoresearch export",
    "  /autoresearch dashboard",
  ].join("\n");

// ported from pi-autoresearch@939ede8 index.ts:1098-1106 (the kickoff) and 3098-3120
export const rulesKickoff = (trimmedArgs: string): string =>
  `Autoresearch mode active. ${trimmedArgs} ${BENCHMARK_GUARDRAIL}`;

export const skillKickoffCommand = (trimmedArgs: string): string =>
  `/skill:autoresearch-create ${trimmedArgs} ${BENCHMARK_GUARDRAIL}`.replace(/\s+/g, " ").trim();

/**
 * pi's `_expandSkillCommand` (earendil-works/pi agent-session.ts, with
 * `stripFrontmatter` from utils/frontmatter.ts): what the model reads for a
 * `/skill:<name> <args>` message. `skillMd` is the SKILL.md text.
 */
export function expandSkillCommand(
  text: string,
  skill: { name: string; filePath: string; baseDir: string; skillMd: string },
): string {
  if (!text.startsWith("/skill:")) return text;
  const spaceIndex = text.indexOf(" ");
  const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
  const body = stripFrontmatter(skill.skillMd).trim();
  const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
  return args ? `${skillBlock}\n\n${args}` : skillBlock;
}

function stripFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return normalized;
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return normalized;
  return normalized.slice(endIndex + 4).trim();
}

/** The notices upstream shows with ctx.ui.notify, each with its level. */
export const NOTICES = {
  // index.ts:2594, 2601, 2605
  tuiOnly: "The fullscreen dashboard is only available in TUI mode",
  notActive: "Autoresearch mode is not active",
  noExperiments: "No experiments yet",
  // index.ts:2974, 2983, 2986
  noLog: (fileName: string) => `No ${fileName} found — run some experiments first`,
  dashboardAt: (url: string) => `Dashboard at ${url} (live updates)`,
  exportFailed: (message: string) => `Export failed: ${message}`,
  // index.ts:3012-3015
  off: (wasRunning: boolean) =>
    wasRunning ? "Autoresearch mode OFF — aborting current run" : "Autoresearch mode OFF",
  // index.ts:3067-3070, 3076, 3078
  deleteFailed: (name: string, message: string) => `Failed to delete ${name}: ${message}`,
  cleared: (deleted: string[]) => `Deleted ${deleted.join(", ")} and turned autoresearch mode OFF`,
  noLogCleared: "No session log found. Autoresearch mode OFF",
  // index.ts:3084
  alreadyActive: "Autoresearch already active — use '/autoresearch off' to stop first",
  // index.ts:3102-3107
  activated: (rulesLoaded: boolean) =>
    rulesLoaded
      ? "Autoresearch mode ON — rules loaded from .auto/prompt.md"
      : "Autoresearch mode ON — no .auto/prompt.md found, loading autoresearch-create skill",
} as const;

// ---------------------------------------------------------------------------
// The three tools' texts (index.ts:1568-1579, 1687-1699, 2203-2218)
// ---------------------------------------------------------------------------

export interface ToolText {
  name: "init_experiment" | "run_experiment" | "log_experiment";
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
}

export const INIT_TOOL: ToolText = {
  name: "init_experiment",
  label: "Init Experiment",
  description:
    "Initialize the experiment session. Call once before the first run_experiment to set the name, primary metric, unit, and direction. Writes the config header to .auto/log.jsonl.",
  promptSnippet:
    "Initialize experiment session (name, metric, unit, direction). Call once before first run.",
  promptGuidelines: [
    "Call init_experiment exactly once at the start of an autoresearch session, before the first run_experiment.",
    "If the session log (.auto/log.jsonl) already exists with a config, do NOT call init_experiment again.",
    "If the optimization target changes (different benchmark, metric, or workload), call init_experiment again to insert a new config header and reset the baseline.",
  ],
};

export const RUN_TOOL: ToolText = {
  name: "run_experiment",
  label: "Run Experiment",
  description:
    `Run a shell command as an experiment. Times wall-clock duration, captures output, detects pass/fail via exit code. Output is truncated to last ${EXPERIMENT_MAX_LINES} lines or ${EXPERIMENT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Use for any autoresearch experiment.`,
  promptSnippet:
    "Run a timed experiment command (captures duration, output, exit code)",
  promptGuidelines: [
    "Use run_experiment instead of bash when running experiment commands — it handles timing and output capture automatically.",
    "After run_experiment, always call log_experiment to record the result.",
    "If the benchmark script outputs structured METRIC lines (e.g. 'METRIC total_µs=15200'), run_experiment will parse them automatically and suggest exact values for log_experiment. Use these parsed values directly instead of extracting them manually from the output.",
  ],
};

export const LOG_TOOL: ToolText = {
  name: "log_experiment",
  label: "Log Experiment",
  description:
    "Record an experiment result. Tracks metrics, updates the status widget and dashboard. Call after every run_experiment.",
  promptSnippet:
    "Log experiment result (commit, metric, status, description)",
  promptGuidelines: [
    "Always call log_experiment after run_experiment to record the result.",
    "log_experiment automatically runs git add -A && git commit on 'keep', and auto-reverts code changes on 'discard'/'crash'/'checks_failed' (autoresearch files are preserved). Do NOT commit or revert manually.",
    "Use status 'keep' if the PRIMARY metric improved. 'discard' if worse or unchanged. 'crash' if it failed. Secondary metrics are for monitoring — they almost never affect keep/discard. Only discard a primary improvement if a secondary metric degraded catastrophically, and explain why in the description.",
    "log_experiment reports a confidence score after 3+ runs (best improvement as a multiple of the noise floor). ≥2.0× = likely real, <1.0× = within noise. If confidence is below 1.0×, consider re-running the same experiment to confirm before keeping. The score is advisory — it never auto-discards.",
    "If you discover complex but promising optimizations you won't pursue immediately, append them as bullet points to .auto/ideas.md. Don't let good ideas get lost.",
    "Always include the asi parameter. At minimum: {\"hypothesis\": \"what you tried\"}. On discard/crash, also include rollback_reason and next_action_hint. Add any other key/value pairs that capture what you learned — dead ends, surprising findings, error details, bottlenecks. This is the only structured memory that survives reverts.",
    "When log_experiment records a retry of a previously discarded idea after its assumptions changed, set asi.revisits_run to the earlier run number (a positive integer) and explain what changed in description. Omit revisits_run for new ideas and verification reruns.",
  ],
};

export const TOOLS: readonly ToolText[] = [INIT_TOOL, RUN_TOOL, LOG_TOOL];

// ---------------------------------------------------------------------------
// System prompt addendum (index.ts:1522-1562)
// ---------------------------------------------------------------------------

/** The text before_agent_start appends while the mode is on, verbatim. */
export function addendumText(opts: {
  mdPath: string;
  checksPath: string;
  ideasPath: string;
  hasChecks: boolean;
  hasIdeas: boolean;
}): string {
  const { mdPath, checksPath, ideasPath, hasChecks, hasIdeas } = opts;

  let extra =
    "\n\n## Autoresearch Mode (ACTIVE)" +
    "\nYou are in autoresearch mode. Optimize the primary metric through an autonomous experiment loop." +
    "\nUse init_experiment, run_experiment, and log_experiment tools. NEVER STOP until interrupted." +
    `\nExperiment rules: ${mdPath} — read this file at the start of every session and after compaction.` +
    "\nWrite promising but deferred optimizations as bullet points to .auto/ideas.md — don't let good ideas get lost." +
    `\n${BENCHMARK_GUARDRAIL}` +
    "\nIf the user sends a follow-on message while an experiment is running, finish the current run_experiment + log_experiment cycle first, then address their message in the next iteration.";

  if (hasChecks) {
    extra +=
      "\n\n## Backpressure Checks (ACTIVE)" +
      `\n${checksPath} exists and runs automatically after every passing benchmark in run_experiment.` +
      "\nIf the benchmark passes but checks fail, run_experiment will report it clearly." +
      "\nUse status 'checks_failed' in log_experiment when this happens — it behaves like a crash (no commit, changes auto-reverted)." +
      "\nYou cannot use status 'keep' when checks have failed." +
      "\nThe checks execution time does NOT affect the primary metric.";
  }

  if (hasIdeas) {
    extra += `\n\n💡 Ideas backlog exists at ${ideasPath} — check it for promising experiment paths. Prune stale entries.`;
  }

  return extra;
}

/**
 * What pi puts in its own prompt sections for the three tools (pi core/system-prompt.ts):
 * a `- name: snippet` line each for its tools section and each deduplicated guideline as
 * a `- rule` bullet for its rules section. Here both sit in the addendum (F13), under the
 * names the model actually calls (F1).
 */
export function toolSectionsText(servedNames: Record<ToolText["name"], string>): string {
  const lines = TOOLS.map((tool) => `- ${servedNames[tool.name]}: ${tool.promptSnippet}`);
  const seen = new Set<string>();
  const rules: string[] = [];
  for (const tool of TOOLS) {
    for (const guideline of tool.promptGuidelines) {
      const rule = guideline.trim();
      if (!rule || seen.has(rule)) continue;
      seen.add(rule);
      rules.push(`- ${rule}`);
    }
  }
  const mapping = `The tools init_experiment, run_experiment and log_experiment are available as ${TOOLS.map((tool) => servedNames[tool.name]).join(", ")}.`;
  return `\n\n${mapping}\n\n<tools>\n${lines.join("\n")}\n</tools>\n\n<rules>\n${rules.join("\n")}\n</rules>`;
}

// ---------------------------------------------------------------------------
// Result texts, extracted from the tools' execute bodies with the same output
// ---------------------------------------------------------------------------

// ported from pi-autoresearch@939ede8 index.ts:1590, 1710, 2229
export const workDirErrorText = (workDirError: string): string => `❌ ${workDirError}`;

// ported from pi-autoresearch@939ede8 index.ts:1637, 2440
export const jsonlWriteFailedText = (message: string): string =>
  `⚠️ Failed to write .auto/log.jsonl: ${message}`;

// ported from pi-autoresearch@939ede8 index.ts:1659-1665
export function initResultText(state: ExperimentState, isReinit: boolean, workDir: string, cwd: string): string {
  const reinitNote = isReinit ? " (re-initialized — previous results archived, new baseline needed)" : "";
  const limitNote = state.maxExperiments !== null ? `\nMax iterations: ${state.maxExperiments} (from .auto/config.json)` : "";
  const workDirNote = workDir !== cwd ? `\nWorking directory: ${workDir}` : "";
  return `✅ Experiment initialized: "${state.name}"${reinitNote}\nMetric: ${state.metricName} (${state.metricUnit || "unitless"}, ${state.bestDirection} is better)${limitNote}${workDirNote}\nConfig written to .auto/log.jsonl. Now run the baseline with run_experiment.`;
}

// ported from pi-autoresearch@939ede8 index.ts:1721
export const maxExperimentsReachedText = (maxExperiments: number): string =>
  `🛑 Maximum experiments reached (${maxExperiments}). The experiment loop is done. To continue, call init_experiment to start a new segment.`;

// ported from pi-autoresearch@939ede8 index.ts:1736
export const measureScriptRequiredText = (benchmarkScriptRel: string, autoresearchShPath: string, command: string): string =>
  `❌ ${benchmarkScriptRel} exists — you must run it instead of a custom command.\n\nFound: ${autoresearchShPath}\nYour command: ${command}\n\nUse: run_experiment({ command: "bash ${benchmarkScriptRel}" }) or run_experiment({ command: "./${benchmarkScriptRel}" })`;

// ported from pi-autoresearch@939ede8 index.ts:1738-1750
export const blockedRunDetails = (command: string): RunDetails =>
  ({
    command,
    exitCode: null,
    durationSeconds: 0,
    passed: false,
    crashed: true,
    timedOut: false,
    tailOutput: "",
    checksPass: null,
    checksTimedOut: false,
    checksOutput: "",
    checksDuration: 0,
  }) as RunDetails;

/** ported from pi-autoresearch@939ede8 index.ts:2006-2067: the model's run_experiment text. */
export function runResultText(
  state: Pick<ExperimentState, "bestMetric" | "metricName" | "metricUnit" | "secondaryMetrics">,
  details: RunDetails,
  benchmarkPassed: boolean,
  llmTruncation: TruncationResult,
  fullOutputPath: string | undefined,
): string {
  const { exitCode, durationSeconds, checksTimedOut, checksPass, checksDuration, parsedMetrics, parsedPrimary } = details;

  // Build LLM response
  let text = "";
  if (details.timedOut) {
    text += `⏰ TIMEOUT after ${durationSeconds.toFixed(1)}s\n`;
  } else if (!benchmarkPassed) {
    text += `💥 FAILED (exit code ${exitCode}) in ${durationSeconds.toFixed(1)}s\n`;
  } else if (checksTimedOut) {
    text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
    text += `⏰ CHECKS TIMEOUT (.auto/checks.sh) after ${checksDuration.toFixed(1)}s\n`;
    text += `Log this as 'checks_failed' — the benchmark metric is valid but checks timed out.\n`;
  } else if (checksPass === false) {
    text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
    text += `💥 CHECKS FAILED (.auto/checks.sh) in ${checksDuration.toFixed(1)}s\n`;
    text += `Log this as 'checks_failed' — the benchmark metric is valid but correctness checks did not pass.\n`;
  } else {
    text += `✅ PASSED in ${durationSeconds.toFixed(1)}s\n`;
    if (checksPass === true) {
      text += `✅ Checks passed in ${checksDuration.toFixed(1)}s\n`;
    }
  }

  if (state.bestMetric !== null) {
    text += `📊 Current best ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}\n`;
  }

  // Show parsed METRIC lines to the LLM
  if (parsedMetrics) {
    const secondary = Object.entries(parsedMetrics).filter(([k]) => k !== state.metricName);

    // Human-readable summary
    text += `\n📐 Parsed metrics:`;
    if (parsedPrimary !== null) {
      text += ` ★ ${state.metricName}=${formatNum(parsedPrimary, state.metricUnit)}`;
    }
    for (const [name, value] of secondary) {
      // Infer unit from name suffix for display
      const sm = state.secondaryMetrics.find((m) => m.name === name);
      const unit = sm?.unit ?? "";
      text += ` ${name}=${formatNum(value, unit)}`;
    }

    // Machine-ready values for log_experiment (raw numbers, not formatted)
    text += `\nUse these values directly in log_experiment (metric: ${parsedPrimary ?? "?"}, metrics: {${secondary.map(([k, v]) => `"${k}": ${v}`).join(", ")}})\n`;
  }

  text += `\n${llmTruncation.content}`;

  if (llmTruncation.truncated) {
    if (llmTruncation.truncatedBy === "lines") {
      text += `\n\n[Showing last ${llmTruncation.outputLines} of ${llmTruncation.totalLines} lines.`;
    } else {
      text += `\n\n[Showing last ${llmTruncation.outputLines} lines (${formatSize(EXPERIMENT_MAX_BYTES)} limit).`;
    }
    if (fullOutputPath) {
      text += ` Full output: ${fullOutputPath}`;
    }
    text += `]`;
  }

  if (checksPass === false) {
    text += `\n\n── Checks output (last 80 lines) ──\n${details.checksOutput}`;
  }

  return text;
}

// ported from pi-autoresearch@939ede8 index.ts:2241
export const checksFailedKeepText = (checksOutput: string): string =>
  `❌ Cannot keep — .auto/checks.sh failed.\n\n${checksOutput.slice(-500)}\n\nLog as 'checks_failed' instead. The benchmark metric is valid but correctness checks did not pass.`;

// ported from pi-autoresearch@939ede8 index.ts:2258
export const missingMetricsText = (missing: string[], knownNames: Set<string>, providedNames: Set<string>): string =>
  `❌ Missing secondary metrics: ${missing.join(", ")}\n\nYou must provide all previously tracked metrics. Expected: ${[...knownNames].join(", ")}\nGot: ${[...providedNames].join(", ") || "(none)"}\n\nFix: include ${missing.map((m) => `"${m}": <value>`).join(", ")} in the metrics parameter.`;

// ported from pi-autoresearch@939ede8 index.ts:2270
export const newMetricsText = (newMetrics: string[], knownNames: Set<string>): string =>
  `❌ New secondary metric${newMetrics.length > 1 ? "s" : ""} not previously tracked: ${newMetrics.join(", ")}\n\nExisting metrics: ${[...knownNames].join(", ")}\n\nIf this metric has proven very valuable to watch, call log_experiment again with force: true to add it. Otherwise, remove it from the metrics parameter.`;

// ported from pi-autoresearch@939ede8 index.ts:2298-2308 (the loop body's unit choice)
export function inferSecondaryUnit(name: string): string {
  let unit = "";
  if (name.endsWith("µs")) unit = "µs";
  else if (name.endsWith("_ms")) unit = "ms";
  else if (name.endsWith("_s") || name.endsWith("_sec")) unit = "s";
  else if (name.endsWith("_kb")) unit = "kb";
  else if (name.endsWith("_mb")) unit = "mb";
  return unit;
}

/** ported from pi-autoresearch@939ede8 index.ts:2317-2379: the log text before git. */
export function logSummaryText(
  state: ExperimentState,
  experiment: ExperimentResult,
  params: { status: ExperimentResult["status"]; metric: number },
  secondaryMetrics: Record<string, number>,
  mergedASI: ASI | undefined,
): string {
  // Build response text
  const segmentCount = currentResults(state.results, state.currentSegment).length;
  let text = `Logged #${state.results.length}: ${experiment.status} — ${experiment.description}`;

  if (state.bestMetric !== null) {
    text += `\nBaseline ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}`;
    if (segmentCount > 1 && params.status === "keep" && params.metric > 0) {
      const delta = params.metric - state.bestMetric;
      const pct = ((delta / state.bestMetric) * 100).toFixed(1);
      const sign = delta > 0 ? "+" : "";
      text += ` | this: ${formatNum(params.metric, state.metricUnit)} (${sign}${pct}%)`;
    }
  }

  // Show secondary metrics
  if (Object.keys(secondaryMetrics).length > 0) {
    const baselines = findBaselineSecondary(state.results, state.currentSegment, state.secondaryMetrics);
    const parts: string[] = [];
    for (const [name, value] of Object.entries(secondaryMetrics)) {
      const def = state.secondaryMetrics.find((m) => m.name === name);
      const unit = def?.unit ?? "";
      let part = `${name}: ${formatNum(value, unit)}`;
      const bv = baselines[name];
      if (bv !== undefined && state.results.length > 1 && bv !== 0) {
        const d = value - bv;
        const p = ((d / bv) * 100).toFixed(1);
        const s = d > 0 ? "+" : "";
        part += ` (${s}${p}%)`;
      }
      parts.push(part);
    }
    text += `\nSecondary: ${parts.join("  ")}`;
  }

  // Show ASI summary
  if (mergedASI) {
    const asiParts: string[] = [];
    for (const [k, v] of Object.entries(mergedASI)) {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      asiParts.push(`${k}: ${s.length > 80 ? s.slice(0, 77) + "…" : s}`);
    }
    if (asiParts.length > 0) {
      text += `\n📋 ASI: ${asiParts.join(" | ")}`;
    }
  }

  // Show confidence score
  if (state.confidence !== null) {
    const confStr = state.confidence.toFixed(1);
    if (state.confidence >= 2.0) {
      text += `\n📊 Confidence: ${confStr}× noise floor — improvement is likely real`;
    } else if (state.confidence >= 1.0) {
      text += `\n📊 Confidence: ${confStr}× noise floor — improvement is above noise but marginal`;
    } else {
      text += `\n⚠️ Confidence: ${confStr}× noise floor — improvement is within noise. Consider re-running to confirm before keeping.`;
    }
  }

  text += `\n(${segmentCount} experiments`;
  if (state.maxExperiments !== null) {
    text += ` / ${state.maxExperiments} max`;
  }
  text += `)`;

  return text;
}

// ported from pi-autoresearch@939ede8 index.ts:2384-2390
export function keepCommitMessage(
  description: string,
  status: ExperimentResult["status"],
  metricName: string,
  metric: number,
  secondaryMetrics: Record<string, number>,
): string {
  const resultData: Record<string, unknown> = {
    status,
    [metricName || "metric"]: metric,
    ...secondaryMetrics,
  };
  const trailerJson = JSON.stringify(resultData);
  return `${description}\n\nResult: ${trailerJson}`;
}

// ported from pi-autoresearch@939ede8 index.ts:2396, 2401, 2407, 2419, 2423
export const GIT_TEXT = {
  addFailed: (code: number | null, output: string) => `git add failed (exit ${code}): ${output.slice(0, 200)}`,
  nothingToCommit: `\n📝 Git: nothing to commit (working tree clean)`,
  committed: (firstLine: string) => `\n📝 Git: committed — ${firstLine}`,
  commitFailed: (code: number | null, output: string) => `\n⚠️ Git commit failed (exit ${code}): ${output.slice(0, 200)}`,
  commitError: (message: string) => `\n⚠️ Git commit error: ${message}`,
  // index.ts:2450, 2452
  reverted: (status: string) => `\n📝 Git: reverted changes (${status}) — autoresearch files preserved`,
  revertFailed: (message: string) => `\n⚠️ Git revert failed: ${message}`,
} as const;

// ported from pi-autoresearch@939ede8 index.ts:2445-2448, verbatim
export const REVERT_SCRIPT = `
            git checkout -- . ':(exclude,glob)**/${AUTO_DIR}' ':(exclude,glob)**/${AUTO_DIR}/**' ':(exclude,glob)**/autoresearch.*' ':(exclude,glob)**/autoresearch.*/**'
            git clean -fd -e '${AUTO_DIR}' -e '**/${AUTO_DIR}/**' -e 'autoresearch.*' -e '**/autoresearch.*/**' 2>/dev/null
          `;

// ported from pi-autoresearch@939ede8 index.ts:2471, 2476
export const limitReachedText = (maxExperiments: number | null): string =>
  `\n\n🛑 Maximum experiments reached (${maxExperiments}). STOP the experiment loop now.`;

export const REVISIT_DISCARDS_TEXT =
  "\n\nBefore choosing the next experiment, consider whether this result or discovery invalidates a previous discard's rollback reason. If so, name what changed and weigh a targeted retry against other candidates. Otherwise, move on. Don't revive a discarded idea without a changed assumption. Verification reruns to resolve measurement noise are separate.";

// ported from pi-autoresearch@939ede8 index.ts:1250-1258
export const buildSessionSnapshot = (state: ExperimentState): SessionSnapshot => ({
  metric_name: state.metricName,
  metric_unit: state.metricUnit,
  direction: state.bestDirection,
  baseline_metric: state.bestMetric,
  best_metric: findBestMetric(state.results, state.currentSegment, state.bestDirection),
  run_count: state.results.length,
  goal: state.name ?? "",
});
