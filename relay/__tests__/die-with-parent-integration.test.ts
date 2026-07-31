/**
 * Issue #1723 acceptance criterion #2: SIGKILL-ing a test runner mid-relay-test
 * must leave zero orphaned relay servers — the die-with-parent watchdog fires
 * when the parent dies.
 *
 * This exercises the full mechanism end-to-end without booting the (heavy) relay
 * server: a parent process spawns a watchdog-guarded child, we SIGKILL the
 * parent (no graceful cleanup possible), and assert the child reaps itself.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const parentPath = fileURLToPath(new URL('./fixtures/die-with-parent-parent.mjs', import.meta.url));

/**
 * Whether `pid` is a still-RUNNING process. A process that has exited but
 * reparented to a non-reaping ancestor (e.g. the vitest worker under which this
 * test runs) lingers as a zombie ('Z') — it holds no memory and is effectively
 * reaped, so it does NOT count as a surviving relay orphan. On Linux we read
 * `/proc/<pid>/stat`; elsewhere we fall back to `kill(pid, 0)`. In production
 * the stranded relay reparents to init (pid 1), which reaps zombies outright.
 */
function isRunning(pid: number): boolean {
  if (process.platform === 'linux') {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      return false; // process gone
    }
    const rparen = stat.lastIndexOf(')');
    const state = rparen >= 0 ? stat.slice(rparen + 2).split(' ')[0] : undefined;
    return state !== 'Z' && state !== 'X' && state !== 'x';
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup.splice(0)) {
    try {
      fn();
    } catch {
      // best effort
    }
  }
});

describe('die-with-parent watchdog (integration)', () => {
  it('reaps a watchdog-guarded child when its parent is SIGKILL-ed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-dwp-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const pidFile = join(dir, 'child.pid');

    // Plain node (no tsx) for the parent: a tsx-loaded parent does not reparent
    // its child reliably under vitest. The child still uses tsx for the .ts
    // watchdog module.
    const parent = spawn(process.execPath, [parentPath, pidFile], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    cleanup.push(() => {
      try {
        if (parent.pid) process.kill(parent.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    });

    // Wait for the parent to write the child's pid.
    let childPid = 0;
    const gotPid = await waitFor(() => {
      try {
        const raw = readFileSync(pidFile, 'utf8').trim();
        if (!raw) return false;
        childPid = Number.parseInt(raw, 10);
        return Number.isInteger(childPid) && childPid > 0;
      } catch {
        return false;
      }
    }, 15_000);
    expect(gotPid).toBe(true);
    cleanup.push(() => {
      try {
        if (childPid > 0) process.kill(childPid, 'SIGKILL');
      } catch {
        // already gone
      }
    });

    // The child should be alive before we kill the parent.
    expect(await waitFor(() => isRunning(childPid), 5_000)).toBe(true);

    // Kill the parent WITHOUT any chance to clean up.
    expect(parent.pid).toBeGreaterThan(0);
    process.kill(parent.pid!, 'SIGKILL');

    // The child's watchdog (50 ms poll) must observe the reparent and exit.
    const childReaped = await waitFor(() => !isRunning(childPid), 10_000);
    expect(childReaped).toBe(true);
  }, 30_000);
});
