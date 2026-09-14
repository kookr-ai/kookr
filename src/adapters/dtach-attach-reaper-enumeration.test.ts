import { afterEach, describe, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { listRealProcesses } from './dtach-attach-reaper.js';
import { createResourceWatchdogHostSampler } from '../server/resource-watchdog-sampler.js';

vi.mock('node:fs', () => ({ readdirSync: vi.fn(), readFileSync: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });

describe.each(['linux', 'darwin'])('process enumeration on %s', (platform) => {
  test.each([false, true])('distinguishes empty success from failure in the default watchdog path (failure=%s)', (failure) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform as NodeJS.Platform);
    const enumerate = platform === 'linux' ? vi.mocked(readdirSync) : vi.mocked(execFileSync);
    if (failure) enumerate.mockImplementation(() => { throw new Error('enumeration failed'); });
    else if (platform === 'linux') vi.mocked(readdirSync).mockReturnValue([]);
    else vi.mocked(execFileSync).mockReturnValue('');

    const readProcessRssKb = vi.fn(() => 1);
    const sample = createResourceWatchdogHostSampler({
      readMeminfo: () => ({ memTotalKb: null, memAvailableKb: null, swapTotalKb: null, swapFreeKb: null }),
      readOomKillTotal: () => null,
      readProcessRssKb,
    }).sample();
    expect(sample.rssCoverage).toEqual({
      eligibleProcesses: failure ? null : 0, attemptedReads: 0, successfulReads: 0, truncated: false,
    });
    expect(enumerate).toHaveBeenCalledTimes(1);
    expect(readProcessRssKb).not.toHaveBeenCalled();
    expect(listRealProcesses()).toEqual([]); // Existing reaper callers keep their fallback.
    expect(enumerate).toHaveBeenCalledTimes(2);
  });
});

test('strict Linux enumeration retains ordering and skips unreadable command lines', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  vi.mocked(readdirSync).mockReturnValue(['9', '2', '3', 'self'] as unknown as ReturnType<typeof readdirSync>);
  vi.mocked(readFileSync).mockImplementation((path) => {
    if (path === '/proc/2/cmdline') throw new Error('process exited');
    return path === '/proc/9/cmdline' ? 'claude\0worker' : 'codex\0exec';
  });
  expect(listRealProcesses({ throwOnError: true })).toEqual([
    { pid: 9, command: 'claude worker' }, { pid: 3, command: 'codex exec' },
  ]);
  expect(readdirSync).toHaveBeenCalledTimes(1);
  expect(readFileSync).toHaveBeenCalledTimes(3);
});
