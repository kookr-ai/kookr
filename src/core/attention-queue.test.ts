import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Anomaly } from './types.js';
import { AttentionQueue } from './attention-queue.js';

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

describe('AttentionQueue', () => {
  let queue: AttentionQueue;

  beforeEach(() => {
    queue = new AttentionQueue();
  });

  describe('Core queue behavior', () => {
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

    test('enqueue while snoozed updates anomaly but stays snoozed', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'needs_input', 'info'));
      queue.snooze('a1', 60000);

      // Enqueue with different anomaly while snoozed
      queue.enqueue('a1', makeAnomaly('a1', 'repeated_error', 'critical'));

      // Should still be snoozed (not in active queue)
      expect(queue.next()).toBeNull();

      // After snooze expires, should have the updated anomaly
      vi.useFakeTimers();
      vi.advanceTimersByTime(60001);

      const next = queue.next();
      expect(next).not.toBeNull();
      expect(next!.anomaly.type).toBe('repeated_error');
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

    test('agent completes while snoozed - stays completed', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'repeated_error', 'critical'));
      queue.snooze('a1', 5000);
      queue.purge('a1'); // agent completed while snoozed — purge clears both maps

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

    test('anomaly updated while snoozed is preserved after cancel', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'needs_input', 'info'));
      queue.snooze('a1', 60000);

      // Enqueue updates the snoozed anomaly in-place
      queue.enqueue('a1', makeAnomaly('a1', 'stuck_loop', 'critical'));

      queue.cancelSnooze('a1');
      const next = queue.next();
      expect(next!.anomaly.type).toBe('stuck_loop');
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

    test('purge() clears both entries and snoozed', () => {
      vi.useFakeTimers();
      queue.enqueue('a1', makeAnomaly('a1', 'repeated_error', 'critical'));
      queue.snooze('a1', 5000);

      queue.purge('a1');

      vi.advanceTimersByTime(5001);
      expect(queue.next()).toBeNull();
      vi.useRealTimers();
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

      // After snooze consumes it, purge the snooze too
      queue.purge('a1');

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
    test('getSnoozed() returns snoozed entries with agentId', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'repeated_error', 'critical'));
      queue.snooze('a1', 5000, 'investigating');

      const snoozed = queue.getSnoozed();
      expect(snoozed).toHaveLength(1);
      expect(snoozed[0].agentId).toBe('a1');
      expect(snoozed[0].anomaly.type).toBe('repeated_error');
      expect(snoozed[0].reason).toBe('investigating');
      expect(snoozed[0].expiresAt).toBeGreaterThan(Date.now());
    });

    test('getSnoozed() returns empty array when nothing snoozed', () => {
      expect(queue.getSnoozed()).toEqual([]);
    });

    test('importSnoozed() populates snoozed map', () => {
      const anomaly = makeAnomaly('a1', 'repeated_error', 'critical');
      queue.importSnoozed([
        { agentId: 'a1', anomaly, expiresAt: Date.now() + 60000, reason: 'test' },
      ]);

      expect(queue.getSnoozedUntil('a1')).not.toBeNull();
      expect(queue.getAnomaly('a1')).toEqual(anomaly);
      expect(queue.next()).toBeNull(); // should not be in active entries
    });

    test('importSnoozed() clears conflicting active entries', () => {
      queue.enqueue('a1', makeAnomaly('a1', 'needs_input', 'info'));

      const anomaly = makeAnomaly('a1', 'repeated_error', 'critical');
      queue.importSnoozed([
        { agentId: 'a1', anomaly, expiresAt: Date.now() + 60000 },
      ]);

      // Active entry should be gone, only snoozed remains
      expect(queue.next()).toBeNull();
      expect(queue.getSnoozedUntil('a1')).not.toBeNull();
    });

    test('importSnoozed() is idempotent', () => {
      const anomaly = makeAnomaly('a1', 'repeated_error', 'critical');
      const entry = { agentId: 'a1', anomaly, expiresAt: Date.now() + 60000, reason: 'r' };

      queue.importSnoozed([entry]);
      queue.importSnoozed([entry]);

      expect(queue.getSnoozed()).toHaveLength(1);
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
});
