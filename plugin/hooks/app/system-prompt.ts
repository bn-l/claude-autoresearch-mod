// ported from pi-autoresearch@939ede8 index.ts:1522-1562 (before_agent_start): the
// addendum is appended to a system prompt section while the mode is on. Claude Code
// caches sections, so the text is recomputed as each prompt is submitted and the cache
// dropped only when the text changed (a mode flip, checks.sh or ideas.md appearing or
// going), which keeps the prompt cache warm as pi's static note did. The tools' snippets
// and guidelines, which pi puts in its own tools and rules sections, follow the
// addendum under the names the tools are served as (F1, F13).

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

/** Recomputes the addendum; drops the cached section only when its text changed. */
export async function refreshAddendum(ctx: Ctx): Promise<void> {
  let next: string | null;
  try {
    next = await computeAddendum(ctx);
  } catch {
    return;
  }
  if (next === ctx.addendum) return;
  ctx.addendum = next;
  ctx.host.invalidate("prompt.section");
}

/** The section's text with the addendum appended while the mode is on. */
export async function sectionWithAddendum(ctx: Ctx, base: string | null): Promise<string | null> {
  if (!ctx.runtime.autoresearchMode) return base;
  if (ctx.addendum === null) ctx.addendum = await computeAddendum(ctx).catch(() => null);
  if (ctx.addendum === null) return base;
  return (base ?? "") + ctx.addendum;
}
