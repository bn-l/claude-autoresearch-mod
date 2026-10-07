// Not in upstream (I10): before the loop starts over uncommitted changes, the person is
// told which files they are and what may happen to them, and asked whether to stash them
// first, start anyway, or not start. Upstream's keep runs
// `git add -A && git commit` and its discard `git checkout -- .` and `git clean -fd`, so
// they may end up in the loop's commits or be undone for good. The session files
// (`.auto/`, `autoresearch.*`), which the revert spares, and ignored files, which
// `git clean -fd` leaves alone, are not listed.

import { AUTO_DIR } from "../upstream/paths-core.ts";
import type { Host } from "./host.ts";

export interface UncommittedChange {
  kind: "edited" | "new" | "deleted";
  /** From the repository root; an untracked folder ends with `/`. */
  path: string;
  /** For an untracked folder, the files in it. */
  files?: number;
}

// The revert's own exclusions, as pathspecs (REVERT_SCRIPT).
const SESSION_FILES = [
  `:(exclude,glob)**/${AUTO_DIR}`,
  `:(exclude,glob)**/${AUTO_DIR}/**`,
  ":(exclude,glob)**/autoresearch.*",
  ":(exclude,glob)**/autoresearch.*/**",
];

const GIT_TIMEOUT_MS = 10000;

/** What the warning lists and a stash takes: workDir, less the session files. */
const LISTED = [".", ...SESSION_FILES];

/** The uncommitted changes in workDir, or null when git can't say (not a repository, no git). */
export async function uncommittedChanges(host: Host, workDir: string): Promise<UncommittedChange[] | null> {
  const status = await host
    .run(["git", "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", ...LISTED], {
      cwd: workDir,
      timeoutMs: GIT_TIMEOUT_MS,
    })
    .catch(() => null);
  if (!status || status.exitCode !== 0) return null;

  const changes: UncommittedChange[] = [];
  const entries = status.stdout.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    const [x, y] = [entry[0], entry[1]];
    const path = entry.slice(3);
    // A rename or copy is followed by the path it came from.
    if (x === "R" || x === "C") i++;
    if (x === "?") changes.push({ kind: "new", path });
    else if (y === "D" || (x === "D" && y === " ")) changes.push({ kind: "deleted", path });
    else if (x === "A") changes.push({ kind: "new", path });
    else changes.push({ kind: "edited", path });
  }

  for (const change of changes) {
    if (!change.path.endsWith("/")) continue;
    const files = await host
      .run(["git", "ls-files", "-z", "--others", "--exclude-standard", "--", `:(top,literal)${change.path}`], {
        cwd: workDir,
        timeoutMs: GIT_TIMEOUT_MS,
      })
      .catch(() => null);
    if (files && files.exitCode === 0) change.files = files.stdout.split("\0").filter(Boolean).length;
  }
  return changes;
}

const SHOWN_PER_KIND = 5;
const LABELS = [
  ["edited", "Edited:   "],
  ["new", "New:      "],
  ["deleted", "Deleted:  "],
] as const;

const named = (change: UncommittedChange): string =>
  change.files === undefined ? change.path : `${change.path} (${change.files} file${change.files === 1 ? "" : "s"})`;

// ---------------------------------------------------------------------------
// `/autoresearch` asks what to do with them (I10), where someone can answer
// ---------------------------------------------------------------------------

export const UNCOMMITTED_STASH = "Stash them, then start";
export const UNCOMMITTED_START = "Start anyway";
export const UNCOMMITTED_CANCEL = "Don't start";
export const UNCOMMITTED_CHOICES = [UNCOMMITTED_STASH, UNCOMMITTED_START, UNCOMMITTED_CANCEL] as const;
/** The dialog's chip (12 characters at most). */
export const UNCOMMITTED_HEADER = "Uncommitted";
export const STASH_MESSAGE = "autoresearch: uncommitted changes set aside before the loop started";

const SHOWN_IN_QUESTION = 4;

