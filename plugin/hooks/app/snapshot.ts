// Not in upstream (I10): log_experiment commits or reverts only the experiment's changes.
// pi's keep runs `git add -A && git commit` and its discard `git checkout -- .` and
// `git clean -fd`, so on a tree with uncommitted work a keep commits that work into the
// experiment's commit and a discard erases it. Here every iteration starts from a
// snapshot of the working tree, taken when the mode turns on and after each
// log_experiment:
// - the snapshot is the tracked files' contents, as a tree written from a copy of the
//   index (the real index is never touched), and the list of untracked files;
// - a discard restores the tracked files that changed from that tree, and deletes files
//   that weren't there;
// - a keep commits those changes onto HEAD through a private index. Where a file already
//   had uncommitted edits, only the experiment's own hunks are committed; when they don't
//   apply on their own, the whole file is, and the result says so.
// The session files (.auto/, autoresearch.*) are never reverted and are committed on a
// keep, as upstream does. Ignored files are never touched. Changes to an untracked file
// that was already there can't be told apart, so they are left as they are.

import { AUTO_DIR } from "../upstream/paths-core.ts";
import { posix as path } from "../upstream/vendor/path.js";
import type { Ctx } from "./context.ts";
import type { Host } from "./host.ts";

export interface TreeSnapshot {
  /** The tracked files' contents when the iteration started (a git tree). */
  tree: string;
  /** Untracked, unignored files then, from the repository root. */
  untracked: string[];
}

interface Repo {
  top: string;
  gitDir: string;
  /** The workDir from the repository root, with a trailing slash ("" at the root). */
  prefix: string;
  /** Names this workDir's files in the git directory. */
  key: string;
}

// The revert's own exclusions, as pathspecs (REVERT_SCRIPT).
export const SESSION_FILE_EXCLUDES = [
  `:(exclude,glob)**/${AUTO_DIR}`,
  `:(exclude,glob)**/${AUTO_DIR}/**`,
  ":(exclude,glob)**/autoresearch.*",
  ":(exclude,glob)**/autoresearch.*/**",
];
const SESSION_FILES = [`:(glob)**/${AUTO_DIR}/**`, ":(glob)**/autoresearch.*", ":(glob)**/autoresearch.*/**"];

const GIT_TIMEOUT_MS = 60000;
const SUBMODULE = "160000";

const nulList = (paths: readonly string[]): string => paths.map((p) => `${p}\0`).join("");
const splitNul = (text: string): string[] => text.split("\0").filter(Boolean);

function hashOf(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  return hash.toString(16);
}

async function repoOf(host: Host, workDir: string): Promise<Repo | null> {
  const result = await host
    .run(["git", "rev-parse", "--show-toplevel", "--absolute-git-dir", "--show-prefix"], { cwd: workDir, timeoutMs: GIT_TIMEOUT_MS })
    .catch(() => null);
  if (!result || result.exitCode !== 0) return null;
  const [top, gitDir, prefix = ""] = result.stdout.split("\n");
  if (!top || !gitDir) return null;
  return { top, gitDir, prefix, key: hashOf(workDir) };
}

/** git in the repository root, optionally on another index; rejects on a non-zero exit. */
async function git(
  host: Host,
  repo: Repo,
  args: string[],
  init: { index?: string; stdin?: string; allowFailure?: boolean } = {},
): Promise<string> {
  const argv = init.index ? ["env", `GIT_INDEX_FILE=${init.index}`, "git", ...args] : ["git", ...args];
  const result = await host.run(argv, { cwd: repo.top, stdin: init.stdin, timeoutMs: GIT_TIMEOUT_MS });
  if (result.exitCode !== 0 && !init.allowFailure) {
    throw new Error(`git ${args[0]} failed (exit ${result.exitCode}): ${(result.stdout + result.stderr).trim().slice(0, 200)}`);
  }
  return result.exitCode === 0 ? result.stdout : "";
}

/** The workDir's part of the repository, less the session files. */
const scope = (repo: Repo): string[] => [repo.prefix ? `:(top)${repo.prefix}` : ":/", ...SESSION_FILE_EXCLUDES];

const indexPath = (repo: Repo, name: string): string => `${repo.gitDir}/autoresearch-${name}-${repo.key}`;
const storePath = (repo: Repo): string => `${repo.gitDir}/autoresearch-snapshot-${repo.key}.json`;

