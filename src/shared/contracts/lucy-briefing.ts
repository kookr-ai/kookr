/**
 * Wire contract for the briefing Lucy writes to the operator when they open her panel or come
 * back to the dashboard. The server builds it from its own records with fixed sentence patterns
 * (`core/lucy-operator/operator-briefing.ts`); no model is called.
 */

/** `GET`: the briefing for the state of the work right now, as a {@link LucyBriefingResponse}. */
export const LUCY_BRIEFING_PATH = '/api/lucy/briefing';

export interface LucyBriefingResponse {
  /** What she writes, addressed to the operator: at most about 45 words, no ids, paths or prompts. Empty when nothing waits on the operator: she then writes nothing. */
  text: string;
  /** Up to three follow-up requests the operator can press. */
  chips: string[];
  /** Changes only when what waits on the operator changes; the panel uses it to avoid repeating a briefing. */
  signature: string;
  /** The server's clock when it was built (ms since epoch). */
  at: number;
}
