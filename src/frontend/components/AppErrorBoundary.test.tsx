// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { __setAppErrorBoundaryReloadDashboardForTests, AppErrorBoundary } from './AppErrorBoundary.js';

function ThrowingPanel(): React.ReactElement {
  throw new Error('Bad finding payload');
}

function HealthyPanel(): React.ReactElement {
  return <div>Dashboard ready</div>;
}

describe('AppErrorBoundary', () => {
  let container: HTMLDivElement;
  let root: Root;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    __setAppErrorBoundaryReloadDashboardForTests();
    consoleError.mockRestore();
  });

  test('shows a dashboard fallback instead of a blank tree after a render error', () => {
    act(() => {
      root.render(
        <AppErrorBoundary>
          <ThrowingPanel />
        </AppErrorBoundary>,
      );
    });

    expect(container.textContent).toContain('Kookr hit a panel error');
    expect(container.textContent).toContain('Bad finding payload');
    expect(container.textContent).toContain('Likely source');
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector('button')?.textContent).toContain('Try again');
  });

  test('can retry rendering children without reloading the page', () => {
    let shouldThrow = true;

    function FlakyPanel(): React.ReactElement {
      if (shouldThrow) throw new Error('Temporary panel crash');
      return <div>Recovered dashboard</div>;
    }

    act(() => {
      root.render(
        <AppErrorBoundary>
          <FlakyPanel />
        </AppErrorBoundary>,
      );
    });

    expect(container.textContent).toContain('Temporary panel crash');
    shouldThrow = false;

    const retryButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Try again');
    expect(retryButton).toBeDefined();

    act(() => {
      retryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Recovered dashboard');
    expect(container.textContent).not.toContain('Temporary panel crash');
  });

  test('uses the injected reload action for the dashboard reload button', () => {
    const reloadDashboard = vi.fn();

    act(() => {
      root.render(
        <AppErrorBoundary reloadDashboard={reloadDashboard}>
          <ThrowingPanel />
        </AppErrorBoundary>,
      );
    });

    const reloadButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Reload dashboard');
    expect(reloadButton).toBeDefined();

    act(() => {
      reloadButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(reloadDashboard).toHaveBeenCalledOnce();
  });

  test('keeps the production reload action wired when no reload prop is injected', () => {
    const reloadDashboard = vi.fn();
    __setAppErrorBoundaryReloadDashboardForTests(reloadDashboard);

    act(() => {
      root.render(
        <AppErrorBoundary>
          <ThrowingPanel />
        </AppErrorBoundary>,
      );
    });

    const reloadButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Reload dashboard');
    expect(reloadButton).toBeDefined();

    act(() => {
      reloadButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(reloadDashboard).toHaveBeenCalledOnce();
  });

  test('renders children normally when no render error occurs', () => {
    act(() => {
      root.render(
        <AppErrorBoundary>
          <HealthyPanel />
        </AppErrorBoundary>,
      );
    });

    expect(container.textContent).toContain('Dashboard ready');
    expect(container.textContent).not.toContain('Kookr hit a panel error');
  });
});
