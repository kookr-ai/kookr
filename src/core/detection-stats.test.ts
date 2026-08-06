import { beforeEach, describe, expect, test } from 'vitest';
import { ANOMALY_TYPES } from './anomaly-types.js';
import type { AnomalyType } from './types.js';
import {
  SUPPRESSION_REASONS,
  getDetectionStats,
  hydrateDetectionStats,
  recordDetectionCheck,
  recordDetectionFire,
  recordFalseNegative,
  recordFalsePositive,
  recordSubagentOrphans,
  recordSubagentTtlEviction,
  recordSuppression,
  resetDetectionStats,
} from './detection-stats.js';
import type { DetectionStats } from './detection-stats.js';

/** A type distinct from whichever type a case records, to assert siblings stay untouched. */
const OTHER_TYPE: AnomalyType = 'permission_blocked';

/** Sum every value in a per-type counter bucket. */
function bucketTotal(bucket: Record<AnomalyType, number>): number {
  return Object.values(bucket).reduce((sum, n) => sum + n, 0);
}

describe('detection-stats', () => {
  beforeEach(() => {
    resetDetectionStats();
  });

  describe('getDetectionStats', () => {
    test('returns the zeroed initial shape after reset', () => {
      const stats = getDetectionStats();
      for (const type of ANOMALY_TYPES) {
        expect(stats.checks[type]).toBe(0);
        expect(stats.fires[type]).toBe(0);
        expect(stats.falsePositives[type]).toBe(0);
        expect(stats.falseNegatives[type]).toBe(0);
        expect(stats.suppressed[type]).toBe(0);
        for (const reason of SUPPRESSION_REASONS) {
          expect(stats.suppressionReasons[type][reason]).toBe(0);
        }
      }
      expect(stats.subagentOrphans).toBe(0);
      expect(stats.subagentSessionsWithOrphans).toBe(0);
      expect(stats.subagentTtlEvictions).toBe(0);
    });

    test('returns a defensive copy that does not alias internal state', () => {
      recordDetectionCheck('needs_input');
      const first = getDetectionStats();
      first.checks.needs_input = 999;
      first.suppressionReasons.needs_input.subagent_running = 999;
      first.subagentOrphans = 999;

      const second = getDetectionStats();
      expect(second.checks.needs_input).toBe(1);
      expect(second.suppressionReasons.needs_input.subagent_running).toBe(0);
      expect(second.subagentOrphans).toBe(0);
    });
  });

  describe('record functions', () => {
    test('recordDetectionCheck increments only the checks counter for its type', () => {
      recordDetectionCheck('repeated_error');
      recordDetectionCheck('repeated_error');
      const stats = getDetectionStats();
      expect(stats.checks.repeated_error).toBe(2);
      expect(stats.checks[OTHER_TYPE]).toBe(0);
      expect(bucketTotal(stats.fires)).toBe(0);
      expect(bucketTotal(stats.falsePositives)).toBe(0);
      expect(bucketTotal(stats.falseNegatives)).toBe(0);
      expect(bucketTotal(stats.suppressed)).toBe(0);
    });

    test('recordDetectionFire increments only the fires counter for its type', () => {
      recordDetectionFire('stale_agent');
      const stats = getDetectionStats();
      expect(stats.fires.stale_agent).toBe(1);
      expect(stats.fires[OTHER_TYPE]).toBe(0);
      expect(bucketTotal(stats.checks)).toBe(0);
    });

    test('recordFalsePositive increments only the falsePositives counter for its type', () => {
      recordFalsePositive('api_error');
      const stats = getDetectionStats();
      expect(stats.falsePositives.api_error).toBe(1);
      expect(stats.falsePositives[OTHER_TYPE]).toBe(0);
      expect(bucketTotal(stats.falseNegatives)).toBe(0);
    });

    test('recordFalseNegative increments only the falseNegatives counter for its type', () => {
      recordFalseNegative('budget_exceeded');
      const stats = getDetectionStats();
      expect(stats.falseNegatives.budget_exceeded).toBe(1);
      expect(stats.falseNegatives[OTHER_TYPE]).toBe(0);
      expect(bucketTotal(stats.falsePositives)).toBe(0);
    });

    test('recordSuppression increments both the suppressed total and the per-reason counter', () => {
      recordSuppression('needs_input', 'subagent_running');
      recordSuppression('needs_input', 'subagent_running');
      recordSuppression('needs_input', 'snooze_false_positive');
      const stats = getDetectionStats();
      expect(stats.suppressed.needs_input).toBe(3);
      expect(stats.suppressionReasons.needs_input.subagent_running).toBe(2);
      expect(stats.suppressionReasons.needs_input.snooze_false_positive).toBe(1);
      expect(stats.suppressionReasons.needs_input.systemic_hook_stall).toBe(0);
      // Siblings untouched.
      expect(stats.suppressed[OTHER_TYPE]).toBe(0);
      expect(stats.suppressionReasons[OTHER_TYPE].subagent_running).toBe(0);
    });

    test('recordSubagentOrphans accumulates orphan count and affected-session count independently', () => {
      recordSubagentOrphans(3, 1);
      recordSubagentOrphans(2, 1);
      const stats = getDetectionStats();
      expect(stats.subagentOrphans).toBe(5);
      expect(stats.subagentSessionsWithOrphans).toBe(2);
      expect(stats.subagentTtlEvictions).toBe(0);
    });

    test('recordSubagentTtlEviction accumulates the eviction count', () => {
      recordSubagentTtlEviction(4);
      recordSubagentTtlEviction(1);
      const stats = getDetectionStats();
      expect(stats.subagentTtlEvictions).toBe(5);
      expect(stats.subagentOrphans).toBe(0);
      expect(stats.subagentSessionsWithOrphans).toBe(0);
    });
  });

  describe('hydrateDetectionStats', () => {
    test('merges provided per-type fields', () => {
      hydrateDetectionStats({
        checks: { needs_input: 10 } as DetectionStats['checks'],
        fires: { needs_input: 4 } as DetectionStats['fires'],
      });
      const stats = getDetectionStats();
      expect(stats.checks.needs_input).toBe(10);
      expect(stats.fires.needs_input).toBe(4);
    });

    test('preserves fields absent from a partial snapshot (no accidental zeroing)', () => {
      // Seed some live state, then hydrate a snapshot that only mentions `checks`.
      recordDetectionFire('needs_input');
      recordFalsePositive('api_error');
      recordSuppression('stale_agent', 'systemic_hook_stall');
      recordSubagentOrphans(7, 2);
      recordSubagentTtlEviction(3);

      hydrateDetectionStats({
        checks: { needs_input: 42 } as DetectionStats['checks'],
      });

      const stats = getDetectionStats();
      // The named bucket/key is applied.
      expect(stats.checks.needs_input).toBe(42);
      // Everything the snapshot did not mention is preserved, not zeroed.
      expect(stats.fires.needs_input).toBe(1);
      expect(stats.falsePositives.api_error).toBe(1);
      expect(stats.suppressed.stale_agent).toBe(1);
      expect(stats.suppressionReasons.stale_agent.systemic_hook_stall).toBe(1);
      expect(stats.subagentOrphans).toBe(7);
      expect(stats.subagentSessionsWithOrphans).toBe(2);
      expect(stats.subagentTtlEvictions).toBe(3);
    });

    test('hydrates per-type keys absent from the snapshot bucket at their existing value', () => {
      recordDetectionCheck('api_error');
      // Snapshot names `checks` but omits `api_error` within it.
      hydrateDetectionStats({
        checks: { needs_input: 5 } as DetectionStats['checks'],
      });
      const stats = getDetectionStats();
      expect(stats.checks.needs_input).toBe(5);
      // api_error was not in the snapshot bucket, so it keeps its prior value.
      expect(stats.checks.api_error).toBe(1);
    });

    test('hydrates suppressionReasons nested counters', () => {
      hydrateDetectionStats({
        suppressed: { needs_input: 6 } as DetectionStats['suppressed'],
        suppressionReasons: {
          needs_input: {
            subagent_running: 2,
            systemic_hook_stall: 3,
            snooze_false_positive: 1,
          },
        } as DetectionStats['suppressionReasons'],
      });
      const stats = getDetectionStats();
      expect(stats.suppressed.needs_input).toBe(6);
      expect(stats.suppressionReasons.needs_input.subagent_running).toBe(2);
      expect(stats.suppressionReasons.needs_input.systemic_hook_stall).toBe(3);
      expect(stats.suppressionReasons.needs_input.snooze_false_positive).toBe(1);
    });

    test('hydrates scalar subagent counters', () => {
      hydrateDetectionStats({
        subagentOrphans: 12,
        subagentSessionsWithOrphans: 4,
        subagentTtlEvictions: 9,
      });
      const stats = getDetectionStats();
      expect(stats.subagentOrphans).toBe(12);
      expect(stats.subagentSessionsWithOrphans).toBe(4);
      expect(stats.subagentTtlEvictions).toBe(9);
    });

    test('ignores invalid values: negatives, non-finite, wrong types', () => {
      recordDetectionCheck('needs_input'); // existing value 1

      hydrateDetectionStats({
        checks: {
          needs_input: -1, // negative rejected -> keep existing
          repeated_error: Number.NaN, // NaN rejected -> keep default 0
          api_error: Number.POSITIVE_INFINITY, // non-finite rejected
          stale_agent: 'nope' as unknown as number, // wrong type rejected
          merge_conflict: 8, // valid -> applied
        } as DetectionStats['checks'],
        subagentOrphans: -5, // negative scalar rejected
        subagentTtlEvictions: 'x' as unknown as number, // wrong-type scalar rejected
      });

      const stats = getDetectionStats();
      expect(stats.checks.needs_input).toBe(1);
      expect(stats.checks.repeated_error).toBe(0);
      expect(stats.checks.api_error).toBe(0);
      expect(stats.checks.stale_agent).toBe(0);
      expect(stats.checks.merge_conflict).toBe(8);
      expect(stats.subagentOrphans).toBe(0);
      expect(stats.subagentTtlEvictions).toBe(0);
    });

    test('ignores unknown keys and non-object buckets', () => {
      hydrateDetectionStats({
        checks: null as unknown as DetectionStats['checks'],
        // Unknown per-type key inside a valid bucket is ignored.
        fires: { not_a_real_type: 99, needs_input: 2 } as unknown as DetectionStats['fires'],
        // Unknown top-level key is ignored (does not throw).
        bogusField: 123,
      } as Partial<DetectionStats> & Record<string, unknown>);
      const stats = getDetectionStats();
      expect(stats.fires.needs_input).toBe(2);
      expect(bucketTotal(stats.checks)).toBe(0);
      expect((stats as unknown as Record<string, unknown>).not_a_real_type).toBeUndefined();
    });

    test('accepts a fully empty snapshot without touching any counter', () => {
      recordDetectionCheck('needs_input');
      hydrateDetectionStats({});
      expect(getDetectionStats().checks.needs_input).toBe(1);
    });
  });

  describe('resetDetectionStats', () => {
    test('returns the singleton to its initial zeroed shape', () => {
      recordDetectionCheck('needs_input');
      recordDetectionFire('api_error');
      recordFalsePositive('stale_agent');
      recordFalseNegative('merge_conflict');
      recordSuppression('needs_input', 'subagent_running');
      recordSubagentOrphans(3, 1);
      recordSubagentTtlEviction(2);

      resetDetectionStats();

      const stats = getDetectionStats();
      expect(bucketTotal(stats.checks)).toBe(0);
      expect(bucketTotal(stats.fires)).toBe(0);
      expect(bucketTotal(stats.falsePositives)).toBe(0);
      expect(bucketTotal(stats.falseNegatives)).toBe(0);
      expect(bucketTotal(stats.suppressed)).toBe(0);
      for (const type of ANOMALY_TYPES) {
        for (const reason of SUPPRESSION_REASONS) {
          expect(stats.suppressionReasons[type][reason]).toBe(0);
        }
      }
      expect(stats.subagentOrphans).toBe(0);
      expect(stats.subagentSessionsWithOrphans).toBe(0);
      expect(stats.subagentTtlEvictions).toBe(0);
    });
  });

  test('every exported ANOMALY_TYPE has record coverage in checks and fires', () => {
    for (const type of ANOMALY_TYPES) {
      recordDetectionCheck(type);
      recordDetectionFire(type);
    }
    const stats = getDetectionStats();
    for (const type of ANOMALY_TYPES) {
      expect(stats.checks[type]).toBe(1);
      expect(stats.fires[type]).toBe(1);
    }
  });
});
