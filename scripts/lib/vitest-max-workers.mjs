// Worker cap for vitest (vitest.config.mts `maxWorkers`). Agent suites share the
// host with the supervisor and desktop, so the default is 4. The integration
// train raises it through KOOKR_VITEST_MAX_WORKERS. Only a positive integer
// written in plain digits counts; anything else (unset, empty, `0`, `-2`,
// `2.5`, `1e3`) keeps the default.

export const DEFAULT_VITEST_MAX_WORKERS = 4;

/**
 * @param {string | undefined} raw the value of KOOKR_VITEST_MAX_WORKERS
 * @returns {number}
 */
export function vitestMaxWorkers(raw) {
  const value = (raw ?? '').trim();
  if (!/^[1-9][0-9]*$/.test(value)) return DEFAULT_VITEST_MAX_WORKERS;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : DEFAULT_VITEST_MAX_WORKERS;
}
