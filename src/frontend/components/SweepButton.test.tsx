// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { SweepButton } from './SweepButton.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function flush() {
  return act(async () => {
    await Promise.resolve();
  });
}

function sendEscape(): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

function sendTab(shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

async function renderSweepButton(options: {
  projectCount?: number;
  send?: ReturnType<typeof vi.fn>;
} = {}) {
  const send = options.send ?? vi.fn();
  const projectCount = options.projectCount ?? 3;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<SweepButton send={send} projectCount={projectCount} />);
  });
  await flush();

  return { container, root, send };
}

async function openConfirm(container: HTMLElement) {
  const trigger = container.querySelector<HTMLButtonElement>('[data-testid="sweep-button"]');
  if (!trigger) throw new Error('Missing sweep button');
  trigger.focus();
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
  return trigger;
}

describe('SweepButton confirm dialog', () => {
  let roots: Root[] = [];

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    syncGlobalStore();
    useKookrStore.setState({ sweepRunning: false });
  });

  afterEach(async () => {
    for (const root of roots) {
      await act(async () => {
        root.unmount();
      });
    }
    roots = [];
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  test('Escape closes the confirm dialog without running the sweep', async () => {
    const { container, root, send } = await renderSweepButton();
    roots.push(root);

    await openConfirm(container);
    expect(container.querySelector('[data-testid="sweep-confirm"]')).not.toBeNull();
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="sweep-cancel"]'),
    );

    await act(async () => {
      sendEscape();
    });
    await flush();

    expect(container.querySelector('[data-testid="sweep-confirm"]')).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(useKookrStore.getState().sweepRunning).toBe(false);
  });

  test('focuses Cancel on open and traps Tab between Cancel and Sweep', async () => {
    const { container, root } = await renderSweepButton();
    roots.push(root);

    await openConfirm(container);

    const cancel = container.querySelector<HTMLButtonElement>('[data-testid="sweep-cancel"]');
    const confirm = container.querySelector<HTMLButtonElement>('[data-testid="sweep-confirm-go"]');
    expect(cancel).not.toBeNull();
    expect(confirm).not.toBeNull();
    expect(document.activeElement).toBe(cancel);

    confirm!.focus();
    const forwardWrap = sendTab();
    expect(document.activeElement).toBe(cancel);
    expect(forwardWrap.defaultPrevented).toBe(true);

    cancel!.focus();
    const backwardWrap = sendTab(true);
    expect(document.activeElement).toBe(confirm);
    expect(backwardWrap.defaultPrevented).toBe(true);
  });

  test('Cancel click closes without running the sweep', async () => {
    const { container, root, send } = await renderSweepButton();
    roots.push(root);

    await openConfirm(container);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="sweep-cancel"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.querySelector('[data-testid="sweep-confirm"]')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  test('Sweep confirm sends workspace:sweep and closes the dialog', async () => {
    const { container, root, send } = await renderSweepButton();
    roots.push(root);

    await openConfirm(container);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="sweep-confirm-go"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.querySelector('[data-testid="sweep-confirm"]')).toBeNull();
    expect(send).toHaveBeenCalledWith({ type: 'workspace:sweep' });
    expect(useKookrStore.getState().sweepRunning).toBe(true);
  });
});
