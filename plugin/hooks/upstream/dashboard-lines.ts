// Upstream's widget and overlay drawing, as text: pi-autoresearch@939ede8 index.ts.
// renderDashboardLines and its helpers are verbatim; the widget's and the overlay's own
// lines, drawn inline in updateWidget and the overlay component, are extracted into
// functions with the same output. Everything draws through a pi `Theme`; ui/styled.ts
// supplies one whose colours are markers it turns into styled text.

import { truncateToWidth, visibleWidth } from "./vendor/tui-width.ts";
import {
  currentResults,
  findBaselineMetric,
  findBaselineRunNumber,
  findBaselineSecondary,
  formatElapsed,
  formatNum,
  isBetter,
  type ExperimentState,
} from "./experiment-core.ts";

/** The pi theme tokens upstream draws with (pi coding-agent Theme). */
export type ThemeColor =
  | "accent" | "warning" | "success" | "error" | "muted" | "dim" | "text"
  | "border" | "borderMuted" | "toolTitle";

/** The part of pi's Theme upstream uses. */
export interface Theme {
  fg(color: ThemeColor, text: string): string;
  bold(text: string): string;
}

// ported from pi-autoresearch@939ede8 index.ts:662-702
export function truncateDisplayText(text: string, width: number): string {
  if (width <= 0) return "";
  return truncateToWidth(text, width, "…", true);
}

export function joinPartsToWidth(parts: string[], width: number): string {
  let line = "";
  for (const part of parts) {
    if (!part) continue;
    const next = line + part;
    if (visibleWidth(next) <= width) {
      line = next;
      continue;
    }
    return truncateToWidth(line || part, width, "…", true);
  }
  return truncateToWidth(line, width, "…", true);
}

function appendRightAlignedAdaptiveHint(
  left: string,
  width: number,
  theme: Theme,
  candidates: string[]
): string {
  if (width <= 0) return "";
  const leftWidth = visibleWidth(left);
  for (const candidate of candidates) {
    const hint = theme.fg("dim", ` ${candidate}`);
    const hintWidth = visibleWidth(hint);
    if (hintWidth > width) continue;
    if (leftWidth + hintWidth <= width) {
      return left + " ".repeat(Math.max(0, width - leftWidth - hintWidth)) + hint;
    }
    const availableLeftWidth = Math.max(0, width - hintWidth);
    const truncatedLeft = truncateToWidth(left, availableLeftWidth, "…", true);
    const truncatedLeftWidth = visibleWidth(truncatedLeft);
    return truncatedLeft + " ".repeat(Math.max(0, width - truncatedLeftWidth - hintWidth)) + hint;
  }
  return truncateToWidth(left, width, "…", true);
}

// ported from pi-autoresearch@939ede8 index.ts:763-1062
// ---------------------------------------------------------------------------
// Dashboard table renderer (pure function, no UI deps)
// ---------------------------------------------------------------------------

