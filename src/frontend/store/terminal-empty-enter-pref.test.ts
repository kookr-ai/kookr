// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TERMINAL_EMPTY_ENTER_ADVANCE_KEY,
  __resetTerminalEmptyEnterAdvanceForTests,
  getTerminalEmptyEnterAdvance,
  setTerminalEmptyEnterAdvance,
} from './terminal-empty-enter-pref.js';

describe('terminal empty-Enter advance preference', () => {
  beforeEach(() => {
    localStorage.removeItem(TERMINAL_EMPTY_ENTER_ADVANCE_KEY);
    __resetTerminalEmptyEnterAdvanceForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(TERMINAL_EMPTY_ENTER_ADVANCE_KEY);
  });

  it('is on when nothing is stored', () => {
    expect(getTerminalEmptyEnterAdvance()).toBe(true);
  });

  it.each([
    ['false', false],
    ['true', true],
    ['garbage', true],
  ])('reads a stored %s as %s', (stored, expected) => {
    localStorage.setItem(TERMINAL_EMPTY_ENTER_ADVANCE_KEY, stored);
    __resetTerminalEmptyEnterAdvanceForTests();
    expect(getTerminalEmptyEnterAdvance()).toBe(expected);
  });

  it('persists a change and survives a reload', () => {
    setTerminalEmptyEnterAdvance(false);
    expect(localStorage.getItem(TERMINAL_EMPTY_ENTER_ADVANCE_KEY)).toBe('false');
    __resetTerminalEmptyEnterAdvanceForTests();
    expect(getTerminalEmptyEnterAdvance()).toBe(false);
  });

  it('keeps the choice for this page load when storage refuses the write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    setTerminalEmptyEnterAdvance(false);
    expect(getTerminalEmptyEnterAdvance()).toBe(false);
  });

  it('follows a change made in another tab', () => {
    window.dispatchEvent(new StorageEvent('storage', { key: TERMINAL_EMPTY_ENTER_ADVANCE_KEY, newValue: 'false' }));
    expect(getTerminalEmptyEnterAdvance()).toBe(false);
    window.dispatchEvent(new StorageEvent('storage', { key: TERMINAL_EMPTY_ENTER_ADVANCE_KEY, newValue: null }));
    expect(getTerminalEmptyEnterAdvance()).toBe(true);
  });
});
