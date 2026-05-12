// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { OperationsPanel } from './OperationsPanel.js';

let root: Root;
let container: HTMLDivElement;

function mount(onClose = vi.fn()) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(OperationsPanel, { send: vi.fn(), onClose }));
  });
  return { el: container, onClose };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ checks: {}, fires: {}, falsePositives: {} }),
  } as Response)));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

describe('OperationsPanel', () => {
  test('renders diagnostics and circuit breaker empty states in the utility surface', async () => {
    const { el } = mount();
    await flush();

    expect(el.textContent).toContain('Diagnostics');
    expect(el.textContent).toContain('No detection checks recorded yet');
    expect(el.textContent).toContain('No circuit breakers reported yet');
  });

  test('close button calls onClose', async () => {
    const { el, onClose } = mount();
    await flush();

    const close = el.querySelector<HTMLButtonElement>('.operations-panel-close');
    expect(close).toBeTruthy();
    act(() => close?.click());
    expect(onClose).toHaveBeenCalledOnce();
  });
});