export function renderDashboardLines(
  st: ExperimentState,
  width: number,
  th: Theme,
  maxRows: number = 6,
  headerHints: string[] = []
): string[] {
  const lines: string[] = [];

  if (st.results.length === 0) {
    lines.push(`  ${th.fg("dim", "No experiments yet.")}`);
    return lines;
  }

  const cur = currentResults(st.results, st.currentSegment);
  const kept = cur.filter((r) => r.status === "keep").length;
  const discarded = cur.filter((r) => r.status === "discard").length;
  const crashed = cur.filter((r) => r.status === "crash").length;
  const checksFailed = cur.filter((r) => r.status === "checks_failed").length;

  const baseline = st.bestMetric;
  const baselineRunNumber = findBaselineRunNumber(st.results, st.currentSegment);
  const baselineSec = findBaselineSecondary(st.results, st.currentSegment, st.secondaryMetrics);

  // Find best kept primary metric and its run number (current segment only)
  let bestPrimary: number | null = null;
  let bestSecondary: Record<string, number> = {};
  let bestRunNum = 0;
  for (let i = st.results.length - 1; i >= 0; i--) {
    const r = st.results[i];
    if (r.segment !== st.currentSegment) continue;
    if (r.status === "keep" && r.metric > 0) {
      if (bestPrimary === null || isBetter(r.metric, bestPrimary, st.bestDirection)) {
        bestPrimary = r.metric;
        bestSecondary = r.metrics ?? {};
        bestRunNum = i + 1;
      }
    }
  }

  // Runs summary
  const confSuffix = st.confidence !== null
    ? (() => {
        const confStr = st.confidence!.toFixed(1);
        const confColor: Parameters<typeof th.fg>[0] = st.confidence! >= 2.0 ? "success" : st.confidence! >= 1.0 ? "warning" : "error";
        return `  ${th.fg(confColor, `(conf: ${confStr}×)`)}`;
      })()
    : "";
  lines.push(
    truncateToWidth(
      `  ${th.fg("muted", "Runs:")} ${th.fg("text", String(st.results.length))}` +
        `  ${th.fg("success", `${kept} kept`)}` +
        confSuffix +
        (discarded > 0 ? `  ${th.fg("warning", `${discarded} discarded`)}` : "") +
        (crashed > 0 ? `  ${th.fg("error", `${crashed} crashed`)}` : "") +
        (checksFailed > 0 ? `  ${th.fg("error", `${checksFailed} checks failed`)}` : ""),
      width
    )
  );

  // Baseline: first run's primary metric
  const baselineSuffix = baselineRunNumber === null ? "" : ` #${baselineRunNumber}`;
  lines.push(
    truncateToWidth(
      `  ${th.fg("muted", "Baseline:")} ${th.fg("muted", `★ ${st.metricName}: ${formatNum(baseline, st.metricUnit)}${baselineSuffix}`)}`,
      width
    )
  );


  // Progress: best primary metric with delta + run number
  if (bestPrimary !== null) {
    let progressLine = `  ${th.fg("muted", "Progress:")} ${th.fg("warning", th.bold(`★ ${st.metricName}: ${formatNum(bestPrimary, st.metricUnit)}`))}${th.fg("dim", ` #${bestRunNum}`)}`;

    if (baseline !== null && baseline !== 0 && bestPrimary !== baseline) {
      const pct = ((bestPrimary - baseline) / baseline) * 100;
      const sign = pct > 0 ? "+" : "";
      const color = isBetter(bestPrimary, baseline, st.bestDirection) ? "success" : "error";
      progressLine += th.fg(color, ` (${sign}${pct.toFixed(1)}%)`);
    }

    lines.push(truncateToWidth(progressLine, width));

    // Progress secondary metrics — wrap into lines that fit width, indented
    if (st.secondaryMetrics.length > 0) {
      const indent = "            "; // 12 chars to align under progress value
      const maxLineW = width - 2 - indent.length; // 2 for leading "  "

      // Build individually-colored parts
      const secParts: string[] = [];
      for (const sm of st.secondaryMetrics) {
        const val = bestSecondary[sm.name];
        const bv = baselineSec[sm.name];
        if (val !== undefined) {
          let part = th.fg("muted", `${sm.name}: ${formatNum(val, sm.unit)}`);
          if (bv !== undefined && bv !== 0 && val !== bv) {
            const p = ((val - bv) / bv) * 100;
            const s = p > 0 ? "+" : "";
            const c = val <= bv ? "success" : "error";
            part += th.fg(c, ` ${s}${p.toFixed(1)}%`);
          }
          secParts.push(part);
        }
      }

      // Flow-wrap parts into lines
      if (secParts.length > 0) {
        let curLine = "";
        let curVisW = 0;
        for (const part of secParts) {
          const partVisW = visibleWidth(part);
          const sep = curLine ? "  " : "";
          if (curLine && curVisW + sep.length + partVisW > maxLineW) {
            lines.push(truncateToWidth(`  ${th.fg("dim", indent)}${curLine}`, width));
            curLine = part;
            curVisW = partVisW;
          } else {
            curLine += sep + part;
            curVisW += sep.length + partVisW;
          }
        }
        if (curLine) {
          lines.push(truncateToWidth(`  ${th.fg("dim", indent)}${curLine}`, width));
        }
      }
    }
  }

  lines.push("");

  // Determine visible rows once — used for both column sizing and rendering
  const effectiveMax = maxRows <= 0 ? st.results.length : maxRows;
  const startIdx = Math.max(0, st.results.length - effectiveMax);
  const rowsToRender = st.results.slice(startIdx);

  // Only show secondary metric columns that have at least one value in rendered rows
  const secMetrics = st.secondaryMetrics.filter((sm) =>
    rowsToRender.some((r) => (r.metrics ?? {})[sm.name] !== undefined)
  );

  // Column definitions
  // Primary column: "★ " prefix (2 visible) + metric name + 1 padding, clamped to 25% of width
  const primaryLabel = "★ " + (st.metricName || "metric");
  const primaryW = Math.max(11, Math.min(Math.floor(width * 0.25), visibleWidth(primaryLabel) + 1));
  // Changed from upstream (I8): the run number's column was 3 wide, so from run 100 the
  // number ran into the commit ("100abc1234"); it now fits the highest number and a space.
  const col = { idx: Math.max(3, String(st.results.length).length + 1), commit: 8, primary: primaryW, status: 15 };
  const minDescW = Math.max(10, Math.floor(width * 0.25));
  const fixedW = col.idx + col.commit + col.primary + col.status + 6;

  // Compute each secondary column width from actual content: max(name, widest value) + 1 padding
  const secColWidths: number[] = secMetrics.map((sm) => {
    let maxW = visibleWidth(sm.name);
    for (const r of rowsToRender) {
      const val = (r.metrics ?? {})[sm.name];
      if (val !== undefined) {
        maxW = Math.max(maxW, visibleWidth(formatNum(val, sm.unit)));
      }
    }
    return maxW + 1;
  });

  const totalSecWidth = () => secColWidths.slice(0, visibleSecMetrics.length).reduce((a, b) => a + b, 0);

  // Drop secondary columns from the right until they fit
  let visibleSecMetrics = secMetrics;
  while (visibleSecMetrics.length > 0 && totalSecWidth() > width - fixedW - minDescW) {
    visibleSecMetrics = visibleSecMetrics.slice(0, -1);
  }

  const descW = Math.max(minDescW, width - fixedW - totalSecWidth());

  // Table header — primary metric name bolded with ★
  let headerLine =
    `  ${th.fg("muted", "#".padEnd(col.idx))}` +
    `${th.fg("muted", "commit".padEnd(col.commit))}` +
    `${th.fg("warning", th.bold(truncateToWidth(primaryLabel, col.primary - 1).padEnd(col.primary)))}`;

  for (let si = 0; si < visibleSecMetrics.length; si++) {
    const sm = visibleSecMetrics[si];
    headerLine += th.fg(
      "muted",
      sm.name.padEnd(secColWidths[si])
    );
  }

  headerLine +=
    `${th.fg("muted", "status".padEnd(col.status))}` +
    `${th.fg("muted", "description")}`;

  lines.push(
    headerHints.length > 0
      ? appendRightAlignedAdaptiveHint(headerLine, width, th, headerHints)
      : truncateToWidth(headerLine, width, "…", true)
  );
  lines.push(
    truncateToWidth(
      `  ${th.fg("borderMuted", "─".repeat(Math.max(0, width - 4)))}`,
      width
    )
  );

  // Baseline values for delta display (current segment only)
  const baselinePrimary = findBaselineMetric(st.results, st.currentSegment);
  const baselineSecondary = findBaselineSecondary(
    st.results,
    st.currentSegment,
    st.secondaryMetrics
  );

  // Show max 6 recent runs, with a note about hidden earlier ones
  if (startIdx > 0) {
    lines.push(
      truncateToWidth(
        `  ${th.fg("dim", `… ${startIdx} earlier run${startIdx === 1 ? "" : "s"}`)}`,
        width
      )
    );
  }

  const baselineIndex = st.results.findIndex((x) => x.segment === st.currentSegment);

  for (let i = startIdx; i < st.results.length; i++) {
    const r = st.results[i];
    const isOld = r.segment !== st.currentSegment;
    const isBaseline = !isOld && i === baselineIndex;

    const color = isOld
      ? "dim"
      : r.status === "keep"
        ? "success"
        : r.status === "crash" || r.status === "checks_failed"
          ? "error"
          : "warning";

    // Primary metric with color coding
    const primaryStr = formatNum(r.metric, st.metricUnit);
    let primaryColor: Parameters<typeof th.fg>[0] = isOld ? "dim" : "text";
    if (!isOld) {
      if (isBaseline) {
        primaryColor = "text"; // baseline row — normal text
      } else if (
        baselinePrimary !== null &&
        r.status === "keep" &&
        r.metric > 0
      ) {
        if (isBetter(r.metric, baselinePrimary, st.bestDirection)) {
          primaryColor = "success";
        } else if (r.metric !== baselinePrimary) {
          primaryColor = "error";
        }
      }
    }

    const idxStr = th.fg("dim", String(i + 1).padEnd(col.idx));
    const commitStr = isOld
      ? "(old)".padEnd(col.commit)
      : r.status !== "keep"
        ? "—".padStart(Math.ceil(col.commit / 2)).padEnd(col.commit)
        : r.commit.padEnd(col.commit);

    let rowLine =
      `  ${idxStr}` +
      `${th.fg(isOld ? "dim" : "accent", commitStr)}` +
      `${th.fg(primaryColor, isOld ? primaryStr.padEnd(col.primary) : th.bold(primaryStr.padEnd(col.primary)))}`;

    // Secondary metrics (only visible columns)
    const rowMetrics = r.metrics ?? {};
    for (let si = 0; si < visibleSecMetrics.length; si++) {
      const sm = visibleSecMetrics[si];
      const colW = secColWidths[si];
      const val = rowMetrics[sm.name];
      if (val !== undefined) {
        const secStr = formatNum(val, sm.unit);
        let secColor: Parameters<typeof th.fg>[0] = "dim";
        if (!isOld) {
          const bv = baselineSecondary[sm.name];
          if (isBaseline) {
            secColor = "text";
          } else if (bv !== undefined && bv !== 0) {
            secColor = val <= bv ? "success" : "error";
          }
        }
        rowLine += th.fg(secColor, secStr.padEnd(colW));
      } else {
        rowLine += th.fg("dim", "—".padEnd(colW));
      }
    }

    rowLine +=
      `${th.fg(color, r.status.padEnd(col.status))}` +
      `${th.fg("muted", r.description.slice(0, descW))}`;

    lines.push(truncateToWidth(rowLine, width));
  }

  return lines;
}

