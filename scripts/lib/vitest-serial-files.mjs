// Test files the unit suite runs one at a time, after everything else, with a
// retry (vitest.config.mts, project `serial`). Issue #3794.
//
// Each file here spawns real processes (dtach, relay servers, nb, child
// runners) or races a timer against real I/O. Run beside a dozen other workers
// on a loaded host, they miss the test timeout or their timing window, while
// they pass on their own. That is what failed the integration train's first
// cycles on 15 Nov 2026 (load average about 38): more than five such files
// failed at once, over the flaky re-run's limit, and the train halted.
//
// Add a file here when it fails under load and passes alone; say why in the
// commit. A listed path that no longer exists fails
// scripts/lib/vitest-serial-files.test.ts, so a rename cannot quietly put the
// file back into the parallel run.
export const SERIAL_TEST_FILES = [
  'scripts/lib/nb-parity.test.ts',
  'scripts/prod-restart.test.ts',
  'src/adapters/local-dtach-backend.test.ts',
  'src/adapters/opencode-shelf-memory.test.ts',
  'src/integrations/telegram/transcribe.test.ts',
  'src/server/launch-dependency-runner.sigterm.test.ts',
  'src/server/lucy-interaction.wiring.test.ts',
  'src/server/relay-lifecycle.test.ts',
  'src/server/remote-launch-broker.test.ts',
  'src/server/schedule-runner.test.ts',
  'src/server/terminal-host.test.ts',
  'src/server/terminal-input-coordinator.test.ts',
];

/** Default per-test timeout. It exists to catch hangs, not slow hosts. */
export const DEFAULT_TEST_TIMEOUT_MS = 15_000;

/**
 * Per-test timeout from KOOKR_VITEST_TEST_TIMEOUT_MS. scripts/verify.sh sets a
 * longer one in train mode: the train has its own 90-minute cap, and a loaded
 * host should not turn a slow test into a red train. Only a positive integer
 * written in plain digits counts; anything else keeps 15 s.
 *
 * @param {string | undefined} raw
 * @returns {number}
 */
export function vitestTestTimeoutMs(raw) {
  const value = (raw ?? '').trim();
  if (!/^[1-9][0-9]*$/.test(value)) return DEFAULT_TEST_TIMEOUT_MS;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : DEFAULT_TEST_TIMEOUT_MS;
}
