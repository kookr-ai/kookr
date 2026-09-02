import { apiFetch } from './client.js';

/**
 * The reflection recommendation the dashboard reads at bootstrap to decide
 * whether to nudge the operator to run a session reflection. Only the fields
 * the app root consumes are modeled here; the server's full response
 * (`ReflectionRecommendationResponse`) carries more. All fields are optional so
 * a partial or evolving payload never throws when a reader dereferences it.
 */
export interface ReflectionRecommendationPayload {
  sessionId?: string | null;
  report?: { totalInterventions?: number } | null;
  recommendation?: {
    shouldSuggest?: boolean;
    summary: string;
    sessionLabel: string;
    totalFindings?: number;
  } | null;
}

/**
 * GET the session-reflection recommendation, returning `null` on any non-2xx
 * response instead of throwing — matching the app root's original
 * `fetch(...).then(res => res.ok ? res.json() : null)`. A 2xx body that is not
 * JSON still rejects, exactly as the inline `res.json()` did, so the caller's
 * `.catch` keeps handling it.
 */
export async function getReflectionRecommendation(): Promise<ReflectionRecommendationPayload | null> {
  const res = await apiFetch('/api/reflect/recommendation');
  return res.ok ? ((await res.json()) as ReflectionRecommendationPayload) : null;
}
