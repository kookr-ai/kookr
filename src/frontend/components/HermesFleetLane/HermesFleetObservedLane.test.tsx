// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { HermesFleetObservedLane } from './HermesFleetObservedLane.js';
import { useKookrStore } from '../../store/useStore.js';
import { HERMES_LANE_OPEN_KEY } from '../../store/hermes-lane-open.js';
import type {
  ObservedActivitySnapshot,
  ObservedSessionView,
} from '../../../shared/contracts/observed-activity.js';

let root: Root | null = null;
let container: HTMLDivElement;

function session(overrides: Partial<ObservedSessionView> = {}): ObservedSessionView {
  return {
    sessionId: 'hermes-obs-a',
    state: 'working',
    label: 'reviewing PR #1',
    receivedAt: 1000,
    firstSeen: 500,
    pulseCount: 5,
    effectiveState: 'working',
    ageMs: 3000,
    ...overrides,
  };
}

function snapshot(overrides: Partial<ObservedActivitySnapshot> = {}): ObservedActivitySnapshot {
  return {
    sessions: [],
    counters: { accepted: 0, deduped: 0, rejected: {}, lastAcceptedAt: null, lastRejectAt: null, startedAt: 0 },
    now: 100_000,
    ...overrides,
  };
}

function mount(): void {
  act(() => {
    root = createRoot(container);
    root.render(<HermesFleetObservedLane />);
  });
}

function setSnapshot(snap: ObservedActivitySnapshot | null): void {
  act(() => {
    useKookrStore.setState({ observedActivity: snap });
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  useKookrStore.setState({ observedActivity: null });
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container.remove();
});

describe('HermesFleetObservedLane', () => {
  test('renders nothing until a snapshot arrives (flag off)', () => {
    mount();
    expect(container.querySelector('[data-testid="hermes-observed-lane"]')).toBeNull();
  });

  test('shows the pill with a working count once a snapshot arrives', () => {
    mount();
    setSnapshot(snapshot({ sessions: [session(), session({ sessionId: 'hermes-obs-b' })] }));
    const pill = container.querySelector('[data-testid="hermes-pill"]');
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toContain('2 working');
    // Collapsed by default: no panel.
    expect(container.querySelector('[data-testid="hermes-lane-panel"]')).toBeNull();
  });

  test('clicking the pill opens the lane, lists sessions, and persists the open state', () => {
    mount();
    setSnapshot(snapshot({ sessions: [session({ label: 'digest sweep' })] }));
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="hermes-pill"]')!.click();
    });
    expect(container.querySelector('[data-testid="hermes-lane-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="hermes-session-row"]')?.textContent).toContain('digest sweep');
    expect(localStorage.getItem(HERMES_LANE_OPEN_KEY)).toBe('1');
  });

  test('restores the open state from localStorage on mount', () => {
    localStorage.setItem(HERMES_LANE_OPEN_KEY, '1');
    mount();
    setSnapshot(snapshot({ sessions: [session()] }));
    expect(container.querySelector('[data-testid="hermes-lane-panel"]')).not.toBeNull();
  });

  describe('three distinct empty states', () => {
    beforeEach(() => {
      localStorage.setItem(HERMES_LANE_OPEN_KEY, '1'); // open so the body is visible
    });

    test('awaiting: never accepted a pulse, no rejects', () => {
      mount();
      setSnapshot(snapshot({ counters: { accepted: 0, deduped: 0, rejected: {}, lastAcceptedAt: null, lastRejectAt: null, startedAt: 50_000 } }));
      expect(container.querySelector('[data-testid="hermes-empty-awaiting"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="hermes-empty-idle"]')).toBeNull();
      expect(container.querySelector('[data-testid="hermes-empty-bridge-error"]')).toBeNull();
    });

    test('idle: accepted before but nothing active now', () => {
      mount();
      setSnapshot(snapshot({ counters: { accepted: 10, deduped: 0, rejected: {}, lastAcceptedAt: 40_000, lastRejectAt: null, startedAt: 0 } }));
      expect(container.querySelector('[data-testid="hermes-empty-idle"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="hermes-empty-awaiting"]')).toBeNull();
    });

    test('bridge-error: a recent reject outranks awaiting/idle', () => {
      mount();
      setSnapshot(snapshot({
        now: 100_000,
        counters: { accepted: 0, deduped: 0, rejected: { invalid_token: 3 }, lastAcceptedAt: null, lastRejectAt: 99_000, startedAt: 0 },
      }));
      const err = container.querySelector('[data-testid="hermes-empty-bridge-error"]');
      expect(err).not.toBeNull();
      expect(err?.textContent).toContain('invalid_token');
      expect(container.querySelector('[data-testid="hermes-empty-awaiting"]')).toBeNull();
    });

    test('a stale reject (outside the window) does NOT trigger bridge-error', () => {
      mount();
      setSnapshot(snapshot({
        now: 1_000_000,
        counters: { accepted: 5, deduped: 0, rejected: { invalid_token: 3 }, lastAcceptedAt: 900_000, lastRejectAt: 10_000, startedAt: 0 },
      }));
      expect(container.querySelector('[data-testid="hermes-empty-bridge-error"]')).toBeNull();
      expect(container.querySelector('[data-testid="hermes-empty-idle"]')).not.toBeNull();
    });
  });
});
