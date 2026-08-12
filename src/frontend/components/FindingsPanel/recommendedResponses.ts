import type { AnomalyType } from '../../../shared/protocol.js';

/**
 * Static, catalog-derived one-line "what to do next" copy per {@link AnomalyType}.
 *
 * The strings distill the **Recommended response.** paragraph of each type's
 * section in `docs/reference/findings.md` (the canonical findings catalog,
 * shipped via #702). They close the attention-routing loop on the card itself so
 * an operator does not have to open the docs or guess the next action.
 *
 * Discipline (issue #2396):
 * - Compile-time: `Record<AnomalyType, string>` forces exactly one entry per
 *   union member — adding a new anomaly type without copy fails `tsc`.
 * - Runtime: `recommendedResponses.test.ts` asserts every `ANOMALY_TYPES` key
 *   maps to non-empty, ≤120-char copy (no silent empty product).
 * - Static only: no network / docs fetch at runtime. Copy is hand-maintained and
 *   kept short (one line) so the card never grows taller than useful.
 */
export const RECOMMENDED_RESPONSES: Record<AnomalyType, string> = {
  needs_input:
    'Read the explanation, check the terminal if needed, then send a reply or hint.',
  permission_blocked: "Approve or deny the blocked tool in the agent's terminal.",
  repeated_error:
    'Send a hint that breaks the loop: a corrected command, a missing dependency, or a new approach.',
  merge_conflict:
    'Resolve the conflict — guide the agent to fix the files, or fix them in the working tree yourself.',
  stale_agent:
    "Inspect the terminal; nudge the agent, or stop and relaunch if it's hung or has exited.",
  hook_disconnected:
    "Check the agent's hooks are installed and pointed at this Kookr instance.",
  hook_missing: "Install and configure the Kookr hooks for this agent's session.",
  hook_parse_degraded:
    'Check the hook writer / adapter payload shape — an agent or schema change may be breaking records.',
  backend_unreachable:
    "Check the dtach backend and socket dir; stop and relaunch the task if it's wedged.",
  api_error:
    'Fix provider credentials or billing for auth errors; retry the turn for transient ones.',
  budget_exceeded:
    'Decide whether the spend is justified — stop or redirect the task, or acknowledge and continue.',
};

/**
 * Recommended-response copy for an anomaly type, or `undefined` when the type is
 * absent (defensive — `undefined` input, or a wire value outside the union).
 */
export function recommendedResponseFor(
  type: AnomalyType | undefined,
): string | undefined {
  if (!type) return undefined;
  return RECOMMENDED_RESPONSES[type];
}
