/**
 * Contract for `GET /api/tasks/recent-prompts` — the manual-launch prompt recall
 * surfaced in the Launch dialog (RFC: rfc-launch-prompt-recall).
 *
 * The endpoint returns the most recent *distinct* prompts the operator has sent
 * via a manual launch (`provenance.kind === 'manual'`), so the dialog can refill
 * the Task description without retyping or authoring a playbook. Prompt bodies
 * are the same ones the same-origin dashboard already obtains via
 * `GET /api/tasks?view=full`; this projection returns only distinct, capped,
 * ranked strings (kilobytes, not the ~MB full list).
 */

/** Default page size when the caller supplies no `limit`. */
export const RECENT_PROMPTS_DEFAULT_LIMIT = 20;
/** Hard cap on `limit`; larger requests are clamped down to this. */
export const RECENT_PROMPTS_MAX_LIMIT = 50;

/** One recalled prompt, deduped on its display text across all its launches. */
export interface RecentPromptEntry {
  /**
   * The display prompt (`displayPromptForTask`): prefers `userPrompt`, strips the
   * worktree-guardrail preamble, falls back to the legacy `prompt`. Never carries
   * Kookr's injected guidance.
   */
  prompt: string;
  /** The most-recent launch's working directory — drives the "in <repo>" tag. */
  cwd: string;
  /** The most-recent launch's `createdAt`, epoch ms. Recency ordering + display. */
  at: number;
  /**
   * True when *any* launch of this prompt used the (canonicalized) working
   * directory the caller asked to prioritize. Ranked ahead of non-matches so a
   * prompt tied to the current repo surfaces first even if last run elsewhere.
   */
  cwdMatch: boolean;
}

function isRecentPromptEntry(value: unknown): value is RecentPromptEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.prompt === 'string' &&
    typeof v.cwd === 'string' &&
    typeof v.at === 'number' &&
    typeof v.cwdMatch === 'boolean'
  );
}

/**
 * Parse a `GET /api/tasks/recent-prompts` response body. Returns the entries on
 * a well-formed array, or `null` on anything else (non-array, wrong shape) so the
 * client can fail closed to "no recall available" without throwing.
 */
export function parseRecentPromptsResponse(body: unknown): RecentPromptEntry[] | null {
  if (!Array.isArray(body)) return null;
  const out: RecentPromptEntry[] = [];
  for (const item of body) {
    if (!isRecentPromptEntry(item)) return null;
    out.push({ prompt: item.prompt, cwd: item.cwd, at: item.at, cwdMatch: item.cwdMatch });
  }
  return out;
}
