// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import {
  __resetAudioAlertLogForTests,
  getAudioAlertSnapshot,
  recordAudioAlertDecision,
  useAudioAlertLog,
  type LocalAudioAlertDecision,
} from './audio-alert-log.js';

function decision(overrides: Partial<LocalAudioAlertDecision> = {}): LocalAudioAlertDecision {
  return {
    id: overrides.id ?? `audio-${Math.random()}`,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    source: overrides.source ?? 'finding',
    outcome: overrides.outcome ?? 'scheduled',
    reason: overrides.reason ?? 'test',
    soundEnabled: overrides.soundEnabled ?? true,
    audioVolume: overrides.audioVolume ?? 1,
    chimeSound: overrides.chimeSound ?? 'classic',
    soundStateSource: overrides.soundStateSource ?? 'localStorage',
    soundStorageAvailable: overrides.soundStorageAvailable ?? true,
    dndEnabled: overrides.dndEnabled ?? false,
    dndExpiresAt: overrides.dndExpiresAt ?? null,
    pageVisibility: overrides.pageVisibility ?? 'visible',
    documentHasFocus: overrides.documentHasFocus ?? true,
    clientSessionId: overrides.clientSessionId ?? 'session-1',
    clientTabId: overrides.clientTabId ?? 'tab-1',
    ...overrides,
  };
}

describe('audio alert log', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T12:00:00.000Z'));
    __resetAudioAlertLogForTests();
  });

  afterEach(() => {
    __resetAudioAlertLogForTests();
    vi.useRealTimers();
  });

  test('records recent decisions newest-first with counts by outcome', () => {
    recordAudioAlertDecision(decision({ id: 'a', outcome: 'suppressed_muted' }));
    recordAudioAlertDecision(decision({ id: 'b', outcome: 'scheduled' }));

    const snapshot = getAudioAlertSnapshot();
    expect(snapshot.entries.map((entry) => entry.id)).toEqual(['b', 'a']);
    expect(snapshot.lastDecision?.id).toBe('b');
    expect(snapshot.countsByOutcome).toMatchObject({
      scheduled: 1,
      suppressed_muted: 1,
    });
  });

  test('coalesces repeated identical suppressed outcomes', () => {
    recordAudioAlertDecision(decision({
      id: 'a',
      timestamp: '2026-05-13T12:00:00.000Z',
      outcome: 'suppressed_dnd',
      source: 'finding',
      reason: 'dnd enabled',
      agentId: 'agent-a',
      anomalyType: 'stale_agent',
    }));
    recordAudioAlertDecision(decision({
      id: 'b',
      timestamp: '2026-05-13T12:00:05.000Z',
      outcome: 'suppressed_dnd',
      source: 'finding',
      reason: 'dnd enabled',
      agentId: 'agent-a',
      anomalyType: 'stale_agent',
    }));

    const snapshot = getAudioAlertSnapshot();
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]).toMatchObject({
      id: 'a',
      repeatCount: 2,
      firstSeenAt: '2026-05-13T12:00:00.000Z',
      lastSeenAt: '2026-05-13T12:00:05.000Z',
    });
  });

  test('does not coalesce scheduled outcomes', () => {
    recordAudioAlertDecision(decision({ id: 'a', outcome: 'scheduled' }));
    recordAudioAlertDecision(decision({ id: 'b', outcome: 'scheduled' }));

    expect(getAudioAlertSnapshot().entries.map((entry) => entry.id)).toEqual(['b', 'a']);
  });

  test('caps the ring buffer at 100 decisions', () => {
    for (let index = 0; index < 105; index += 1) {
      recordAudioAlertDecision(decision({
        id: `decision-${index}`,
        timestamp: new Date(Date.UTC(2026, 4, 13, 12, 0, index)).toISOString(),
        outcome: 'scheduled',
      }));
    }

    const snapshot = getAudioAlertSnapshot();
    expect(snapshot.entries).toHaveLength(100);
    expect(snapshot.entries[0]?.id).toBe('decision-104');
    expect(snapshot.entries.at(-1)?.id).toBe('decision-5');
  });

  test('useAudioAlertLog subscribes through useSyncExternalStore', async () => {
    let root: Root | null = null;
    const container = document.createElement('div');
    document.body.appendChild(container);

    function Probe() {
      const snapshot = useAudioAlertLog();
      return React.createElement('span', null, snapshot.lastDecision?.outcome ?? 'empty');
    }

    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Probe));
    });
    expect(container.textContent).toBe('empty');

    await act(async () => {
      recordAudioAlertDecision(decision({ outcome: 'suppressed_muted' }));
    });
    expect(container.textContent).toBe('suppressed_muted');

    await act(async () => {
      root?.unmount();
    });
    container.remove();
  });
});
