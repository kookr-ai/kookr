// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { globalEnterShouldNavigate } from './global-enter-nav.js';

describe('globalEnterShouldNavigate', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function el(html: string): Element {
    const host = document.createElement('div');
    host.innerHTML = html;
    const node = host.firstElementChild!;
    document.body.appendChild(node);
    return node;
  }

  test('navigates when focus rests on a non-interactive element', () => {
    expect(globalEnterShouldNavigate(document.body)).toBe(true);
    expect(globalEnterShouldNavigate(el('<div class="task-card">x</div>'))).toBe(true);
    expect(globalEnterShouldNavigate(null)).toBe(true);
  });

  test('does not navigate when focus is on an interactive control', () => {
    expect(globalEnterShouldNavigate(el('<input />'))).toBe(false);
    expect(globalEnterShouldNavigate(el('<textarea></textarea>'))).toBe(false);
    expect(globalEnterShouldNavigate(el('<select></select>'))).toBe(false);
    expect(globalEnterShouldNavigate(el('<button>Skip</button>'))).toBe(false);
    expect(globalEnterShouldNavigate(el('<a href="#">link</a>'))).toBe(false);
    expect(globalEnterShouldNavigate(el('<div contenteditable="true">x</div>'))).toBe(false);
    expect(globalEnterShouldNavigate(el('<div role="button">x</div>'))).toBe(false);
    expect(globalEnterShouldNavigate(el('<div role="menuitem">x</div>'))).toBe(false);
    expect(globalEnterShouldNavigate(el('<div role="tab">x</div>'))).toBe(false);
  });

  test('does not navigate while a dialog owns the keyboard — every modal signal', () => {
    // .dialog-overlay modals
    el('<div class="dialog-overlay"><button>OK</button></div>');
    expect(globalEnterShouldNavigate(document.body)).toBe(false);

    // aria-modal modal whose backdrop class is NOT .dialog-overlay
    // (SweepButton / TaskDependencyEditor pattern) — the regression this guards.
    document.body.innerHTML = '';
    el('<div class="sweep-confirm-backdrop"><div role="dialog" aria-modal="true">Confirm?</div></div>');
    expect(globalEnterShouldNavigate(document.body)).toBe(false);

    // role=dialog without aria-modal (non-modal popover) still owns Enter.
    document.body.innerHTML = '';
    el('<div role="dialog">popover</div>');
    expect(globalEnterShouldNavigate(document.body)).toBe(false);
  });
});
