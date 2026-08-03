import { describe, test, expect } from 'vitest';
import { timingSafeTokenEqual } from './admin-token.js';

describe('timingSafeTokenEqual', () => {
  test('returns true for equal tokens', () => {
    expect(timingSafeTokenEqual('secret-token', 'secret-token')).toBe(true);
  });

  test('returns false for unequal tokens of the same length', () => {
    expect(timingSafeTokenEqual('secret-token', 'secret-tokeX')).toBe(false);
  });

  test('returns false for unequal tokens of different lengths', () => {
    expect(timingSafeTokenEqual('secret', 'secre')).toBe(false);
    expect(timingSafeTokenEqual('secret', 'secret!')).toBe(false);
  });

  test('returns false when presented is undefined', () => {
    expect(timingSafeTokenEqual('secret', undefined)).toBe(false);
  });

  test('returns false for empty presented token against non-empty expected', () => {
    expect(timingSafeTokenEqual('secret', '')).toBe(false);
  });
});
