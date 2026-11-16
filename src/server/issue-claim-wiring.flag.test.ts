import { describe, expect, it } from 'vitest';
import { isIssueClaimsEnabled } from './issue-claim-wiring.js';

describe('isIssueClaimsEnabled (issue #3937)', () => {
  it('is on when KOOKR_ISSUE_CLAIMS is unset or empty', () => {
    expect(isIssueClaimsEnabled({})).toBe(true);
    expect(isIssueClaimsEnabled({ KOOKR_ISSUE_CLAIMS: '' })).toBe(true);
    expect(isIssueClaimsEnabled({ KOOKR_ISSUE_CLAIMS: 'on' })).toBe(true);
  });

  it.each(['0', 'false', 'off', 'no', 'OFF'])('is off when KOOKR_ISSUE_CLAIMS=%s', (value) => {
    expect(isIssueClaimsEnabled({ KOOKR_ISSUE_CLAIMS: value })).toBe(false);
  });
});
