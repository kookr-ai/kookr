/**
 * Test fixture for the die-with-parent integration test (#1723).
 *
 * Spawns the watchdog-guarded child, writes the child's pid to the file named
 * in argv[2], then stays alive. The test SIGKILLs THIS process and asserts the
 * grandchild reaps itself.
 *
 * Deliberately a plain `.mjs` (no TypeScript, no tsx loader) so that killing
 * this process cleanly reparents the child. A tsx-loaded parent does not
 * reparent its child reliably under vitest, which would mask the watchdog.
 * Not a test file so vitest never collects it.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pidFile = process.argv[2];
if (!pidFile) {
  process.stderr.write('usage: die-with-parent-parent.mjs <pidFile>\n');
  process.exit(1);
}

const childPath = fileURLToPath(new URL('./die-with-parent-child.ts', import.meta.url));
const child = spawn(process.execPath, ['--import', 'tsx', childPath], {
  stdio: ['ignore', 'inherit', 'inherit'],
  // Declare our pid so the child watches THIS process, immune to the tsx
  // boot-race (parent may die before the child finishes starting up).
  env: { ...process.env, KOOKR_RELAY_PARENT_PID: String(process.pid) },
});

if (!child.pid) {
  process.stderr.write('failed to spawn child\n');
  process.exit(1);
}

writeFileSync(pidFile, String(child.pid), 'utf8');

// Stay alive until the test kills us.
setInterval(() => {}, 1_000);
