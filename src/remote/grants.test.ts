import { describe, expect, it } from 'vitest';

import type { RemoteCommandAction } from './command-journal.js';
import { grantForRemoteCommandAction } from './grants.js';
import type { KnownGrant } from './policy-sync.js';

// The expected mapping, typed as Record<RemoteCommandAction, KnownGrant>. The annotation
// makes a local `tsc` (or an editor's TS server) reject the file if a union member loses
// its entry or a new member is added without one. Note this file is excluded from the
// repo's build tsconfigs, so that type check is a local/editor signal, not a CI gate —
// the runtime backstop below is what `pnpm test` actually enforces:
//   - `it.each` asserts every entry against the real classifier, so any grants.ts change
//     (a remapped or dropped action returning the wrong grant or null) fails the suite;
//   - the length pin fails the suite if an entry is dropped from this table.
const EXPECTED_GRANT: Record<RemoteCommandAction, KnownGrant> = {
  presetReply: 'terminalInput',
  submitMessage: 'terminalInput',
  leaseAcquire: 'terminalInput',
  leaseHeartbeat: 'terminalInput',
  leaseOverride: 'terminalInput',
  permissionApprove: 'permissionApprove',
  launch: 'launch',
  skip: 'stop',
  snooze: 'stop',
  'mark-done': 'stop',
};

describe('grantForRemoteCommandAction', () => {
  const cases = Object.entries(EXPECTED_GRANT) as Array<[RemoteCommandAction, KnownGrant]>;

  it('pins the mapped-action count so a dropped entry fails at runtime', () => {
    // RemoteCommandAction has 10 members; every one must appear in EXPECTED_GRANT.
    expect(Object.keys(EXPECTED_GRANT)).toHaveLength(10);
  });

  it.each(cases)('maps %s to the %s grant', (action, expected) => {
    expect(grantForRemoteCommandAction(action)).toBe(expected);
  });

  it('returns null for an unknown action string (default deny)', () => {
    expect(grantForRemoteCommandAction('not-a-real-action')).toBeNull();
  });

  // Near-misses of real actions must not leak a grant: an unmapped string, wrong casing,
  // or a hyphen/camelCase variant of 'mark-done'/'permissionApprove' all deny.
  it.each(['markDone', 'MARK_DONE', 'permission-approve', 'Launch', 'stop', 'terminalInput'])(
    'returns null for the near-miss action %o (default deny)',
    (action) => {
      expect(grantForRemoteCommandAction(action)).toBeNull();
    },
  );

  it.each([undefined, null, '', 42, {}, []])(
    'returns null for the non-string input %o (default deny)',
    (action) => {
      expect(grantForRemoteCommandAction(action)).toBeNull();
    },
  );
});
