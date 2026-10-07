// ported from pi-autoresearch@939ede8 index.ts:1522-1562 (before_agent_start): the
// addendum is this mod's own section of the system prompt while the mode is on (F13),
// added last, after Claude Code's own. The text is recomputed as each prompt is
// submitted, so each request reads it from memory, and it only changes with the session
// (a mode flip, checks.sh or ideas.md appearing or going), which keeps the prompt cache
// warm as pi's static note did. The tools' snippets and guidelines, which pi puts in its
// own tools and rules sections, follow the addendum under the names the tools are served
// as (F1).

import { addendumText, toolSectionsText } from "../upstream/experiment-core.ts";
import { resolveWorkDir, sessionFilesOf, type Ctx } from "./context.ts";

export async function computeAddendum(ctx: Ctx): Promise<string | null> {
  if (!ctx.runtime.autoresearchMode) return null;

  const cwd = await ctx.host.sessionCwd();
  const workDir = await resolveWorkDir(ctx.host, cwd);
  const files = await sessionFilesOf(ctx.host, workDir);
  const mdPath = files.path("prompt");
  const ideasPath = files.path("ideas");
  const checksPath = files.path("checks");

  let text = addendumText({
    mdPath,
    checksPath,
    ideasPath,
    hasChecks: files.exists(checksPath),
    hasIdeas: files.exists(ideasPath),
  });
  if (ctx.toolNames) text += toolSectionsText(ctx.toolNames);
  return text;
}

/** Recomputes the addendum (a failed lookup keeps the last one). */
export async function refreshAddendum(ctx: Ctx): Promise<void> {
  try {
    ctx.addendum = await computeAddendum(ctx);
  } catch {
    // keep the last one
  }
}

/** The mod's system prompt section while the mode is on; null while it is off. */
export async function addendumSection(ctx: Ctx): Promise<string | null> {
  if (!ctx.runtime.autoresearchMode) return null;
  if (ctx.addendum === null) ctx.addendum = await computeAddendum(ctx).catch(() => null);
  return ctx.addendum?.trim() || null;
}
