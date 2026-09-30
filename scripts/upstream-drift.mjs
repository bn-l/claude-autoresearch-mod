#!/usr/bin/env node
// Lists what upstream changed since the commit this port is taken from that touches
// what the port took (PLAN Phase 7): the regions named by provenance comments under
// plugin/ ("pi-autoresearch@939ede8 index.ts:1206-1221 and 1506-1513"), and the files
// copied whole (skills/, assets/, and tests/ for unit/). `scripts/sync-upstream.sh
// --check <sha>` runs it.
//
//   upstream-drift.mjs <sha-or-ref>     compare the ported commit with <sha-or-ref>
//
// Upstream is fetched (history and trees, blobs on demand) into a temporary bare
// repository from AUTORESEARCH_UPSTREAM_URL, by default GitHub. Exits 1 when something
// ported is touched, 2 on an error, 0 otherwise.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const URL_ = process.env.AUTORESEARCH_UPSTREAM_URL ?? "https://github.com/davebcn87/pi-autoresearch.git";
const SOURCE_DIR = "extensions/pi-autoresearch/";
/** Copied whole: a change here is picked up by a subtree pull and sync-upstream.sh (or by hand for tests/). */
const WHOLE = [/^skills\//, /^assets\/(template\.html|logo\.webp)$/, /^tests\//];

const target = process.argv[2];
if (!target) {
  console.error("usage: upstream-drift.mjs <sha-or-ref>");
  process.exit(2);
}

// -- the provenance comments ----------------------------------------------------------

const RANGE = String.raw`\d+(?:-\d+)?`;
const REF = new RegExp(
  String.raw`pi-autoresearch@([0-9a-f]{7,40})(?:\s|\n\s*(?:\/\/|\*))+(?:${SOURCE_DIR})?([\w.-]+\.(?:ts|mjs|js)):(${RANGE}(?:(?:,\s*|\s+and\s+)${RANGE})*)`,
  "g",
);

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "skills", "assets", ".claude-plugin"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.(ts|tsx|mjs|js|sh)$/.test(entry.name)) yield path;
  }
}

/** Every region a comment names: { base, file, from, to, where }. */
function portedRegions() {
  const regions = [];
  for (const path of sourceFiles(join(ROOT, "plugin"))) {
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(REF)) {
      const line = text.slice(0, match.index).split("\n").length;
      const where = `${relative(ROOT, path)}:${line}`;
      for (const range of match[3].split(/,\s*|\s+and\s+/)) {
        const [from, to = from] = range.split("-").map(Number);
        regions.push({ base: match[1], file: match[2], from, to, where });
      }
    }
  }
  return regions;
}

// -- upstream -------------------------------------------------------------------------

const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

function fetchUpstream(repo, refs) {
  execFileSync("git", ["init", "--bare", "-q", repo]);
  git(repo, "fetch", "-q", "--filter=blob:none", URL_, "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*");
  for (const ref of refs) {
    try {
      git(repo, "rev-parse", "-q", "--verify", `${ref}^{commit}`);
    } catch {
      // a commit on no branch (a pull request's, say) is fetched by its full sha
      git(repo, "fetch", "-q", "--filter=blob:none", URL_, ref);
    }
  }
  return refs.map((ref) => git(repo, "rev-parse", "--verify", `${ref}^{commit}`).trim());
}

/** The changed lines of `file` between the commits, as old-side hunks { from, count }. */
function hunks(repo, base, head, file) {
  const diff = git(repo, "diff", "-U0", "--no-color", "--no-ext-diff", base, head, "--", file);
  const found = [];
  for (const line of diff.split("\n")) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) found.push({ from: Number(match[1]), count: match[2] === undefined ? 1 : Number(match[2]), text: line.replace(/ @@.*/, " @@") });
  }
  return found;
}

/** A hunk touches a region when it changes a line of it or inserts inside it. */
function touches(hunk, region) {
  if (hunk.count === 0) return hunk.from >= region.from && hunk.from < region.to;
  return hunk.from <= region.to && hunk.from + hunk.count - 1 >= region.from;
}

// -- the report -----------------------------------------------------------------------

const regions = portedRegions();
const bases = [...new Set(regions.map((region) => region.base))];
if (bases.length !== 1) {
  console.error(`upstream-drift: provenance comments name ${bases.length} commits (${bases.join(", ")}); expected one`);
  process.exit(2);
}

const repo = mkdtempSync(join(tmpdir(), "autoresearch-drift-"));
let status = 0;
try {
  const [base, head] = fetchUpstream(repo, [bases[0], target]);
  console.log(`upstream ${base.slice(0, 7)}..${head.slice(0, 7)}: ${regions.length} ported regions`);

  const byFile = Map.groupBy(regions, (region) => region.file);
  const touched = [];
  for (const [file, fileRegions] of byFile) {
    const fileHunks = hunks(repo, base, head, SOURCE_DIR + file);
    for (const region of fileRegions) {
      const hits = fileHunks.filter((hunk) => touches(hunk, region));
      if (hits.length > 0) touched.push({ region, hits });
    }
  }
  if (touched.length > 0) {
    status = 1;
    console.log("\nported regions upstream changed:");
    for (const { region, hits } of touched) {
      const lines = region.from === region.to ? `${region.from}` : `${region.from}-${region.to}`;
      console.log(`  ${region.file}:${lines}  (${region.where})  ${hits.map((hunk) => hunk.text).join(" ")}`);
    }
  }

  const changed = git(repo, "diff", "--name-status", "--no-renames", base, head)
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
  const whole = changed.filter(([, path]) => WHOLE.some((pattern) => pattern.test(path)));
  const ported = new Set([...byFile.keys()].map((file) => SOURCE_DIR + file));
  const other = changed.filter(([, path]) => !WHOLE.some((pattern) => pattern.test(path)) && !ported.has(path));
  if (whole.length > 0) {
    status = 1;
    console.log("\ncopied whole, changed upstream (pull the subtree, run scripts/sync-upstream.sh; tests/ → unit/ by hand):");
    for (const [kind, path] of whole) console.log(`  ${kind} ${path}`);
  }
  if (other.length > 0) {
    console.log("\nother upstream changes (not ported):");
    for (const [kind, path] of other) console.log(`  ${kind} ${path}`);
  }
  if (status === 0) console.log("nothing ported has changed");
} catch (error) {
  console.error(`upstream-drift: ${error instanceof Error ? error.message.trim() : String(error)}`);
  status = 2;
} finally {
  rmSync(repo, { recursive: true, force: true });
}
process.exit(status);
