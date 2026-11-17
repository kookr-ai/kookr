import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findDtachPidsReferencing,
  findLingeringTestDtachPids,
  isTestSuiteDtachCmdline,
  listProcCmdlines,
  reapLingeringTestDtachMasters,
  type CmdlinePid,
} from './reap-dtach.js';
import { TEST_ORPHAN_MIN_AGE_MS, TEST_RUN_ID_ENV, isPidAlive, mintTestRunId } from './test-run-identity.js';

function proc(pid: number, cmdline: string): CmdlinePid {
  return { pid, cmdline };
}

describe('isTestSuiteDtachCmdline', () => {
  it('matches terminal-input-coordinator /tmp/tsc-* masters', () => {
    expect(
      isTestSuiteDtachCmdline(
        'dtach -n /tmp/tsc-iGbFd1/sc/busy-control.sock -r winch -E node canary.mjs',
      ),
    ).toBe(true);
  });

  it('matches local-dtach-backend ldb-test- masters under os.tmpdir()', () => {
    expect(
      isTestSuiteDtachCmdline(
        '/vendor/dtach/dtach -n /tmp/ldb-test-abc123/test/s1.sock -r winch -E /bin/sh',
      ),
    ).toBe(true);
  });

  it('matches session-reaper integration and macOS path-budget prefixes', () => {
    expect(
      isTestSuiteDtachCmdline(
        'dtach -n /tmp/kookr-session-reaper-it-xyz/test/orphan.sock -E sleep',
      ),
    ).toBe(true);
    expect(
      isTestSuiteDtachCmdline(
        'dtach -n /tmp/ldb-mac-sim-xxxx/test/s.sock -E true',
      ),
    ).toBe(true);
  });

  it('matches test-suite attachers (dtach -a) on the same socket prefixes', () => {
    expect(
      isTestSuiteDtachCmdline('dtach -a /tmp/tsc-abc/sc/s1.sock -E'),
    ).toBe(true);
  });

  it('never matches production /tmp/kookr-dtach/ masters or attachers', () => {
    expect(
      isTestSuiteDtachCmdline(
        'dtach -n /tmp/kookr-dtach/1000/port-4800/kookr-abc.sock -r winch -E claude',
      ),
    ).toBe(false);
    expect(
      isTestSuiteDtachCmdline(
        'dtach -a /tmp/kookr-dtach/1000/port-4800/kookr-abc.sock -E',
      ),
    ).toBe(false);
  });

  it('ignores non-dtach processes and unrelated paths', () => {
    expect(isTestSuiteDtachCmdline('node dist/index.js')).toBe(false);
    expect(isTestSuiteDtachCmdline('dtach -n /tmp/other-app/s.sock -E x')).toBe(false);
    expect(isTestSuiteDtachCmdline('')).toBe(false);
  });
});

describe('findDtachPidsReferencing', () => {
  const procs: CmdlinePid[] = [
    proc(10, 'dtach -n /tmp/ldb-test-abc/test/s1.sock -E sleep'),
    proc(11, 'dtach -n /tmp/ldb-test-other/test/s1.sock -E sleep'),
    proc(12, 'dtach -a /tmp/ldb-test-abc/test/s1.sock -E'),
    proc(13, 'node /tmp/ldb-test-abc/script.js'),
    proc(14, 'dtach -n /tmp/kookr-dtach/1000/x.sock -E claude'),
  ];

  it('returns only dtach pids whose cmdline includes the given dir', () => {
    expect(findDtachPidsReferencing('/tmp/ldb-test-abc', () => procs)).toEqual([10, 12]);
  });

  it('returns empty for empty dir or no matches', () => {
    expect(findDtachPidsReferencing('', () => procs)).toEqual([]);
    expect(findDtachPidsReferencing('/tmp/no-such-dir', () => procs)).toEqual([]);
  });
});

