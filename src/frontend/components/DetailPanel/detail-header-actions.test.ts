import { describe, expect, test } from 'vitest';
import { deriveDetailHeaderActions } from './detail-header-actions.js';

describe('deriveDetailHeaderActions (#3561 slice 4b)', () => {
  test.each([
    ['pending', true, null, ['cancel']],
    ['inProgress', true, 'complete', ['reflect', 'cancel']],
    ['open', true, 'complete', ['reflect', 'cancel']],
    ['terminated', true, 'markDone', ['relaunch', 'reopen', 'reflect', 'migrate']],
    ['terminated', false, 'markDone', ['relaunch', 'reopen', 'reflect']],
    ['cancelled', true, 'relaunch', ['reopen', 'reflect', 'migrate']],
    ['cancelled', false, 'relaunch', ['reopen', 'reflect']],
    ['completed', true, 'relaunch', ['reopen', 'reflect']],
  ] as const)('%s (canMigrate=%s) → primary %s, menu %j', (taskStatus, canMigrate, primary, menu) => {
    expect(deriveDetailHeaderActions({ taskId: 't1', taskStatus, canMigrate })).toEqual({ primary, menu });
  });

  test('a session without a task has no actions', () => {
    expect(deriveDetailHeaderActions({ taskId: undefined, taskStatus: 'inProgress', canMigrate: true })).toEqual({ primary: null, menu: [] });
  });

  test('an unknown status falls back to the active-task actions', () => {
    expect(deriveDetailHeaderActions({ taskId: 't1', taskStatus: undefined, canMigrate: true }).primary).toBe('complete');
  });

  test('Cancel is never the main action, so no destructive button sits on screen at rest', () => {
    for (const taskStatus of ['open', 'pending', 'inProgress', 'completed', 'terminated', 'cancelled'] as const) {
      expect(deriveDetailHeaderActions({ taskId: 't1', taskStatus, canMigrate: true }).primary).not.toBe('cancel');
    }
  });

  test('Migrate is never offered for a live task', () => {
    for (const taskStatus of ['open', 'pending', 'inProgress', 'completed'] as const) {
      expect(deriveDetailHeaderActions({ taskId: 't1', taskStatus, canMigrate: true }).menu).not.toContain('migrate');
    }
  });
});
