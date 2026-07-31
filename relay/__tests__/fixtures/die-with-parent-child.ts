/**
 * Test fixture for the die-with-parent integration test (#1723).
 *
 * Installs the watchdog with a short poll interval and then stays alive. When
 * the parent process that spawned it is killed, the watchdog observes that the
 * live ppid no longer matches the declared parent and exits — proving a
 * stranded relay reaps itself even when its parent dies without a chance to
 * clean up (SIGKILL).
 *
 * The parent passes its own pid via `KOOKR_RELAY_PARENT_PID`, mirroring how the
 * relay lifecycle declares the launcher pid; this closes the boot-race where a
 * live ppid read during (slow) tsx startup would capture the post-reparent pid.
 *
 * Not a test file (no `.test.ts` suffix) so vitest never collects it.
 */
import { installDieWithParentWatchdog, readDieWithParentConfig } from '../../die-with-parent.js';

const config = readDieWithParentConfig(process.env);

installDieWithParentWatchdog({
  intervalMs: 50,
  ...(config.expectedPpid !== undefined ? { expectedPpid: config.expectedPpid } : {}),
  onParentExit: () => {
    // Deterministic marker for the parent-exit path; the test asserts exit.
    process.stdout.write('child:parent-exit\n');
    process.exit(0);
  },
});

// Signal readiness so the test knows the watchdog is armed, then stay resident.
process.stdout.write('child:ready\n');
const keepAlive = setInterval(() => {}, 1_000);
// Safety net: never outlive the test run even if something goes wrong.
setTimeout(() => {
  clearInterval(keepAlive);
  process.exit(2);
}, 30_000).unref();
