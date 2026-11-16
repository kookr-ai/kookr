/**
 * Reading a feature switch that is on by default (issue #3937).
 *
 * Finished features ship switched on. Their environment variable stays as a kill
 * switch: `0`, `false`, `off` or `no` (any case, surrounding spaces ignored) turns
 * the feature off. Anything else, including an unset or empty variable, leaves it
 * on, so a typo never silently disables a feature the operator expects to run.
 */

const KILL_SWITCH_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'off', 'no']);

/** True when `raw` is one of the kill-switch spellings (`0` / `false` / `off` / `no`). */
export function isKillSwitchValue(raw: string | undefined): boolean {
  return raw !== undefined && KILL_SWITCH_VALUES.has(raw.trim().toLowerCase());
}

/** True unless `raw` is a kill-switch spelling. Unset and empty mean on. */
export function isDefaultOnFlagEnabled(raw: string | undefined): boolean {
  return !isKillSwitchValue(raw);
}
