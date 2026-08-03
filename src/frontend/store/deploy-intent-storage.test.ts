// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { loadDeployIntent, saveDeployIntent } from './deploy-intent-storage.js';

describe('deploy-intent-storage', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  test('defaults to false when unset', () => {
    expect(loadDeployIntent()).toBe(false);
  });

  test('round-trips a recent deploy intent', () => {
    const now = 1_700_000_000_000;
    saveDeployIntent(true, now);
    expect(loadDeployIntent(now + 1_000)).toBe(true);
  });

  test('clears on set false', () => {
    saveDeployIntent(true);
    saveDeployIntent(false);
    expect(loadDeployIntent()).toBe(false);
  });

  test('expires after the TTL window', () => {
    const now = 1_700_000_000_000;
    saveDeployIntent(true, now);
    expect(loadDeployIntent(now + 6 * 60 * 1000)).toBe(false);
  });
});
