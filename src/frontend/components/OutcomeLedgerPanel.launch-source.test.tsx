// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { LaunchSourceStrip } from './OutcomeLedgerPanel.js';
import type { OutcomeLedgerLaunchSourceMix } from '../../shared/contracts/outcome-ledger.js';

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
});

function render(mix: OutcomeLedgerLaunchSourceMix): void {
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(LaunchSourceStrip, { mix }));
  });
}

describe('LaunchSourceStrip', () => {
  test('renders a labeled count and share for each launch source, including legacy unknown', () => {
    render({
      total: 8,
      counts: { manual: 4, scheduled: 2, parent: 1, unknown: 1 },
      shares: { manual: 0.5, scheduled: 0.25, parent: 0.125, unknown: 0.125 },
    });

    // Assert per-span so each bucket's count, label, and share are tied to the
    // same node — a swapped share would slip past a free-floating substring.
    const strip = container.querySelector('[aria-label="Task launch-source mix"]');
    expect(strip).not.toBeNull();
    const spanTexts = Array.from(strip!.querySelectorAll(':scope > span')).map((s) => s.textContent ?? '');
    expect(spanTexts).toEqual([
      '4 manual 50%',
      '2 scheduled 25%',
      '1 child 13%',
      '1 unknown 13%',
    ]);
  });

  test('shows every bucket at zero and omits shares when the window has no tasks', () => {
    render({
      total: 0,
      counts: { manual: 0, scheduled: 0, parent: 0, unknown: 0 },
      shares: null,
    });

    const text = container.textContent ?? '';
    expect(text).toContain('0 manual');
    expect(text).toContain('0 scheduled');
    expect(text).toContain('0 child');
    expect(text).toContain('0 unknown');
    // With no tasks there is no share to divide, so no percentage is shown.
    expect(text).not.toContain('%');
    expect(container.querySelector('.outcome-launch-source-share')).toBeNull();
  });
});
