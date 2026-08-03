// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useKookrStore } from '../store/useStore.js';
import type { CircuitBreakerSnapshot } from '../../shared/protocol.js';
import { CircuitBreakerPanel } from './CircuitBreakerPanel.js';

let root: Root | null;
let container: HTMLDivElement;

function breaker(overrides: Partial<CircuitBreakerSnapshot> = {}): CircuitBreakerSnapshot {
  return {
    name: 'supervisor',
    state: 'closed',
    failureCount: 0,
    successCount: 0,
    rejectedCalls: 0,
    tripCount: 0,
    lastFailureTime: null,
    lastStateChange: Date.now(),
    resetTimeoutMs: 60_000,
    ...overrides,
  };
}

function mount(props: { defaultExpanded?: boolean } = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(CircuitBreakerPanel, {
      send: vi.fn(),
      defaultExpanded: props.defaultExpanded ?? false,
      showEmpty: true,
    }));
  });
  return container;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useKookrStore.setState({ circuitBreakers: [breaker()] });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  useKookrStore.setState({ circuitBreakers: [] });
});

describe('CircuitBreakerPanel disclosure a11y', () => {
  test('header is a button with aria-expanded reflecting collapsed/expanded state', () => {
    mount({ defaultExpanded: false });

    const header = container.querySelector('.circuit-breaker-section .section-header') as HTMLButtonElement;
    expect(header).not.toBeNull();
    expect(header.tagName).toBe('BUTTON');
    expect(header.type).toBe('button');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.cb-body')).toBeNull();

    act(() => header.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.cb-body')).not.toBeNull();
    expect(container.textContent).toContain('supervisor');

    act(() => header.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.cb-body')).toBeNull();
  });

  test('keyboard activation via click (native button Enter/Space) toggles the section', () => {
    // Native <button> maps Enter/Space to click; assert the click handler toggles.
    mount({ defaultExpanded: true });
    const header = container.querySelector('.circuit-breaker-header') as HTMLButtonElement;
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(header.getAttribute('type')).toBe('button');

    act(() => header.click());
    expect(header.getAttribute('aria-expanded')).toBe('false');

    act(() => header.click());
    expect(header.getAttribute('aria-expanded')).toBe('true');
  });
});
