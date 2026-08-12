import { describe, test, expect } from 'vitest';
import { classifyMigration, hasReconstructableIntent, type MigrationProbe } from './migratability.js';
import type { Task } from '../task-read-model.js';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    prompt: 'do the thing',
    userPrompt: 'do the thing',
    cwd: '/repo',
    agentType: 'grok-build',
    status: 'terminated',
    sessions: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Task;
}

function probe(overrides: Partial<MigrationProbe> = {}): MigrationProbe {
  return {
    targetAgent: 'claude-code',
    targetAvailable: true,
    hasCwd: true,
    cwdExists: true,
    gitUsable: true,
    liveSession: false,
    forkEligibleSameAgent: false,
    alreadyMigrated: false,
    worktreeShared: false,
    allowCancelled: false,
    ...overrides,
  };
}

describe('classifyMigration', () => {
  test('a terminated grok task with intact cwd + intent is migratable', () => {
    const r = classifyMigration(task(), probe());
    expect(r).toEqual({ migratable: true, worktreeShared: false });
  });

  test('echoes worktreeShared regardless of verdict', () => {
    expect(classifyMigration(task(), probe({ worktreeShared: true })).worktreeShared).toBe(true);
    expect(
      classifyMigration(task({ status: 'completed' }), probe({ worktreeShared: true })).worktreeShared,
    ).toBe(true);
  });

  test.each(['completed', 'open', 'pending'] as const)('%s is not migratable', (status) => {
    expect(classifyMigration(task({ status }), probe()).reason).toBe('status_not_migratable');
  });

  test('cancelled is blocked unless allowCancelled', () => {
    expect(classifyMigration(task({ status: 'cancelled' }), probe()).reason).toBe('status_not_migratable');
    expect(classifyMigration(task({ status: 'cancelled' }), probe({ allowCancelled: true })).migratable).toBe(true);
  });

  test('ralph loop tasks are workflow-owner-unsupported', () => {
    expect(classifyMigration(task({ ralphLoop: {} as never }), probe()).reason).toBe('workflow_owner_unsupported');
  });

  test('already-migrated tasks are blocked', () => {
    expect(classifyMigration(task(), probe({ alreadyMigrated: true })).reason).toBe('already_migrated');
  });

  test('same-agent with fork possible routes to restore', () => {
    expect(classifyMigration(task(), probe({ forkEligibleSameAgent: true })).reason).toBe('same_agent_use_restore');
  });

  test('unavailable target is blocked', () => {
    expect(classifyMigration(task(), probe({ targetAvailable: false })).reason).toBe('target_agent_unavailable');
  });

  test('a live session blocks migration', () => {
    expect(classifyMigration(task({ status: 'inProgress' }), probe({ liveSession: true })).reason).toBe('live_session_exists');
  });

  test('inProgress with no live session is migratable', () => {
    expect(classifyMigration(task({ status: 'inProgress' }), probe()).migratable).toBe(true);
  });

  test('missing/gone cwd and unusable git are distinct reasons', () => {
    expect(classifyMigration(task(), probe({ hasCwd: false })).reason).toBe('missing_cwd');
    expect(classifyMigration(task(), probe({ cwdExists: false })).reason).toBe('cwd_gone');
    expect(classifyMigration(task(), probe({ gitUsable: false })).reason).toBe('git_unavailable');
  });

  test('missing intent blocks', () => {
    const r = classifyMigration(task({ userPrompt: undefined, prompt: '   ' }), probe());
    expect(r.reason).toBe('missing_intent');
  });

  test('reason priority: status before availability', () => {
    // completed + unavailable target → status wins (checked first)
    expect(classifyMigration(task({ status: 'completed' }), probe({ targetAvailable: false })).reason).toBe(
      'status_not_migratable',
    );
  });
});

describe('hasReconstructableIntent', () => {
  test('true when userPrompt present', () => {
    expect(hasReconstructableIntent(task())).toBe(true);
  });
  test('falls back to prompt', () => {
    expect(hasReconstructableIntent(task({ userPrompt: undefined, prompt: 'p' }))).toBe(true);
  });
  test('false when both blank', () => {
    expect(hasReconstructableIntent(task({ userPrompt: '', prompt: '' }))).toBe(false);
  });
});
