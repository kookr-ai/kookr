import { describe, expect, test, vi } from 'vitest';
import {
  classifyProcessCommand,
  countAgentFamilies,
  createResourceWatchdogHostSampler,
  parseMeminfo,
  parseOomKillTotal,
} from './resource-watchdog-sampler.js';

describe('parseMeminfo', () => {
  test('extracts swap and available memory', () => {
    const snap = parseMeminfo([
      'MemTotal:       16384000 kB',
      'MemAvailable:    2048000 kB',
      'SwapTotal:       8388608 kB',
      'SwapFree:        1048576 kB',
    ].join('\n'));
    expect(snap.memAvailableKb).toBe(2_048_000);
    expect(snap.swapTotalKb).toBe(8_388_608);
    expect(snap.swapFreeKb).toBe(1_048_576);
  });
});

describe('parseOomKillTotal', () => {
  test('reads oom_kill counter', () => {
    expect(parseOomKillTotal('pgfault 1\noom_kill 7\npgmajfault 2\n')).toBe(7);
    expect(parseOomKillTotal('nope\n')).toBeNull();
  });
});

describe('classifyProcessCommand / countAgentFamilies', () => {
  test('classifies agent families and dtach', () => {
    expect(classifyProcessCommand('/usr/bin/claude --print')).toMatchObject({ family: 'claude' });
    expect(classifyProcessCommand('codex exec')).toMatchObject({ family: 'codex' });
    expect(classifyProcessCommand('grok-build agent')).toMatchObject({ family: 'grok' });
    expect(classifyProcessCommand('dtach -n /tmp/x.sock -E claude')).toMatchObject({
      family: 'claude',
      isDtach: true,
    });
  });

  test('counts per family', () => {
    const counts = countAgentFamilies([
      { pid: 1, command: 'claude' },
      { pid: 2, command: 'claude' },
      { pid: 3, command: 'codex' },
      { pid: 4, command: 'dtach -a /tmp/kookr.sock' },
      { pid: 5, command: 'bash' },
    ]);
    expect(counts).toEqual({ claude: 2, grok: 0, codex: 1, dtach: 1 });
  });
});

