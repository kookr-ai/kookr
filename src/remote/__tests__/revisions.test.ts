import { describe, expect, test } from 'vitest';
import { RemoteSessionRevisionTracker } from '../revisions.js';

describe('RemoteSessionRevisionTracker', () => {
  test('increments monotonically per node/session scope', () => {
    const tracker = new RemoteSessionRevisionTracker();
    const a = { nodeId: 'node-a', sessionId: 'session-1' };
    const b = { nodeId: 'node-a', sessionId: 'session-2' };
    const c = { nodeId: 'node-b', sessionId: 'session-1' };

    expect(tracker.current(a)).toBe(0);
    expect(tracker.next(a)).toBe(1);
    expect(tracker.next(a)).toBe(2);
    expect(tracker.current(a)).toBe(2);
    expect(tracker.current(b)).toBe(0);
    expect(tracker.next(b)).toBe(1);
    expect(tracker.next(c)).toBe(1);
  });

  test('reset clears only the requested node/session scope', () => {
    const tracker = new RemoteSessionRevisionTracker();
    const a = { nodeId: 'node-a', sessionId: 'session-1' };
    const b = { nodeId: 'node-a', sessionId: 'session-2' };

    tracker.next(a);
    tracker.next(b);
    tracker.reset(a);

    expect(tracker.current(a)).toBe(0);
    expect(tracker.current(b)).toBe(1);
  });
});
