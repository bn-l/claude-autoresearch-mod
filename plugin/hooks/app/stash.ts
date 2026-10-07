// I19: the changes `/autoresearch` stashed before the loop started (I10) are offered back.
// When the loop clearly stops (the iteration cap, `/autoresearch off` or `clear`, the
// auto-resume limits) the person is asked: unstash now, or do it themselves with the
// command printed for them. Unstashing now is only recommended when it is safe: on the
// branch the changes came from, with nothing uncommitted, and no file the loop's commits
// changed among them. After Esc, or a turn that ends without the loop carrying on, a line
// in the transcript says where the changes are instead, once each time; a session that
// starts with them still stashed says so once.

import { canonicalPath, resolveWorkDir, type Ctx } from "./context.ts";
import { gitOut, uncommittedChanges, type MadeStash } from "./uncommitted.ts";

/** A stash this mod made, as kept in the store under the folder it was made in. */
export interface StashRecord extends MadeStash {
  /** How many uncommitted changes it set aside. */
  changes: number;
  stashedAt: number;
}

const STASH_KEY_PREFIX = "stash:";
const RECORDS_KEPT = 20;

export const UNSTASH_NOW = "Unstash now (recommended)";
export const UNSTASH_MYSELF = "I'll do it myself";
export const UNSTASH_MYSELF_RECOMMENDED = "I'll do it myself (recommended)";
export const UNSTASH_ANYWAY = "Unstash now anyway";
/** The dialog's chip (12 characters at most). */
export const UNSTASH_HEADER = "Stash";

const SHOWN_FILES = 4;

const keyOf = async (ctx: Ctx, workDir: string): Promise<string> => `${STASH_KEY_PREFIX}${await canonicalPath(ctx.host, workDir)}`;

const lines = (text: string | null): string[] => (text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);

const changesText = (n: number): string => `${n} change${n === 1 ? "" : "s"}`;
const areText = (n: number): string => (n === 1 ? "is" : "are");
const themText = (n: number): string => (n === 1 ? "it" : "them");

async function readRecords(ctx: Ctx, key: string): Promise<StashRecord[]> {
  const value = await ctx.host.storeGet(key).catch(() => undefined);
  return Array.isArray(value) ? (value as StashRecord[]).filter((record) => typeof record?.commit === "string") : [];
}

/** Keeps a stash just made, to offer it back when the loop stops. */
export async function rememberStash(ctx: Ctx, workDir: string, record: StashRecord): Promise<void> {
  const key = await keyOf(ctx, workDir);
  const records = [...(await readRecords(ctx, key)), record].slice(-RECORDS_KEPT);
  await ctx.host.storeSet(key, records).catch(() => undefined);
}

/** One of our stashes still in `git stash list`, with the ref that names it now. */
interface LiveStash {
  record: StashRecord;
  ref: string;
}

/** Our stashes in this folder that are still stashed, newest first; the rest are forgotten. */
async function liveStashes(ctx: Ctx, workDir: string): Promise<LiveStash[]> {
  const key = await keyOf(ctx, workDir);
  const records = await readRecords(ctx, key);
  if (records.length === 0) return [];
  const listed = await gitOut(ctx.host, workDir, ["stash", "list", "--format=%H"]);
  if (listed === null) return [];
  const commits = lines(listed);
  const live = records.filter((record) => commits.includes(record.commit));
  if (live.length !== records.length) await ctx.host.storeSet(key, live).catch(() => undefined);
  return live.map((record) => ({ record, ref: `stash@{${commits.indexOf(record.commit)}}` })).reverse();
}

async function forget(ctx: Ctx, workDir: string, commit: string): Promise<void> {
  const key = await keyOf(ctx, workDir);
  const records = (await readRecords(ctx, key)).filter((record) => record.commit !== commit);
  await ctx.host.storeSet(key, records).catch(() => undefined);
}

const currentBranch = async (ctx: Ctx, workDir: string): Promise<string | null> =>
  (await gitOut(ctx.host, workDir, ["symbolic-ref", "--short", "-q", "HEAD"]))?.trim() || null;

/** The command that brings a stash back: on its own branch, switched to first when the loop moved. */
function restoreCommand(stash: LiveStash, branch: string | null): string {
  const pop = `git stash pop ${stash.ref}`;
  return stash.record.branch && branch !== stash.record.branch ? `git switch ${stash.record.branch} && ${pop}` : pop;
}

/** The files in a stash: the tracked ones it changed and the untracked ones it took. */
async function stashedFiles(ctx: Ctx, workDir: string, commit: string): Promise<string[] | null> {
  const tracked = await gitOut(ctx.host, workDir, ["diff", "--name-only", "--no-renames", `${commit}^1`, commit]);
  if (tracked === null) return null;
  const files = lines(tracked);
  if ((await gitOut(ctx.host, workDir, ["rev-parse", "-q", "--verify", `${commit}^3`])) !== null) {
    const untracked = await gitOut(ctx.host, workDir, ["ls-tree", "-r", "--full-tree", "--name-only", `${commit}^3`]);
    if (untracked === null) return null;
    files.push(...lines(untracked));
  }
  return files;
}

const named = (files: string[]): string =>
  files.slice(0, SHOWN_FILES).join(", ") + (files.length > SHOWN_FILES ? ` and ${files.length - SHOWN_FILES} more` : "");

