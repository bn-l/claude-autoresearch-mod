// The three tools' renderCall / renderResult from pi-autoresearch@939ede8 index.ts, as
// text: each body is upstream's, returning the styled string where upstream returned
// `new Text(text, 0, 0)` (pi's Text word-wraps to the row's width; ui/styled.ts draws
// the string in a wrapping Text). `result.content[0].text` is the tool's output string,
// `result.details` what the tool call kept for its rows (ToolDetails below).

import { formatSize } from "./vendor/truncate.ts";
import {
  EXPERIMENT_MAX_BYTES,
  formatNum,
  isBetter,
  type ExperimentResult,
  type ExperimentState,
  type MetricDef,
  type RunDetails,
} from "./experiment-core.ts";
import type { Theme, ThemeColor } from "./dashboard-lines.ts";

/** A tool call's input as the model sent it. */
export type ToolArgs = Record<string, unknown>;

/** What run_experiment keeps for its rows (index.ts:2069-2072's details). */
export type RunRowDetails = RunDetails & {
  truncation?: { truncated: boolean; truncatedBy: "lines" | "bytes" | null; outputLines: number; totalLines: number };
  fullOutputPath?: string;
};

/**
 * What log_experiment keeps for its rows. Upstream kept `{ experiment, state:
 * cloneExperimentState(state), wallClockSeconds }` (LogDetails), a copy of every result
 * per row; its renderResult reads five things of that state, kept here instead and
 * computed at log time by `logRowDetails` with upstream's own loop.
 */
export interface LogRowDetails {
  experiment: ExperimentResult;
  /** `s.results.length` */
  runNumber: number;
  /** `s.bestMetric` (the segment's baseline) */
  bestMetric: number | null;
  /** The best kept metric renderResult computes from `s` (index.ts:2553-2558). */
  best: number | null;
  metricName: string;
  metricUnit: string;
  secondaryMetrics: MetricDef[];
  wallClockSeconds: number | null;
}

// ported from pi-autoresearch@939ede8 index.ts:2550-2558 (the best-kept loop), run at log time
export function logRowDetails(
  experiment: ExperimentResult,
  s: ExperimentState,
  wallClockSeconds: number | null,
): LogRowDetails {
  let best: number | null = null;
  if (s.bestMetric !== null) {
    // Find the actual best kept metric in the current segment
    best = s.bestMetric;
    for (const r of s.results) {
      if (r.segment === s.currentSegment && r.status === "keep" && r.metric > 0) {
        if (isBetter(r.metric, best, s.bestDirection)) best = r.metric;
      }
    }
  }
  return {
    experiment: { ...experiment, metrics: { ...experiment.metrics } },
    runNumber: s.results.length,
    bestMetric: s.bestMetric,
    best,
    metricName: s.metricName,
    metricUnit: s.metricUnit,
    secondaryMetrics: s.secondaryMetrics.map((metric) => ({ ...metric })),
    wallClockSeconds,
  };
}

// ported from pi-autoresearch@939ede8 index.ts:1671-1675
export function renderInitCall(args: ToolArgs, theme: Theme): string {
  let text = theme.fg("toolTitle", theme.bold("init_experiment "));
  text += theme.fg("accent", (args.name as string | undefined) ?? "");
  return text;
}

// ported from pi-autoresearch@939ede8 index.ts:1677-1680
export function renderInitResult(outputText: string): string {
  return outputText;
}

// ported from pi-autoresearch@939ede8 index.ts:2075-2082
export function renderRunCall(args: ToolArgs, theme: Theme): string {
  let text = theme.fg("toolTitle", theme.bold("run_experiment "));
  text += theme.fg("muted", String(args.command ?? ""));
  if (args.timeout_seconds) {
    text += theme.fg("dim", ` (timeout: ${args.timeout_seconds}s)`);
  }
  return text;
}

// ported from pi-autoresearch@939ede8 index.ts:2084-2106 (isPartial: the 1 s updates)
export function renderRunPartial(elapsed: string, outputText: string, expanded: boolean, theme: Theme): string {
  const PREVIEW_LINES = 5;

  let text = theme.fg("warning", `⏳ Running${elapsed ? ` ${elapsed}` : ""}…`);

  // Always show tail of streaming output (like bash tool shows preview lines)
  if (outputText) {
    const lines = outputText.split("\n");
    const maxLines = expanded ? 20 : PREVIEW_LINES;
    const tail = lines.slice(-maxLines).join("\n");
    if (tail.trim()) {
      text += "\n" + theme.fg("dim", tail);
    }
  }

  return text;
}