describe('findLingeringTestDtachPids', () => {
  const NOW = 1_000_000_000_000;
  const OLD = NOW - TEST_ORPHAN_MIN_AGE_MS - 1;
  const YOUNG = NOW - 1_000;
  const MINE = '100-aaaaaa';
  const LIVE_OTHER = '200-bbbbbb';
  const DEAD_OTHER = '300-cccccc';

  interface Fake {
    cmdline: string;
    env?: Record<string, string> | null;
    startTimeMs?: number | null;
  }

  function find(fakes: Record<number, Fake>, runId: string | null = MINE): number[] {
    return findLingeringTestDtachPids({
      list: () => Object.entries(fakes).map(([pid, f]) => proc(Number(pid), f.cmdline)),
      readEnviron: (pid) => fakes[pid]?.env ?? null,
      readStartTimeMs: (pid) => fakes[pid]?.startTimeMs ?? null,
      isPidAlive: (pid) => pid !== 300,
      runId,
      now: NOW,
      selfPid: 1,
    });
  }

  it("reaps the current run's dtach processes by environ or socket path, at any age and prefix", () => {
    expect(
      find({
        10: { cmdline: 'dtach -n /tmp/tsc-a/sc/s.sock -E node c.mjs', env: { [TEST_RUN_ID_ENV]: MINE }, startTimeMs: YOUNG },
        11: { cmdline: 'dtach -n /tmp/ldb-case-a/test/s.sock -E sh', env: { [TEST_RUN_ID_ENV]: MINE } },
        12: { cmdline: `dtach -n /tmp/kvr-${MINE}/ldb-case-b/test/s.sock -E sh`, env: null, startTimeMs: YOUNG },
        13: { cmdline: `dtach -a /tmp/kvr-${MINE}/ldb-case-b/test/s.sock -E`, env: {} },
      }),
    ).toEqual([10, 11, 12, 13]);
  });

  it("leaves a concurrent run's dtach processes alone, even old ones with a test prefix", () => {
    expect(
      find({
        20: { cmdline: 'dtach -n /tmp/tsc-b/sc/s.sock -E sleep', env: { [TEST_RUN_ID_ENV]: LIVE_OTHER }, startTimeMs: OLD },
        21: { cmdline: `dtach -n /tmp/kvr-${LIVE_OTHER}/tsc-c/s.sock -E sleep`, env: null, startTimeMs: OLD },
      }),
    ).toEqual([]);
  });

  it('reaps a dead run\'s processes only once they are older than the orphan threshold', () => {
    expect(
      find({
        30: { cmdline: `dtach -n /tmp/kvr-${DEAD_OTHER}/x/s.sock -E sleep`, startTimeMs: OLD },
        31: { cmdline: `dtach -n /tmp/kvr-${DEAD_OTHER}/y/s.sock -E sleep`, startTimeMs: YOUNG },
      }),
    ).toEqual([30]);
  });

  it('reaps an old test-prefixed dtach with no run id, but not a young one or one of unknown age', () => {
    expect(
      find({
        40: { cmdline: 'dtach -n /tmp/tsc-leak/sc/s.sock -E node canary.mjs', startTimeMs: OLD },
        41: { cmdline: 'dtach -n /tmp/ldb-test-x/test/s.sock -E sleep', startTimeMs: YOUNG },
        42: { cmdline: 'dtach -a /tmp/tsc-leak/sc/s.sock -E', startTimeMs: null },
      }),
    ).toEqual([40]);
  });

  it('never selects production kookr-dtach, unmarked dtach without a run id, non-dtach (even naming dtach) or itself', () => {
    expect(
      find({
        1: { cmdline: 'dtach -n /tmp/tsc-self/s.sock', env: { [TEST_RUN_ID_ENV]: MINE } },
        50: { cmdline: 'dtach -n /tmp/kookr-dtach/1000/port-4800/k.sock -E claude', env: { [TEST_RUN_ID_ENV]: MINE }, startTimeMs: OLD },
        51: { cmdline: 'dtach -n /tmp/other-app/s.sock -E x', startTimeMs: OLD },
        52: { cmdline: 'node dist/index.js', env: { [TEST_RUN_ID_ENV]: MINE } },
        53: { cmdline: 'node /home/u/dtach-tools/run.js /tmp/tsc-a/x', env: { [TEST_RUN_ID_ENV]: MINE } },
      }),
    ).toEqual([]);
  });

  it('without a current run id, sweeps only orphans', () => {
    expect(
      find(
        {
          60: { cmdline: 'dtach -n /tmp/tsc-a/s.sock', env: { [TEST_RUN_ID_ENV]: MINE }, startTimeMs: YOUNG },
          61: { cmdline: 'dtach -n /tmp/tsc-b/s.sock', startTimeMs: OLD },
        },
        null,
      ),
    ).toEqual([61]);
  });
});