/** The tracked files as they are now, as a tree, through a copy of the index. */
async function trackedTree(host: Host, repo: Repo): Promise<string> {
  const index = indexPath(repo, "tree-index");
  await host.remove(index);
  if (await host.exists(`${repo.gitDir}/index`)) {
    // -p: git re-reads a file changed in the second the index was written only when it
    // can compare with the index's own time, so the copy must keep it.
    await host.run(["cp", "-p", `${repo.gitDir}/index`, index], { cwd: repo.top, timeoutMs: GIT_TIMEOUT_MS });
  }
  try {
    await git(host, repo, ["add", "-u"], { index });
    return (await git(host, repo, ["write-tree"], { index })).trim();
  } finally {
    await host.remove(index).catch(() => undefined);
  }
}

async function untrackedFiles(host: Host, repo: Repo): Promise<string[]> {
  return splitNul(await git(host, repo, ["ls-files", "-z", "--others", "--exclude-standard", "--full-name", "--", ...scope(repo)]));
}

async function takeSnapshot(host: Host, repo: Repo): Promise<TreeSnapshot> {
  return { tree: await trackedTree(host, repo), untracked: await untrackedFiles(host, repo) };
}

/**
 * Snapshots the working tree as the iteration starts, and keeps a copy in the git
 * directory for a hot reload. Null outside a git repository or when git fails; log.ts
 * then uses upstream's commands.
 */
export async function snapshotWorkTree(ctx: Ctx, workDir: string): Promise<TreeSnapshot | null> {
  const repo = await repoOf(ctx.host, workDir);
  let snapshot: TreeSnapshot | null = null;
  if (repo) {
    snapshot = await takeSnapshot(ctx.host, repo).catch(() => null);
    if (snapshot) {
      const stored = JSON.stringify({ sessionId: ctx.sessionId, workDir, ...snapshot });
      await ctx.host.writeText(storePath(repo), stored).catch(() => undefined);
    }
  }
  ctx.snapshot = snapshot;
  return snapshot;
}

/** The snapshot this session last took for workDir, after a hot reload. */
export async function reloadSnapshot(ctx: Ctx, workDir: string): Promise<TreeSnapshot | null> {
  const repo = await repoOf(ctx.host, workDir);
  if (!repo) return null;
  try {
    const stored = JSON.parse((await ctx.host.readText(storePath(repo))) ?? "null") as
      | (TreeSnapshot & { sessionId: string; workDir: string })
      | null;
    if (stored && stored.sessionId === ctx.sessionId && stored.workDir === workDir && stored.tree) {
      return { tree: stored.tree, untracked: stored.untracked ?? [] };
    }
  } catch {
    // A copy we can't read is no copy.
  }
  return null;
}

interface Changes {
  /** Tracked files whose contents changed or which were deleted: restored on a discard. */
  changed: string[];
  /** Files that weren't there: deleted on a discard. */
  created: string[];
  /** Every path a keep commits, the session files apart. */
  all: string[];
  now: string;
}

async function changesSince(host: Host, repo: Repo, snapshot: TreeSnapshot): Promise<Changes> {
  const now = await trackedTree(host, repo);
  const raw = splitNul(await git(host, repo, ["diff-tree", "-r", "-z", "--no-renames", snapshot.tree, now, "--", ...scope(repo)]));
  const before = new Set(snapshot.untracked);
  const changed: string[] = [];
  const created: string[] = [];
  // Raw entries: ":<mode> <mode> <sha> <sha> <status>", then the path.
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const [oldMode, newMode, , , status] = raw[i]!.slice(1).split(" ");
    const file = raw[i + 1]!;
    if (oldMode === SUBMODULE || newMode === SUBMODULE) continue;
    // Added to the index since: new, unless it was an untracked file already.
    if (status === "A") {
      if (!before.has(file)) created.push(file);
    } else {
      changed.push(file);
    }
  }
  for (const file of await untrackedFiles(host, repo)) {
    if (!before.has(file) && !created.includes(file)) created.push(file);
  }
  return { changed, created, all: [...changed, ...created], now };
}

/** Removes `file` and the folders it leaves empty, up to the workDir. */
async function removeCreated(host: Host, repo: Repo, file: string): Promise<void> {
  await host.remove(`${repo.top}/${file}`);
  const stop = repo.prefix.replace(/\/$/, "");
  for (let dir = path.dirname(file); dir !== "." && dir !== stop && dir.startsWith(stop); dir = path.dirname(dir)) {
    const result = await host.run(["rmdir", `${repo.top}/${dir}`], { cwd: repo.top, timeoutMs: GIT_TIMEOUT_MS }).catch(() => null);
    if (!result || result.exitCode !== 0) break;
  }
}

