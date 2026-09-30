// Upstream's renderers draw through a pi Theme, whose fg and bold wrap text in ANSI SGR
// (`ESC[<colour>m … ESC[39m`, `ESC[1m … ESC[22m`). `markerTheme` does the same with a
// private colour code per pi theme token, so pi's own width and truncation code (vendored)
// measures and cuts the lines exactly as in pi; `styledLines` then parses those lines into
// spans that Claude Code's Text draws in its theme's colours (the plan's mapping, §4.3).

import type { Theme, ThemeColor } from "../upstream/dashboard-lines.ts";

const TOKENS: readonly ThemeColor[] = [
  "accent", "warning", "success", "error", "muted", "dim", "text", "border", "borderMuted", "toolTitle",
];

/** pi theme token → Claude Code theme key (undefined: the default colour). */
export const THEME_KEY: Record<ThemeColor, string | undefined> = {
  text: "text",
  accent: "claude",
  success: "success",
  warning: "warning",
  error: "error",
  muted: "inactive",
  dim: "subtle",
  border: "inactive",
  borderMuted: "subtle",
  toolTitle: undefined,
};

/** The private SGR parameters a token is marked with: an RGB no theme draws. */
const markerOf = (token: ThemeColor): string => `38;2;1;2;${TOKENS.indexOf(token)}`;

export const markerTheme: Theme = {
  fg(color, text) {
    return `\x1b[${markerOf(color)}m${text}\x1b[39m`;
  },
  bold(text) {
    return `\x1b[1m${text}\x1b[22m`;
  },
};

/** A theme that draws nothing but the text (tests, plain surfaces). */
export const plainTheme: Theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

export interface Span {
  text: string;
  /** A Claude Code theme key. */
  color?: string;
  bold?: boolean;
}

interface Style {
  token: ThemeColor | null;
  bold: boolean;
}

/** Length of the escape sequence at `pos` (CSI up to its final byte, OSC/APC to ST or BEL). */
function escapeLength(text: string, pos: number): number {
  const next = text[pos + 1];
  if (next === "[") {
    for (let j = pos + 2; j < text.length; j++) {
      const code = text.charCodeAt(j);
      if (code >= 0x40 && code <= 0x7e) return j + 1 - pos;
    }
    return text.length - pos;
  }
  if (next === "]" || next === "_" || next === "P") {
    for (let j = pos + 2; j < text.length; j++) {
      if (text.charCodeAt(j) === 0x07) return j + 1 - pos;
      if (text[j] === "\x1b" && text[j + 1] === "\\") return j + 2 - pos;
    }
    return text.length - pos;
  }
  return Math.min(2, text.length - pos);
}

function applySgr(params: string, style: Style): void {
  if (params === "" || params === "0") {
    style.token = null;
    style.bold = false;
    return;
  }
  const marker = /^38;2;1;2;(\d+)$/.exec(params);
  if (marker) {
    style.token = TOKENS[Number(marker[1])] ?? null;
    return;
  }
  // Compound resets and the codes pi's theme uses; anything else (a benchmark's own
  // colours) is dropped and its text drawn in the style around it.
  for (const part of params.split(";")) {
    if (part === "0") {
      style.token = null;
      style.bold = false;
    } else if (part === "1") {
      style.bold = true;
    } else if (part === "22") {
      style.bold = false;
    } else if (part === "39") {
      style.token = null;
    }
  }
}

function spanOf(text: string, style: Style): Span {
  const span: Span = { text };
  const key = style.token ? THEME_KEY[style.token] : undefined;
  if (key) span.color = key;
  if (style.bold || style.token === "toolTitle") span.bold = true;
  return span;
}

/**
 * Parses marked text into lines of spans. Style carries across line breaks, as it does
 * on a terminal; tabs become three spaces, as pi-tui draws them.
 */
export function styledLines(text: string): Span[][] {
  const lines: Span[][] = [[]];
  const style: Style = { token: null, bold: false };
  let run = "";

  const flush = () => {
    if (run) lines[lines.length - 1].push(spanOf(run, style));
    run = "";
  };

  for (let i = 0; i < text.length; ) {
    const char = text[i];
    if (char === "\x1b") {
      const length = escapeLength(text, i);
      const sequence = text.slice(i, i + length);
      if (sequence.startsWith("\x1b[") && sequence.endsWith("m")) {
        flush();
        applySgr(sequence.slice(2, -1), style);
      }
      i += length;
      continue;
    }
    if (char === "\n") {
      flush();
      lines.push([]);
      i++;
      continue;
    }
    if (char === "\r") {
      i++;
      continue;
    }
    run += char === "\t" ? "   " : char;
    i++;
  }
  flush();
  return lines;
}

/** The text of spans, styles dropped (tests; plain rendering). */
export function plainTextOf(lines: Span[][]): string {
  return lines.map((line) => line.map((span) => span.text).join("")).join("\n");
}
