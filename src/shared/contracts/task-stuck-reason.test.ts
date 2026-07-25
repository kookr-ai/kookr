import { describe, expect, it } from 'vitest';

import { isTaskStuckReason, TASK_STUCK_REASONS } from './task-stuck-reason.js';

// The reason strings are a wire contract consumed by the dashboard badge and
// any supervisor client filtering on stuckReason — pin the literals so a
// rename is a deliberate, cross-surface decision.
describe('task-stuck-reason contract', () => {
  it('pins the documented reason literals', () => {
    expect([...TASK_STUCK_REASONS]).toEqual([
      'awaiting_completion_ack',
      'hung_suspect',
      'waiting_on_input',
      'permission_blocked',
    ]);
  });

  it('narrows valid reasons and rejects everything else', () => {
    for (const reason of TASK_STUCK_REASONS) expect(isTaskStuckReason(reason)).toBe(true);
    expect(isTaskStuckReason('running')).toBe(false);
    expect(isTaskStuckReason(null)).toBe(false);
    expect(isTaskStuckReason(undefined)).toBe(false);
  });
});
