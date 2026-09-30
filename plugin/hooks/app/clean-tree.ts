// Not in upstream (I10): the loop only starts on a working tree with nothing to lose.
// A discard reverts with `git checkout -- .` and `git clean -fd` (REVERT_SCRIPT), which
// would also erase whatever was uncommitted before the loop began. The session files are
// spared by the revert and ignored files by `git clean`, so neither counts here.

import { AUTO_DIR } from "../upstream/paths-core.ts";
import type { Host } from "./host.ts";

// The revert's own exclusions, as pathspecs.
const SESSION_FILES = [
  `:(exclude,glob)**/${AUTO_DIR}`,
  `:(exclude,glob)**/${AUTO_DIR}/**`,
  ":(exclude,glob)**/autoresearch.*",
  ":(exclude,glob)**/autoresearch.*/**",
];

/**
 * The changes a discard in `workDir` would erase, as paths from the repository root, or
 * null when git can't say (not a repository, or no git).
 */
export async function uncommittedChanges(host: Host, workDir: string): Promise<string[] | null> {
  const result = await host
    .run(["git", "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", ".", ...SESSION_FILES], {
      cwd: workDir,
      timeoutMs: 10000,
    })
    .catch(() => null);
  if (!result || result.exitCode !== 0) return null;

  const paths: string[] = [];
  const entries = result.stdout.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    // A rename or copy is followed by the path it came from.
    if (entry[0] === "R" || entry[0] === "C") i++;
  }
  return paths;
}

const SHOWN_PATHS = 3;

/** Why the loop didn't start: from `/autoresearch`, or at a session start that would have turned it on. */
export function uncommittedNotice(paths: string[], from: "command" | "session"): string {
  const count = `${paths.length} uncommitted change${paths.length === 1 ? "" : "s"}`;
  const shown = paths.slice(0, SHOWN_PATHS).join(", ");
  const more = paths.length > SHOWN_PATHS ? ` and ${paths.length - SHOWN_PATHS} more` : "";
  return [
    `Autoresearch ${from === "command" ? "not started" : "left off"}: ${count} would be erased.`,
    `Every discarded experiment runs git checkout and git clean here, which would delete them (${shown}${more}).`,
    `Commit or stash them (git stash -u), or use a clean git worktree, then run /autoresearch ${from === "command" ? "again" : "to resume"}.`,
  ].join("\n");
}
