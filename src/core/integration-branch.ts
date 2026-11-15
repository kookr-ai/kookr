/**
 * Parser for the `integrationBranch` field of `.kookr/delivery-gate.json`
 * (#3788). Pure, so the integration train (which must not import I/O modules)
 * and the server share one implementation. Mirrors
 * `delivery_gate_integration_branch` in scripts/lib/delivery-gate.sh; the
 * reader that finds the file is in ./delivery-gate-config.ts.
 */

/** The branch the train promotes to; it can never be the integration branch. */
export const TRAIN_TARGET_BRANCH = 'main';

/**
 * The integration branch named by a delivery-gate config, or null. Rejects
 * anything git would parse as an option or a range, and `main` itself.
 */
export function parseIntegrationBranch(configJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return null;
  }
  const branch = (parsed as { integrationBranch?: unknown } | null)?.integrationBranch;
  if (typeof branch !== 'string' || branch === '') return null;
  if (branch.startsWith('-') || branch.includes('..') || !/^[A-Za-z0-9._/-]+$/.test(branch)) return null;
  if (branch === TRAIN_TARGET_BRANCH) return null;
  return branch;
}
