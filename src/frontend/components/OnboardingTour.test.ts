// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { OnboardingTour } from './OnboardingTour.js';
import { close, open } from '../store/onboarding-store.js';

async function flush() {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
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

function focusablesInDialog(container: HTMLElement): HTMLElement[] {
  const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) return [];
  const selector = [
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(', ');
  return Array.from(dialog.querySelectorAll<HTMLElement>(selector));
}

describe('OnboardingTour readiness guidance', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => close());
    act(() => root.unmount());
    document.body.innerHTML = '';
    localStorage.clear();
  });

  test('renders first-launch readiness guidance in the tour flow', async () => {
    await act(async () => {
      root.render(React.createElement(OnboardingTour));
    });
    act(() => open());
    await flush();

    for (let i = 0; i < 3; i++) {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('.onboarding-btn.primary')?.click();
      });
      await flush();
    }

    expect(container.querySelector('.onboarding-header h3')?.textContent).toBe('First-launch readiness');
    expect(container.textContent).toContain('pnpm run doctor');
    expect(container.textContent).toContain('Missing agent binary or auth');
  });

  test('surfaces a shortcut cheatsheet during onboarding', async () => {
    await act(async () => {
      root.render(React.createElement(OnboardingTour));
    });
    act(() => open());
    await flush();

    for (let i = 0; i < 4; i++) {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('.onboarding-btn.primary')?.click();
      });
      await flush();
    }

    expect(container.querySelector('.onboarding-header h3')?.textContent).toBe('Shortcuts that save clicks');
    expect(container.textContent).toContain('Jump to next finding by severity');
    expect(container.textContent).toContain('Open quick launch bar');
    expect(container.textContent).toContain('?');
  });
});

describe('OnboardingTour focus management', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => close());
    act(() => root.unmount());
    document.body.innerHTML = '';
    localStorage.clear();
  });

  test('initial focus lands on the primary Next button', async () => {
    await act(async () => {
      root.render(React.createElement(OnboardingTour));
    });
    act(() => open());
    await flush();

    const primary = container.querySelector<HTMLButtonElement>('.onboarding-btn.primary');
    expect(primary).not.toBeNull();
    expect(document.activeElement).toBe(primary);
  });

  test('Tab from last focusable cycles to first; Shift+Tab from first cycles to last', async () => {
    await act(async () => {
      root.render(React.createElement(OnboardingTour));
    });
    act(() => open());
    await flush();

    const focusables = focusablesInDialog(container);
    // Skip + step dots + Next (Back is disabled on card 0).
    expect(focusables.length).toBeGreaterThanOrEqual(2);
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;

    last.focus();
    const forwardWrap = sendTab();
    expect(document.activeElement).toBe(first);
    expect(forwardWrap.defaultPrevented).toBe(true);

    first.focus();
    const backwardWrap = sendTab(true);
    expect(document.activeElement).toBe(last);
    expect(backwardWrap.defaultPrevented).toBe(true);
  });

  test('Tab starting outside the dialog is pulled back to the first focusable', async () => {
    const outside = document.createElement('button');
    outside.type = 'button';
    outside.textContent = 'Outside';
    document.body.appendChild(outside);

    await act(async () => {
      root.render(React.createElement(OnboardingTour));
    });
    act(() => open());
    await flush();

    outside.focus();
    expect(document.activeElement).toBe(outside);

    const escapedFocus = sendTab();
    const first = focusablesInDialog(container)[0];
    expect(document.activeElement).toBe(first);
    expect(escapedFocus.defaultPrevented).toBe(true);
  });
});
