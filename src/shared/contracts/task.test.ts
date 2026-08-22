import { describe, expect, it } from 'vitest';
import { isTerminatedAtLaunch, PRE_SESSION_DISPOSITION_REASONS } from './task.js';

describe('isTerminatedAtLaunch (#2744)', () => {
  it('is true for every pre-session disposition reason', () => {
    for (const reason of PRE_SESSION_DISPOSITION_REASONS) {
      expect(isTerminatedAtLaunch({ disposition: { reason } })).toBe(true);
    }
  });

  it('is false when a session attached or the task never launched', () => {
    expect(isTerminatedAtLaunch({})).toBe(false);
    expect(isTerminatedAtLaunch({ disposition: { reason: 'hung_reap' } })).toBe(false);
    expect(isTerminatedAtLaunch({ disposition: { reason: 'first_hook_miss' } })).toBe(false);
  });
});
