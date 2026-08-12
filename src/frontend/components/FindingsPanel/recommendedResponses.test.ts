import { describe, test, expect } from 'vitest';
import { ANOMALY_TYPES } from '../../../shared/protocol.js';
import {
  RECOMMENDED_RESPONSES,
  recommendedResponseFor,
} from './recommendedResponses.js';

// Drift guard (issue #2396): every AnomalyType must carry catalog-derived
// recommended-response copy. Adding a type to the union without an entry here
// fails the suite — no silent empty product on the finding card. Mirrors the
// docs drift guard in src/core/anomaly-types.test.ts (map keys == union).
describe('recommended responses map', () => {
  test.each(ANOMALY_TYPES)('has non-empty copy for %s', (type) => {
    const copy = RECOMMENDED_RESPONSES[type];
    expect(copy, `missing recommended response for ${type}`).toBeTruthy();
    expect(copy.trim().length).toBeGreaterThan(0);
  });

  test('has an entry for every AnomalyType and no undocumented extras', () => {
    expect(Object.keys(RECOMMENDED_RESPONSES).sort()).toEqual(
      [...ANOMALY_TYPES].sort(),
    );
  });

  test('keeps every line short (<=120 chars, one line only)', () => {
    for (const [type, copy] of Object.entries(RECOMMENDED_RESPONSES)) {
      expect(copy.length, `${type} copy too long`).toBeLessThanOrEqual(120);
      expect(copy, `${type} copy must be one line`).not.toContain('\n');
    }
  });

  test('recommendedResponseFor returns copy for a known type', () => {
    expect(recommendedResponseFor('permission_blocked')).toBe(
      RECOMMENDED_RESPONSES.permission_blocked,
    );
  });

  test('recommendedResponseFor is defensive for undefined input', () => {
    expect(recommendedResponseFor(undefined)).toBeUndefined();
  });
});
