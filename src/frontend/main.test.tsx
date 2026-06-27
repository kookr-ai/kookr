// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

describe('frontend bootstrap', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetModules();
    document.body.innerHTML = '<div id="root"></div>';
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    document.body.innerHTML = '';
    consoleError.mockRestore();
    vi.resetModules();
    vi.clearAllMocks();
  });

  test('wraps the bootstrapped app in the dashboard error boundary', async () => {
    vi.doMock('./auth-session.js', () => ({
      bootstrapAuthSession: vi.fn(async () => {}),
    }));
    vi.doMock('./App.js', () => ({
      App: () => {
        throw new Error('Bootstrap panel crash');
      },
    }));

    await act(async () => {
      await import('./main.js');
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(document.body.textContent).toContain('Kookr hit a panel error');
    expect(document.body.textContent).toContain('Bootstrap panel crash');
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });
});
