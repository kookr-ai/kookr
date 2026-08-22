import { describe, expect, it } from 'vitest';
import { isTerminatedAtLaunch } from './task.js';

describe('isTerminatedAtLaunch (#2744)', () => {
  it('is true for pre-session launch_error / launch_timeout / stale_open_launch', () => {
    expect(isTerminatedAtLaunch({ disposition: { reason: 'launch_error' } })).toBe(true);
    expect(isTerminatedAtLaunch({ disposition: { reason: 'launch_timeout' } })).toBe(true);
    expect(isTerminatedAtLaunch({ disposition: { reason: 'stale_open_launch' } })).toBe(true);
  });

  it('is false when a session attached or the task never launched', () => {
    expect(isTerminatedAtLaunch({})).toBe(false);
    expect(isTerminatedAtLaunch({ disposition: { reason: 'hung_reap' } })).toBe(false);
    expect(isTerminatedAtLaunch({ disposition: { reason: 'first_hook_miss' } })).toBe(false);
  });
});
