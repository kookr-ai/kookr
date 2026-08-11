// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  elevatedPipelineStarvationRepos,
  PipelineStarvationPanel,
} from './PipelineStarvationPanel.js';
import type { PipelineStarvationStatus } from '../store/store-types.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';

let root: Root | null = null;
let container: HTMLDivElement;

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function fixture(overrides: Partial<PipelineStarvationStatus> = {}): PipelineStarvationStatus {
  return {
    schemaVersion: 'pipeline-starvation.v1',
    repos: {
      'kookr-ai/kookr': {
        repo: 'kookr-ai/kookr',
        consecutiveBlockedEmpty: 3,
        effectiveScoutCooldownMs: 3_600_000,
        lastBlockedEmptyAt: '2026-08-10T12:00:00.000Z',
        lastSpawnSkipReason: 'scout_cooldown',
      },
      'jeanibarz/lucy': {
        repo: 'jeanibarz/lucy',
        consecutiveBlockedEmpty: 0,
        effectiveScoutCooldownMs: 0,
      },
      'z/repo': {
        repo: 'z/repo',
        consecutiveBlockedEmpty: 1,
        effectiveScoutCooldownMs: 0,
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  syncGlobalStore();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
});

describe('elevatedPipelineStarvationRepos', () => {
  test('keeps only consecutiveBlockedEmpty > 0, sorted by repo key', () => {
    const rows = elevatedPipelineStarvationRepos(fixture().repos);
    expect(rows.map((r) => r.repo)).toEqual(['kookr-ai/kookr', 'z/repo']);
    expect(rows[0]?.consecutiveBlockedEmpty).toBe(3);
  });

  test('returns empty for missing or empty maps', () => {
    expect(elevatedPipelineStarvationRepos(null)).toEqual([]);
    expect(elevatedPipelineStarvationRepos(undefined)).toEqual([]);
    expect(elevatedPipelineStarvationRepos({})).toEqual([]);
  });
});

describe('PipelineStarvationPanel', () => {
  test('renders elevated rows from a fixture health payload', () => {
    act(() => {
      root = createRoot(container);
      root.render(React.createElement(PipelineStarvationPanel, { snapshot: fixture() }));
    });

    expect(container.textContent).toContain('Pipeline Starvation');
    expect(container.textContent).toContain('2 elevated');
    expect(container.textContent).toContain('kookr-ai/kookr');
    expect(container.textContent).toContain('blockedEmpty=3');
    expect(container.textContent).toContain('cooldown=1h');
    expect(container.textContent).toContain('z/repo');
    expect(container.textContent).toContain('blockedEmpty=1');
    expect(container.textContent).not.toContain('jeanibarz/lucy');
    expect(container.textContent).toContain('drought');
  });

  test('shows a calm empty state when the block is missing or idle', () => {
    act(() => {
      root = createRoot(container);
      root.render(React.createElement(PipelineStarvationPanel, {
        snapshot: { schemaVersion: 'pipeline-starvation.v1', repos: {} },
      }));
    });

    expect(container.textContent).toContain('Pipeline Starvation');
    expect(container.textContent).toContain('none elevated');
    expect(container.textContent).toContain('No elevated pipeline starvation.');
    expect(container.textContent).not.toContain('drought');
  });

  test('reads elevated rows from the ops-health store projection', () => {
    useKookrStore.getState().handleOpsHealth({ pipelineStarvation: fixture() });

    act(() => {
      root = createRoot(container);
      root.render(React.createElement(PipelineStarvationPanel));
    });

    expect(container.textContent).toContain('kookr-ai/kookr');
    expect(container.textContent).toContain('blockedEmpty=3');
  });
});
