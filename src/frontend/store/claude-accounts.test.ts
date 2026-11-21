import { describe, expect, test } from 'vitest';
import { accountStatus, pickContinueAccount } from './claude-accounts.js';
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
