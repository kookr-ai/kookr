import { describe, expect, it } from 'vitest';
import {
  findDtachPidsReferencing,
  findLingeringTestDtachPids,
  isTestSuiteDtachCmdline,
  type CmdlinePid,
} from './reap-dtach.js';

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
  const procs: CmdlinePid[] = [
    proc(10, 'dtach -n /tmp/tsc-leak/sc/s.sock -E node canary.mjs'),
    proc(11, 'dtach -n /tmp/ldb-test-x/test/s.sock -E sleep'),
    proc(12, 'dtach -n /tmp/kookr-dtach/1000/port-4800/k.sock -E claude'),
    proc(13, 'node dist/index.js'),
    proc(14, 'dtach -a /tmp/tsc-leak/sc/s.sock -E'),
  ];

  it('returns only test-suite dtach pids, never production kookr-dtach', () => {
    expect(findLingeringTestDtachPids(() => procs)).toEqual([10, 11, 14]);
  });

  it('returns empty when nothing matches', () => {
    expect(findLingeringTestDtachPids(() => [proc(1, 'node dist/index.js')])).toEqual([]);
  });
});
