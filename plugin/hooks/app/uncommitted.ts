// Not in upstream (I10): before the loop starts over uncommitted changes, the person is
// told which files they are and what may happen to them. Upstream's keep runs
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

/** The uncommitted changes in workDir, or null when git can't say (not a repository, no git). */
export async function uncommittedChanges(host: Host, workDir: string): Promise<UncommittedChange[] | null> {
  const status = await host
    .run(["git", "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", ".", ...SESSION_FILES], {
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
