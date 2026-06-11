// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentState, AnomalySeverity, AnomalyType } from '../../shared/protocol.js';
import type { Anomaly } from '../../shared/contracts/anomalies.js';
import { useKookrStore } from '../store/useStore.js';
import { __resetDndForTests, disableDnd, enableDnd } from './useDnd.js';
import { getTabAttentionBadgeState, useTabAttentionBadge } from './useTabAttentionBadge.js';

const DETECTED_AT = new Date('2026-06-11T06:00:00.000Z');

function mkAgent(opts: {
  agentId: string;
  severity?: AnomalySeverity;
  type?: AnomalyType;
  snoozedUntil?: number;
  suppressed?: boolean;
  taskStatus?: AgentState['taskStatus'];
  effectiveAttentionSeverity?: AnomalySeverity;
}): AgentState {
  const anomaly: Anomaly = {
    agentId: opts.agentId,
    type: opts.type ?? 'permission_blocked',
    severity: opts.severity ?? 'warning',
    explanation: 'mock finding',
    detectedAt: DETECTED_AT,
  };
  return {
    agentId: opts.agentId,
    events: [],
    anomaly,
    snoozedUntil: opts.snoozedUntil,
    suppressed: opts.suppressed,
    taskStatus: opts.taskStatus ?? 'inProgress',
    effectiveAttentionSeverity: opts.effectiveAttentionSeverity,
  };
}

function HookHost() {
  useTabAttentionBadge();
  return null;
}

describe('getTabAttentionBadgeState', () => {
  test('counts active findings and chooses the highest effective severity', () => {
    const state = getTabAttentionBadgeState([
      mkAgent({ agentId: 'warning', severity: 'warning' }),
      mkAgent({ agentId: 'info-parent', severity: 'info', effectiveAttentionSeverity: 'critical' }),
    ], false);

    expect(state).toEqual({ count: 2, severity: 'critical' });
  });

  test('ignores hidden, pending, and terminal findings', () => {
    const state = getTabAttentionBadgeState([
      mkAgent({ agentId: 'snoozed', snoozedUntil: Date.now() + 60_000 }),
      mkAgent({ agentId: 'suppressed', suppressed: true }),
      mkAgent({ agentId: 'pending', taskStatus: 'pending' }),
      mkAgent({ agentId: 'completed', taskStatus: 'completed' }),
    ], false);

    expect(state).toBeNull();
  });

  test('returns null while DND is active', () => {
    expect(getTabAttentionBadgeState([mkAgent({ agentId: 'finding' })], true)).toBeNull();
  });
});

describe('useTabAttentionBadge', () => {
  let root: Root | null;
  let container: HTMLDivElement;
  let store: Map<string, string>;
  let getContextSpy: ReturnType<typeof vi.spyOn>;
  let toDataURLSpy: ReturnType<typeof vi.spyOn>;

  function mount(): void {
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container);
      root.render(React.createElement(HookHost));
    });
  }

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    root = null;
    store = new Map();
    document.head.innerHTML = '<title>kookr</title><link rel="icon" type="image/x-icon" href="/favicon.ico">';

    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    });

    const context = {
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      fillText: vi.fn(),
      fillStyle: '',
      font: '',
      lineWidth: 0,
      strokeStyle: '',
      textAlign: '',
      textBaseline: '',
    };
    getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    toDataURLSpy = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,badged');

    __resetDndForTests();
    disableDnd();
    useKookrStore.setState({ agents: [], selectedAgentId: null });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    useKookrStore.setState({ agents: [], selectedAgentId: null });
    __resetDndForTests();
    getContextSpy.mockRestore();
    toDataURLSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('debounces a nonzero finding count into the title and favicon', () => {
    useKookrStore.setState({
      agents: [
        mkAgent({ agentId: 'a', severity: 'warning' }),
        mkAgent({ agentId: 'b', severity: 'critical' }),
      ],
    });

    mount();

    expect(document.title).toBe('kookr');
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(document.title).toBe('kookr');

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(document.title).toBe('(2) kookr');
    expect(document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.getAttribute('href')).toBe('data:image/png;base64,badged');
    expect(toDataURLSpy).toHaveBeenCalledWith('image/png');
  });

  test('clears the badge immediately when findings are attended', () => {
    useKookrStore.setState({ agents: [mkAgent({ agentId: 'a' })] });
    mount();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(document.title).toBe('(1) kookr');

    act(() => {
      useKookrStore.setState({ agents: [] });
    });

    expect(document.title).toBe('kookr');
    expect(document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.getAttribute('href')).toBe('/favicon.ico');
  });

  test('suppresses and restores the badge around DND', () => {
    useKookrStore.setState({ agents: [mkAgent({ agentId: 'a' })] });
    mount();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(document.title).toBe('(1) kookr');

    act(() => {
      enableDnd();
    });

    expect(document.title).toBe('kookr');
    expect(document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.getAttribute('href')).toBe('/favicon.ico');

    act(() => {
      disableDnd();
    });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(document.title).toBe('(1) kookr');
    expect(document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.getAttribute('href')).toBe('data:image/png;base64,badged');
  });

  test('does not restart the debounce when unchanged findings get a new array identity', () => {
    const finding = mkAgent({ agentId: 'a' });
    useKookrStore.setState({ agents: [finding] });
    mount();

    act(() => {
      vi.advanceTimersByTime(500);
      useKookrStore.setState({ agents: [{ ...finding }] });
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(document.title).toBe('(1) kookr');
  });

  test('restores the original title and favicon on unmount', () => {
    useKookrStore.setState({ agents: [mkAgent({ agentId: 'a' })] });
    mount();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(document.title).toBe('(1) kookr');

    act(() => root?.unmount());

    expect(document.title).toBe('kookr');
    expect(document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.getAttribute('href')).toBe('/favicon.ico');
  });
});
