// @vitest-environment jsdom
import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  LAUNCH_TASK_DIALOG_DRAFT_KEY,
  loadLaunchTaskDialogDraft,
  saveLaunchTaskDialogDraft,
  clearLaunchTaskDialogDraft,
} from './launch-task-dialog-draft.js';

const KEY = LAUNCH_TASK_DIALOG_DRAFT_KEY;

describe('launch-task-dialog-draft', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('load returns null when no draft is stored', () => {
    expect(loadLaunchTaskDialogDraft()).toBeNull();
  });

  test('save then load round-trips the three fields', () => {
    saveLaunchTaskDialogDraft({ prompt: 'Fix the bug', cwd: '/repo', criteria: 'Tests pass' });

    expect(loadLaunchTaskDialogDraft()).toEqual({
      prompt: 'Fix the bug',
      cwd: '/repo',
      criteria: 'Tests pass',
    });
  });

  test('load returns null on corrupted JSON', () => {
    localStorage.setItem(KEY, 'not-json');

    expect(loadLaunchTaskDialogDraft()).toBeNull();
  });

  test('load returns null when parsed value is not an object', () => {
    localStorage.setItem(KEY, JSON.stringify('a string'));
    expect(loadLaunchTaskDialogDraft()).toBeNull();

    localStorage.setItem(KEY, JSON.stringify(42));
    expect(loadLaunchTaskDialogDraft()).toBeNull();
  });

  test('load tolerantly coerces missing or wrong-typed fields to empty strings', () => {
    localStorage.setItem(KEY, JSON.stringify({ prompt: 'only this' }));

    expect(loadLaunchTaskDialogDraft()).toEqual({
      prompt: 'only this',
      cwd: '',
      criteria: '',
    });
  });

  test('save with all-empty prompt and criteria clears the key', () => {
    localStorage.setItem(KEY, JSON.stringify({ prompt: 'old', cwd: '/a', criteria: 'old' }));

    saveLaunchTaskDialogDraft({ prompt: '', cwd: '/some/auto-cwd', criteria: '' });

    expect(localStorage.getItem(KEY)).toBeNull();
  });

  test('save with whitespace-only prompt and criteria clears the key (cwd alone does not save)', () => {
    saveLaunchTaskDialogDraft({ prompt: '   ', cwd: '/recent/path', criteria: '\n\t' });

    expect(localStorage.getItem(KEY)).toBeNull();
  });

  test('save with non-empty prompt persists all three fields including cwd', () => {
    saveLaunchTaskDialogDraft({ prompt: 'typed', cwd: '/a', criteria: '' });

    const stored = JSON.parse(localStorage.getItem(KEY)!);
    expect(stored).toEqual({ prompt: 'typed', cwd: '/a', criteria: '' });
  });

  test('save with non-empty criteria persists even if prompt is empty', () => {
    // Edge case: user typed only in criteria. Still counts as a draft worth saving.
    saveLaunchTaskDialogDraft({ prompt: '', cwd: '/a', criteria: 'PR created' });

    const stored = JSON.parse(localStorage.getItem(KEY)!);
    expect(stored).toEqual({ prompt: '', cwd: '/a', criteria: 'PR created' });
  });

  test('clear removes the key', () => {
    saveLaunchTaskDialogDraft({ prompt: 'x', cwd: '/a', criteria: 'y' });
    expect(localStorage.getItem(KEY)).not.toBeNull();

    clearLaunchTaskDialogDraft();

    expect(localStorage.getItem(KEY)).toBeNull();
  });

  test('save does not throw when setItem throws (quota exceeded / private mode)', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = vi.fn(() => {
      throw new Error('QuotaExceededError');
    });

    try {
      expect(() =>
        saveLaunchTaskDialogDraft({ prompt: 'p', cwd: '/a', criteria: 'c' }),
      ).not.toThrow();
    } finally {
      Storage.prototype.setItem = original;
    }
  });

  test('load does not throw when getItem throws', () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = vi.fn(() => {
      throw new Error('SecurityError');
    });

    try {
      expect(loadLaunchTaskDialogDraft()).toBeNull();
    } finally {
      Storage.prototype.getItem = original;
    }
  });

  test('clear does not throw when removeItem throws', () => {
    const original = Storage.prototype.removeItem;
    Storage.prototype.removeItem = vi.fn(() => {
      throw new Error('SecurityError');
    });

    try {
      expect(() => clearLaunchTaskDialogDraft()).not.toThrow();
    } finally {
      Storage.prototype.removeItem = original;
    }
  });
});
