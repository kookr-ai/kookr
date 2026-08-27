import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { spawn as nodeSpawn } from 'node:child_process';
import { runStopPredicate } from './ralph-predicate.js';

/** Process groups are a POSIX concept; the timeout-reaping tests only run there. */
const posixOnly = process.platform === 'win32' ? it.skip : it;

// Liveness probe for the test's own assertions. Pid recycling could in theory
// make a just-reaped pid look alive again, but the window between the SUT
// confirming the group drained and this re-check is a single event-loop tick,
// so recycling that fast is not a realistic flake source.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort teardown so a broken fix cannot leak real sleep processes. */
function emergencyKill(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/** Poll a predicate-written pid file until it holds at least `count` pids. */
async function waitForPids(file: string, count: number, timeoutMs = 3000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pids = (await readFile(file, 'utf-8'))
        .split('\n')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 1);
      if (pids.length >= count) return pids.slice(0, count);
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`pid file ${file} never reached ${count} pids`);
}

/** Minimal ChildProcess stand-in for driving the settlement state machine. */
class FakeChild extends EventEmitter {
  constructor(public pid: number) {
    super();
  }
  kill(): boolean {
    return true;
  }
}

function fakeSpawnReturning(child: FakeChild): typeof nodeSpawn {
  return (() => child) as unknown as typeof nodeSpawn;
}

describe('runStopPredicate', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ralph-pred-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns satisfied=true when the command exits 0', async () => {
    const r = await runStopPredicate('exit 0', { cwd: dir, iteration: 1 });
    expect(r.satisfied).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.errored).toBe(false);
  });

  it('returns satisfied=false when the command exits non-zero', async () => {
    const r = await runStopPredicate('exit 7', { cwd: dir, iteration: 1 });
    expect(r.satisfied).toBe(false);
    expect(r.exitCode).toBe(7);
    expect(r.timedOut).toBe(false);
  });

  it('exposes RALPH_ITERATION to the predicate', async () => {
    const out = join(dir, 'iter');
    await runStopPredicate(`printf '%s' "$RALPH_ITERATION" > ${out}`, { cwd: dir, iteration: 42 });
    const written = await readFile(out, 'utf-8');
    expect(written).toBe('42');
  });

  it('exposes RALPH_LAST_OUTPUT_FILE when provided', async () => {
    const sink = join(dir, 'sink');
    await runStopPredicate(`printf '%s' "$RALPH_LAST_OUTPUT_FILE" > ${sink}`, {
      cwd: dir,
      iteration: 1,
      lastOutputFile: '/tmp/some/path.jsonl',
    });
    const written = await readFile(sink, 'utf-8');
    expect(written).toBe('/tmp/some/path.jsonl');
  });

  it('does not set RALPH_LAST_OUTPUT_FILE when omitted', async () => {
    const sink = join(dir, 'sink');
    await runStopPredicate(
      `if [ -z "\${RALPH_LAST_OUTPUT_FILE+set}" ]; then printf '%s' unset > ${sink}; else printf '%s' set > ${sink}; fi`,
      { cwd: dir, iteration: 1 },
    );
    const written = await readFile(sink, 'utf-8');
    expect(written).toBe('unset');
  });

  it('runs the predicate inside the supplied cwd', async () => {
    await writeFile(join(dir, 'marker'), 'hello');
    const r = await runStopPredicate('test -f marker', { cwd: dir, iteration: 1 });
    expect(r.satisfied).toBe(true);
  });

  it('marks the result timedOut when the predicate exceeds the budget', async () => {
    const r = await runStopPredicate('sleep 5', {
      cwd: dir,
      iteration: 1,
      timeoutMs: 100,
    });
    expect(r.timedOut).toBe(true);
    expect(r.satisfied).toBe(false);
    expect(r.errored).toBe(false);
  });

  it('returns errored=true when spawn fails', async () => {
    const fakeSpawn = (() => {
      throw new Error('spawn ENOENT');
    }) as unknown as typeof import('node:child_process').spawn;
    const r = await runStopPredicate('exit 0', {
      cwd: dir,
      iteration: 1,
      spawn: fakeSpawn,
    });
    expect(r.errored).toBe(true);
    expect(r.satisfied).toBe(false);
    expect(r.errorMessage).toContain('ENOENT');
  });

  it('treats a signal-killed process as not satisfied even if exit code is 0', async () => {
    // SIGTERM-killed shell: exit code may be null on some platforms. The
    // contract is: satisfied requires exit 0 AND no signal AND no timeout.
    const r = await runStopPredicate('sleep 3', {
      cwd: dir,
      iteration: 1,
      timeoutMs: 50,
    });
    expect(r.satisfied).toBe(false);
    expect(r.timedOut).toBe(true);
  });

  it('grep-style predicate (the M1 example) works against a real file', async () => {
    const promptFile = join(dir, 'prompt.md');
    await writeFile(promptFile, 'work in progress\n<promise>DONE</promise>\n');
    const r = await runStopPredicate('grep -q "<promise>DONE</promise>" prompt.md', {
      cwd: dir,
      iteration: 1,
    });
    expect(r.satisfied).toBe(true);

    await writeFile(promptFile, 'still working\n');
    const r2 = await runStopPredicate('grep -q "<promise>DONE</promise>" prompt.md', {
      cwd: dir,
      iteration: 2,
    });
    expect(r2.satisfied).toBe(false);
    expect(r2.exitCode).toBe(1);
  });
});

