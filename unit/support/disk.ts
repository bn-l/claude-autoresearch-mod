// Upstream's disk-reading signatures over the ported cores, so upstream's unit tests run
// against plugin/hooks/upstream/* with only their import lines changed. Each function
// here does exactly the I/O the core had lifted out of it, with node:fs.
import * as fs from "node:fs";
import * as path from "node:path";

import * as paths from "../../plugin/hooks/upstream/paths-core.ts";
import * as compaction from "../../plugin/hooks/upstream/compaction-core.ts";
import * as hooks from "../../plugin/hooks/upstream/hooks-core.ts";

export { AUTO_DIR, sessionFileCandidates } from "../../plugin/hooks/upstream/paths-core.ts";
export {
  extractAutoresearchSessionName,
  hasAutoresearchConfigHeader,
  isAutoresearchConfigEntry,
  isAutoresearchRunEntry,
  parseJsonlEntry,
  reconstructJsonlState,
} from "../../plugin/hooks/upstream/jsonl.ts";

const exists = (filePath: string): boolean => fs.existsSync(filePath);

export function sessionFilePath(dir: string, kind: paths.SessionFileKind): string {
  return paths.sessionFilePath(dir, kind, exists);
}

export function hookScriptPath(workDir: string, stage: paths.HookStage): string {
  return paths.hookScriptPath(workDir, stage, exists);
}

export function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function autoresearchSummaryPathsFor(workDir: string): compaction.AutoresearchSummaryPaths {
  return compaction.autoresearchSummaryPathsFor(workDir, exists);
}

function readFileOrEmpty(filePath: string): string {
  if (!fs.existsSync(filePath)) return "";
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

export function buildAutoresearchCompactionSummary(summaryPaths: compaction.AutoresearchSummaryPaths): string {
  return compaction.buildAutoresearchCompactionSummary(summaryPaths, {
    jsonl: readFileOrEmpty(summaryPaths.jsonlPath),
    md: readFileOrEmpty(summaryPaths.mdPath),
    ideas: readFileOrEmpty(summaryPaths.ideasPath),
  });
}

export function appendHookLogEntryIfConfigured(
  jsonlPath: string,
  stage: hooks.HookStage,
  result: hooks.HookResult,
): boolean {
  const content = fs.existsSync(jsonlPath) ? fs.readFileSync(jsonlPath, "utf-8") : null;
  const line = hooks.hookLogLineIfConfigured(content, stage, result);
  if (line === null) return false;
  try {
    fs.appendFileSync(jsonlPath, line);
    return true;
  } catch {
    return false;
  }
}
