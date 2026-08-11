// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import React from 'react';
import {
  parseCapacityResidual,
  parsePipelineStarvation,
  useOpsHealthPoll,
} from './useOpsHealthPoll.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function PollHarness({ intervalMs = 0 }: { intervalMs?: number }) {
  useOpsHealthPoll(intervalMs);
  return null;
}

describe('useOpsHealthPoll', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  test('parses /api/health smoke + watchdog + capacity residual + pipeline starvation into the store', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'ok',
        prodSmokeTick: {
          schemaVersion: 'prod-smoke-tick.v1',
          status: 'alert',
          consecutiveFailures: 7,
          failingChecks: ['version-probe'],
          generatedAt: '2026-08-04T00:00:00.000Z',
          firstFailedAt: '2026-08-03T17:00:00.000Z',
        },
        resourceWatchdog: {
          enabled: false,
          lastDecision: 'disabled',
          pressureWhileDisabled: false,
          pressureWhileDisabledReason: null,
        },
        capacity: {
          maxActiveTasks: 10,
          active: 8,
          free: 2,
          byClass: { working: 1, finishedAwaitingAck: 7, hungSuspect: 0, launching: 0 },
          oldestFinishedAwaitingAckAgeMs: 9e6,
        },
        pipelineStarvation: {
          schemaVersion: 'pipeline-starvation.v1',
          repos: {
            'kookr-ai/kookr': {
              repo: 'kookr-ai/kookr',
              consecutiveBlockedEmpty: 3,
              effectiveScoutCooldownMs: 3_600_000,
              lastBlockedEmptyAt: '2026-08-04T00:00:00.000Z',
            },
          },
        },
      }),
    });

    await act(async () => {
      root.render(React.createElement(PollHarness, { intervalMs: 0 }));
    });
    // Allow the async poll to settle.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/health', { cache: 'no-store' });
    expect(useKookrStore.getState().prodSmokeTick).toEqual({
      consecutiveFailures: 7,
      status: 'alert',
      failingChecks: ['version-probe'],
      generatedAt: '2026-08-04T00:00:00.000Z',
      firstFailedAt: '2026-08-03T17:00:00.000Z',
    });
    expect(useKookrStore.getState().resourceWatchdog).toEqual({
      enabled: false,
      lastDecision: 'disabled',
      pressureWhileDisabled: false,
      pressureWhileDisabledReason: null,
    });
    expect(useKookrStore.getState().capacityResidual).toEqual({
      finishedAwaitingAck: 7,
      oldestFinishedAwaitingAckAgeMs: 9e6,
    });
    expect(useKookrStore.getState().pipelineStarvation).toEqual({
      schemaVersion: 'pipeline-starvation.v1',
      repos: {
        'kookr-ai/kookr': {
          repo: 'kookr-ai/kookr',
          consecutiveBlockedEmpty: 3,
          effectiveScoutCooldownMs: 3_600_000,
          lastBlockedEmptyAt: '2026-08-04T00:00:00.000Z',
        },
      },
    });
  });

  test('soft-fails on network error without throwing', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));

    await act(async () => {
      root.render(React.createElement(PollHarness, { intervalMs: 0 }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useKookrStore.getState().prodSmokeTick).toBeNull();
    expect(useKookrStore.getState().resourceWatchdog).toBeNull();
    expect(useKookrStore.getState().capacityResidual).toBeNull();
    expect(useKookrStore.getState().pipelineStarvation).toBeNull();
  });
});

describe('parsePipelineStarvation (issue #2259)', () => {
  test('returns null for missing or wrong schemaVersion', () => {
    expect(parsePipelineStarvation(null)).toBeNull();
    expect(parsePipelineStarvation(undefined)).toBeNull();
    expect(parsePipelineStarvation({ schemaVersion: 'other.v1', repos: {} })).toBeNull();
    expect(parsePipelineStarvation({ repos: {} })).toBeNull();
  });

  test('parses valid repos and drops rows without consecutiveBlockedEmpty', () => {
    expect(parsePipelineStarvation({
      schemaVersion: 'pipeline-starvation.v1',
      repos: {
        'a/repo': {
          repo: 'a/repo',
          consecutiveBlockedEmpty: 2.7,
          effectiveScoutCooldownMs: 1_800_000.9,
          lastSpawnSkipReason: 'scout_cooldown',
        },
        'bad/repo': { repo: 'bad/repo' },
        'idle/repo': {
          repo: 'idle/repo',
          consecutiveBlockedEmpty: 0,
          effectiveScoutCooldownMs: -10,
        },
      },
    })).toEqual({
      schemaVersion: 'pipeline-starvation.v1',
      repos: {
        'a/repo': {
          repo: 'a/repo',
          consecutiveBlockedEmpty: 2,
          effectiveScoutCooldownMs: 1_800_000,
          lastSpawnSkipReason: 'scout_cooldown',
        },
        'idle/repo': {
          repo: 'idle/repo',
          consecutiveBlockedEmpty: 0,
          effectiveScoutCooldownMs: 0,
        },
      },
    });
  });

  test('accepts empty repos map', () => {
    expect(parsePipelineStarvation({
      schemaVersion: 'pipeline-starvation.v1',
      repos: {},
    })).toEqual({ schemaVersion: 'pipeline-starvation.v1', repos: {} });
  });
});

describe('parseCapacityResidual (issue #2082)', () => {
  test('returns null for missing or malformed capacity blocks', () => {
    expect(parseCapacityResidual(null)).toBeNull();
    expect(parseCapacityResidual(undefined)).toBeNull();
    expect(parseCapacityResidual('x')).toBeNull();
    expect(parseCapacityResidual({})).toBeNull();
    expect(parseCapacityResidual({ byClass: null })).toBeNull();
    expect(parseCapacityResidual({ byClass: {} })).toBeNull();
    expect(parseCapacityResidual({ byClass: { finishedAwaitingAck: '7' } })).toBeNull();
    expect(parseCapacityResidual({ byClass: { finishedAwaitingAck: Number.NaN } })).toBeNull();
  });

  test('parses count and oldest age, clamping/nulling age safely', () => {
    expect(parseCapacityResidual({
      byClass: { finishedAwaitingAck: 7 },
      oldestFinishedAwaitingAckAgeMs: 9e6,
    })).toEqual({ finishedAwaitingAck: 7, oldestFinishedAwaitingAckAgeMs: 9e6 });

    expect(parseCapacityResidual({
      byClass: { finishedAwaitingAck: 3.9 },
      oldestFinishedAwaitingAckAgeMs: null,
    })).toEqual({ finishedAwaitingAck: 3, oldestFinishedAwaitingAckAgeMs: null });

    expect(parseCapacityResidual({
      byClass: { finishedAwaitingAck: 2 },
      oldestFinishedAwaitingAckAgeMs: 'old',
    })).toEqual({ finishedAwaitingAck: 2, oldestFinishedAwaitingAckAgeMs: null });

    expect(parseCapacityResidual({
      byClass: { finishedAwaitingAck: 1 },
      oldestFinishedAwaitingAckAgeMs: -50,
    })).toEqual({ finishedAwaitingAck: 1, oldestFinishedAwaitingAckAgeMs: 0 });
  });
});
