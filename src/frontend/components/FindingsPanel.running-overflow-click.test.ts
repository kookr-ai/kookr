// @vitest-environment jsdom

/**
 * FindingsPanel Healthy-rail expand + scroll (issue #3406). App bumps
 * `expandHealthyNonce` when the overview "+N more in Healthy" overflow is
 * clicked; the panel reuses `expandHealthy` and scrolls the section into
 * view. Healthy defaults to expanded, so an already-open section only
 * scrolls; a manually-collapsed one re-expands. Count refreshes must not
 * expand the section. Mirrors the Completed effect (#3333).
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  FindingsPanel,
  HEALTHY_SECTION_COLLAPSED_KEY,
} from './FindingsPanel.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { AgentState, ClientMessage } from '../../shared/protocol.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function makeHealthyAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: overrides.agentId ?? 'agent-1',
    taskId: overrides.taskId ?? 'task-1',
    taskName: overrides.taskName ?? 'Some task',
    description: 'Working',
    events: [],
    anomaly: null,
    taskStatus: 'inProgress',
    cwd: '/tmp/project',
    startedAt: '2026-09-20T12:00:00.000Z',
    ...overrides,
  } as AgentState;
}

function renderPanel(root: Root, props: {
  healthy?: AgentState[];
  expandHealthyNonce?: number;
  consumedExpandHealthyNonceRef?: { current: number };
  send?: (msg: ClientMessage) => void;
}): void {
  act(() => {
    root.render(React.createElement(FindingsPanel, {
      findings: [],
      healthy: props.healthy ?? [makeHealthyAgent()],
      pending: [],
      snoozed: [],
      completed: [],
      selectedAgentId: null,
      send: props.send ?? vi.fn(),
      clearCompletedFinishedCount: 0,
      clearCompletedTerminatedCount: 0,
      expandHealthyNonce: props.expandHealthyNonce,
      consumedExpandHealthyNonceRef: props.consumedExpandHealthyNonceRef,
    }));
  });
}

describe('FindingsPanel running-overflow expand request (issue #3406)', () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let originalScrollIntoView: typeof Element.prototype.scrollIntoView | undefined;
  let scrolledElements: Element[];
  let scrollOptions: unknown[];

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    localStorage.clear();
    syncGlobalStore();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ checks: {}, fires: {}, falsePositives: {} }),
      text: async () => '{}',
    })));
    originalScrollIntoView = Element.prototype.scrollIntoView;
    scrolledElements = [];
    scrollOptions = [];
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value(this: Element, options?: ScrollIntoViewOptions | boolean) {
        scrolledElements.push(this);
        scrollOptions.push(options);
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    if (originalScrollIntoView) {
      Object.defineProperty(Element.prototype, 'scrollIntoView', {
        configurable: true,
        value: originalScrollIntoView,
      });
    } else {
      delete (Element.prototype as Element & { scrollIntoView?: unknown }).scrollIntoView;
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  test('a nonce bump expands a collapsed Healthy section and scrolls it into view', () => {
    localStorage.setItem(HEALTHY_SECTION_COLLAPSED_KEY, '1');
    renderPanel(root!, { expandHealthyNonce: 0 });
    expect(container.querySelector('.healthy-section .section-header')?.getAttribute('aria-expanded')).toBe('false');
    expect(scrolledElements).toHaveLength(0);

    renderPanel(root!, { expandHealthyNonce: 1 });
    act(() => vi.runOnlyPendingTimers());

    expect(container.querySelector('.healthy-section .section-header')?.getAttribute('aria-expanded')).toBe('true');
    expect(localStorage.getItem(HEALTHY_SECTION_COLLAPSED_KEY)).toBe('0');
    expect(scrolledElements).toHaveLength(1);
    expect(scrolledElements[0]).toBe(container.querySelector('.healthy-section'));
    expect(scrollOptions[0]).toEqual({ block: 'nearest' });
  });

  test('an already-expanded Healthy section still scrolls into view without collapsing', () => {
    // Healthy defaults to expanded, so this is the common path.
    renderPanel(root!, { expandHealthyNonce: 0 });
    expect(container.querySelector('.healthy-section .section-header')?.getAttribute('aria-expanded')).toBe('true');

    renderPanel(root!, { expandHealthyNonce: 1 });
    act(() => vi.runOnlyPendingTimers());

    expect(container.querySelector('.healthy-section .section-header')?.getAttribute('aria-expanded')).toBe('true');
    expect(scrolledElements).toHaveLength(1);
    expect(scrolledElements[0]).toBe(container.querySelector('.healthy-section'));
  });

  test('a consumed click does not re-expand after remount if the operator collapsed Healthy', () => {
    const consumedExpandHealthyNonceRef = { current: 0 };
    renderPanel(root!, { expandHealthyNonce: 0, consumedExpandHealthyNonceRef });
    renderPanel(root!, { expandHealthyNonce: 1, consumedExpandHealthyNonceRef });
    act(() => vi.runOnlyPendingTimers());
    expect(container.querySelector('.healthy-section .section-header')?.getAttribute('aria-expanded')).toBe('true');

    const header = container.querySelector<HTMLButtonElement>('.healthy-section .section-header');
    act(() => header!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.querySelector('.healthy-section .section-header')?.getAttribute('aria-expanded')).toBe('false');
    expect(localStorage.getItem(HEALTHY_SECTION_COLLAPSED_KEY)).toBe('1');

    act(() => root!.unmount());
    root = createRoot(container);
    scrolledElements.length = 0;
    renderPanel(root, { expandHealthyNonce: 1, consumedExpandHealthyNonceRef });
    act(() => vi.runOnlyPendingTimers());

    expect(container.querySelector('.healthy-section .section-header')?.getAttribute('aria-expanded')).toBe('false');
    expect(scrolledElements).toHaveLength(0);
  });

  test('refreshing the healthy list without a nonce bump does not scroll', () => {
    localStorage.setItem(HEALTHY_SECTION_COLLAPSED_KEY, '1');
    renderPanel(root!, {
      healthy: [makeHealthyAgent({ agentId: 'h1', taskId: 't1' })],
      expandHealthyNonce: 0,
    });
    expect(container.querySelector('.healthy-section .section-header')?.getAttribute('aria-expanded')).toBe('false');

    renderPanel(root!, {
      healthy: [
        makeHealthyAgent({ agentId: 'h1', taskId: 't1' }),
        makeHealthyAgent({ agentId: 'h2', taskId: 't2' }),
      ],
      expandHealthyNonce: 0,
    });
    act(() => vi.runOnlyPendingTimers());

    expect(container.querySelector('.healthy-section .section-header')?.getAttribute('aria-expanded')).toBe('false');
    expect(scrolledElements).toHaveLength(0);
  });

  test('a fresh mount with the nonce already bumped expands a collapsed Healthy section and scrolls (mobile tab-switch path)', () => {
    // On mobile, clicking the overflow switches to the findings tab, which
    // mounts FindingsPanel FRESH with the nonce already bumped against a zero
    // high-water — the real path, distinct from a re-render bump. This pins
    // the first-paint guard (`nonce <= consumed.current`) that every other
    // case reaches only via a second render.
    localStorage.setItem(HEALTHY_SECTION_COLLAPSED_KEY, '1');
    renderPanel(root!, { expandHealthyNonce: 1, consumedExpandHealthyNonceRef: { current: 0 } });
    act(() => vi.runOnlyPendingTimers());

    expect(container.querySelector('.healthy-section .section-header')?.getAttribute('aria-expanded')).toBe('true');
    expect(scrolledElements).toHaveLength(1);
    expect(scrolledElements[0]).toBe(container.querySelector('.healthy-section'));
  });

  test('a mount under StrictMode still expands and scrolls (deferred high-water survives the effect replay)', () => {
    // The high-water write lives inside the setTimeout precisely so StrictMode's
    // mount→cleanup→mount replay (cleanup cancels the first timer) still fires
    // the scroll once. A regression that marked the nonce consumed synchronously
    // would break this while passing every single-mount case above.
    localStorage.setItem(HEALTHY_SECTION_COLLAPSED_KEY, '1');
    act(() => root!.unmount());
    root = createRoot(container);
    act(() => {
      root!.render(React.createElement(React.StrictMode, null, React.createElement(FindingsPanel, {
        findings: [],
        healthy: [makeHealthyAgent()],
        pending: [],
        snoozed: [],
        completed: [],
        selectedAgentId: null,
        send: vi.fn(),
        clearCompletedFinishedCount: 0,
        clearCompletedTerminatedCount: 0,
        expandHealthyNonce: 1,
      })));
    });
    act(() => vi.runOnlyPendingTimers());

    expect(container.querySelector('.healthy-section .section-header')?.getAttribute('aria-expanded')).toBe('true');
    expect(scrolledElements).toHaveLength(1);
    expect(scrolledElements[0]).toBe(container.querySelector('.healthy-section'));
  });
});
