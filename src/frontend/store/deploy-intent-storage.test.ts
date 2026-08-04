// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  DEPLOY_INTENT_TTL_MS,
  deployIntentRemainingMs,
  loadDeployIntent,
  loadDeployIntentActive,
  saveDeployIntent,
} from './deploy-intent-storage.js';

describe('deploy-intent-storage', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  test('defaults to inactive when unset', () => {
    expect(loadDeployIntent()).toBeNull();
    expect(loadDeployIntentActive()).toBe(false);
    expect(deployIntentRemainingMs()).toBe(0);
  });

  test('round-trips a recent deploy intent with pre-deploy commit', () => {
    const now = 1_700_000_000_000;
    saveDeployIntent(true, { preDeployCommit: 'abc123d', now });
    expect(loadDeployIntent(now + 1_000)).toEqual({
      active: true,
      preDeployCommit: 'abc123d',
      stampedAt: now,
    });
    expect(loadDeployIntentActive(now + 1_000)).toBe(true);
  });

  test('clears on set false', () => {
    saveDeployIntent(true, { preDeployCommit: 'abc123d' });
    saveDeployIntent(false);
    expect(loadDeployIntent()).toBeNull();
    expect(loadDeployIntentActive()).toBe(false);
  });

  test('expires after the TTL window and stays active just under it (#1982 ~2min)', () => {
    const now = 1_700_000_000_000;
    saveDeployIntent(true, { preDeployCommit: 'abc123d', now });
    expect(DEPLOY_INTENT_TTL_MS).toBe(2 * 60 * 1000);
    expect(loadDeployIntentActive(now + DEPLOY_INTENT_TTL_MS - 1)).toBe(true);
    expect(loadDeployIntentActive(now + DEPLOY_INTENT_TTL_MS + 1)).toBe(false);
  });

  test('deployIntentRemainingMs counts down and hits zero after TTL', () => {
    const now = 1_700_000_000_000;
    saveDeployIntent(true, { preDeployCommit: 'abc123d', now });
    expect(deployIntentRemainingMs(now + 30_000)).toBe(DEPLOY_INTENT_TTL_MS - 30_000);
    expect(deployIntentRemainingMs(now + DEPLOY_INTENT_TTL_MS + 5)).toBe(0);
  });

  test('preserves preDeployCommit when re-asserting without a new value', () => {
    const now = 1_700_000_000_000;
    saveDeployIntent(true, { preDeployCommit: 'abc123d', now });
    saveDeployIntent(true, { now: now + 100 });
    expect(loadDeployIntent(now + 100)?.preDeployCommit).toBe('abc123d');
  });

  test('drops invalid legacy payloads', () => {
    sessionStorage.setItem('kookr.deploying', 'not-a-number');
    expect(loadDeployIntent()).toBeNull();
  });
});