// ported from pi-autoresearch@939ede8 index.ts:2084-2196 (settled)
export function renderRunResult(
  d: RunRowDetails | undefined,
  outputText: string,
  expanded: boolean,
  theme: Theme,
): string {
  const PREVIEW_LINES = 5;

  if (!d) {
    return outputText;
  }

  // Helper: append tail output preview or full output
  const appendOutput = (text: string, output: string): string => {
    if (!output) return text;
    const lines = output.split("\n");
    if (expanded) {
      text += "\n" + theme.fg("dim", output.slice(-2000));
    } else {
      const tail = lines.slice(-PREVIEW_LINES).join("\n");
      if (tail.trim()) {
        const hidden = lines.length - PREVIEW_LINES;
        if (hidden > 0) {
          text += "\n" + theme.fg("muted", `… ${hidden} more lines`);
        }
        text += "\n" + theme.fg("dim", tail);
      }
    }
    return text;
  };

  if (d.timedOut) {
    let text = theme.fg("error", `⏰ TIMEOUT ${d.durationSeconds.toFixed(1)}s`);
    text = appendOutput(text, d.tailOutput);
    return text;
  }

  // Helper: format parsed primary metric suffix (empty string if not available)
  const parsedSuffix = d.parsedPrimary !== null && d.parsedPrimary !== undefined
    ? theme.fg("accent", `, ${d.metricName}: ${formatNum(d.parsedPrimary, d.metricUnit)}`)
    : "";

  if (d.checksTimedOut) {
    let text =
      theme.fg("success", `✅ wall: ${d.durationSeconds.toFixed(1)}s`) +
      parsedSuffix +
      theme.fg("error", ` ⏰ checks timeout ${d.checksDuration.toFixed(1)}s`);
    text = appendOutput(text, d.checksOutput);
    return text;
  }

  if (d.checksPass === false) {
    let text =
      theme.fg("success", `✅ wall: ${d.durationSeconds.toFixed(1)}s`) +
      parsedSuffix +
      theme.fg("error", ` 💥 checks failed ${d.checksDuration.toFixed(1)}s`);
    text = appendOutput(text, d.checksOutput);
    return text;
  }

  if (d.crashed) {
    let text = theme.fg("error", `💥 FAIL exit=${d.exitCode} ${d.durationSeconds.toFixed(1)}s`) + parsedSuffix;
    text = appendOutput(text, d.tailOutput);
    return text;
  }

  let text = theme.fg("success", "✅ ");

  // Show wall-clock and parsed primary metric together
  const parts: string[] = [`wall: ${d.durationSeconds.toFixed(1)}s`];
  if (d.parsedPrimary !== null && d.parsedPrimary !== undefined) {
    parts.push(`${d.metricName}: ${formatNum(d.parsedPrimary, d.metricUnit)}`);
  }
  text += theme.fg("accent", parts.join(", "));

  if (d.checksPass === true) {
    text += theme.fg("success", ` ✓ checks ${d.checksDuration.toFixed(1)}s`);
  }

  if (d.truncation?.truncated && d.fullOutputPath) {
    text += theme.fg("warning", " (truncated)");
  }

  text = appendOutput(text, d.tailOutput);

  if (expanded && d.truncation?.truncated && d.fullOutputPath) {
    if (d.truncation.truncatedBy === "lines") {
      text += "\n" + theme.fg("warning", `[Truncated: showing ${d.truncation.outputLines} of ${d.truncation.totalLines} lines. Full output: ${d.fullOutputPath}]`);
    } else {
      text += "\n" + theme.fg("warning", `[Truncated: ${d.truncation.outputLines} lines shown (${formatSize(EXPERIMENT_MAX_BYTES)} limit). Full output: ${d.fullOutputPath}]`);
    }
  }

  return text;
}

// ported from pi-autoresearch@939ede8 index.ts:2502-2513
export function renderLogCall(args: ToolArgs, theme: Theme): string {
  let text = theme.fg("toolTitle", theme.bold("log_experiment "));
  const color: ThemeColor =
    args.status === "keep"
      ? "success"
      : args.status === "crash" || args.status === "checks_failed"
        ? "error"
        : "warning";
  text += theme.fg(color, String(args.status ?? ""));
  text += " " + theme.fg("dim", String(args.description ?? ""));
  return text;
}

// ported from pi-autoresearch@939ede8 index.ts:2515-2580; `s.*` reads LogRowDetails
export function renderLogResult(d: LogRowDetails | undefined, outputText: string, theme: Theme): string {
  if (!d) {
    return outputText;
  }

  const exp = d.experiment;
  const color: ThemeColor =
    exp.status === "keep"
      ? "success"
      : exp.status === "crash" || exp.status === "checks_failed"
        ? "error"
        : "warning";
  const icon =
    exp.status === "keep" ? "✓" : exp.status === "crash" ? "✗" : exp.status === "checks_failed" ? "⚠" : "–";

  let text =
    theme.fg(color, `${icon} `) +
    theme.fg("accent", `#${d.runNumber}`);

  // Show wall-clock and primary metric together
  const metricParts: string[] = [];
  if (d.wallClockSeconds !== null && d.wallClockSeconds !== undefined) {
    metricParts.push(`wall: ${d.wallClockSeconds.toFixed(1)}s`);
  }
  if (exp.metric > 0) {
    metricParts.push(`${d.metricName}: ${formatNum(exp.metric, d.metricUnit)}`);
  }
  if (metricParts.length > 0) {
    text += theme.fg("dim", " (") + theme.fg("warning", metricParts.join(theme.fg("dim", ", "))) + theme.fg("dim", ")");
  }

  text += " " + theme.fg("muted", exp.description);

  // Show best metric for context (overall best, not just this run)
  if (d.bestMetric !== null && d.best !== null) {
    text +=
      theme.fg("dim", " │ ") +
      theme.fg("warning", `★ best: ${formatNum(d.best, d.metricUnit)}`);
  }

  // Show secondary metrics inline
  if (Object.keys(exp.metrics).length > 0) {
    const parts: string[] = [];
    for (const [name, value] of Object.entries(exp.metrics)) {
      const def = d.secondaryMetrics.find((m) => m.name === name);
      parts.push(`${name}=${formatNum(value, def?.unit ?? "")}`);
    }
    text += theme.fg("dim", `  ${parts.join(" ")}`);
  }

  const revisitsRun = exp.asi?.revisits_run;
  if (typeof revisitsRun === "number" && Number.isInteger(revisitsRun) && revisitsRun > 0) {
    text += "\n" + theme.fg("accent", `↻ Revisiting #${revisitsRun}`);
  }

  return text;
}
