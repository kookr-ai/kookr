import { describe, expect, test } from 'vitest';
import { activeModalReducer, type ActiveModalState } from './app-modal-reducer.js';

describe('activeModalReducer', () => {
  test('opens a modal from the idle state', () => {
    expect(activeModalReducer(null, { type: 'open', modal: 'settings' })).toBe('settings');
  });

  test('opening a different modal replaces the current one (mutual exclusion)', () => {
    const afterSettings: ActiveModalState = activeModalReducer(null, { type: 'open', modal: 'settings' });
    expect(activeModalReducer(afterSettings, { type: 'open', modal: 'launch' })).toBe('launch');
  });

  test('close returns to the idle state', () => {
    expect(activeModalReducer('bugReport', { type: 'close' })).toBeNull();
  });

  test('close from idle is a no-op', () => {
    expect(activeModalReducer(null, { type: 'close' })).toBeNull();
  });

  test('toggle opens the modal when idle', () => {
    expect(activeModalReducer(null, { type: 'toggle', modal: 'shortcuts' })).toBe('shortcuts');
  });

  test('toggle closes the modal when it is already the active one', () => {
    expect(activeModalReducer('shortcuts', { type: 'toggle', modal: 'shortcuts' })).toBeNull();
  });

  test('toggle switches to a different modal when another is active', () => {
    expect(activeModalReducer('settings', { type: 'toggle', modal: 'shortcuts' })).toBe('shortcuts');
  });
});
