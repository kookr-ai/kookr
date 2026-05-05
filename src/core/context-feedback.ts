/**
 * Pure threshold helper for the context-window hook-feedback advisory.
 *
 * The advisory fires when a session's per-turn context-fill ratio crosses
 * the MODERATE band, defined as `triggerRatio * 2/3` (≈ 0.50 with the v5
 * cycler's default trigger of 0.75). The advisory does NOT fire above
 * `triggerRatio` — that's the cycler's territory; the cycler injects an
 * explicit user message there.
 *
 * Anchoring the band to the cycler's `triggerRatio` keeps a single tunable
 * knob across both subsystems: lower the cycler's threshold and the advisory
 * scales proportionally.
 *
 * See: docs/rfc/rfc-context-window-hook-feedback.md (PR-1 prerequisite).
 */

/** Band identifier: 0 means "below MODERATE" (advisory should not fire). */
export type AdvisoryBand = 0 | 50;

/**
 * Return the band the given fill ratio falls into.
 *
 * - Below `triggerRatio * 2/3`: returns `0` (no advisory).
 * - Between `triggerRatio * 2/3` (inclusive) and `triggerRatio` (exclusive):
 *   returns `50` (MODERATE — advisory should fire if not yet fired this epoch).
 * - At or above `triggerRatio`: returns `0` (cycler territory; advisory
 *   stays silent).
 *
 * The cycler-territory return is `0` rather than a separate band because
 * once the cycler is firing the agent will receive a real user message
 * from Kookr anyway — a passive hook advisory there would just add noise.
 *
 * Invalid inputs (non-finite, negative, triggerRatio out of (0, 1]) return 0.
 */
export function bandFor(ratio: number, triggerRatio: number): AdvisoryBand {
  if (!Number.isFinite(ratio) || !Number.isFinite(triggerRatio)) return 0;
  if (triggerRatio <= 0 || triggerRatio > 1) return 0;
  if (ratio <= 0) return 0;
  if (ratio >= triggerRatio) return 0;
  const moderateRatio = triggerRatio * (2 / 3);
  if (ratio >= moderateRatio) return 50;
  return 0;
}
