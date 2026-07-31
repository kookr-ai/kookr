/**
 * Integration test for the orphan/terminal-task session reaper (issue #1720):
 * a real dtach-backed dummy session (a spawned `sleep`) is reaped end-to-end
 * through `LocalDtachBackend`, proving the process tree actually dies and the
 * socket is actually removed — not just that the pure classification logic
 * says it should be. Self-contained: random-ish temp instance dir, no shared
 * state, no real process is touched other than the `sleep` this test itself
 * spawns via dtach.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDtachBackend } from '../adapters/local-dtach-backend.js';
import { killProcessTree } from '../adapters/process-tree.js';
import { TaskStore } from '../core/tasks.js';
import type { SessionReapConfig } from '../core/session-reap-policy.js';
import { SessionReaperService } from './session-reaper.js';

function resolveDtachBinary(): string | null {
  const vendored = join(process.cwd(), 'vendor', 'dtach', 'dtach');
  if (existsSync(vendored)) return vendored;
  try {
    execFileSync('dtach', ['--help'], { stdio: 'pipe' });
    return 'dtach';
  } catch {
    return null;
  }
}

/** Reap any dtach masters (and their children) still referencing `dir` — same convention as local-dtach-backend.test.ts. */
async function reapDtachReferencing(dir: string): Promise<void> {
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return;
  }
  const targets: number[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmdline = readFileSync(`/proc/${name}/cmdline`, 'utf-8').replace(/\0/g, ' ');
      if (cmdline.includes('dtach') && cmdline.includes(dir)) targets.push(Number(name));
    } catch {
      // process exited between readdir and read — skip
    }
  }
  for (const pid of targets) {
    await killProcessTree(pid, { graceMs: 2_000 });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(25);
  }
  return await predicate();
}

const DTACH = resolveDtachBinary();
const skipIfNoDtach = DTACH ? it : it.skip;

const ENABLED_CONFIG: SessionReapConfig = {
  enabled: true,
  orphanAgeThresholdMs: 24 * 60 * 60 * 1000,
  terminalTaskGraceMs: 60_000,
};

describe('SessionReaperService — real dtach integration', () => {
  let tmpDir: string;
  let backend: LocalDtachBackend;

  beforeAll(() => {
    if (!DTACH) {
      console.warn(
        '[session-reaper.integration.test] dtach not found; skipping. Run scripts/build-dtach.sh to enable.',
      );
    }
  });

  afterEach(async () => {
    backend?.close?.();
    if (tmpDir) {
      try {
        await reapDtachReferencing(tmpDir);
      } catch {
        // best-effort
      }
      try {
        if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  skipIfNoDtach(
    'reaps a real orphan session past the age threshold: process tree dies and the socket is removed',
    { timeout: 20_000 },
    async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'kookr-session-reaper-it-'));
      backend = new LocalDtachBackend({ socketDir: tmpDir, instanceId: 'test', dtachBinary: DTACH! });

      const sessionId = 'kookr-orphan-it';
      await backend.createSession({ id: sessionId, command: '/bin/sh', args: ['-c', 'sleep 60'] });

      expect(await waitFor(() => backend.isAlive(sessionId))).toBe(true);
      const sock = join(tmpDir, 'test', `${sessionId}.sock`);
      expect(existsSync(sock)).toBe(true);
      // The manifest can briefly hold pid -1 right after spawn until the
      // `/proc` scan resolves the master (see `waitForMasterIdentity` in
      // local-dtach-backend.test.ts) — poll rather than assume synchronous.
      await waitFor(() => (backend.getSessionDiagnostics!(sessionId)?.masterPid ?? -1) > 0);
      const masterPid = backend.getSessionDiagnostics!(sessionId)!.masterPid!;
      expect(masterPid).toBeGreaterThan(0);

      // No owning task at all — a true orphan. Backdate the reap clock (not
      // the real process) past the age threshold rather than actually waiting
      // 24h+ in a test.
      const taskStore = new TaskStore();
      const reaper = new SessionReaperService({
        taskStore,
        backend,
        getConfig: () => ENABLED_CONFIG,
        now: () => Date.now() + 25 * 60 * 60 * 1000,
      });

      const result = await reaper.runSweep();
      expect(result.reaped.map((d) => d.sessionId)).toEqual([sessionId]);

      // The process tree actually dies... `killSession`'s escalation allows up
      // to `KILL_WAIT_SECONDS` (process-tree.ts default grace) before SIGKILL,
      // so this poll intentionally uses a longer bound than the default
      // `waitFor` — in practice `sleep` dies on the initial SIGTERM well
      // within that window (it does not trap TERM), so this rarely reaches
      // the KILL escalation at all.
      expect(await waitFor(() => {
        try {
          process.kill(masterPid, 0);
          return false;
        } catch {
          return true;
        }
      }, 15_000)).toBe(true);
      // ...and the socket is actually removed.
      expect(await waitFor(() => !existsSync(sock), 15_000)).toBe(true);
      expect(await backend.isAlive(sessionId)).toBe(false);
    },
  );

  skipIfNoDtach(
    'reaps a real session whose owning task already completed (leak class 2), even though the process is alive',
    { timeout: 20_000 },
    async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'kookr-session-reaper-it-'));
      backend = new LocalDtachBackend({ socketDir: tmpDir, instanceId: 'test', dtachBinary: DTACH! });

      const sessionId = 'kookr-leak-it';
      await backend.createSession({ id: sessionId, command: '/bin/sh', args: ['-c', 'sleep 60'] });
      expect(await waitFor(() => backend.isAlive(sessionId))).toBe(true);
      const sock = join(tmpDir, 'test', `${sessionId}.sock`);

      const taskStore = new TaskStore();
      const task = taskStore.createTask('Fix bug', '/cwd');
      taskStore.addSession(task.id, {
        tmuxSession: sessionId,
        agentType: 'codex-cli',
        cwd: '/cwd',
        createdAt: new Date(),
        lastStatus: 'completed',
      });
      taskStore.completeTask(task.id);

      const reaper = new SessionReaperService({
        taskStore,
        backend,
        getConfig: () => ENABLED_CONFIG,
        // Past the 60s terminal-task grace, nowhere near the 24h orphan threshold.
        now: () => Date.now() + 2 * 60 * 60 * 1000,
      });

      const result = await reaper.runSweep();
      expect(result.reaped.map((d) => d.sessionId)).toEqual([sessionId]);
      expect(await waitFor(() => !existsSync(sock), 15_000)).toBe(true);
      expect(await backend.isAlive(sessionId)).toBe(false);
    },
  );
});