describe('createResourceWatchdogHostSampler', () => {
  const hostReaders = {
    readMeminfo: () => ({ memTotalKb: null, memAvailableKb: null, swapTotalKb: null, swapFreeKb: null }),
    readOomKillTotal: () => null,
  };

  test.each([10, 12])('reports the bounded prefix with a display limit of %i', (limit) => {
    const budget = Math.max(limit * 4, 40);
    const entries = Array.from({ length: budget + 1 }, (_, i) => ({ pid: i + 1, command: 'claude' }));
    const listProcesses = vi.fn(() => [{ pid: 999, command: 'bash' }, ...entries]);
    const readProcessRssKb = vi.fn((pid: number) => pid * 100);
    const sample = createResourceWatchdogHostSampler({
      ...hostReaders, listProcesses, readProcessRssKb, topConsumerLimit: limit,
    }).sample();

    expect(sample.rssCoverage).toEqual({
      eligibleProcesses: budget + 1, attemptedReads: budget, successfulReads: budget, truncated: true,
    });
    expect(listProcesses).toHaveBeenCalledTimes(1);
    expect(readProcessRssKb.mock.calls.map(([pid]) => pid)).toEqual(entries.slice(0, budget).map(({ pid }) => pid));
    expect(sample.topConsumers).toHaveLength(limit);
    expect(sample.topConsumers.map(({ pid }) => pid)).toEqual(Array.from({ length: limit }, (_, i) => budget - i));
    expect(sample.topConsumers.some(({ pid }) => pid === budget + 1)).toBe(false);
  });

  test.each([{ entries: [] }, { entries: [{ pid: 1, command: 'bash' }] }])('reports complete coverage of an empty eligible set ($entries)', ({ entries }) => {
    const readProcessRssKb = vi.fn(() => 1);
    const sample = createResourceWatchdogHostSampler({
      ...hostReaders, listProcesses: () => entries, readProcessRssKb,
    }).sample();
    expect(sample.rssCoverage).toEqual({ eligibleProcesses: 0, attemptedReads: 0, successfulReads: 0, truncated: false });
    expect(sample.topConsumers).toEqual([]);
    expect(readProcessRssKb).not.toHaveBeenCalled();
  });

  test('distinguishes failed enumeration from a successful empty enumeration', () => {
    const readProcessRssKb = vi.fn(() => 1);
    const sample = createResourceWatchdogHostSampler({
      ...hostReaders,
      listProcesses: () => { throw new Error('process enumeration unavailable'); },
      readProcessRssKb,
    }).sample();
    expect(sample.rssCoverage).toEqual({ eligibleProcesses: null, attemptedReads: 0, successfulReads: 0, truncated: false });
    expect(sample.topConsumers).toEqual([]);
    expect(readProcessRssKb).not.toHaveBeenCalled();
  });

  test('counts zero RSS as measured and retains successes across raced-away processes', () => {
    const readProcessRssKb = vi.fn((pid: number) => {
      if (pid === 2) throw new Error('process exited');
      return [100, 0, null, null, 200, NaN, -1, Infinity][pid] ?? null;
    });
    const sample = createResourceWatchdogHostSampler({
      ...hostReaders,
      listProcesses: () => Array.from({ length: 8 }, (_, pid) => ({ pid, command: 'codex' })),
      readProcessRssKb,
    }).sample();
    expect(sample.rssCoverage).toEqual({ eligibleProcesses: 8, attemptedReads: 8, successfulReads: 3, truncated: false });
    expect(sample.topConsumers.map(({ pid }) => pid)).toEqual([4, 0]);
    expect(readProcessRssKb).toHaveBeenCalledTimes(8);
  });

  test('reports eligible processes even when all RSS reads are unavailable', () => {
    const sample = createResourceWatchdogHostSampler({
      ...hostReaders,
      listProcesses: () => [{ pid: 1, command: 'dtach -a /tmp/session' }],
      readProcessRssKb: () => null,
    }).sample();
    expect(sample.rssCoverage).toEqual({ eligibleProcesses: 1, attemptedReads: 1, successfulReads: 0, truncated: false });
    expect(sample.topConsumers).toEqual([]);
  });

  test('builds a sample from injected readers (no real /proc)', () => {
    const sampler = createResourceWatchdogHostSampler({
      readMeminfo: () => ({
        memTotalKb: 16_000_000,
        memAvailableKb: 512 * 1024,
        swapTotalKb: 1_000_000,
        swapFreeKb: 200_000,
      }),
      readOomKillTotal: () => 3,
      listProcesses: () => [
        { pid: 10, command: 'claude worker' },
        { pid: 11, command: 'grok' },
      ],
      readProcessRssKb: (pid) => (pid === 10 ? 500_000 : 100_000),
      getSessionPressure: () => ({ orphanSessionCount: 2, terminalLeakCount: 1 }),
      nowIso: () => '2026-07-31T12:00:00.000Z',
    });
    const sample = sampler.sample();
    expect(sample.sampledAt).toBe('2026-07-31T12:00:00.000Z');
    expect(sample.swapUsedPercent).toBeCloseTo(80, 5);
    expect(sample.memAvailableMb).toBe(512);
    expect(sample.oomKillTotal).toBe(3);
    expect(sample.processCounts.claude).toBe(1);
    expect(sample.processCounts.grok).toBe(1);
    expect(sample.orphanSessionCount).toBe(2);
    expect(sample.terminalLeakCount).toBe(1);
    expect(sample.topConsumers[0]?.pid).toBe(10);
    expect(sample.rssCoverage).toEqual({ eligibleProcesses: 2, attemptedReads: 2, successfulReads: 2, truncated: false });
  });
});
