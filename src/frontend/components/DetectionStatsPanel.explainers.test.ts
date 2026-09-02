// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DetectionStatsPanel } from './DetectionStatsPanel.js';

let root: Root | null;
let container: HTMLDivElement;

function fetchResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(DetectionStatsPanel, {
      defaultExpanded: true,
      showEmpty: true,
    }));
  });
  return container;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/anomaly-stats')) {
      return Promise.resolve(fetchResponse({
        checks: { needs_input: 10 },
        fires: { needs_input: 4 },
        falsePositives: { needs_input: 2 },
        falseNegatives: { needs_input: 1 },
      }));
    }
    return Promise.resolve(fetchResponse({}, false, 404));
  }));
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  vi.restoreAllMocks();
});

describe('DetectionStatsPanel metric explainers (issue #3001)', () => {
  test('FP, FN, and fire-rate figures each expose a plain-language explainer', async () => {
    mount();
    await flush();

    const fp = container.querySelector('.stats-fp') as HTMLElement;
    const fn = container.querySelector('.stats-fn') as HTMLElement;
    const rate = container.querySelector('.stats-rate') as HTMLElement;

    expect(fp).not.toBeNull();
    expect(fn).not.toBeNull();
    expect(rate).not.toBeNull();

    // FP: defined relative to operator dismissal.
    expect(fp.getAttribute('title')).toContain('False positives');
    expect(fp.getAttribute('title')?.toLowerCase()).toContain('dismissed');
    expect(fp.getAttribute('aria-label')).toContain('False positives');

    // FN: defined relative to a miss the operator reported.
    expect(fn.getAttribute('title')).toContain('False negatives');
    expect(fn.getAttribute('title')?.toLowerCase()).toContain('missed');
    expect(fn.getAttribute('aria-label')).toContain('False negatives');

    // Fire rate: clarifies how to read it (not inherently good or bad).
    expect(rate.getAttribute('title')).toContain('Fire rate');
    expect(rate.getAttribute('title')?.toLowerCase()).toContain('not inherently good or bad');
    expect(rate.getAttribute('aria-label')).toContain('fire rate');
  });
});
