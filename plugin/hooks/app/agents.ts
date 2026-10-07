// I14: agents beside the loop. Upstream has one agent. Here Claude can start subagents,
// workflow agents and teammates, and the loop is only safe with one of them changing the
// working tree between a keep or discard and the next: a discard's `git checkout` and
// `git clean` would wipe what a background agent is still writing, a keep's `git add -A`
// would commit it half-done, and a benchmark would measure a tree that is still changing.

import type { Ctx } from "./context.ts";

/** tool.call's refusal of our tools in a subagent's loop. */
export const SUBAGENT_DENY =
  "autoresearch tools run in the main session only: a subagent can't run or log experiments. Report your findings back instead.";

/** The transcript line that tells the person a subagent was refused. */
export const subagentRefusedLine = (tool: string): string =>
  `A subagent called ${tool} and was refused; the experiment tools run in the main session only`;

/** Refuses a subagent's call to one of our tools, telling the person once per subagent. */
export function refuseSubagent(ctx: Ctx, tool: string, agentId: string): { deny: string } {
  if (!ctx.refusedAgents.has(agentId)) {
    ctx.refusedAgents.add(agentId);
    ctx.host.log(subagentRefusedLine(tool));
  }
  return { deny: SUBAGENT_DENY };
}

const LOOP_RUNS_ALONE = "autoresearch mode is on, and the loop runs one experiment at a time";

export const WORKFLOW_DENY = `${LOOP_RUNS_ALONE}: workflow agents keep working in the background, so they are refused while it is on. Use a foreground subagent, or turn the mode off with /autoresearch off.`;

export const TEAMMATE_DENY = `${LOOP_RUNS_ALONE}: teammates keep working in the background, so they are refused while it is on. Use a foreground subagent, or turn the mode off with /autoresearch off.`;

/** What agent.spawn tells about the agent about to start. */
export interface SpawnFacts {
  background: boolean;
  isWorkflow: boolean;
  isTeammate: boolean;
}

/** null: let it start as asked; `foreground`: start it in the foreground; `deny`: refuse it. */
export type SpawnDecision = null | { foreground: true } | { deny: string };

export function spawnDecision(ctx: Ctx, spawn: SpawnFacts): SpawnDecision {
  if (!ctx.runtime.autoresearchMode) return null;
  if (spawn.isWorkflow) return { deny: WORKFLOW_DENY };
  if (spawn.isTeammate) return { deny: TEAMMATE_DENY };
  if (spawn.background) return { foreground: true };
  return null;
}
