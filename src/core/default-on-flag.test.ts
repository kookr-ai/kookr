import { describe, expect, it } from 'vitest';
import { isDefaultOnFlagEnabled, isKillSwitchValue } from './default-on-flag.js';

describe('isDefaultOnFlagEnabled (issue #3937)', () => {
  it('is on when the variable is unset or empty', () => {
    expect(isDefaultOnFlagEnabled(undefined)).toBe(true);
    expect(isDefaultOnFlagEnabled('')).toBe(true);
    expect(isDefaultOnFlagEnabled('   ')).toBe(true);
  });

  it.each(['0', 'false', 'off', 'no', ' OFF ', 'False', 'NO'])('is off for the kill switch %j', (raw) => {
    expect(isDefaultOnFlagEnabled(raw)).toBe(false);
    expect(isKillSwitchValue(raw)).toBe(true);
  });

  it.each(['1', 'true', 'on', 'yes', 'enabled', 'typo'])('stays on for %j', (raw) => {
    expect(isDefaultOnFlagEnabled(raw)).toBe(true);
    expect(isKillSwitchValue(raw)).toBe(false);
  });
});
