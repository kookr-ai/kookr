import { describe, expect, test } from 'vitest';
import { accountStatus, nearLimitWindows, pickContinueAccount, testQuotaStatus } from './claude-accounts.js';
import { makeAccount } from './claude-accounts-fixtures.js';
import type { ClaudeAccountTestResponse } from '../../shared/contracts/claude-accounts.js';

const test_ = (name: string, outcome: ClaudeAccountTestResponse['outcome']): ClaudeAccountTestResponse => ({
  name, outcome, message: '', testedAt: '2026-01-01T00:00:00.000Z',
});

describe('accountStatus', () => {
  test('maps each outcome to its chip label', () => {
    expect(accountStatus(undefined).label).toBe('Not tested');
    expect(accountStatus(test_('a', 'ok')).label).toBe('Working');
    expect(accountStatus(test_('a', 'usage_limited')).label).toBe('Out of quota');
    expect(accountStatus(test_('a', 'auth_failed')).label).toBe('Sign-in failed');
  });
});

describe('tested-account quota', () => {
  const resetsAt = '2026-12-01T00:00:00.000Z';
  const withQuota = (quota: ClaudeAccountTestResponse['quota']): ClaudeAccountTestResponse => ({ ...test_('a', 'ok'), quota });

  test('a near-limit window turns Working into Near limit; the outcome stays ok', () => {
    const near = withQuota({ sevenDay: { utilization: 99, resetsAt, status: 'allowed_warning' } });
    expect(accountStatus(near)).toEqual({ outcome: 'ok', label: 'Near limit', tone: 'warn' });
    expect(accountStatus(withQuota({ sevenDay: { utilization: 40, resetsAt, status: 'allowed' } })).label).toBe('Working');
    expect(nearLimitWindows(near.quota)).toEqual(['7-day']);
  });

  test('testQuotaStatus shapes the measured windows like the host quota, dated by the test', () => {
    expect(testQuotaStatus(test_('a', 'ok'))).toBeNull();
    expect(testQuotaStatus(withQuota({}))).toBeNull();
    expect(testQuotaStatus(withQuota({ fiveHour: { utilization: 56, resetsAt } }))).toEqual({
      fiveHour: { utilization: 56, resetsAt },
      sevenDay: null,
      updatedAt: Date.parse('2026-01-01T00:00:00.000Z'),
    });
  });
});

describe('pickContinueAccount', () => {
  const accounts = [makeAccount('host'), makeAccount('pro'), makeAccount('work')];

  test('skips the current account and accounts whose last test was out of quota or refused', () => {
    const tests = { pro: test_('pro', 'usage_limited') };
    expect(pickContinueAccount(accounts, 'host', tests)?.name).toBe('work');
    expect(pickContinueAccount(accounts, 'host', { ...tests, work: test_('work', 'auth_failed') })).toBeUndefined();
  });

  test('prefers the first untested or working account, in list order', () => {
    expect(pickContinueAccount(accounts, 'work', {})?.name).toBe('host');
    expect(pickContinueAccount(accounts, 'host', { pro: test_('pro', 'ok') })?.name).toBe('pro');
  });
});