/** Why unstashing now isn't safe, or null when it is. */
async function unsafeBecause(ctx: Ctx, workDir: string, stash: LiveStash, branch: string | null): Promise<string | null> {
  const { record } = stash;
  if (record.branch === null) return "they were stashed on a detached HEAD";
  if (branch !== record.branch) return `the loop is on ${branch ?? "a detached HEAD"}, not ${record.branch}, where they came from`;
  const now = await uncommittedChanges(ctx.host, workDir);
  if (now === null) return "git couldn't say what is uncommitted now";
  if (now.length > 0) return `there are uncommitted changes now (${named(now.map((change) => change.path))})`;
  const stashed = await stashedFiles(ctx, workDir, record.commit);
  const changed = await gitOut(ctx.host, workDir, ["diff", "--name-only", "--no-renames", record.head, "HEAD"]);
  if (stashed === null || changed === null) return "git couldn't say what the loop changed";
  const loopChanged = new Set(lines(changed));
  const both = stashed.filter((file) => loopChanged.has(file));
  if (both.length > 0) return `the loop also changed ${named(both)}, so unstashing may conflict`;
  return null;
}

/** `git stash pop`, with what the person needs to know either way. */
async function popStash(ctx: Ctx, workDir: string, stash: LiveStash, branch: string | null): Promise<void> {
  const n = stash.record.changes;
  const result = await ctx.host
    .run(["git", "stash", "pop", stash.ref], { cwd: workDir, timeoutMs: 30000 })
    .catch((error: unknown) => ({ exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
  if (result.exitCode === 0) {
    await forget(ctx, workDir, stash.record.commit);
    ctx.host.notify(`Unstashed your ${changesText(n)} from before the loop`, "info");
    return;
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (/CONFLICT/.test(output)) {
    ctx.host.log(
      `Unstashing hit conflicts, so git kept the stash. Resolve them, then run \`git stash drop ${stash.ref}\`.`,
    );
    return;
  }
  const why = lines(result.stderr)[0] ?? `git stash pop exited with ${result.exitCode}`;
  ctx.host.log(`Couldn't unstash (${why}); the stash is kept. To try again: \`${restoreCommand(stash, branch)}\``);
}

/**
 * The line that tells the person where their changes are and how to bring them back, after
 * `intro` (a sentence) when there is one.
 */
function whereLine(intro: string | null, stash: LiveStash, branch: string | null, from = "the loop"): string {
  const n = stash.record.changes;
  const when = stash.record.branch && branch !== stash.record.branch ? ` once you're done with ${branch ?? "this branch"}` : "";
  const body = `${changesText(n)} from before ${from} ${areText(n)} in the stash. To bring ${themText(n)} back${when}, run \`${restoreCommand(stash, branch)}\`.`;
  return intro ? `${intro} Your ${body}` : `Your ${body}`;
}

/**
 * The loop clearly stopped: offer each stash of ours still there. Where no one can be asked
 * (`-p`, the SDK), print the command instead.
 */
export async function offerUnstash(ctx: Ctx): Promise<void> {
  if (ctx.unstashOffer) return ctx.unstashOffer;
  ctx.stashNoted = true;
  ctx.unstashOffer = (async () => {
    const workDir = await resolveWorkDir(ctx.host, await ctx.host.sessionCwd());
    const stashes = await liveStashes(ctx, workDir);
    if (stashes.length === 0) return;
    const branch = await currentBranch(ctx, workDir);
    const canAsk = await ctx.host.canAsk();
    for (const stash of stashes) {
      if (!canAsk) {
        ctx.host.log(whereLine("The loop has stopped.", stash, branch));
        continue;
      }
      const n = stash.record.changes;
      const unsafe = await unsafeBecause(ctx, workDir, stash, branch);
      const lead = `Your ${changesText(n)} from before the loop ${areText(n)} stashed`;
      const answer = unsafe
        ? await ctx.host.ask(`${lead}, but ${unsafe}. Bring ${themText(n)} back now anyway?`, [UNSTASH_MYSELF_RECOMMENDED, UNSTASH_ANYWAY], UNSTASH_HEADER)
        : await ctx.host.ask(`${lead}. Bring ${themText(n)} back now?`, [UNSTASH_NOW, UNSTASH_MYSELF], UNSTASH_HEADER);
      if (answer === UNSTASH_NOW || answer === UNSTASH_ANYWAY) await popStash(ctx, workDir, stash, branch);
      else ctx.host.log(whereLine(null, stash, branch));
    }
  })().finally(() => {
    ctx.unstashOffer = null;
  });
  return ctx.unstashOffer;
}

/**
 * The loop paused (Esc) or a turn ended without it carrying on: say where the changes are,
 * once each time; nothing is asked or done.
 */
export async function noteStash(ctx: Ctx, why: "paused" | "not-continuing"): Promise<void> {
  if (ctx.stashNoted) return;
  ctx.stashNoted = true;
  const workDir = await resolveWorkDir(ctx.host, await ctx.host.sessionCwd());
  const stashes = await liveStashes(ctx, workDir);
  const branch = stashes.length > 0 ? await currentBranch(ctx, workDir) : null;
  for (const stash of stashes) {
    if (why === "paused") {
      const n = stash.record.changes;
      ctx.host.log(
        `Paused. Your ${changesText(n)} from before the loop ${areText(n)} still stashed; you'll be asked about ${themText(n)} when the loop stops, or run \`${restoreCommand(stash, branch)}\` yourself.`,
      );
    } else {
      ctx.host.log(whereLine("The loop isn't carrying on.", stash, branch));
    }
  }
}

/** A session in a folder where our stashes are still there: say so, once. */
export async function remindStash(ctx: Ctx): Promise<void> {
  if (ctx.stashReminded) return;
  ctx.stashReminded = true;
  ctx.stashNoted = true;
  const workDir = await resolveWorkDir(ctx.host, await ctx.host.sessionCwd());
  const stashes = await liveStashes(ctx, workDir);
  const branch = stashes.length > 0 ? await currentBranch(ctx, workDir) : null;
  for (const stash of stashes) ctx.host.log(whereLine(null, stash, branch, "an earlier loop"));
}