describe('runStopPredicate — process-group timeout cleanup (issue #2857)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ralph-pred-pg-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  posixOnly(
    'reaps a TERM-ignoring predicate and its same-group descendant on timeout',
    async () => {
      // Root shell ignores SIGTERM and waits on a descendant that also ignores
      // SIGTERM (SIG_IGN survives `exec`). With the old `child.killed` gate the
      // follow-up SIGKILL never fired and both leaked; the group SIGKILL sweep
      // must reap both. First line of the pid file is the descendant, second is
      // the root shell ($$ == the spawned group leader).
      const pidFile = join(dir, 'pids');
      const cmd = [
        'trap "" TERM',
        `sh -c 'trap "" TERM; exec sleep 300' &`,
        'CHILD=$!',
        `echo "$CHILD" > "${pidFile}"`,
        `echo "$$" >> "${pidFile}"`,
        'wait "$CHILD"',
      ].join('\n');

      const run = runStopPredicate(cmd, { cwd: dir, iteration: 1, timeoutMs: 150 });
      const pids = await waitForPids(pidFile, 2);
      try {
        const r = await run;
        expect(r.timedOut).toBe(true);
        expect(r.satisfied).toBe(false);
        expect(r.errored).toBe(false);
        // Acceptance: the whole group is absent once the timed-out call settles.
        for (const pid of pids) expect(isAlive(pid)).toBe(false);
      } finally {
        emergencyKill(pids);
      }
    },
    10_000,
  );

  posixOnly(
    'root exit during grace does not cancel same-group descendant cleanup',
    async () => {
      // The root shell has no trap, so SIGTERM ends it during the grace window;
      // its descendant ignores SIGTERM. Root exit must not clear the cleanup —
      // the descendant still has to fall to the post-grace SIGKILL sweep.
      const pidFile = join(dir, 'pids');
      const cmd = [
        `sh -c 'trap "" TERM; exec sleep 300' &`,
        'CHILD=$!',
        `echo "$CHILD" > "${pidFile}"`,
        `echo "$$" >> "${pidFile}"`,
        'sleep 300',
      ].join('\n');

      const run = runStopPredicate(cmd, { cwd: dir, iteration: 1, timeoutMs: 150 });
      const pids = await waitForPids(pidFile, 2);
      const descendant = pids[0];
      try {
        const r = await run;
        expect(r.timedOut).toBe(true);
        expect(isAlive(descendant)).toBe(false);
      } finally {
        emergencyKill(pids);
      }
    },
    10_000,
  );

  it('settles exactly once when exit and a late error both fire', async () => {
    const child = new FakeChild(2_147_483_646); // no real group behind this pid
    const p = runStopPredicate('noop', {
      cwd: dir,
      iteration: 1,
      timeoutMs: 10_000,
      spawn: fakeSpawnReturning(child),
    });
    child.emit('exit', 0, null);
    child.emit('error', new Error('late spawn error')); // must be ignored
    const r = await p;
    expect(r.satisfied).toBe(true);
    expect(r.errored).toBe(false);
    expect(r.exitCode).toBe(0);
  });

  it('settles exactly once when error precedes a late exit', async () => {
    const child = new FakeChild(2_147_483_646);
    const p = runStopPredicate('noop', {
      cwd: dir,
      iteration: 1,
      timeoutMs: 10_000,
      spawn: fakeSpawnReturning(child),
    });
    child.emit('error', new Error('boom enoent'));
    child.emit('exit', 0, null); // must be ignored
    const r = await p;
    expect(r.errored).toBe(true);
    expect(r.satisfied).toBe(false);
    expect(r.errorMessage).toContain('boom');
  });

  it('timeout settles via the fast ESRCH path (not the drain-poll cap) when the group is already gone', async () => {
    // The fake never emits exit and its pid backs no real group, so every group
    // signal raises ESRCH. groupAlive() must recognise ESRCH as "gone" and
    // settle on the first drain probe. The elapsed-time assertion is what makes
    // this meaningful: a regression that treated ESRCH as "still alive" would
    // still settle — but only after the ~1 s GROUP_DRAIN_MAX_POLLS safety cap.
    const child = new FakeChild(2_147_483_646);
    const started = Date.now();
    const r = await runStopPredicate('noop', {
      cwd: dir,
      iteration: 1,
      timeoutMs: 30,
      spawn: fakeSpawnReturning(child),
    });
    const elapsed = Date.now() - started;
    expect(r.timedOut).toBe(true);
    expect(r.satisfied).toBe(false);
    expect(r.errored).toBe(false);
    // timeout (30) + grace (200) + one fast drain probe, well under the ~1 s cap.
    expect(elapsed).toBeLessThan(600);
  });

  it('clears the pending grace timer when the group drains during grace (no leaked SIGKILL)', async () => {
    // The load-bearing leak scenario: the timeout arms the SIGKILL grace timer,
    // then the root exits with the group already gone, so settlement happens via
    // the exit-early path while the grace timer is still pending. If settlement
    // did not clear that timer, it would fire a stray SIGKILL after the promise
    // resolved. We mock process.kill so liveness probes report ESRCH (gone) and
    // real signals are merely recorded, then assert no group signal fires after
    // settlement — including past the original grace deadline.
    const child = new FakeChild(2_147_483_646);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((_pid: number, sig: string | number) => {
      if (sig === 0) {
        const err: NodeJS.ErrnoException = new Error('ESRCH');
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    }) as typeof process.kill);
    try {
      const p = runStopPredicate('noop', {
        cwd: dir,
        iteration: 1,
        timeoutMs: 20,
        spawn: fakeSpawnReturning(child),
      });
      // Fire the root exit at ~60 ms: after the 20 ms timeout arms the 200 ms
      // grace timer, but before that timer would fire.
      setTimeout(() => child.emit('exit', null, 'SIGTERM'), 60);
      const r = await p;
      expect(r.timedOut).toBe(true);
      const callsAtSettle = killSpy.mock.calls.length;
      // Wait past the original grace deadline; a leaked grace timer would fire a
      // SIGKILL group signal in this window.
      await new Promise((res) => setTimeout(res, 250));
      expect(killSpy.mock.calls.length).toBe(callsAtSettle);
    } finally {
      killSpy.mockRestore();
    }
  });
});
