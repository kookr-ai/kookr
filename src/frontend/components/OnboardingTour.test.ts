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
