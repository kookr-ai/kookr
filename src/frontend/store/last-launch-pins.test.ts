// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  LAST_EFFORT_KEY,
  LAST_MODEL_KEY,
  loadLastEffort,
  loadLastModel,
  saveLastEffort,
  saveLastLaunchPins,
  saveLastModel,
} from './last-launch-pins.js';

afterEach(() => {
  localStorage.clear();
});

describe('last-launch-pins', () => {
  test('saves effort and model under independent keys', () => {
    saveLastEffort('high');
    saveLastModel('claude-fable-5');

    expect(localStorage.getItem(LAST_EFFORT_KEY)).toBe('high');
    expect(localStorage.getItem(LAST_MODEL_KEY)).toBe('claude-fable-5');
    expect(loadLastEffort()).toBe('high');
    expect(loadLastModel()).toBe('claude-fable-5');
  });

  test('writing one pin does not overwrite the other', () => {
    saveLastEffort('high');
    saveLastModel('claude-fable-5');
    saveLastEffort('max');

    expect(loadLastEffort()).toBe('max');
    expect(loadLastModel()).toBe('claude-fable-5');
  });

  test('empty or whitespace save clears that key so the next open is Agent default', () => {
    saveLastLaunchPins('high', 'claude-sonnet-5');
    saveLastLaunchPins('  ', '');

    expect(localStorage.getItem(LAST_EFFORT_KEY)).toBeNull();
    expect(localStorage.getItem(LAST_MODEL_KEY)).toBeNull();
    expect(loadLastEffort()).toBeNull();
    expect(loadLastModel()).toBeNull();
  });

  test('load treats a stored blank string as nothing stored', () => {
    localStorage.setItem(LAST_EFFORT_KEY, '   ');
    expect(loadLastEffort()).toBeNull();
  });

  test('save does not throw when setItem throws (quota / private mode)', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = vi.fn(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      expect(() => saveLastLaunchPins('high', 'claude-fable-5')).not.toThrow();
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
      expect(loadLastEffort()).toBeNull();
      expect(loadLastModel()).toBeNull();
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});