/** A discard: the tree back to the snapshot, the session files and everything else left alone. */
export async function revertOwnChanges(host: Host, workDir: string, snapshot: TreeSnapshot): Promise<void> {
  const repo = await repoOf(host, workDir);
  if (!repo) throw new Error("not a git repository");
  const { changed, created } = await changesSince(host, repo, snapshot);
  if (changed.length > 0) {
    const index = indexPath(repo, "restore-index");
    try {
      await git(host, repo, ["read-tree", snapshot.tree], { index });
      await git(host, repo, ["checkout-index", "-f", "-z", "--stdin"], { index, stdin: nulList(changed) });
    } finally {
      await host.remove(index).catch(() => undefined);
    }
  }
  for (const file of created) await removeCreated(host, repo, file);
}

export interface CommitOutcome {
  /** False when there was nothing to commit. */
  committed: boolean;
  /** `git commit`'s output. */
  output: string;
  exitCode: number;
  /** Files with earlier uncommitted edits that had to be committed whole. */
  committedWhole: string[];
}

/** A keep: the experiment's changes and the session files, committed onto HEAD. */
export async function commitOwnChanges(host: Host, workDir: string, snapshot: TreeSnapshot, message: string): Promise<CommitOutcome> {
  const repo = await repoOf(host, workDir);
  if (!repo) throw new Error("not a git repository");
  const { changed, all, now } = await changesSince(host, repo, snapshot);
  const sessionFiles = splitNul(
    await git(host, repo, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--full-name", "--", ...SESSION_FILES.map((spec) => spec.replace(":(glob)", `:(glob,top)${repo.prefix}`))]),
  );

  const hasHead = (await host.run(["git", "rev-parse", "--verify", "-q", "HEAD"], { cwd: repo.top, timeoutMs: GIT_TIMEOUT_MS })).exitCode === 0;
  // A file whose snapshot already differed from HEAD holds earlier uncommitted edits.
  const edited = hasHead && changed.length > 0
    ? new Set(splitNul(await git(host, repo, ["--literal-pathspecs", "diff-tree", "-r", "-z", "--name-only", "--no-renames", "HEAD", snapshot.tree, "--", ...changed])))
    : new Set<string>();

  const index = indexPath(repo, "commit-index");
  const committedWhole: string[] = [];
  try {
    await git(host, repo, hasHead ? ["read-tree", "HEAD"] : ["read-tree", "--empty"], { index });
    const whole = [...all.filter((file) => !edited.has(file)), ...sessionFiles];
    for (const file of edited) {
      const patch = await git(host, repo, ["--literal-pathspecs", "diff", "--binary", snapshot.tree, now, "--", file]);
      const applied = await host.run(["env", `GIT_INDEX_FILE=${index}`, "git", "apply", "--cached", "--binary"], {
        cwd: repo.top,
        stdin: patch,
        timeoutMs: GIT_TIMEOUT_MS,
      });
      if (applied.exitCode !== 0) {
        committedWhole.push(file);
        whole.push(file);
      }
    }
    if (whole.length > 0) {
      await git(host, repo, ["--literal-pathspecs", "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], { index, stdin: nulList(whole) });
    }

    const unchanged = await host.run(["env", `GIT_INDEX_FILE=${index}`, "git", "diff", "--cached", "--quiet"], { cwd: repo.top, timeoutMs: GIT_TIMEOUT_MS });
    if (unchanged.exitCode === 0) return { committed: false, output: "", exitCode: 0, committedWhole: [] };

    const commit = await host.run(["env", `GIT_INDEX_FILE=${index}`, "git", "commit", "-m", message], { cwd: repo.top, timeoutMs: GIT_TIMEOUT_MS });
    const output = (commit.stdout + commit.stderr).trim();
    if (commit.exitCode === 0) {
      // The real index takes the new commit's entries for what was committed, and
      // nothing else, so earlier edits stay as they were: unstaged.
      await git(host, repo, ["--literal-pathspecs", "reset", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"], {
        stdin: nulList([...all, ...sessionFiles]),
        allowFailure: true,
      });
    }
    return { committed: true, output, exitCode: commit.exitCode, committedWhole };
  } finally {
    await host.remove(index).catch(() => undefined);
  }
}
