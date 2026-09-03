// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { RecentPromptsPicker } from './RecentPromptsPicker.js';
import type { RecentPromptEntry } from '../../shared/contracts/recent-prompts.js';

const CWD = '/work/proj';

function entry(over: Partial<RecentPromptEntry> = {}): RecentPromptEntry {
  return { prompt: 'a prompt', cwd: CWD, at: Date.now(), cwdMatch: true, ...over };
}

describe('RecentPromptsPicker', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(props: Partial<React.ComponentProps<typeof RecentPromptsPicker>> = {}): void {
    act(() => {
      root.render(
        React.createElement(RecentPromptsPicker, {
          entries: props.entries ?? [entry()],
          currentCwd: props.currentCwd ?? CWD,
          onSelect: props.onSelect ?? (() => {}),
        }),
      );
    });
  }

  function toggle(): void {
    const btn = container.querySelector<HTMLButtonElement>('.recent-prompts-toggle');
    act(() => btn?.click());
  }

  test('renders nothing when there is no history (no dead affordance)', () => {
    render({ entries: [] });
    expect(container.querySelector('.recent-prompts')).toBeNull();
  });

  test('shows the count and expands on toggle', () => {
    render({ entries: [entry({ prompt: 'one' }), entry({ prompt: 'two' })] });
    const btn = container.querySelector('.recent-prompts-toggle');
    expect(btn?.textContent).toContain('(2)');
    expect(container.querySelector('.recent-prompts-panel')).toBeNull();
    toggle();
    expect(container.querySelector('.recent-prompts-panel')).not.toBeNull();
    expect(container.querySelectorAll('.recent-prompts-item')).toHaveLength(2);
  });

  test('selecting a row emits the full prompt and collapses', () => {
    const onSelect = vi.fn();
    render({ entries: [entry({ prompt: 'review the diff since origin/main' })], onSelect });
    toggle();
    const item = container.querySelector<HTMLButtonElement>('.recent-prompts-item');
    act(() => item?.click());
    expect(onSelect).toHaveBeenCalledWith(
      'review the diff since origin/main',
      { cwdMatch: true, rank: 0 },
    );
    // Panel collapses after selection.
    expect(container.querySelector('.recent-prompts-panel')).toBeNull();
  });

  test('filters by case-insensitive substring over the shown prompts', () => {
    render({
      entries: [
        entry({ prompt: 'Bump the dependencies' }),
        entry({ prompt: 'Review the auth flow' }),
      ],
    });
    toggle();
    const input = container.querySelector<HTMLInputElement>('.recent-prompts-filter');
    act(() => {
      if (input) {
        // React overrides the instance value setter; go through the prototype
        // setter so the controlled input observes the change.
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'auth');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    const items = container.querySelectorAll('.recent-prompts-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('Review the auth flow');
  });

  test('shows an "in <repo>" tag for a cross-repo entry, not for a matching one', () => {
    render({
      entries: [
        entry({ prompt: 'here', cwd: CWD, cwdMatch: true }),
        entry({ prompt: 'elsewhere', cwd: '/work/other', cwdMatch: false }),
      ],
      currentCwd: CWD,
    });
    toggle();
    const repos = [...container.querySelectorAll('.recent-prompts-item-repo')].map((n) => n.textContent);
    expect(repos).toEqual(['in other']);
  });

  test('no repo tag when cwdMatch is false but the cwd equals the current one', () => {
    // Both showRepoTag conjuncts must hold; a same-cwd (non-matched) entry
    // should still suppress the tag.
    render({
      entries: [entry({ prompt: 'p', cwd: CWD, cwdMatch: false })],
      currentCwd: CWD,
    });
    toggle();
    expect(container.querySelector('.recent-prompts-item-repo')).toBeNull();
  });
});
