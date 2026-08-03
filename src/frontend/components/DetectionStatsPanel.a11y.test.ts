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

function mount(props: { defaultExpanded?: boolean } = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(DetectionStatsPanel, {
      defaultExpanded: props.defaultExpanded ?? false,
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
        fires: { needs_input: 2 },
        falsePositives: {},
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

describe('DetectionStatsPanel disclosure a11y', () => {
  test('header is a button with aria-expanded and click toggles the body', async () => {
    mount({ defaultExpanded: false });
    await flush();

    const header = container.querySelector('.detection-stats-section .section-header') as HTMLButtonElement;
    expect(header).not.toBeNull();
    expect(header.tagName).toBe('BUTTON');
    expect(header.type).toBe('button');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.detection-stats-body')).toBeNull();

    act(() => header.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.detection-stats-body')).not.toBeNull();
    expect(container.textContent).toContain('Needs Input');

    act(() => header.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.detection-stats-body')).toBeNull();
  });

  test('keyboard activation via native button click toggles the section', async () => {
    mount({ defaultExpanded: true });
    await flush();

    const header = container.querySelector('.detection-stats-header') as HTMLButtonElement;
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(header.type).toBe('button');

    act(() => header.click());
    expect(header.getAttribute('aria-expanded')).toBe('false');

    act(() => header.click());
    expect(header.getAttribute('aria-expanded')).toBe('true');
  });
});
