// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DetailHeaderActions } from './DetailHeaderActions.js';

const handlers = {
  complete: vi.fn(), resume: vi.fn(), reflect: vi.fn(), cancel: vi.fn(), retry: vi.fn(),
} as never;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function key(k: string) {
  act(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}

async function openMenu() {
  act(() => {
    root.render(
      <DetailHeaderActions taskId="t1" taskStatus="in_progress" signalCompleteReady={false} handlers={handlers} />,
    );
  });
  const trigger = container.querySelector<HTMLButtonElement>('[data-testid="detail-more-actions"]')!;
  act(() => trigger.click());
  return {
    trigger,
    items: () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')),
  };
}

describe('DetailHeaderActions menu keyboard support (#3618)', () => {
  test('arrow keys wrap, Home/End jump', async () => {
    const { items } = await openMenu();
    const list = items();
    expect(list.length).toBeGreaterThan(1);
    expect(document.activeElement).toBe(list[0]);
    key('ArrowDown');
    expect(document.activeElement).toBe(list[1]);
    key('ArrowUp');
    key('ArrowUp');
    expect(document.activeElement).toBe(list[list.length - 1]);
    key('ArrowDown');
    expect(document.activeElement).toBe(list[0]);
    key('End');
    expect(document.activeElement).toBe(list[list.length - 1]);
    key('Home');
    expect(document.activeElement).toBe(list[0]);
  });

  test('Tab closes the menu and parks focus on the trigger', async () => {
    const { trigger, items } = await openMenu();
    key('Tab');
    expect(items()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
  });
});
