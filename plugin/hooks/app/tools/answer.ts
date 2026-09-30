import type { ToolDetails } from "../host.ts";

/**
 * What a tool's execute answers: `result` is the text the model reads (upstream's
 * content[0].text), `context` the hook steers the model reads after it (upstream sent
 * them with deliverAs "steer", F3), `details` what the tool's rows draw from.
 */
export interface ToolAnswer {
  result: string;
  context?: string[];
  details?: ToolDetails;
}
