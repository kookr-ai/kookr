// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { NARRATED_DEMO_YOUTUBE_URL, ONBOARDING_CARDS, OnboardingTour } from './OnboardingTour.js';
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

  test('welcome card links the published narrated demo', async () => {
    await act(async () => {
      root.render(React.createElement(OnboardingTour));
    });
    act(() => open());
    await flush();

    expect(container.querySelector('.onboarding-header h3')?.textContent).toBe('Welcome to Kookr');
    expect(NARRATED_DEMO_YOUTUBE_URL).toBe('https://youtu.be/DHZrO8T_6Xg');
    const demo = container.querySelector<HTMLAnchorElement>('[data-testid="onboarding-welcome-demo"]');
    expect(demo).not.toBeNull();
    expect(demo?.href).toBe(NARRATED_DEMO_YOUTUBE_URL);
    expect(demo?.textContent).toBe('Watch the 2-minute demo');
    expect(demo?.target).toBe('_blank');
    expect(demo?.rel.split(/\s+/)).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
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

describe('OnboardingTour final-card launch conversion', () => {
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

  // Advance from the welcome card to the final card by clicking the primary
  // advance button once per non-final card.
  async function advanceToLastCard() {
    for (let i = 0; i < ONBOARDING_CARDS.length - 1; i++) {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('.onboarding-btn.primary')?.click();
      });
      await flush();
    }
  }

  test('final card offers a primary launch action plus a Done dismiss when wired', async () => {
    await act(async () => {
      root.render(React.createElement(OnboardingTour, { onLaunchFirstTask: () => {} }));
    });
    act(() => open());
    await flush();
    await advanceToLastCard();

    expect(container.querySelector('.onboarding-header h3')?.textContent).toBe('Findings and routing');
    const launch = container.querySelector<HTMLButtonElement>('[data-testid="onboarding-launch-first-task"]');
    expect(launch).not.toBeNull();
    expect(launch?.classList.contains('primary')).toBe(true);
    expect(launch?.textContent).toBe('Launch your first agent');
    const done = container.querySelector<HTMLButtonElement>('[data-testid="onboarding-done"]');
    expect(done?.textContent).toBe('Done');
    // The dismiss must stay secondary so the launch action owns the primary slot.
    expect(done?.classList.contains('primary')).toBe(false);
  });

  test('intermediate cards keep the Next advance button even when launch is wired', async () => {
    await act(async () => {
      root.render(React.createElement(OnboardingTour, { onLaunchFirstTask: () => {} }));
    });
    act(() => open());
    await flush();

    // Welcome card (index 0) and one advance in — still mid-tour, not the CTA.
    for (let step = 0; step < 2; step++) {
      expect(container.querySelector('.onboarding-header h3')?.textContent).not.toBe('Findings and routing');
      expect(container.querySelector('[data-testid="onboarding-launch-first-task"]')).toBeNull();
      expect(container.querySelector('[data-testid="onboarding-done"]')).toBeNull();
      expect(container.querySelector<HTMLButtonElement>('.onboarding-btn.primary')?.textContent).toBe('Next');
      await act(async () => {
        container.querySelector<HTMLButtonElement>('.onboarding-btn.primary')?.click();
      });
      await flush();
    }
  });

  test('clicking launch closes the tour and invokes the callback', async () => {
    let launched = 0;
    await act(async () => {
      root.render(React.createElement(OnboardingTour, { onLaunchFirstTask: () => { launched += 1; } }));
    });
    act(() => open());
    await flush();
    await advanceToLastCard();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="onboarding-launch-first-task"]')?.click();
    });
    await flush();

    expect(launched).toBe(1);
    // Tour is fully torn down before the Launch dialog would open.
    expect(container.querySelector('[data-testid="onboarding-overlay"]')).toBeNull();
  });

  test('Done dismisses the tour without launching', async () => {
    let launched = 0;
    await act(async () => {
      root.render(React.createElement(OnboardingTour, { onLaunchFirstTask: () => { launched += 1; } }));
    });
    act(() => open());
    await flush();
    await advanceToLastCard();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="onboarding-done"]')?.click();
    });
    await flush();

    expect(launched).toBe(0);
    expect(container.querySelector('[data-testid="onboarding-overlay"]')).toBeNull();
  });

  test('without a launch callback the final card keeps a plain Done button', async () => {
    await act(async () => {
      root.render(React.createElement(OnboardingTour));
    });
    act(() => open());
    await flush();
    await advanceToLastCard();

    expect(container.querySelector('[data-testid="onboarding-launch-first-task"]')).toBeNull();
    expect(container.querySelector('[data-testid="onboarding-done"]')).toBeNull();
    const primary = container.querySelector<HTMLButtonElement>('.onboarding-btn.primary');
    expect(primary?.textContent).toBe('Done');
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
