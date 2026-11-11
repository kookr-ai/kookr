// @vitest-environment jsdom

import { Suspense, act, lazy } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AvatarErrorBoundary } from './AvatarErrorBoundary.js';

function Broken(): never {
  throw new Error('chunk missing');
}

describe('AvatarErrorBoundary', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  test('a panel that throws disappears and leaves the rest of the page standing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    act(() => {
      root.render(
        <main>
          <p>dashboard</p>
          <AvatarErrorBoundary>
            <Broken />
          </AvatarErrorBoundary>
        </main>,
      );
    });

    expect(container.textContent).toBe('dashboard');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('avatar panel failed'), expect.any(Error));
  });

  test('panel code that cannot be downloaded (a missing chunk) is contained the same way', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Missing = lazy(() => Promise.reject(new Error('Failed to fetch dynamically imported module')));

    await act(async () => {
      root.render(
        <main>
          <p>dashboard</p>
          <AvatarErrorBoundary>
            <Suspense fallback={null}>
              <Missing />
            </Suspense>
          </AvatarErrorBoundary>
        </main>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toBe('dashboard');
  });

  test('a healthy panel is rendered unchanged', () => {
    act(() => {
      root.render(
        <AvatarErrorBoundary>
          <p>panel</p>
        </AvatarErrorBoundary>,
      );
    });

    expect(container.textContent).toBe('panel');
  });
});
