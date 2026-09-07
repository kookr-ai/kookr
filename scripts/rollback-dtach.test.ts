/**
 * Focused coverage for scripts/rollback-dtach.sh sweep resilience (#3043).
 *
 * Background: after #3042 a live dtach-backed Kookr server re-creates and
 * repopulates its instance dir on its next write, so `rm -rf` during a
 * rollback sweep can fail. Under `set -euo pipefail` that failure used to
 * abort the whole sweep before later instances were cleaned and before the
 * summary printed, leaving masters alive with no report.
 *
 * Acceptance:
 * - The kill phase targets every master the manifest lists — 'active',
 *   'pending', and 'recovered' (issue #3043 asked to widen it past 'active') —
 *   while the pid > 0 guard skips the sentinel pid -1 that unspawned 'pending'
 *   / PID-less 'recovered' entries carry, so `kill -TERM -1` is never reached
 *   and processes outside the manifest are untouched.
 * - A failed `rm` for one instance does not abort the sweep: the bounded retry
 *   is exhausted, later instances are still cleaned, and the un-removable
 *   instance is reported.
 * - The script exits non-zero when it could not remove an instance, and 0 on
 *   a fully clean sweep.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts/rollback-dtach.sh');

/**
 * Start a long-lived process to stand in for an orphaned dtach master and
 * return its pid. The `sleep` is backgrounded by a shell that then exits, so
 * the `sleep` is orphaned and reparented to init (or a subreaper); when the
 * script kills it, init reaps it immediately. A child of this test process
 * would instead linger as a zombie and keep answering `kill -0`, masking
 * whether the script actually killed it. (No `setsid` — orphaning via the
 * shell exit is what does the work, and `setsid` is absent on macOS.)
 */
function spawnFakeMaster(): number {
  const out = spawnSync('bash', ['-c', 'sleep 60 >/dev/null 2>&1 & echo "$!"'], {
    encoding: 'utf8',
  });
  const pid = Number.parseInt((out.stdout ?? '').trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`failed to spawn fake master: ${out.stderr}`);
  }
  return pid;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeManifest(dir: string, entries: Array<{ pid: number; status: string }>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ entries }));
}

function runRollback(root: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, KOOKR_DTACH_SOCK_DIR: root },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('rollback-dtach.sh', () => {
  const spawned: number[] = [];

  function fakeMaster(): number {
    const pid = spawnFakeMaster();
    spawned.push(pid);
    return pid;
  }

  afterEach(() => {
    for (const pid of spawned) {
      if (isAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
    spawned.length = 0;
  });

  it('kills every listed master (active/pending/recovered), skips the pid -1 sentinel, and spares unlisted processes', () => {
    const root = mkdtempSync(join(tmpdir(), 'kookr-rollback-kill-'));
    // A live process that is NOT in any manifest. If the pid -1 sentinel ever
    // reached `kill -TERM -1`, that broadcast would take this bystander down
    // too — so its survival proves the guard held.
    const bystander = fakeMaster();
    try {
      const active = fakeMaster();
      const pending = fakeMaster();
      const recovered = fakeMaster();

      writeManifest(join(root, 'port-4800'), [
        { pid: active, status: 'active' },
        { pid: pending, status: 'pending' },
        { pid: recovered, status: 'recovered' },
        // An unspawned 'pending' entry: pid -1, as the backend writes it
        // before the master exists. Must be skipped, not turned into kill -1.
        { pid: -1, status: 'pending' },
      ]);

      const { status } = runRollback(root);

      // Every listed master is killed regardless of status — the widening the
      // issue asked for past an 'active'-only allowlist.
      expect(isAlive(active)).toBe(false);
      expect(isAlive(pending)).toBe(false);
      expect(isAlive(recovered)).toBe(false);
      // The pid -1 sentinel neither crashed the run nor broadcast a signal.
      expect(isAlive(bystander)).toBe(true);
      // Fully clean sweep of the listed masters: dir removed, exit 0.
      expect(existsSync(root)).toBe(false);
      expect(status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // `chmod 0000` does not stop root from removing the tree, so this test's
  // whole premise (a persistently un-removable dir) evaporates under uid 0.
  const itUnlessRoot = process.getuid?.() === 0 ? it.skip : it;

  itUnlessRoot('survives a failed rm for one instance, sweeps the rest, and reports it', () => {
    const root = mkdtempSync(join(tmpdir(), 'kookr-rollback-stuck-'));
    // A 0000 subdir deterministically makes `rm -rf` fail (EACCES) the way a
    // live writer would make it fail (ENOTEMPTY) — the script's response is
    // the same: retry, give up, record, and keep going.
    const stuckDir = join(root, 'a-stuck');
    const blocked = join(stuckDir, 'locked');
    try {
      const stuckMaster = fakeMaster();
      const cleanMaster = fakeMaster();

      // 'a-stuck' sorts first, so the clean instance is only reached if the
      // sweep did NOT abort on the first failed rm.
      writeManifest(stuckDir, [{ pid: stuckMaster, status: 'active' }]);
      mkdirSync(blocked, { recursive: true });
      writeFileSync(join(blocked, 'sock'), '');
      chmodSync(blocked, 0o000);

      writeManifest(join(root, 'b-clean'), [{ pid: cleanMaster, status: 'active' }]);

      const { status, stderr } = runRollback(root);

      // Both masters were TERMed even though one instance dir could not go.
      expect(isAlive(stuckMaster)).toBe(false);
      expect(isAlive(cleanMaster)).toBe(false);
      // The sweep continued past the stuck instance and cleaned the other.
      expect(existsSync(join(root, 'b-clean'))).toBe(false);
      // The stuck instance survived and was reported, not silently dropped.
      expect(existsSync(stuckDir)).toBe(true);
      expect(stderr).toContain('could not remove');
      expect(stderr).toContain('a-stuck');
      // A non-clean sweep must not report success.
      expect(status).not.toBe(0);
    } finally {
      chmodSync(blocked, 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is a no-op with exit 0 when the socket dir is absent', () => {
    const root = join(tmpdir(), `kookr-rollback-missing-${process.pid}-${Date.now()}`);
    expect(existsSync(root)).toBe(false);
    const { status, stdout } = runRollback(root);
    expect(status).toBe(0);
    expect(stdout).toContain('nothing to do');
  });
});