// Acceptance criteria of issue #4109, on real processes. Each fixture is a
// node process whose command line looks like a dtach master. The finder only
// ever sees the fixtures this test spawned (the injected `list`), so a
// selection bug cannot signal a process of a concurrent test run.
describe.runIf(process.platform === 'linux')('reapLingeringTestDtachMasters on real processes (#4109)', () => {
  // The socket paths only appear in argv; nothing is created there. They are
  // deliberately outside os.tmpdir(), which is this run's `kvr-<id>` directory
  // and would otherwise name the run in every fixture's command line.
  const dir = '/nonexistent-reap-run-fixture';
  const fixtures: ChildProcess[] = [];

  afterEach(() => {
    for (const child of fixtures.splice(0)) child.kill('SIGKILL');
  });

  async function spawnFakeDtach(socketDir: string, env: Record<string, string>): Promise<ChildProcess> {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)', '--', 'dtach', '-n', join(socketDir, 's.sock'), '-E', 'sh'],
      { env: { PATH: process.env.PATH ?? '', ...env }, stdio: 'ignore' },
    );
    fixtures.push(child);
    await once(child, 'spawn');
    return child;
  }

  function onlyFixtures(): CmdlinePid[] {
    const mine = new Set(fixtures.map((c) => c.pid));
    return listProcCmdlines().filter((p) => mine.has(p.pid));
  }

  it("one run's teardown reaps its own processes and leaves the other run's alive", async () => {
    const runA = mintTestRunId(process.pid);
    const runB = mintTestRunId(process.pid);
    const a = await spawnFakeDtach(join(dir, 'ldb-case-a'), { [TEST_RUN_ID_ENV]: runA });
    const b = await spawnFakeDtach(join(dir, 'ldb-case-b'), { [TEST_RUN_ID_ENV]: runB });

    const reaped = await reapLingeringTestDtachMasters({ runId: runA, list: onlyFixtures, graceMs: 200 });

    expect(reaped).toEqual([a.pid]);
    await waitForExit(a);
    expect(b.exitCode).toBeNull();
    expect(b.signalCode).toBeNull();
    expect(isPidAlive(b.pid!)).toBe(true);
  });

  it('reaps a process with no run id once it is older than the orphan threshold', async () => {
    const orphan = await spawnFakeDtach(join(dir, 'tsc-orphan'), {});
    const runA = mintTestRunId(process.pid);

    const young = await reapLingeringTestDtachMasters({ runId: runA, list: onlyFixtures, graceMs: 200 });
    expect(young).toEqual([]);
    expect(orphan.exitCode).toBeNull();

    const later = Date.now() + TEST_ORPHAN_MIN_AGE_MS + 60_000;
    const reaped = await reapLingeringTestDtachMasters({ runId: runA, list: onlyFixtures, graceMs: 200, now: later });
    expect(reaped).toEqual([orphan.pid]);
    await waitForExit(orphan);
  });
});

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, 'exit'),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`pid ${child.pid} still alive`)), 5_000)),
  ]);
}