/** The dialog's question: which changes, what may happen to them, and what to do. */
export function uncommittedQuestion(changes: UncommittedChange[]): string {
  const shown = changes.slice(0, SHOWN_IN_QUESTION).map(named).join(", ");
  const more = changes.length > SHOWN_IN_QUESTION ? ` and ${changes.length - SHOWN_IN_QUESTION} more` : "";
  const count = `${changes.length} uncommitted change${changes.length === 1 ? "" : "s"}`;
  return `${count} (${shown}${more}) may end up in autoresearch's commits or be permanently undone. What should happen to ${changes.length === 1 ? "it" : "them"} before the loop starts?`;
}

/** A stash this mod made: its commit (which names it whatever is stashed later), the branch, HEAD then. */
export interface MadeStash {
  commit: string;
  /** null on a detached HEAD. */
  branch: string | null;
  head: string;
}

/** One git command in workDir: its output, or null when it failed or couldn't start. */
export async function gitOut(host: Host, workDir: string, args: readonly string[]): Promise<string | null> {
  const result = await host.run(["git", ...args], { cwd: workDir, timeoutMs: GIT_TIMEOUT_MS }).catch(() => null);
  return result && result.exitCode === 0 ? result.stdout : null;
}

/**
 * `git stash push --include-untracked` of exactly what the warning lists: workDir less the
 * session files, which stay where they are. `git stash pop` brings them back. Resolves to
 * the stash once nothing listed is left, else to what went wrong (git can save a stash and
 * then fail to clean the tree, so what is left is checked rather than trusted).
 */
export async function stashChanges(host: Host, workDir: string): Promise<MadeStash | { error: string }> {
  const branch = (await gitOut(host, workDir, ["symbolic-ref", "--short", "-q", "HEAD"]))?.trim() || null;
  const head = (await gitOut(host, workDir, ["rev-parse", "HEAD"]))?.trim() ?? "";
  const stashed = await host
    .run(["git", "stash", "push", "--include-untracked", "--message", STASH_MESSAGE, "--", ...LISTED], {
      cwd: workDir,
      timeoutMs: 30000,
    })
    .catch((error: unknown) => ({ exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
  const left = await uncommittedChanges(host, workDir);
  const commit = stashed.exitCode === 0 ? (await gitOut(host, workDir, ["rev-parse", "-q", "--verify", "refs/stash"]))?.trim() : undefined;
  if (stashed.exitCode === 0 && left !== null && left.length === 0 && commit && head) return { commit, branch, head };
  const why = stashed.exitCode !== 0 ? stashed.stderr.trim() || `git stash exited with ${stashed.exitCode}` : "";
  const still = left?.length ? `${left.length} change${left.length === 1 ? " is" : "s are"} still there (${left.slice(0, SHOWN_IN_QUESTION).map(named).join(", ")})` : "";
  return { error: [why, still].filter(Boolean).join("; ") + ". Check `git stash list` before trying again." };
}

/** The warning, from `/autoresearch` (which asks to run it again) or a session start that turned the mode on. */
export function uncommittedWarning(changes: UncommittedChange[], from: "command" | "session"): string {
  const lines = [`⚠ ${changes.length} uncommitted change${changes.length === 1 ? "" : "s"}:`];
  for (const [kind, label] of LABELS) {
    const ofKind = changes.filter((change) => change.kind === kind);
    if (ofKind.length === 0) continue;
    const shown = ofKind.slice(0, SHOWN_PER_KIND).map(named).join(", ");
    const more = ofKind.length > SHOWN_PER_KIND ? ` and ${ofKind.length - SHOWN_PER_KIND} more` : "";
    lines.push(`  ${label}${shown}${more}`);
  }
  lines.push(
    "",
    "Autoresearch commits and reverts with git, so these may end up in its commits or be permanently undone.",
    "",
    from === "command"
      ? "Commit or stash them first (git stash -u), or run /autoresearch again to start anyway."
      : "Commit or stash them before continuing (git stash -u).",
  );
  return lines.join("\n");
}
