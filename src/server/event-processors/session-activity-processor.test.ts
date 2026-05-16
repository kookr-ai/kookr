import { describe, expect, test, vi } from 'vitest';
import { createSessionActivityProcessor } from './session-activity-processor.js';

describe('SessionActivityProcessor', () => {
  test('updates lastEventAt for the matching session', () => {
    const session = { tmuxSession: 'agent-1', lastEventAt: 0 };
    const otherSession = { tmuxSession: 'agent-2', lastEventAt: 0 };
    const processor = createSessionActivityProcessor({
      taskLookup: {
        findTaskBySession: vi.fn().mockReturnValue({ sessions: [session, otherSession] }),
      },
      now: () => 1234,
    });

    processor.process('agent-1');

    expect(session.lastEventAt).toBe(1234);
    expect(otherSession.lastEventAt).toBe(0);
  });

  test('does nothing when no owner task is found', () => {
    const processor = createSessionActivityProcessor({
      taskLookup: { findTaskBySession: vi.fn().mockReturnValue(null) },
      now: () => 1234,
    });

    expect(() => processor.process('agent-1')).not.toThrow();
  });
});
