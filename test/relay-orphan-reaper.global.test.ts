import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';

import { findLingeringTestRelays, reapLingeringTestRelays } from './relay-orphan-reaper.global.js';
import { listProcessSnapshots } from '../src/adapters/proc-process-lister.js';
import type { ProcessSnapshot } from '../src/core/orphan-process-scanner.js';
import {
  TEST_ORPHAN_MIN_AGE_MS,
  TEST_RUN_ID_ENV,
  isPidAlive,
  mintTestRunId,
} from '../src/test-utils/test-run-identity.js';

const NOW = 1_000_000_000_000;
const OLD = NOW - TEST_ORPHAN_MIN_AGE_MS - 1;
const YOUNG = NOW - 1_000;
const MINE = '100-aaaaaa';
const LIVE_OTHER = '200-bbbbbb';
const DEAD_OTHER = '300-cccccc';

function proc(pid: number, cmdline: string, startTimeMs: number | null = YOUNG): ProcessSnapshot {
  return { pid, ppid: 1, cmdline, rssBytes: 0, startTimeMs, cwd: null };
}

describe('findLingeringTestRelays', () => {
  const processes: ProcessSnapshot[] = [
    proc(10, 'node --import tsx /w/kookr/relay/server.ts'), // this run's relay
    proc(11, 'node /w/kookr/relay/server.js', OLD), // prod-ish relay (unmarked)
    proc(12, 'dtach -n /tmp/kookr-dtach/x.sock claude'), // dtach, not relay
    proc(13, 'node dist/index.js'), // unrelated
    proc(14, 'node --import tsx /w2/kookr/relay/server.ts', OLD), // live concurrent run, old
    proc(15, 'node --import tsx /w3/kookr/relay/server.ts', OLD), // dead run, old
    proc(16, 'node --import tsx /w3/kookr/relay/server.ts'), // dead run, young
    proc(17, 'node --import tsx /w4/kookr/relay/server.ts', OLD), // no run id, old
    proc(18, 'node --import tsx /w4/kookr/relay/server.ts'), // no run id, young
    proc(19, 'node --import tsx /w4/kookr/relay/server.ts', null), // no run id, age unknown
  ];
  const marker = { KOOKR_RELAY_DIE_WITH_PARENT: '1' };
  const environ: Record<number, Record<string, string> | null> = {
    10: { ...marker, [TEST_RUN_ID_ENV]: MINE },
    11: { KOOKR_RELAY_ADMIN_TOKEN: 'x' },
    12: { ...marker, [TEST_RUN_ID_ENV]: MINE },
    13: null,
    14: { ...marker, [TEST_RUN_ID_ENV]: LIVE_OTHER },
    15: { ...marker, [TEST_RUN_ID_ENV]: DEAD_OTHER },
    16: { ...marker, [TEST_RUN_ID_ENV]: DEAD_OTHER },
    17: marker,
    18: { VITEST: 'true' },
    19: marker,
  };

  function find(list: ProcessSnapshot[], runId: string | null = MINE): number[] {
    return findLingeringTestRelays({
      listProcesses: () => list,
      readEnviron: (pid) => environ[pid] ?? null,
      isPidAlive: (pid) => pid !== 300,
      runId,
      now: NOW,
    });
  }

  it("selects this run's test relays and old orphans, never a live run's or a prod relay", () => {
    // 10: this run. 15: its run's Vitest process is gone and it is old.
    // 17: no run id and old. Kept: 11 prod relay, 12 dtach, 13 unrelated,
    // 14 a live concurrent run (however old), 16/18 too young, 19 unknown age.
    expect(find(processes)).toEqual([10, 15, 17]);
  });

  it('without a current run id, sweeps only orphans', () => {
    expect(find(processes, null)).toEqual([15, 17]);
  });

  it('returns empty when nothing matches', () => {
    expect(find([proc(20, 'node dist/index.js')])).toEqual([]);
  });
});

// Acceptance criteria of issue #4109, on real processes. Each fixture is a
// node process whose command line names `relay/server.ts`. The finder only
// ever sees the fixtures this test spawned (the injected lister), so a
// selection bug cannot signal a process of a concurrent test run.
describe.runIf(process.platform === 'linux')('reapLingeringTestRelays on real processes (#4109)', () => {
  const fixtures: ChildProcess[] = [];

  afterEach(() => {
    for (const child of fixtures.splice(0)) child.kill('SIGKILL');
  });

  async function spawnFakeRelay(env: Record<string, string>): Promise<ChildProcess> {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)', '--', '/nonexistent-reap-run-fixture/relay/server.ts'],
      { env: { PATH: process.env.PATH ?? '', KOOKR_RELAY_DIE_WITH_PARENT: '1', ...env }, stdio: 'ignore' },
    );
    fixtures.push(child);
    await once(child, 'spawn');
    return child;
  }

  function onlyFixtures(): ProcessSnapshot[] {
    const mine = new Set(fixtures.map((c) => c.pid));
    return listProcessSnapshots().filter((p) => mine.has(p.pid));
  }

  it("one run's teardown reaps its own relays and leaves the other run's alive", async () => {
    const runA = mintTestRunId(process.pid);
    const runB = mintTestRunId(process.pid);
    const a = await spawnFakeRelay({ [TEST_RUN_ID_ENV]: runA });
    const b = await spawnFakeRelay({ [TEST_RUN_ID_ENV]: runB });

    expect(reapLingeringTestRelays({ runId: runA, listProcesses: onlyFixtures })).toEqual([a.pid]);

    await waitForExit(a);
    expect(b.exitCode).toBeNull();
    expect(b.signalCode).toBeNull();
    expect(isPidAlive(b.pid!)).toBe(true);
  });

  it('reaps a relay with no run id once it is older than the orphan threshold', async () => {
    const orphan = await spawnFakeRelay({});
    const runA = mintTestRunId(process.pid);

    expect(reapLingeringTestRelays({ runId: runA, listProcesses: onlyFixtures })).toEqual([]);
    expect(orphan.exitCode).toBeNull();

    const later = Date.now() + TEST_ORPHAN_MIN_AGE_MS + 60_000;
    expect(reapLingeringTestRelays({ runId: runA, listProcesses: onlyFixtures, now: later })).toEqual([orphan.pid]);
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
