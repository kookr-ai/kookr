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

function renderTooltip(text: string, buttonProps: React.ComponentProps<'button'> = {}) {
  act(() => {
    root.render(
      React.createElement(
        Tooltip,
        { text },
        React.createElement('button', { type: 'button', ...buttonProps }, 'Target'),
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

  test('shows an associated tooltip on focus and preserves child handlers', () => {
    const onFocus = vi.fn();
    const onKeyDown = vi.fn();
    renderTooltip('Keyboard-accessible details', {
      'aria-describedby': 'existing-description',
      onFocus,
      onKeyDown,
    });

    const button = container.querySelector('button')!;
    act(() => {
      button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(onFocus).toHaveBeenCalledOnce();

    act(() => {
      vi.advanceTimersByTime(400);
    });

    const tooltip = document.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toBe('Keyboard-accessible details');
    expect(button.getAttribute('aria-describedby')).toBe(`existing-description ${tooltip?.id}`);

    act(() => {
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onKeyDown).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    act(() => {
      button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      vi.advanceTimersByTime(400);
      button.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  test('does not reveal after overlapping hover and focus both end', () => {
    renderTooltip('Mixed-input details');

    const button = container.querySelector('button')!;
    act(() => {
      button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    act(() => {
      button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    act(() => {
      button.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    act(() => {
      button.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
});
