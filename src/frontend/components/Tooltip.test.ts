// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Tooltip } from './Tooltip.js';

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.querySelectorAll('.tooltip-portal').forEach((el) => el.remove());
  vi.useRealTimers();
});

function renderTooltip(text: string) {
  act(() => {
    root.render(
      React.createElement(
        Tooltip,
        { text },
        React.createElement('button', { type: 'button' }, 'Target'),
      ),
    );
  });
}

describe('Tooltip', () => {
  test('does not keep hidden prompt text mounted before hover or after leave', () => {
    renderTooltip('Long task prompt text');

    expect(document.querySelector('.tooltip-portal')).toBeNull();

    const button = container.querySelector('button')!;
    act(() => {
      button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(document.querySelector('.tooltip-portal')?.textContent).toBe('Long task prompt text');

    act(() => {
      button.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(document.querySelector('.tooltip-portal')).toBeNull();
  });
});