// ---------------------------------------------------------------------------
// The widget's and the overlay's own lines (drawn inline upstream)
// ---------------------------------------------------------------------------

// ported from pi-autoresearch@939ede8 index.ts:1270
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ported from pi-autoresearch@939ede8 index.ts:1416-1430: the widget before the first
// logged result, while a run is going
export function widgetRunningLine(
  state: Pick<ExperimentState, "name">,
  runningExperiment: { command: string } | null,
  width: number,
  theme: Theme,
): string {
  const safeWidth = Math.max(1, width);
  const runningLine = joinPartsToWidth(
    [
      theme.fg("accent", "🔬"),
      theme.fg("warning", " running…"),
      state.name ? theme.fg("dim", ` │ ${state.name}`) : "",
      theme.fg("dim", ` │ ${runningExperiment?.command ?? ""}`),
      theme.fg("dim", " │ waiting for first logged result"),
    ],
    safeWidth
  );
  return runningLine;
}

// ported from pi-autoresearch@939ede8 index.ts:1437-1463: the widget with results
export function widgetLines(
  state: ExperimentState,
  width: number,
  theme: Theme,
  headerHints: string[],
): string[] {
  const safeWidth = Math.max(1, width);
  const title = truncateDisplayText(
    `🔬 autoresearch${state.name ? `: ${state.name}` : ""}`,
    Math.max(0, safeWidth - 5)
  );
  const fillLen = Math.max(0, safeWidth - 3 - 1 - visibleWidth(title) - 1);
  const rows = safeWidth < 95 ? 4 : 6;

  return [
    truncateToWidth(
      theme.fg("borderMuted", "───") +
        theme.fg("accent", ` ${title} `) +
        theme.fg("borderMuted", "─".repeat(fillLen)),
      safeWidth,
      "…",
      true
    ),
    ...renderDashboardLines(
      state,
      safeWidth,
      theme,
      rows,
      headerHints
    ),
  ];
}

