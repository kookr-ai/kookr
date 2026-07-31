import { describe, expect, it } from 'vitest';

import { listProcessSnapshots, readProcessEnviron } from './proc-process-lister.js';

const onLinux = process.platform === 'linux';

describe('readProcessEnviron', () => {
  it.skipIf(!onLinux)('parses this process environ into a KEY=VALUE map', () => {
    const env = readProcessEnviron(process.pid);
    expect(env).not.toBeNull();
    // PATH is virtually always present; compare against the live value.
    expect(env!.PATH).toBe(process.env.PATH);
  });

  it('returns null for a pid that cannot be read', () => {
    // pid 2^31-1 is effectively never live; /proc read throws → null.
    expect(readProcessEnviron(2_147_483_646)).toBeNull();
  });
});

describe('listProcessSnapshots', () => {
  it.skipIf(!onLinux)('includes this process with a correct ppid, cmdline, and plausible start time', () => {
    const snapshots = listProcessSnapshots();
    const self = snapshots.find((p) => p.pid === process.pid);
    expect(self).toBeDefined();
    // ppid parsed from /proc/self/stat after the paren-wrapped comm.
    expect(self!.ppid).toBe(process.ppid);
    // cmdline is non-empty argv (node ...).
    expect(self!.cmdline.length).toBeGreaterThan(0);
    // Start time is a real past wall-clock, computed from btime + starttime.
    expect(self!.startTimeMs).not.toBeNull();
    expect(self!.startTimeMs!).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(self!.startTimeMs!).toBeGreaterThan(Date.now() - 365 * 24 * 60 * 60 * 1000);
    // cwd resolves to this worktree.
    expect(self!.cwd).not.toBeNull();
  });

  it.skipIf(onLinux)('returns an empty list where /proc is unavailable', () => {
    expect(listProcessSnapshots()).toEqual([]);
  });
});
