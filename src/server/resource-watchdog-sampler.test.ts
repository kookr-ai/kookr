import { describe, expect, test } from 'vitest';
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
  });
});