// ported from pi-autoresearch@939ede8 index.ts:2621-2638 (buildOverlayContent)
export function overlayContent(
  state: ExperimentState,
  renderWidth: number,
  theme: Theme,
  runningExperiment: { startedAt: number } | null,
  now: number,
  spinnerFrame: number,
): string[] {
  const content = renderDashboardLines(state, renderWidth, theme, 0);
  if (runningExperiment) {
    content.push(overlaySpinnerLine(state.results.length + 1, spinnerFrame, now - runningExperiment.startedAt, renderWidth, theme));
  }
  return content;
}

// ported from pi-autoresearch@939ede8 index.ts:2624-2635 (the spinner row)
export function overlaySpinnerLine(
  nextIdx: number,
  spinnerFrame: number,
  elapsedMs: number,
  renderWidth: number,
  theme: Theme,
): string {
  const elapsed = formatElapsed(elapsedMs);
  const frame = SPINNER[spinnerFrame % SPINNER.length];
  return truncateToWidth(
    `  ${theme.fg("dim", String(nextIdx).padEnd(Math.max(3, String(nextIdx).length + 1)))}` + // I8
      theme.fg("warning", `${frame} running… ${elapsed}`),
    renderWidth,
    "…",
    true
  );
}

// ported from pi-autoresearch@939ede8 index.ts:2667-2673 (the title row)
export function overlayTitleLine(state: Pick<ExperimentState, "name">, innerWidth: number, theme: Theme): string {
  const title = truncateDisplayText(
    `🔬 autoresearch${state.name ? `: ${state.name}` : ""}`,
    Math.max(0, innerWidth - 2)
  );
  return ` ${theme.fg("accent", title)}`;
}

// ported from pi-autoresearch@939ede8 index.ts:2679-2684 (the footer's help and position)
export function overlayHelpText(
  safeWidth: number,
  scrollOffset: number,
  viewportRows: number,
  totalRows: number,
): string {
  const scrollInfo = totalRows > viewportRows
    ? ` ${scrollOffset + 1}-${Math.min(scrollOffset + viewportRows, totalRows)}/${totalRows}`
    : "";
  const helpText = safeWidth >= 85
    ? ` ↑↓/j/k scroll • pgup/pgdn • g/G • esc close${scrollInfo} `
    : ` j/k scroll • esc close${scrollInfo} `;
  return helpText;
}
