import { describe, expect, it } from 'vitest';

import { findLingeringTestRelays } from './relay-orphan-reaper.global.js';
import type { ProcessSnapshot } from '../src/core/orphan-process-scanner.js';

function proc(pid: number, cmdline: string): ProcessSnapshot {
  return { pid, ppid: 1, cmdline, rssBytes: 0, startTimeMs: null, cwd: null };
}

describe('findLingeringTestRelays', () => {
  const processes: ProcessSnapshot[] = [
    proc(10, 'node --import tsx /w/kookr/relay/server.ts'), // test relay (marked)
    proc(11, 'node /w/kookr/relay/server.js'), // prod-ish relay (unmarked)
    proc(12, 'dtach -n /tmp/kookr-dtach/x.sock claude'), // dtach, not relay
    proc(13, 'node dist/index.js'), // unrelated
  ];
  const environ: Record<number, Record<string, string> | null> = {
    10: { KOOKR_RELAY_DIE_WITH_PARENT: '1' },
    11: { KOOKR_RELAY_ADMIN_TOKEN: 'x' },
    12: { KOOKR_RELAY_DIE_WITH_PARENT: '1' },
    13: null,
  };

  it('returns only relay servers carrying the test die-with-parent marker', () => {
    const pids = findLingeringTestRelays(
      () => processes,
      (pid) => environ[pid] ?? null,
    );
    // pid 10 only: 11 is an unmarked relay (someone's local/prod relay), 12 is
    // dtach not relay, 13 is unrelated.
    expect(pids).toEqual([10]);
  });

  it('returns empty when nothing matches', () => {
    const pids = findLingeringTestRelays(
      () => [proc(20, 'node dist/index.js')],
      () => ({ KOOKR_RELAY_DIE_WITH_PARENT: '1' }),
    );
    expect(pids).toEqual([]);
  });
});
