import { afterEach, describe, expect, test } from 'vitest';
import { createKookrStore, useKookrStore } from './useStore.js';
import { applyQuotaHeadroomThreshold } from './quota-headroom-threshold.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

describe('quota headroom threshold hydration', () => {
  afterEach(() => {
    syncGlobalStore();
  });

  test('applyQuotaHeadroomThreshold accepts 0–100 and ignores junk', () => {
    syncGlobalStore();
    expect(useKookrStore.getState().quotaHeadroomThreshold).toBe(90);
    applyQuotaHeadroomThreshold(85);
    expect(useKookrStore.getState().quotaHeadroomThreshold).toBe(85);
    applyQuotaHeadroomThreshold(0);
    expect(useKookrStore.getState().quotaHeadroomThreshold).toBe(0);
    applyQuotaHeadroomThreshold(250);
    expect(useKookrStore.getState().quotaHeadroomThreshold).toBe(100);
    applyQuotaHeadroomThreshold(-5);
    expect(useKookrStore.getState().quotaHeadroomThreshold).toBe(0);
    applyQuotaHeadroomThreshold('off');
    applyQuotaHeadroomThreshold(Number.NaN);
    expect(useKookrStore.getState().quotaHeadroomThreshold).toBe(0);
  });
});
