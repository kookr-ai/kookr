/**
 * Tests for the process-tree reaper.
 *
 * These spawn real child processes and inspect `/proc`, so they only run on
 * Linux. Where `/proc` is unavailable the suite is skipped (the helper is a
 * documented single-pid no-op there).
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { collectProcessTree, killProcessTree, readProcessStartTimeMs } from './process-tree.js';

const HAS_PROC = existsSync('/proc/self');
const onLinux = HAS_PROC ? it : it.skip;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until `predicate` holds or the deadline passes. */
async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}

describe('collectProcessTree', () => {
  onLinux('includes the current process', () => {
    const tree = collectProcessTree(process.pid);
    expect(tree).toContain(process.pid);
    expect(tree[0]).toBe(process.pid);
  });

  onLinux('discovers descendants of a spawned root', async () => {
    // bash stays alive as the root and forks two `sleep` children.
    const root = spawn('bash', ['-c', 'sleep 30 & sleep 30 & wait'], { stdio: 'ignore' });
    try {
      await waitFor(() => collectProcessTree(root.pid!).length >= 3);
      const tree = collectProcessTree(root.pid!);
      expect(tree).toContain(root.pid);
      // root + 2 sleeps
      expect(tree.length).toBeGreaterThanOrEqual(3);
    } finally {
      await killProcessTree(root.pid!, { graceMs: 1_000 });
    }
  });

  it('returns [rootPid] when /proc is unavailable or empty (degraded path)', () => {
    // A pid that does not exist still yields itself — the walk just finds no
    // children. This is the same shape as the macOS/no-/proc degradation.
    const tree = collectProcessTree(2_147_483_600);
    expect(tree).toEqual([2_147_483_600]);
  });

  it('rejects non-positive roots', () => {
    expect(collectProcessTree(0)).toEqual([]);
    expect(collectProcessTree(-5)).toEqual([]);
  });
});

describe('readProcessStartTimeMs', () => {
  onLinux('returns a plausible past wall-clock start time for our own pid', () => {
    const startMs = readProcessStartTimeMs(process.pid);
    expect(startMs).not.toBeNull();
    // A live process must have started at or before now, and after the epoch.
    expect(startMs!).toBeGreaterThan(0);
    expect(startMs!).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  onLinux('orders a later-spawned child after our own start time', async () => {
    const ours = readProcessStartTimeMs(process.pid);
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      await waitFor(() => readProcessStartTimeMs(child.pid!) !== null);
      const childStart = readProcessStartTimeMs(child.pid!);
      expect(childStart).not.toBeNull();
      // The child was spawned after this process, so its start time is >= ours
      // (coarse btime resolution means it may land in the same clock tick).
      expect(childStart!).toBeGreaterThanOrEqual(ours!);
    } finally {
      await killProcessTree(child.pid!, { graceMs: 500 });
    }
  });

  it('returns null for a pid that does not exist', () => {
    expect(readProcessStartTimeMs(2_147_483_600)).toBeNull();
  });

  it('rejects non-positive pids', () => {
    expect(readProcessStartTimeMs(0)).toBeNull();
    expect(readProcessStartTimeMs(-1)).toBeNull();
  });
});

describe('killProcessTree', () => {
  // A SIGKILLed child of the test runner lingers as a zombie until Node reaps
  // it, so `kill(pid, 0)` still succeeds momentarily. Wait on the ChildProcess
  // `exit` event for the root (Node reaps it then) and poll for the grandchild
  // pids, which reparent to init and are reaped immediately.
  onLinux('reaps a normal process tree', async () => {
    const root = spawn('bash', ['-c', 'sleep 60 & sleep 60 & wait'], { stdio: 'ignore' });
    const rootExited = new Promise<void>((resolve) => root.on('exit', () => resolve()));
    await waitFor(() => collectProcessTree(root.pid!).length >= 3);
    const descendants = collectProcessTree(root.pid!).filter((pid) => pid !== root.pid);

    await killProcessTree(root.pid!, { graceMs: 2_000 });

    await rootExited;
    expect(await waitFor(() => descendants.every((pid) => !alive(pid)))).toBe(true);
  });

  onLinux('escalates to SIGKILL for a SIGTERM-ignoring process', async () => {
    // bash ignores SIGTERM; only SIGKILL can take it down — exactly the
    // claude/codex failure mode from kookr-ai/kookr#784.
    const root = spawn('bash', ['-c', 'trap "" TERM; sleep 60'], { stdio: 'ignore' });
    const rootExited = new Promise<NodeJS.Signals | null>((resolve) =>
      root.on('exit', (_code, sig) => resolve(sig)),
    );
    await waitFor(() => alive(root.pid!));
    expect(alive(root.pid!)).toBe(true);

    const start = Date.now();
    await killProcessTree(root.pid!, { graceMs: 500 });

    // Node reaps the killed child; assert it died to SIGKILL specifically (the
    // TERM-ignoring root can only have been taken down by the escalation).
    expect(await rootExited).toBe('SIGKILL');
    // The grace window must have elapsed before the SIGKILL escalation.
    expect(Date.now() - start).toBeGreaterThanOrEqual(450);
  });

  it('is a no-op for pids <= 1', async () => {
    // Must never signal init or escalate into a process-group kill.
    await expect(killProcessTree(1)).resolves.toBeUndefined();
    await expect(killProcessTree(0)).resolves.toBeUndefined();
    await expect(killProcessTree(-1)).resolves.toBeUndefined();
  });
});
