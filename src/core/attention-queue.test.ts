import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Anomaly } from './types.js';
import { AttentionQueue } from './attention-queue.js';
import { SNOOZE_UNTIL_NEXT_CHANGE_DURATION_MS } from '../shared/contracts/messages.js';

const FIXED_TIME = new Date('2026-01-01T00:00:00Z');

function makeAnomaly(agentId: string, type: Anomaly['type'], severity: Anomaly['severity']): Anomaly {
  return {
    agentId,
    type,
    severity,
    explanation: `${type} for ${agentId}`,
    detectedAt: FIXED_TIME,
  };
}

function withDetectedAt(anomaly: Anomaly, detectedAt: string): Anomaly {
  return { ...anomaly, detectedAt: new Date(detectedAt) };
}

describe('AttentionQueue', () => {
  let queue: AttentionQueue;

  beforeEach(() => {
    queue = new AttentionQueue();
  });

  describe('Core queue behavior', () => {
    test('notifies observers only when a finding enters the active queue', () => {
      const observer = {
        admitted: vi.fn(),
        resolved: vi.fn(),
      };
      queue.addObserver(observer);
      const first = makeAnomaly('a1', 'needs_input', 'info');
      const repeat = withDetectedAt(makeAnomaly('a1', 'needs_input', 'info'), '2026-01-01T00:01:00Z');
      const changed = makeAnomaly('a1', 'permission_blocked', 'warning');

      queue.enqueue('a1', first);
      queue.enqueue('a1', repeat);
      queue.enqueue('a1', changed);

      expect(observer.admitted).toHaveBeenCalledTimes(2);
      expect(observer.admitted.mock.calls[0][0]).toMatchObject({
        agentId: 'a1',
        fingerprint: 'needs_input::needs_input for a1',
      });
      expect(observer.admitted.mock.calls[1][0]).toMatchObject({
        agentId: 'a1',
        fingerprint: 'permission_blocked::permission_blocked for a1',
      });
      expect(observer.resolved).not.toHaveBeenCalled();
    });

    test('notifies observers on active finding resolution so dedupe can clear', () => {
      const observer = {
        admitted: vi.fn(),
        resolved: vi.fn(),
      };
      queue.addObserver(observer);

      queue.enqueue('a1', makeAnomaly('a1', 'needs_input', 'info'));
      queue.remove('a1');
      queue.remove('a1');

      expect(observer.resolved).toHaveBeenCalledTimes(1);
      expect(observer.resolved.mock.calls[0][0]).toMatchObject({
        agentId: 'a1',
        fingerprint: 'needs_input::needs_input for a1',
      });
    });

    test('respondAndAdvance notifies observers on active finding resolution', () => {
      const observer = {
        admitted: vi.fn(),
        resolved: vi.fn(),
      };
      queue.addObserver(observer);

      queue.enqueue('a1', makeAnomaly('a1', 'needs_input', 'info'));
      queue.enqueue('a2', makeAnomaly('a2', 'permission_blocked', 'warning'));
      const next = queue.respondAndAdvance('a1');

      expect(observer.resolved).toHaveBeenCalledTimes(1);
      expect(observer.resolved.mock.calls[0][0]).toMatchObject({
        agentId: 'a1',
        fingerprint: 'needs_input::needs_input for a1',
      });
      expect(next?.agentId).toBe('a2');
    });

    test('does not notify observers while a non-waking finding remains snoozed', () => {
      const observer = {
        admitted: vi.fn(),
        resolved: vi.fn(),
      };
      queue.addObserver(observer);

      queue.enqueue('a1', makeAnomaly('a1', 'needs_input', 'info'));
      queue.snooze('a1', 60000);
      queue.enqueue('a1', makeAnomaly('a1', 'needs_input', 'info'));

      expect(observer.admitted).toHaveBeenCalledTimes(1);
      expect(observer.resolved).not.toHaveBeenCalled();
    });

    test('notifies observers when enqueue suppresses duplicate or snoozed findings', () => {
      const observer = {
        admitted: vi.fn(),
        suppressed: vi.fn(),
      };
      queue.addObserver(observer);

      queue.enqueue('a1', makeAnomaly('a1', 'needs_input', 'info'));
      queue.enqueue('a1', withDetectedAt(makeAnomaly('a1', 'needs_input', 'info'), '2026-01-01T00:01:00Z'));
      queue.snooze('a1', 60000);
      queue.enqueue('a1', withDetectedAt(makeAnomaly('a1', 'needs_input', 'info'), '2026-01-01T00:02:00Z'));

      expect(observer.admitted).toHaveBeenCalledTimes(1);
      expect(observer.suppressed).toHaveBeenCalledTimes(2);
      expect(observer.suppressed.mock.calls[0][0]).toMatchObject({
        agentId: 'a1',
        fingerprint: 'needs_input::needs_input for a1',
        reason: 'queue_dedupe',
      });
      expect(observer.suppressed.mock.calls[1][0]).toMatchObject({
        agentId: 'a1',
        fingerprint: 'needs_input::needs_input for a1',
        reason: 'queue_snoozed',
      });
    });

    test('enqueue adds agent sorted by severity', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'needs_input', 'info'));
      queue.enqueue('a2', makeAnomaly('a2', 'repeated_error', 'critical'));
      queue.enqueue('a3', makeAnomaly('a3', 'permission_blocked', 'warning'));

      const next = queue.next();
      expect(next).not.toBeNull();
      expect(next!.agentId).toBe('a2'); // critical first
    });

    test('next returns highest-priority agent', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'repeated_error', 'critical'));
      queue.enqueue('a2', makeAnomaly('a2', 'needs_input', 'info'));

      const result = queue.next();
      expect(result!.agentId).toBe('a1');
      expect(result!.anomaly.type).toBe('repeated_error');
    });

    test('next on empty queue returns null', () => {
      expect(queue.next()).toBeNull();
    });

    test('agent completes - removed from queue', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'repeated_error', 'critical'));
      queue.remove('a1');

      expect(queue.next()).toBeNull();
      expect(queue.isAllClear()).toBe(true);
    });

    test('agent re-enters with different anomaly - updated in place', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'needs_input', 'info'));
      queue.enqueue('a1', makeAnomaly('a1', 'repeated_error', 'critical'));

      const all = queue.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].anomaly.type).toBe('repeated_error');
    });

    test('same type with different fingerprint gets a fresh detectedAt', () => {
      const first = withDetectedAt(
        { ...makeAnomaly('a1', 'api_error', 'warning'), explanation: 'API Error: 529 Overloaded' },
        '2026-05-25T09:28:08.000Z',
      );
      const second = withDetectedAt(
        { ...makeAnomaly('a1', 'api_error', 'critical'), explanation: 'Billing quota exhausted' },
        '2026-05-25T10:00:00.000Z',
      );

      queue.enqueue('a1', first);
      queue.enqueue('a1', second);

      const current = queue.peek('a1')!;
      expect(current.explanation).toBe('Billing quota exhausted');
      expect(current.detectedAt.toISOString()).toBe('2026-05-25T10:00:00.000Z');
    });

    test('same fingerprint keeps the original detectedAt', () => {
      const first = withDetectedAt(makeAnomaly('a1', 'api_error', 'warning'), '2026-05-25T09:28:08.000Z');
      const second = withDetectedAt(makeAnomaly('a1', 'api_error', 'warning'), '2026-05-25T10:00:00.000Z');

      queue.enqueue('a1', first);
      queue.enqueue('a1', second);

      expect(queue.peek('a1')!.detectedAt.toISOString()).toBe('2026-05-25T09:28:08.000Z');
    });

    test('liveness findings ignore volatile elapsed-time explanations', () => {
      const first = withDetectedAt(
        { ...makeAnomaly('a1', 'stale_agent', 'warning'), explanation: 'No activity for 10s - agent may be stuck or disconnected' },
        '2026-05-25T09:28:08.000Z',
      );
      const second = withDetectedAt(
        { ...makeAnomaly('a1', 'stale_agent', 'warning'), explanation: 'No activity for 20s - agent may be stuck or disconnected' },
        '2026-05-25T09:28:18.000Z',
      );

      queue.enqueue('a1', first);
      queue.enqueue('a1', second);

      const current = queue.peek('a1')!;
      expect(current.explanation).toContain('20s');
      expect(current.detectedAt.toISOString()).toBe('2026-05-25T09:28:08.000Z');
    });

    test('repeated errors ignore volatile repeat counts', () => {
      const first = withDetectedAt(
        { ...makeAnomaly('a1', 'repeated_error', 'warning'), explanation: 'Same error repeated 3 times: "ECONNRESET"' },
        '2026-05-25T09:28:08.000Z',
      );
      const second = withDetectedAt(
        { ...makeAnomaly('a1', 'repeated_error', 'warning'), explanation: 'Same error repeated 5 times: "ECONNRESET"' },
        '2026-05-25T09:30:00.000Z',
      );

      queue.enqueue('a1', first);
      queue.enqueue('a1', second);

      const current = queue.peek('a1')!;
      expect(current.explanation).toContain('5 times');
      expect(current.detectedAt.toISOString()).toBe('2026-05-25T09:28:08.000Z');
    });
  });

  describe('Skip (F3.6)', () => {
    test('skip moves agent to back of queue', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'repeated_error', 'critical'));
      queue.enqueue('a2', makeAnomaly('a2', 'permission_blocked', 'warning'));

      queue.skip('a1');

      const next = queue.next();
      expect(next!.agentId).toBe('a2');
    });

    test('skipped agent re-enters at correct priority with new anomaly', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'needs_input', 'info'));
      queue.enqueue('a2', makeAnomaly('a2', 'permission_blocked', 'warning'));

      queue.skip('a1');
      // a1 is now at back. Re-enqueue with higher severity
      queue.enqueue('a1', makeAnomaly('a1', 'repeated_error', 'critical'));

      const next = queue.next();
      expect(next!.agentId).toBe('a1'); // now highest priority again
    });
  });

  describe('Snooze (F3.7)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    test('snooze removes agent from queue', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'repeated_error', 'critical'));
      queue.snooze('a1', 5000);

      expect(queue.next()).toBeNull();
    });

    test('snooze expires - agent re-evaluated', () => {
      vi.useFakeTimers();

      queue.enqueue('a1', makeAnomaly('a1', 'repeated_error', 'critical'));
      queue.snooze('a1', 5000);

      expect(queue.next()).toBeNull();

      vi.advanceTimersByTime(5001);

      // After snooze expires, the agent should be back
      expect(queue.next()).not.toBeNull();
      expect(queue.next()!.agentId).toBe('a1');
    });

    test('enqueue while snoozed updates non-escalating anomaly but stays snoozed', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'repeated_error', 'critical'));
      queue.snooze('a1', 60000);

      // Enqueue with lower-severity anomaly while snoozed
      queue.enqueue('a1', makeAnomaly('a1', 'needs_input', 'warning'));

      // Should still be snoozed (not in active queue)
      expect(queue.next()).toBeNull();

      // After snooze expires, should have the updated anomaly
      vi.useFakeTimers();
      vi.advanceTimersByTime(60001);

      const next = queue.next();
      expect(next).not.toBeNull();
      expect(next!.anomaly.type).toBe('needs_input');
    });

    test('same fingerprint severity escalation wakes a timed snooze immediately', () => {
      const first = withDetectedAt(makeAnomaly('a1', 'api_error', 'warning'), '2026-05-25T09:28:08.000Z');
      const second = withDetectedAt(makeAnomaly('a1', 'api_error', 'critical'), '2026-05-25T10:00:00.000Z');

      queue.enqueue('a1', first);
      queue.snooze('a1', 60000);
      queue.enqueue('a1', second);

      expect(queue.getSnoozedUntil('a1')).toBeNull();
      const next = queue.next();
      expect(next).not.toBeNull();
      expect(next!.anomaly.severity).toBe('critical');
      expect(next!.anomaly.detectedAt.toISOString()).toBe('2026-05-25T10:00:00.000Z');
    });

    test('different critical fingerprint wakes a timed snooze immediately', () => {
      const first = { ...makeAnomaly('a1', 'api_error', 'critical'), explanation: 'API Error: 529 Overloaded' };
      const second = { ...makeAnomaly('a1', 'api_error', 'critical'), explanation: 'Billing quota exhausted' };

      queue.enqueue('a1', first);
      queue.snooze('a1', 60000);
      queue.enqueue('a1', second);

      expect(queue.getSnoozedUntil('a1')).toBeNull();
      const next = queue.next();
      expect(next).not.toBeNull();
      expect(next!.anomaly.explanation).toBe('Billing quota exhausted');
    });

    test('until-next-change snooze wakes on a changed finding', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'needs_input', 'warning'));
      queue.snooze('a1', SNOOZE_UNTIL_NEXT_CHANGE_DURATION_MS);

      queue.enqueue('a1', makeAnomaly('a1', 'needs_input', 'warning'));
      expect(queue.next()).toBeNull();

      queue.enqueue('a1', makeAnomaly('a1', 'permission_blocked', 'warning'));

      expect(queue.getSnoozedUntil('a1')).toBeNull();
      const next = queue.next();
      expect(next).not.toBeNull();
      expect(next!.anomaly.type).toBe('permission_blocked');
    });

    test('until-next-change task snooze wakes on first new finding', () => {
      const taskQueue = new AttentionQueue({
        taskIdFor: (agentId) => (agentId === 'sess-A' || agentId === 'sess-B' ? 'task-1' : null),
      });

      taskQueue.snooze('sess-A', SNOOZE_UNTIL_NEXT_CHANGE_DURATION_MS);
      taskQueue.enqueue('sess-B', makeAnomaly('sess-B', 'needs_input', 'info'));

      expect(taskQueue.getSnoozedUntil('sess-B')).toBeNull();
      expect(taskQueue.next()!.anomaly.type).toBe('needs_input');
    });

    test('snoozed same type with different fingerprint gets a fresh detectedAt', () => {
      const first = withDetectedAt(
        { ...makeAnomaly('a1', 'api_error', 'warning'), explanation: 'API Error: 529 Overloaded' },
        '2026-05-25T09:28:08.000Z',
      );
      const second = withDetectedAt(
        { ...makeAnomaly('a1', 'api_error', 'warning'), explanation: 'Billing quota exhausted' },
        '2026-05-25T10:00:00.000Z',
      );

      queue.enqueue('a1', first);
      queue.snooze('a1', 60000);
      queue.enqueue('a1', second);

      expect(queue.next()).toBeNull();
      queue.cancelSnooze('a1');

      const next = queue.next();
      expect(next).not.toBeNull();
      expect(next!.anomaly.explanation).toBe('Billing quota exhausted');
      expect(next!.anomaly.detectedAt.toISOString()).toBe('2026-05-25T10:00:00.000Z');
    });

    test('snoozed liveness finding keeps original detectedAt across volatile explanations', () => {
      const first = withDetectedAt(
        { ...makeAnomaly('a1', 'stale_agent', 'warning'), explanation: 'No activity for 10s - agent may be stuck or disconnected' },
        '2026-05-25T09:28:08.000Z',
      );
      const second = withDetectedAt(
        { ...makeAnomaly('a1', 'stale_agent', 'warning'), explanation: 'No activity for 20s - agent may be stuck or disconnected' },
        '2026-05-25T09:28:18.000Z',
      );

      queue.enqueue('a1', first);
      queue.snooze('a1', 60000);
      queue.enqueue('a1', second);
      queue.cancelSnooze('a1');

      const next = queue.next();
      expect(next).not.toBeNull();
      expect(next!.anomaly.explanation).toContain('20s');
      expect(next!.anomaly.detectedAt.toISOString()).toBe('2026-05-25T09:28:08.000Z');
    });

    test('snooze with fallback anomaly when entry not in entries', () => {
      // Simulate the race: entry was removed from entries but anomaly still exists
      const anomaly = makeAnomaly('a1', 'needs_input', 'info');
      // Don't enqueue — entry is NOT in entries (race condition)
      queue.snooze('a1', 5000, undefined, anomaly);

      // Should be snoozed despite no entry in entries
      expect(queue.next()).toBeNull();
      expect(queue.getSnoozedUntil('a1')).not.toBeNull();

      // After expiry, the snoozed anomaly should restore
      vi.useFakeTimers();
      vi.advanceTimersByTime(5001);
      const next = queue.next();
      expect(next).not.toBeNull();
      expect(next!.agentId).toBe('a1');
      expect(next!.anomaly.type).toBe('needs_input');
      vi.useRealTimers();
    });

    test('snooze without entry or fallback is a no-op', () => {
      queue.snooze('a1', 5000);
      expect(queue.getSnoozedUntil('a1')).toBeNull();
    });

    test('snooze without anomaly stores a task snooze when task identity resolves', () => {
      const taskQueue = new AttentionQueue({
        taskIdFor: (agentId) => (agentId === 'sess-A' ? 'task-1' : null),
      });

      const result = taskQueue.snooze('sess-A', 5000);

      expect(result).not.toBeNull();
      expect(result!.kind).toBe('task');
      expect(taskQueue.getSnoozedUntil('sess-A')).not.toBeNull();
      expect(taskQueue.getSnoozed()[0].key).toBe('task-1');
      expect(taskQueue.getSnoozed()[0].anomaly).toBeUndefined();
    });

    test('agent completes while snoozed - stays completed', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'repeated_error', 'critical'));
      queue.snooze('a1', 5000);
      queue.purge('a1'); // session ended — entries gone, snooze still pending
      queue.purgeTask('a1'); // task deleted — clear the snooze (key=agentId in no-resolver mode)

      vi.useFakeTimers();
      vi.advanceTimersByTime(5001);

      expect(queue.next()).toBeNull();
    });
  });

  describe('cancelSnooze', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    test('moves snoozed agent back to active queue', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'stuck_loop', 'critical'));
      queue.snooze('a1', 60000);
      expect(queue.next()).toBeNull();

      const result = queue.cancelSnooze('a1');
      expect(result).toBe(true);
      expect(queue.getSnoozedUntil('a1')).toBeNull();

      const next = queue.next();
      expect(next).not.toBeNull();
      expect(next!.agentId).toBe('a1');
      expect(next!.anomaly.type).toBe('stuck_loop');
    });

    test('returns false when agent is not snoozed', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'stuck_loop', 'critical'));
      expect(queue.cancelSnooze('a1')).toBe(false);
    });

    test('returns false for unknown agent', () => {
      expect(queue.cancelSnooze('nonexistent')).toBe(false);
    });

    test('restored entry participates in priority sorting', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'stuck_loop', 'critical'));
      queue.enqueue('a2', makeAnomaly('a2', 'needs_input', 'info'));
      queue.snooze('a1', 60000);

      // a2 is now top (only entry)
      expect(queue.next()!.agentId).toBe('a2');

      queue.cancelSnooze('a1');
      // a1 (critical) should now be top
      expect(queue.next()!.agentId).toBe('a1');
    });

    test('non-escalating anomaly updated while snoozed is preserved after cancel', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'stuck_loop', 'critical'));
      queue.snooze('a1', 60000);

      // Enqueue updates the snoozed anomaly in-place
      queue.enqueue('a1', makeAnomaly('a1', 'needs_input', 'warning'));

      queue.cancelSnooze('a1');
      const next = queue.next();
      expect(next!.anomaly.type).toBe('needs_input');
    });
  });

  describe('remove() vs purge()', () => {
    test('remove() only clears entries, not snoozed', () => {
      vi.useFakeTimers();
      queue.enqueue('a1', makeAnomaly('a1', 'repeated_error', 'critical'));
      queue.snooze('a1', 5000);

      queue.remove('a1'); // should NOT clear snoozed

      vi.advanceTimersByTime(5001);
      // Snooze expired — agent should re-enter from snoozed map
      const next = queue.next();
      expect(next).not.toBeNull();
      expect(next!.agentId).toBe('a1');
      vi.useRealTimers();
    });

    test('purge() clears entries; purgeTask() also clears snoozed', () => {
      vi.useFakeTimers();
      queue.enqueue('a1', makeAnomaly('a1', 'repeated_error', 'critical'));
      queue.snooze('a1', 5000);

      queue.purge('a1');
      queue.purgeTask('a1'); // in no-resolver mode the key IS the agentId

      vi.advanceTimersByTime(5001);
      expect(queue.next()).toBeNull();
      vi.useRealTimers();
    });

    test('purge() alone does not drop a pending snooze', () => {
      // Regression: session-end cleanup used to wipe the snooze. With
      // task-keyed snoozes the snooze must survive — only purgeTask() clears.
      queue.enqueue('a1', makeAnomaly('a1', 'repeated_error', 'critical'));
      queue.snooze('a1', 60000);
      queue.purge('a1');
      expect(queue.getSnoozedUntil('a1')).not.toBeNull();
    });

    test('remove() clears active entry', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'repeated_error', 'critical'));
      queue.remove('a1');
      expect(queue.next()).toBeNull();
    });
  });

  describe('Snooze after remove() race condition', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    test('first-time snooze succeeds after remove() clears entries', () => {
      const anomaly = makeAnomaly('a1', 'repeated_error', 'critical');
      queue.enqueue('a1', anomaly);

      // Simulate processEvents() clearing the entry
      queue.remove('a1');

      // getAnomaly() should still find it via lastRemoved
      expect(queue.getAnomaly('a1')).toEqual(anomaly);

      // Snooze using getAnomaly() as fallback (matches ws.ts handler pattern)
      const fallback = queue.getAnomaly('a1');
      queue.snooze('a1', 5000, undefined, fallback ?? undefined);

      expect(queue.getSnoozedUntil('a1')).not.toBeNull();

      // After expiry, the snoozed anomaly should restore
      vi.useFakeTimers();
      vi.advanceTimersByTime(5001);
      const next = queue.next();
      expect(next).not.toBeNull();
      expect(next!.agentId).toBe('a1');
      expect(next!.anomaly.type).toBe('repeated_error');
    });

    test('lastRemoved is cleared by enqueue()', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'repeated_error', 'critical'));
      queue.remove('a1');

      // New anomaly supersedes the removed one
      queue.enqueue('a1', makeAnomaly('a1', 'needs_input', 'info'));
      queue.remove('a1');

      // lastRemoved should now be the needs_input anomaly, not repeated_error
      const anomaly = queue.getAnomaly('a1');
      expect(anomaly).not.toBeNull();
      expect(anomaly!.type).toBe('needs_input');
    });

    test('lastRemoved is cleared by snooze() (consumed)', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'repeated_error', 'critical'));
      queue.remove('a1');

      const fallback = queue.getAnomaly('a1');
      queue.snooze('a1', 5000, undefined, fallback ?? undefined);

      // After snooze consumes lastRemoved, dropping the snooze too should
      // leave getAnomaly with nothing to return.
      queue.purge('a1');
      queue.purgeTask('a1');

      // Now getAnomaly should return null — lastRemoved was consumed
      expect(queue.getAnomaly('a1')).toBeNull();
    });

    test('lastRemoved is cleared by purge()', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'repeated_error', 'critical'));
      queue.remove('a1');
      expect(queue.getAnomaly('a1')).not.toBeNull();

      queue.purge('a1');
      expect(queue.getAnomaly('a1')).toBeNull();
    });

    test('remove() on empty entries does not create stale lastRemoved', () => {
      // remove() when nothing is in entries should not pollute lastRemoved
      queue.remove('a1');
      expect(queue.getAnomaly('a1')).toBeNull();
    });

    test('full race scenario: enqueue → remove → getAnomaly → snooze', () => {
      // This is the exact sequence from the WS handler when processEvents()
      // clears the entry between the UI render and the snooze message
      vi.useFakeTimers();

      const anomaly = makeAnomaly('a1', 'needs_input', 'warning');
      queue.enqueue('a1', anomaly);

      // Event loop tick 1: processEvents() detects resolution
      queue.remove('a1');
      expect(queue.next()).toBeNull(); // Not in active entries

      // Event loop tick 2: WS snooze handler runs
      const snoozeAnomaly = queue.getAnomaly('a1');
      expect(snoozeAnomaly).not.toBeNull(); // Found via lastRemoved!
      queue.snooze('a1', 10000, 'user snoozed', snoozeAnomaly ?? undefined);

      // Verify snooze succeeded
      expect(queue.getSnoozedUntil('a1')).not.toBeNull();

      // Verify snooze expiry restores properly
      vi.advanceTimersByTime(10001);
      const next = queue.next();
      expect(next).not.toBeNull();
      expect(next!.agentId).toBe('a1');
      expect(next!.anomaly.type).toBe('needs_input');
    });
  });

  describe('getSnoozed() and importSnoozed()', () => {
    test('getSnoozed() returns snoozed entries with agentId and key', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'repeated_error', 'critical'));
      queue.snooze('a1', 5000, 'investigating');

      const snoozed = queue.getSnoozed();
      expect(snoozed).toHaveLength(1);
      expect(snoozed[0].agentId).toBe('a1');
      // No resolver configured → snooze key falls back to the agentId.
      expect(snoozed[0].key).toBe('a1');
      expect(snoozed[0].anomaly.type).toBe('repeated_error');
      expect(snoozed[0].reason).toBe('investigating');
      expect(snoozed[0].expiresAt).toBeGreaterThan(Date.now());
    });

    test('getSnoozed() reports the resolved taskId as key when a resolver is configured', () => {
      const taskQueue = new AttentionQueue({
        taskIdFor: (agentId) => (agentId === 'sess-A' ? 'task-1' : null),
      });
      taskQueue.enqueue('sess-A', makeAnomaly('sess-A', 'repeated_error', 'critical'));
      taskQueue.snooze('sess-A', 5000);

      const [entry] = taskQueue.getSnoozed();
      expect(entry.agentId).toBe('sess-A');
      expect(entry.key).toBe('task-1');
    });

    test('expired no-anomaly task snooze does not suppress a newly enqueued anomaly', () => {
      vi.useFakeTimers({ now: FIXED_TIME });
      const taskQueue = new AttentionQueue({
        taskIdFor: (agentId) => (agentId === 'sess-A' ? 'task-1' : null),
      });

      taskQueue.snooze('sess-A', 5000);
      vi.advanceTimersByTime(5001);
      taskQueue.enqueue('sess-A', makeAnomaly('sess-A', 'repeated_error', 'critical'));

      expect(taskQueue.getAll().map((e) => e.agentId)).toEqual(['sess-A']);
      expect(taskQueue.getSnoozedUntil('sess-A')).toBeNull();
    });

    test('expired task snooze with hidden anomaly does not suppress a new post-expiry anomaly', () => {
      vi.useFakeTimers({ now: FIXED_TIME });
      const taskQueue = new AttentionQueue({
        taskIdFor: (agentId) => (agentId === 'sess-A' ? 'task-1' : null),
      });

      taskQueue.snooze('sess-A', 5000);
      taskQueue.enqueue('sess-A', makeAnomaly('sess-A', 'needs_input', 'info'));
      vi.advanceTimersByTime(5001);
      taskQueue.enqueue('sess-A', makeAnomaly('sess-A', 'repeated_error', 'critical'));

      expect(taskQueue.getAll().map((e) => e.agentId)).toEqual(['sess-A']);
      expect(taskQueue.getSnoozed()).toHaveLength(0);
    });

    test('getSnoozed() returns empty array when nothing snoozed', () => {
      expect(queue.getSnoozed()).toEqual([]);
    });

    test('importSnoozed() populates snoozed map', () => {
      const anomaly = makeAnomaly('a1', 'repeated_error', 'critical');
      queue.importSnoozed([
        { agentId: 'a1', key: 'a1', anomaly, expiresAt: Date.now() + 60000, reason: 'test' },
      ]);

      expect(queue.getSnoozedUntil('a1')).not.toBeNull();
      expect(queue.getAnomaly('a1')).toEqual(anomaly);
      expect(queue.next()).toBeNull(); // should not be in active entries
    });

    test('importSnoozed() clears conflicting active entries', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'needs_input', 'info'));

      const anomaly = makeAnomaly('a1', 'repeated_error', 'critical');
      queue.importSnoozed([
        { agentId: 'a1', key: 'a1', anomaly, expiresAt: Date.now() + 60000 },
      ]);

      // Active entry should be gone, only snoozed remains
      expect(queue.next()).toBeNull();
      expect(queue.getSnoozedUntil('a1')).not.toBeNull();
    });

    test('importSnoozed() infers until-next-change snoozes from sentinel duration', () => {
      vi.useFakeTimers({ now: FIXED_TIME });
      const createdAt = Date.now();

      queue.importSnoozed([
        {
          agentId: 'a1',
          key: 'a1',
          anomaly: makeAnomaly('a1', 'needs_input', 'warning'),
          createdAt,
          expiresAt: createdAt + SNOOZE_UNTIL_NEXT_CHANGE_DURATION_MS,
        },
      ]);

      queue.enqueue('a1', makeAnomaly('a1', 'permission_blocked', 'warning'));

      expect(queue.getSnoozedUntil('a1')).toBeNull();
      expect(queue.next()!.anomaly.type).toBe('permission_blocked');
      vi.useRealTimers();
    });

    test('importSnoozed() is idempotent', () => {
      const anomaly = makeAnomaly('a1', 'repeated_error', 'critical');
      const entry = { agentId: 'a1', key: 'a1', anomaly, expiresAt: Date.now() + 60000, reason: 'r' };

      queue.importSnoozed([entry]);
      queue.importSnoozed([entry]);

      expect(queue.getSnoozed()).toHaveLength(1);
    });

    test('task-keyed snooze: new session inherits snooze from prior session of same task', () => {
      // Regression: a Ralph loop's iteration N+1 used to pop a fresh
      // budget_exceeded finding because the snooze was keyed on iteration N's
      // session id. With task-keyed snoozes, every session of the same task
      // shares the snooze.
      const sessionToTask: Record<string, string> = {
        'sess-A': 'task-1',
        'sess-B': 'task-1',
        'sess-C': 'task-2',
      };
      const taskQueue = new AttentionQueue({
        taskIdFor: (agentId) => sessionToTask[agentId] ?? null,
      });

      taskQueue.enqueue('sess-A', {
        ...makeAnomaly('sess-A', 'repeated_error', 'critical'),
        explanation: 'Same error repeated 3 times: "ECONNRESET"',
      });
      taskQueue.snooze('sess-A', 60000, 'investigating');

      // Iteration N ends. New iteration starts on sess-B (same task).
      taskQueue.enqueue('sess-B', {
        ...makeAnomaly('sess-B', 'repeated_error', 'critical'),
        explanation: 'Same error repeated 3 times: "ECONNRESET"',
      });

      // The snooze should swallow the new finding — sess-B doesn't show up.
      expect(taskQueue.getAll()).toEqual([]);
      expect(taskQueue.getSnoozedUntil('sess-B')).not.toBeNull();
      expect(taskQueue.getSnoozedUntil('sess-A')).not.toBeNull();

      // A different task's session is unaffected.
      taskQueue.enqueue('sess-C', makeAnomaly('sess-C', 'repeated_error', 'critical'));
      expect(taskQueue.getAll().map((e) => e.agentId)).toEqual(['sess-C']);

      // Cancelling on the live session restores the finding under that session.
      const cancelled = taskQueue.cancelSnooze('sess-B');
      expect(cancelled).toBe(true);
      expect(taskQueue.getAll().map((e) => e.agentId).sort()).toEqual(['sess-B', 'sess-C']);
    });

    test('purge() of a session does not lose a task-keyed snooze', () => {
      // Regression: Ralph iteration end → cleanupSessionResources →
      // monitor.unregisterAgent → queue.purge — used to wipe the snooze.
      const taskQueue = new AttentionQueue({
        taskIdFor: (agentId) => (agentId.startsWith('sess-') ? 'task-1' : null),
      });

      taskQueue.enqueue('sess-A', {
        ...makeAnomaly('sess-A', 'repeated_error', 'critical'),
        explanation: 'Same error repeated 3 times: "ECONNRESET"',
      });
      taskQueue.snooze('sess-A', 60000);

      // sess-A ends; cleanup purges it from the queue. Snooze must persist.
      taskQueue.purge('sess-A');
      expect(taskQueue.getSnoozedUntil('sess-A')).not.toBeNull();

      // Next session inherits the snooze via the resolver.
      taskQueue.enqueue('sess-B', {
        ...makeAnomaly('sess-B', 'repeated_error', 'critical'),
        explanation: 'Same error repeated 3 times: "ECONNRESET"',
      });
      expect(taskQueue.getAll()).toEqual([]);

      // purgeTask() is the way to actually clear the snooze (full task delete).
      taskQueue.purgeTask('task-1');
      taskQueue.enqueue('sess-B', makeAnomaly('sess-B', 'repeated_error', 'critical'));
      expect(taskQueue.getAll().map((e) => e.agentId)).toEqual(['sess-B']);
    });

    test('expired task-keyed snooze drops without leaving a dead-session entry', () => {
      // Regression of failure-mode-analyst finding: restoring under
      // snooze.agentId after expiry would write a ghost entry under a
      // long-dead session id when in task-keyed mode.
      vi.useFakeTimers();
      const taskQueue = new AttentionQueue({
        taskIdFor: (agentId) => (agentId.startsWith('sess-') ? 'task-1' : null),
      });

      taskQueue.enqueue('sess-A', makeAnomaly('sess-A', 'repeated_error', 'critical'));
      taskQueue.snooze('sess-A', 5000);
      taskQueue.purge('sess-A'); // sess-A dies during snooze

      vi.advanceTimersByTime(5001);

      // Snooze expired and dropped. No ghost entry under sess-A — the
      // supervisor's next tick will re-detect on the live session.
      expect(taskQueue.getAll()).toEqual([]);
      expect(taskQueue.getSnoozedUntil('sess-A')).toBeNull();
      expect(taskQueue.getSnoozedUntil('sess-B')).toBeNull();
      vi.useRealTimers();
    });

    test('round-trip: getSnoozed -> importSnoozed produces same state', () => {
      vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });

      queue.enqueue('a1', makeAnomaly('a1', 'repeated_error', 'critical'));
      queue.snooze('a1', 60000, 'reason1');
      queue.enqueue('a2', makeAnomaly('a2', 'needs_input', 'warning'));
      queue.snooze('a2', 30000);

      const exported = queue.getSnoozed();

      const queue2 = new AttentionQueue();
      queue2.importSnoozed(exported);

      const reimported = queue2.getSnoozed();
      expect(reimported).toHaveLength(2);
      expect(reimported.map((e) => e.agentId).sort()).toEqual(['a1', 'a2']);

      vi.useRealTimers();
    });
  });

  describe('Auto-advance (F3.3)', () => {
    test('respondAndAdvance returns next agent', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'repeated_error', 'critical'));
      queue.enqueue('a2', makeAnomaly('a2', 'permission_blocked', 'warning'));

      const next = queue.respondAndAdvance('a1');
      expect(next).not.toBeNull();
      expect(next!.agentId).toBe('a2');

      // a1 should be removed
      expect(queue.getAll()).toHaveLength(1);
    });

    test('respondAndAdvance when last agent returns null', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'repeated_error', 'critical'));

      const next = queue.respondAndAdvance('a1');
      expect(next).toBeNull();
      expect(queue.isAllClear()).toBe(true);
    });
  });

  describe('isAllClear', () => {
    test('returns true when empty', () => {
      expect(queue.isAllClear()).toBe(true);
    });

    test('returns false when agents queued', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'needs_input', 'info'));
      expect(queue.isAllClear()).toBe(false);
    });
  });

  describe('getActiveAnomaly', () => {
    test('returns the active anomaly for an enqueued agent', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'repeated_error', 'critical'));
      const active = queue.getActiveAnomaly('a1');
      expect(active).not.toBeNull();
      expect(active!.type).toBe('repeated_error');
    });

    test('returns null for an unknown agent', () => {
      expect(queue.getActiveAnomaly('nope')).toBeNull();
    });

    test('returns null when the agent is snoozed', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'permission_blocked', 'warning'));
      queue.snooze('a1', 60_000);
      expect(queue.getActiveAnomaly('a1')).toBeNull();
    });

    test('returns null after remove (does not fall back to lastRemoved)', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'needs_input', 'info'));
      queue.remove('a1');
      // getAnomaly() would return the lastRemoved fallback; getActiveAnomaly must not.
      expect(queue.getAnomaly('a1')).not.toBeNull();
      expect(queue.getActiveAnomaly('a1')).toBeNull();
    });

    test('expired snoozes become observable as active', () => {
      vi.useFakeTimers();
      vi.setSystemTime(FIXED_TIME);
      try {
        queue.enqueue('a1', makeAnomaly('a1', 'repeated_error', 'critical'));
        queue.snooze('a1', 60_000);
        expect(queue.getActiveAnomaly('a1')).toBeNull();

        vi.advanceTimersByTime(61_000);
        const active = queue.getActiveAnomaly('a1');
        expect(active).not.toBeNull();
        expect(active!.type).toBe('repeated_error');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
