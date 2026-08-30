import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ScheduleStore,
  ScheduleValidationError,
  scheduleResolutionSignature,
  pruneExecutionLedger,
  isPendingLedgerEntry,
  hasScheduleLoopConfig,
  normalizeScheduleLoopConfig,
  resolveScheduleAgentSelection,
  MAX_LEDGER_ENTRIES,
  type ScheduleExecutionLedgerEntry,
} from './schedule.js';

describe('ScheduleStore', () => {
  let dir: string;
  let store: ScheduleStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'schedule-test-'));
    store = new ScheduleStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a schedule with valid input', () => {
    const schedule = store.create({
      name: 'Nightly Triage',
      cron: '0 0 * * *',
      playbook: { path: 'issue-triage.md', parameters: { repoFullName: 'kookr-ai/kookr' } },
      cwd: '/tmp',
    });

    expect(schedule.id).toBeTruthy();
    expect(schedule.name).toBe('Nightly Triage');
    expect(schedule.cron).toBe('0 0 * * *');
    expect(schedule.enabled).toBe(true);
    // Unpinned: inherits settings.defaultAgentType at fire time.
    expect(schedule.agentType).toBeUndefined();
  });

  it('omits agentType on create when not provided and preserves pin when set', async () => {
    const unpinned = store.create({
      name: 'Default inherit',
      cron: '0 0 * * *',
      playbook: { path: 'a.md', parameters: {} },
      cwd: '/tmp',
    });
    expect(unpinned.agentType).toBeUndefined();

    const pinned = store.create({
      name: 'Pinned grok',
      cron: '0 0 * * *',
      playbook: { path: 'a.md', parameters: {} },
      cwd: '/tmp',
      agentType: 'grok-build',
    });
    expect(pinned.agentType).toBe('grok-build');

    await store.persist();
    const reloaded = new ScheduleStore(dir);
    await reloaded.load();
    expect(reloaded.get(unpinned.id)?.agentType).toBeUndefined();
    expect(reloaded.get(pinned.id)?.agentType).toBe('grok-build');

    const cleared = reloaded.updateDefinition(pinned.id, { agentType: null });
    expect(cleared.agentType).toBeUndefined();
    await reloaded.persist();
    const reloaded2 = new ScheduleStore(dir);
    await reloaded2.load();
    expect(reloaded2.get(pinned.id)?.agentType).toBeUndefined();
  });

  it('resolveScheduleAgentSelection prefers pin then default getter', () => {
    expect(resolveScheduleAgentSelection({}, () => 'grok-build')).toBe('grok-build');
    expect(resolveScheduleAgentSelection({ agentType: 'codex-cli' }, () => 'grok-build')).toBe('codex-cli');
    expect(resolveScheduleAgentSelection({})).toBe('claude-code');
  });

  it('persists optional effort and model pins (#1518)', async () => {
    const schedule = store.create({
      name: 'Fable daily reflect',
      cron: '0 8 * * *',
      playbook: { path: 'reflect.md', parameters: {} },
      cwd: '/tmp',
      agentType: 'claude-code',
      effort: 'max',
      model: 'claude-fable-5',
    });
    expect(schedule.effort).toBe('max');
    expect(schedule.model).toBe('claude-fable-5');

    await store.persist();
    const reloaded = new ScheduleStore(dir);
    await reloaded.load();
    const loaded = reloaded.get(schedule.id);
    expect(loaded?.effort).toBe('max');
    expect(loaded?.model).toBe('claude-fable-5');

    const updated = reloaded.updateDefinition(schedule.id, {
      effort: 'high',
      model: 'claude-opus-4-8',
    });
    expect(updated.effort).toBe('high');
    expect(updated.model).toBe('claude-opus-4-8');
  });

  it('omits effort/model when not provided (no global default side effect) (#1518)', () => {
    const schedule = store.create({
      name: 'Plain',
      cron: '0 0 * * *',
      playbook: { path: 'a.md', parameters: {} },
      cwd: '/tmp',
    });
    expect(schedule.effort).toBeUndefined();
    expect(schedule.model).toBeUndefined();
  });

  it('persists and clears portable small intent without pinning an agent', async () => {
    const schedule = store.create({
      name: 'Routine sentinel',
      cron: '*/15 * * * *',
      playbook: { path: 'sentinel.md', parameters: {} },
      cwd: '/tmp',
      modelTier: 'small',
    });
    expect(schedule.agentType).toBeUndefined();
    expect(schedule.modelTier).toBe('small');

    await store.persist();
    const reloaded = new ScheduleStore(dir);
    await reloaded.load();
    expect(reloaded.get(schedule.id)?.modelTier).toBe('small');
    expect(reloaded.updateDefinition(schedule.id, { modelTier: null }).modelTier).toBeUndefined();
  });

  it('rejects ambiguous schedule tier and raw pins', () => {
    expect(() => store.create({
      name: 'Ambiguous',
      cron: '0 * * * *',
      playbook: { path: 'sentinel.md', parameters: {} },
      cwd: '/tmp',
      modelTier: 'small',
      model: 'claude-haiku-4-5',
    })).toThrow(ScheduleValidationError);
  });

  it('persists a loop config (empty {} is enough to arm) and clears it on null (#1899)', async () => {
    const schedule = store.create({
      name: 'Always-on batch',
      cron: '0 * * * *',
      playbook: { path: 'loopable-batch.md', parameters: {} },
      cwd: '/tmp',
      loop: {},
    });
    expect(hasScheduleLoopConfig(schedule)).toBe(true);
    expect(schedule.loop).toEqual({});

    await store.persist();
    const reloaded = new ScheduleStore(dir);
    await reloaded.load();
    const loaded = reloaded.get(schedule.id)!;
    expect(hasScheduleLoopConfig(loaded)).toBe(true);
    expect(loaded.loop).toEqual({});

    // Nested playbook.loop is accepted on create and normalized onto Schedule.loop.
    const nested = store.create({
      name: 'Nested loop',
      cron: '0 * * * *',
      playbook: { path: 'batch.md', parameters: {}, loop: { iterationCap: 12 } },
      cwd: '/tmp',
    });
    expect(nested.loop).toEqual({ iterationCap: 12 });
    expect(nested.playbook.loop).toBeUndefined(); // not stored under playbook

    // Explicit null clears the arming flag.
    const cleared = reloaded.updateDefinition(schedule.id, { loop: null });
    expect(hasScheduleLoopConfig(cleared)).toBe(false);
    expect(cleared.loop).toBeUndefined();

    // Update with fields replaces.
    const withCap = reloaded.updateDefinition(schedule.id, { loop: { iterationCap: 8, costCapUsd: 2.5 } });
    expect(withCap.loop).toEqual({ iterationCap: 8, costCapUsd: 2.5 });
  });

  it('normalizeScheduleLoopConfig accepts empty object and drops malformed fields (#1899)', () => {
    expect(normalizeScheduleLoopConfig({})).toEqual({});
    expect(normalizeScheduleLoopConfig({ iterationCap: 6, stopPredicate: 'test -f stop' })).toEqual({
      iterationCap: 6,
      stopPredicate: 'test -f stop',
    });
    expect(normalizeScheduleLoopConfig({ iterationCap: -1, costCapUsd: 'nope' })).toEqual({});
    expect(normalizeScheduleLoopConfig(null)).toBeUndefined();
    expect(normalizeScheduleLoopConfig('loop')).toBeUndefined();
  });

  it('creates a schedule with a finite cron trigger limit', () => {
    const schedule = store.create({
      name: 'Finite',
      cron: '0 0 * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: '/tmp',
      maxTriggers: 10,
    });

    expect(schedule.maxTriggers).toBe(10);
    expect(schedule.remainingTriggers).toBe(10);
    expect(schedule.stopReason).toBeUndefined();
    expect(schedule.exhaustedAt).toBeUndefined();
  });

  it('rejects invalid cron expression', () => {
    expect(() => store.create({
      name: 'Bad',
      cron: 'not valid',
      playbook: { path: 'test.md', parameters: {} },
      cwd: '/tmp',
    })).toThrow(ScheduleValidationError);
  });

  it('rejects invalid finite trigger limits', () => {
    expect(() => store.create({
      name: 'Bad',
      cron: '0 0 * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: '/tmp',
      maxTriggers: 0,
    })).toThrow(ScheduleValidationError);

    expect(() => store.create({
      name: 'Bad',
      cron: '0 0 * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: '/tmp',
      maxTriggers: 1.5,
    })).toThrow(ScheduleValidationError);
  });

  it('rejects missing name', () => {
    expect(() => store.create({
      name: '',
      cron: '0 0 * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: '/tmp',
    })).toThrow(ScheduleValidationError);
  });

  it('rejects missing playbook path', () => {
    expect(() => store.create({
      name: 'Test',
      cron: '0 0 * * *',
      playbook: { path: '', parameters: {} },
      cwd: '/tmp',
    })).toThrow(ScheduleValidationError);
  });

  it('lists schedules', () => {
    store.create({ name: 'A', cron: '0 0 * * *', playbook: { path: 'a.md', parameters: {} }, cwd: '/tmp' });
    store.create({ name: 'B', cron: '0 6 * * *', playbook: { path: 'b.md', parameters: {} }, cwd: '/tmp' });
    expect(store.list()).toHaveLength(2);
  });

  it('updates a schedule definition', () => {
    const schedule = store.create({
      name: 'Test',
      cron: '0 0 * * *',
      playbook: { path: 'a.md', parameters: {} },
      cwd: '/tmp',
    });

    const updated = store.updateDefinition(schedule.id, {
      name: 'Updated',
      cron: '0 6 * * *',
      playbook: { path: 'b.md', parameters: { branch: 'main' } },
    });

    expect(updated.name).toBe('Updated');
    expect(updated.cron).toBe('0 6 * * *');
    expect(updated.playbook).toEqual({ path: 'b.md', parameters: { branch: 'main' } });
  });

  it('updates finite trigger limits while preserving consumed cron runs', () => {
    const schedule = store.create({
      name: 'Finite',
      cron: '0 0 * * *',
      playbook: { path: 'a.md', parameters: {} },
      cwd: '/tmp',
      maxTriggers: 10,
    });

    store.replace({
      ...schedule,
      remainingTriggers: 4,
    });

    const increased = store.updateDefinition(schedule.id, {
      maxTriggers: 12,
    });
    expect(increased.maxTriggers).toBe(12);
    expect(increased.remainingTriggers).toBe(6);
    expect(increased.stopReason).toBeUndefined();

    const cleared = store.updateDefinition(schedule.id, {
      maxTriggers: null,
    });
    expect(cleared.maxTriggers).toBeUndefined();
    expect(cleared.remainingTriggers).toBeUndefined();
    expect(cleared.stopReason).toBeUndefined();
    expect(cleared.exhaustedAt).toBeUndefined();
  });

  it('marks a lowered trigger limit as exhausted when consumed runs already meet the limit', () => {
    const schedule = store.create({
      name: 'Finite',
      cron: '0 0 * * *',
      playbook: { path: 'a.md', parameters: {} },
      cwd: '/tmp',
      maxTriggers: 5,
    });

    store.replace({
      ...schedule,
      enabled: true,
      remainingTriggers: 1,
    });

    const updated = store.updateDefinition(schedule.id, {
      maxTriggers: 4,
    });

    expect(updated.maxTriggers).toBe(4);
    expect(updated.remainingTriggers).toBe(0);
    expect(updated.enabled).toBe(false);
    expect(updated.stopReason).toBe('trigger_limit_reached');
    expect(updated.exhaustedAt).toEqual(expect.any(String));
  });

  it('re-enables an auto-exhausted schedule when maxTriggers is cleared', () => {
    const schedule = store.create({
      name: 'Exhausted once',
      cron: '0 0 * * *',
      playbook: { path: 'a.md', parameters: {} },
      cwd: '/tmp',
      maxTriggers: 1,
    });

    store.replace({
      ...schedule,
      enabled: false,
      remainingTriggers: 0,
      stopReason: 'trigger_limit_reached',
      exhaustedAt: '2026-01-01T00:05:00.000Z',
    });

    const rearmed = store.updateDefinition(schedule.id, { maxTriggers: null });

    expect(rearmed.enabled).toBe(true);
    expect(rearmed.maxTriggers).toBeUndefined();
    expect(rearmed.remainingTriggers).toBeUndefined();
    expect(rearmed.stopReason).toBeUndefined();
    expect(rearmed.exhaustedAt).toBeUndefined();
  });

  it('re-enables an auto-exhausted schedule when maxTriggers is raised', () => {
    const schedule = store.create({
      name: 'Exhausted once',
      cron: '0 0 * * *',
      playbook: { path: 'a.md', parameters: {} },
      cwd: '/tmp',
      maxTriggers: 1,
    });

    store.replace({
      ...schedule,
      enabled: false,
      remainingTriggers: 0,
      stopReason: 'trigger_limit_reached',
      exhaustedAt: '2026-01-01T00:05:00.000Z',
    });

    const rearmed = store.updateDefinition(schedule.id, { maxTriggers: 5 });

    // One prior consumption preserved; 5 - 1 = 4 remaining.
    expect(rearmed.enabled).toBe(true);
    expect(rearmed.maxTriggers).toBe(5);
    expect(rearmed.remainingTriggers).toBe(4);
    expect(rearmed.stopReason).toBeUndefined();
    expect(rearmed.exhaustedAt).toBeUndefined();
  });

  it('keeps an operator-disabled schedule disabled after a limit edit', () => {
    const schedule = store.create({
      name: 'Operator off',
      cron: '0 0 * * *',
      playbook: { path: 'a.md', parameters: {} },
      cwd: '/tmp',
      maxTriggers: 10,
    });

    // Operator toggle — no exhaustion markers.
    store.replace({
      ...schedule,
      enabled: false,
      remainingTriggers: 7,
    });

    const raised = store.updateDefinition(schedule.id, { maxTriggers: 12 });
    expect(raised.enabled).toBe(false);
    expect(raised.maxTriggers).toBe(12);
    expect(raised.remainingTriggers).toBe(9);
    expect(raised.stopReason).toBeUndefined();
    expect(raised.exhaustedAt).toBeUndefined();

    const cleared = store.updateDefinition(schedule.id, { maxTriggers: null });
    expect(cleared.enabled).toBe(false);
    expect(cleared.maxTriggers).toBeUndefined();
    expect(cleared.remainingTriggers).toBeUndefined();
    expect(cleared.stopReason).toBeUndefined();
    expect(cleared.exhaustedAt).toBeUndefined();
  });

  it('stays exhausted when a limit edit does not restore budget', () => {
    const exhaustedAt = '2026-01-01T00:05:00.000Z';
    const schedule = store.create({
      name: 'Still out of budget',
      cron: '0 0 * * *',
      playbook: { path: 'a.md', parameters: {} },
      cwd: '/tmp',
      maxTriggers: 5,
    });

    store.replace({
      ...schedule,
      enabled: false,
      remainingTriggers: 0,
      stopReason: 'trigger_limit_reached',
      exhaustedAt,
    });

    // Same limit (consumed=5 → remaining still 0) — must not re-arm.
    const sameLimit = store.updateDefinition(schedule.id, { maxTriggers: 5 });
    expect(sameLimit.enabled).toBe(false);
    expect(sameLimit.remainingTriggers).toBe(0);
    expect(sameLimit.stopReason).toBe('trigger_limit_reached');
    expect(sameLimit.exhaustedAt).toBe(exhaustedAt);

    // Lower limit still yields remaining 0.
    const lowered = store.updateDefinition(schedule.id, { maxTriggers: 3 });
    expect(lowered.enabled).toBe(false);
    expect(lowered.maxTriggers).toBe(3);
    expect(lowered.remainingTriggers).toBe(0);
    expect(lowered.stopReason).toBe('trigger_limit_reached');
    expect(lowered.exhaustedAt).toBe(exhaustedAt);
  });

  it('re-enables when only a partial exhaustion marker is present', () => {
    const schedule = store.create({
      name: 'Partial marker',
      cron: '0 0 * * *',
      playbook: { path: 'a.md', parameters: {} },
      cwd: '/tmp',
      maxTriggers: 1,
    });

    // Half-state: exhaustedAt without stopReason (defensive OR in wasAutoExhausted).
    store.replace({
      ...schedule,
      enabled: false,
      remainingTriggers: 0,
      exhaustedAt: '2026-01-01T00:05:00.000Z',
    });

    const rearmed = store.updateDefinition(schedule.id, { maxTriggers: null });
    expect(rearmed.enabled).toBe(true);
    expect(rearmed.stopReason).toBeUndefined();
    expect(rearmed.exhaustedAt).toBeUndefined();
  });

  it('does not re-arm a consecutive_failures pause when clearing maxTriggers (issue #2353)', () => {
    const schedule = store.create({
      name: 'Failure paused',
      cron: '0 0 * * *',
      playbook: { path: 'a.md', parameters: {} },
      cwd: '/tmp',
      maxTriggers: 3,
    });

    store.replace({
      ...schedule,
      enabled: false,
      remainingTriggers: 0,
      stopReason: 'consecutive_failures',
      exhaustedAt: '2026-01-01T00:05:00.000Z',
      consecutiveFailures: 5,
      operatorHold: true,
    });

    const cleared = store.updateDefinition(schedule.id, { maxTriggers: null });
    expect(cleared.enabled).toBe(false);
    expect(cleared.stopReason).toBe('consecutive_failures');
    expect(cleared.consecutiveFailures).toBe(5);
    expect(cleared.maxTriggers).toBeUndefined();
  });

  it('toggles enabled state', () => {
    const schedule = store.create({
      name: 'Test',
      cron: '0 0 * * *',
      playbook: { path: 'a.md', parameters: {} },
      cwd: '/tmp',
    });

    const updated = store.setEnabled(schedule.id, false);
    expect(updated.enabled).toBe(false);
  });

  it('operatorHold parks a disable and clears on re-enable (issue #2196)', () => {
    const schedule = store.create({
      name: 'Critical residual',
      cron: '0 0 * * *',
      playbook: { path: 'lucy-orchestration-effectiveness.md', parameters: {} },
      cwd: '/tmp',
    });

    // Intentional disable of a critical schedule auto-parks (UI Pause / CLI).
    const plainCriticalDisable = store.setEnabled(schedule.id, false);
    expect(plainCriticalDisable.enabled).toBe(false);
    expect(plainCriticalDisable.operatorHold).toBe(true);

    const unpark = store.setEnabled(schedule.id, true);
    expect(unpark.enabled).toBe(true);
    expect(unpark.operatorHold).toBeUndefined();

    // Explicit hold:false leaves re-armable (ops/test escape hatch).
    const rearmable = store.setEnabled(schedule.id, false, { operatorHold: false });
    expect(rearmable.enabled).toBe(false);
    expect(rearmable.operatorHold).toBeUndefined();

    // Non-critical plain disable does not invent a hold.
    const other = store.create({
      name: 'Nightly idea scout',
      cron: '0 0 * * *',
      playbook: { path: 'repository-idea-scout.md', parameters: {} },
      cwd: '/tmp',
    });
    const otherDisabled = store.setEnabled(other.id, false);
    expect(otherDisabled.operatorHold).toBeUndefined();
  });

  it('tags an operator hold with provenance + heldAt and clears both on re-enable (issue #2520)', () => {
    const schedule = store.create({
      name: 'Critical residual',
      cron: '0 0 * * *',
      playbook: { path: 'lucy-orchestration-effectiveness.md', parameters: {} },
      cwd: '/tmp',
    });

    // Critical intentional disable auto-parks: tagged operator-sourced.
    const parked = store.setEnabled(schedule.id, false);
    expect(parked.operatorHold).toBe(true);
    expect(parked.holdSource).toBe('operator');
    expect(parked.heldAt).toBe(parked.updatedAt);

    // Re-enable clears the whole hold triple.
    const unpark = store.setEnabled(schedule.id, true);
    expect(unpark.operatorHold).toBeUndefined();
    expect(unpark.holdSource).toBeUndefined();
    expect(unpark.heldAt).toBeUndefined();

    // Explicit operatorHold:true (operator PATCH) also tags operator.
    const explicit = store.setEnabled(schedule.id, false, { operatorHold: true });
    expect(explicit.holdSource).toBe('operator');
    expect(typeof explicit.heldAt).toBe('string');
  });

  it('rehydrates a daemon-sourced hold + heldAt across a reload (issue #2520)', async () => {
    const schedule = store.create({
      name: 'Cascade victim',
      cron: '0 0 * * *',
      playbook: { path: 'a.md', parameters: {} },
      cwd: '/tmp',
    });
    // Simulate the #2353 auto-pause writing a daemon-sourced hold.
    store.replace({
      ...schedule,
      enabled: false,
      stopReason: 'consecutive_failures',
      operatorHold: true,
      holdSource: 'daemon',
      heldAt: '2026-08-14T00:10:00.000Z',
    });
    await store.persist();

    const reloaded = new ScheduleStore(dir);
    await reloaded.load();
    const after = reloaded.get(schedule.id)!;
    expect(after.operatorHold).toBe(true);
    expect(after.holdSource).toBe('daemon');
    expect(after.heldAt).toBe('2026-08-14T00:10:00.000Z');
  });

  it('replaces a schedule with runtime execution state', () => {
    const schedule = store.create({
      name: 'Runtime',
      cron: '0 0 * * *',
      playbook: { path: 'a.md', parameters: {} },
      cwd: '/tmp',
    });
    const evaluatedAt = new Date().toISOString();

    store.replace({
      ...schedule,
      lastScheduledFor: evaluatedAt,
      lastCronEvaluatedAt: evaluatedAt,
      latestExecution: {
        receiptId: 'receipt-1',
        executionToken: 'token-1',
        scheduledFor: evaluatedAt,
        evaluatedAt,
        triggeredAt: evaluatedAt,
        trigger: 'cron',
        taskId: 'task-1',
        outcome: 'running',
        reasonCode: 'none',
      },
      currentExecution: {
        id: 'receipt-1',
        scheduleId: schedule.id,
        executionToken: 'token-1',
        trigger: 'cron',
        decision: 'cron_due',
        scheduledFor: evaluatedAt,
        evaluatedAt,
        taskId: 'task-1',
        status: 'accepted',
      },
      executionLedger: [
        {
          id: `${schedule.id}:cron:${evaluatedAt}`,
          scheduleId: schedule.id,
          receiptId: 'receipt-1',
          executionToken: 'token-1',
          trigger: 'cron',
          decision: 'cron_due',
          scheduledFor: evaluatedAt,
          evaluatedAt,
          completedAt: evaluatedAt,
          taskId: 'task-1',
          outcome: 'running',
          reasonCode: 'none',
        },
      ],
    });

    const updated = store.get(schedule.id)!;
    expect(updated.latestExecution?.outcome).toBe('running');
    expect(updated.currentExecution?.status).toBe('accepted');
    expect(updated.executionLedger[0]).toEqual(expect.objectContaining({
      taskId: 'task-1',
      outcome: 'running',
      decision: 'cron_due',
    }));
    expect(updated.lastScheduledFor).toBe(evaluatedAt);
  });

  it('deletes a schedule', () => {
    const schedule = store.create({
      name: 'Test',
      cron: '0 0 * * *',
      playbook: { path: 'a.md', parameters: {} },
      cwd: '/tmp',
    });

    expect(store.delete(schedule.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  it('persists and loads runtime schedule state atomically', async () => {
    const created = store.create({
      name: 'Persist Test',
      cron: '0 0 * * *',
      playbook: { path: 'a.md', parameters: {} },
      cwd: '/tmp',
      maxTriggers: 3,
    });

    store.replace({
      ...created,
      remainingTriggers: 0,
      enabled: false,
      stopReason: 'trigger_limit_reached',
      exhaustedAt: '2026-01-01T00:05:00.000Z',
      latestExecution: {
        executionToken: 'token-1',
        evaluatedAt: '2026-01-01T00:00:00.000Z',
        trigger: 'cron',
        outcome: 'dispatch_failed',
        taskId: 'task-1',
        reasonCode: 'validation',
      },
      executionLedger: [
        {
          id: `${created.id}:cron:2026-01-01T00:00:00.000Z`,
          scheduleId: created.id,
          executionToken: 'token-1',
          trigger: 'cron',
          decision: 'catch_up',
          scheduledFor: '2026-01-01T00:00:00.000Z',
          evaluatedAt: '2026-01-01T00:00:01.000Z',
          completedAt: '2026-01-01T00:00:02.000Z',
          taskId: 'task-1',
          outcome: 'dispatch_failed',
          reasonCode: 'validation',
          message: 'Invalid playbook',
        },
      ],
    });
    await store.persist();

    const content = await readFile(join(dir, 'schedules.json'), 'utf-8');
    const data = JSON.parse(content);
    expect(data).toHaveLength(1);
    expect(data[0].latestExecution.outcome).toBe('dispatch_failed');
    expect(data[0].executionLedger).toHaveLength(1);
    expect(data[0].executionLedger[0].decision).toBe('catch_up');
    expect(data[0].remainingTriggers).toBe(0);
    expect(data[0].stopReason).toBe('trigger_limit_reached');

    const reloaded = new ScheduleStore(dir);
    await reloaded.load();
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0].latestExecution?.outcome).toBe('dispatch_failed');
    expect(reloaded.list()[0].executionLedger[0]).toEqual(expect.objectContaining({
      outcome: 'dispatch_failed',
      reasonCode: 'validation',
      message: 'Invalid playbook',
    }));
    expect(reloaded.list()[0].remainingTriggers).toBe(0);
    expect(reloaded.list()[0].stopReason).toBe('trigger_limit_reached');
    expect(reloaded.list()[0].exhaustedAt).toBe('2026-01-01T00:05:00.000Z');
  });

  it('persists lastRunStatus=skipped across reload (issue #2568)', async () => {
    const created = store.create({
      name: 'Skip persist',
      cron: '0 0 * * *',
      playbook: { path: 'a.md', parameters: {} },
      cwd: '/tmp',
    });
    store.replace({
      ...created,
      lastRunStatus: 'skipped',
      consecutiveFailures: 5,
    });
    await store.persist();

    const reloaded = new ScheduleStore(dir);
    await reloaded.load();
    expect(reloaded.list()[0].lastRunStatus).toBe('skipped');
    expect(reloaded.list()[0].consecutiveFailures).toBe(5);
  });

  it('writes schedules.json compactly (no pretty indentation) (#2217)', async () => {
    store.create({
      name: 'Compact Write',
      cron: '0 0 * * *',
      playbook: { path: 'a.md', parameters: {} },
      cwd: '/tmp',
    });
    await store.persist();

    const content = await readFile(join(dir, 'schedules.json'), 'utf-8');
    const parsed = JSON.parse(content) as Array<{ name: string }>;
    // Couple compact format to a real persist result (not empty/wrong payload).
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('Compact Write');
    // Canonical compact form: re-stringify of parse equals on-disk bytes.
    expect(content).toBe(JSON.stringify(parsed));
  });

  it('loads legacy pretty-printed schedules.json (#2217)', async () => {
    const pretty = JSON.stringify(
      [
        {
          id: 'legacy-pretty-1',
          name: 'Legacy Pretty',
          cron: '0 0 * * *',
          playbook: { path: 'legacy.md', parameters: {} },
          cwd: '/tmp',
          enabled: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          executionLedger: [],
        },
      ],
      null,
      2,
    );
    // Sanity: fixture is actually pretty-printed (multi-space indent).
    expect(pretty).toMatch(/\n {2}/);
    await writeFile(join(dir, 'schedules.json'), pretty, 'utf-8');

    const reloaded = new ScheduleStore(dir);
    await reloaded.load();
    expect(reloaded.getLoadError()).toBeUndefined();
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0].name).toBe('Legacy Pretty');
    expect(reloaded.list()[0].id).toBe('legacy-pretty-1');
  });

  it('re-arms the persist chain after a failed write while surfacing the failure', async () => {
    const blockedDir = join(dir, 'blocked');
    await writeFile(blockedDir, 'not a directory', 'utf-8');
    const flakyStore = new ScheduleStore(blockedDir);

    flakyStore.create({
      name: 'First',
      cron: '0 0 * * *',
      playbook: { path: 'a.md', parameters: {} },
      cwd: '/tmp',
    });

    await expect(flakyStore.persist()).rejects.toThrow();

    await rm(blockedDir, { force: true });
    await mkdir(blockedDir);

    flakyStore.create({
      name: 'Second',
      cron: '0 6 * * *',
      playbook: { path: 'b.md', parameters: {} },
      cwd: '/tmp',
    });

    await expect(flakyStore.persist()).resolves.toBeUndefined();

    const persisted = JSON.parse(await readFile(join(blockedDir, 'schedules.json'), 'utf-8'));
    expect(persisted.map((schedule: { name: string }) => schedule.name)).toEqual(['First', 'Second']);
  });

  it('listWithComputed includes nextRunAt and cronDescription', () => {
    store.create({ name: 'Test', cron: '0 0 * * *', playbook: { path: 'a.md', parameters: {} }, cwd: '/tmp' });

    const computed = store.listWithComputed();
    expect(computed).toHaveLength(1);
    expect(computed[0].cronDescription).toBe('Daily at 00:00');
    expect(new Date(computed[0].nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it('listWithComputed uses lastScheduledFor as the cadence watermark', () => {
    const schedule = store.create({
      name: 'Minute Job',
      cron: '* * * * *',
      playbook: { path: 'a.md', parameters: {} },
      cwd: '/tmp',
    });
    const lastScheduledFor = new Date(Date.now() - 2 * 60_000).toISOString();

    store.replace({
      ...schedule,
      lastScheduledFor,
      latestExecution: {
        executionToken: 'token-1',
        evaluatedAt: lastScheduledFor,
        scheduledFor: lastScheduledFor,
        trigger: 'cron',
        outcome: 'completed',
        reasonCode: 'none',
      },
    });

    const computed = store.getWithComputed(schedule.id)!;
    expect(computed.nextRunAt).not.toBeNull();
    expect(new Date(computed.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it('listWithComputed returns null nextRunAt for disabled schedule', () => {
    store.create({
      name: 'Disabled',
      cron: '0 0 * * *',
      playbook: { path: 'a.md', parameters: {} },
      cwd: '/tmp',
      enabled: false,
    });

    const computed = store.listWithComputed();
    expect(computed[0].nextRunAt).toBeNull();
  });

  it('listWithComputed returns null nextRunAt for exhausted schedule', () => {
    const schedule = store.create({
      name: 'Finite',
      cron: '* * * * *',
      playbook: { path: 'a.md', parameters: {} },
      cwd: '/tmp',
      maxTriggers: 1,
    });

    store.replace({
      ...schedule,
      enabled: false,
      remainingTriggers: 0,
      stopReason: 'trigger_limit_reached',
      exhaustedAt: new Date().toISOString(),
    });

    const computed = store.getWithComputed(schedule.id)!;
    expect(computed.nextRunAt).toBeNull();
    expect(computed.stopReason).toBe('trigger_limit_reached');
    expect(computed.remainingTriggers).toBe(0);
  });

  it('rejects update of nonexistent schedule', () => {
    expect(() => store.updateDefinition('nonexistent', { name: 'Nope' })).toThrow(ScheduleValidationError);
  });

  it('rejects update with invalid cron', () => {
    const schedule = store.create({
      name: 'Test',
      cron: '0 0 * * *',
      playbook: { path: 'a.md', parameters: {} },
      cwd: '/tmp',
    });

    expect(() => store.updateDefinition(schedule.id, { cron: 'bad cron bad cron bad' })).toThrow(ScheduleValidationError);
  });

  it('loads gracefully with corrupted JSON', async () => {
    await writeFile(join(dir, 'schedules.json'), '{ broken json', 'utf-8');
    const reloaded = new ScheduleStore(dir);
    await reloaded.load();
    expect(reloaded.list()).toHaveLength(0);
  });

  it('loads gracefully when file does not exist', async () => {
    const reloaded = new ScheduleStore('/nonexistent/path');
    await reloaded.load();
    expect(reloaded.list()).toHaveLength(0);
  });

  describe('playbook scope carry-through (R2)', () => {
    it('create stores an explicit scope', () => {
      const schedule = store.create({
        name: 'Plugin Job',
        cron: '0 0 * * *',
        playbook: { path: 'plug.md', parameters: {}, scope: 'plugin' },
        cwd: '/tmp',
      });
      expect(schedule.playbook).toEqual({ path: 'plug.md', parameters: {}, scope: 'plugin' });
    });

    it('create without scope leaves it unset (legacy = project)', () => {
      const schedule = store.create({
        name: 'Legacy',
        cron: '0 0 * * *',
        playbook: { path: 'a.md', parameters: {} },
        cwd: '/tmp',
      });
      expect(schedule.playbook.scope).toBeUndefined();
    });

    it('updateDefinition carries a new scope through', () => {
      const schedule = store.create({
        name: 'Job',
        cron: '0 0 * * *',
        playbook: { path: 'a.md', parameters: {} },
        cwd: '/tmp',
      });
      const updated = store.updateDefinition(schedule.id, {
        playbook: { path: 'usr.md', parameters: {}, scope: 'user' },
      });
      expect(updated.playbook).toEqual({ path: 'usr.md', parameters: {}, scope: 'user' });
    });

    it('an update that omits scope preserves the already-pinned scope (no un-pin)', () => {
      const schedule = store.create({
        name: 'Pinned',
        cron: '0 0 * * *',
        playbook: { path: 'plug.md', parameters: {}, scope: 'plugin' },
        cwd: '/tmp',
      });
      // Patch path+parameters only — scope omitted. Must stay 'plugin'.
      const updated = store.updateDefinition(schedule.id, {
        playbook: { path: 'plug.md', parameters: { branch: 'main' } },
      });
      expect(updated.playbook).toEqual({ path: 'plug.md', parameters: { branch: 'main' }, scope: 'plugin' });
    });

    it('scope survives a persist + reload round-trip', async () => {
      store.create({
        name: 'Plugin Job',
        cron: '0 0 * * *',
        playbook: { path: 'plug.md', parameters: {}, scope: 'plugin' },
        cwd: '/tmp',
      });
      await store.persist();

      const reloaded = new ScheduleStore(dir);
      await reloaded.load();
      expect(reloaded.list()[0].playbook.scope).toBe('plugin');
    });
  });

  describe('cached playbook resolution health (R9)', () => {
    it('reports unknown until the cache is seeded, then the cached tri-state', () => {
      const schedule = store.create({
        name: 'Health',
        cron: '0 0 * * *',
        playbook: { path: 'a.md', parameters: {} },
        cwd: '/tmp',
      });
      const sig = scheduleResolutionSignature(schedule);

      // Cache miss → unknown (never broken).
      expect(store.getWithComputed(schedule.id)!.playbookResolution).toBe('unknown');

      store.setPlaybookResolution(schedule.id, sig, true);
      expect(store.getWithComputed(schedule.id)!.playbookResolution).toBe('resolvable');

      store.setPlaybookResolution(schedule.id, sig, false);
      expect(store.getWithComputed(schedule.id)!.playbookResolution).toBe('unresolvable');
    });

    it('falls back to unknown when the cached signature is stale (cwd/path edit)', () => {
      const schedule = store.create({
        name: 'Edited',
        cron: '0 0 * * *',
        playbook: { path: 'a.md', parameters: {} },
        cwd: '/tmp',
      });
      store.setPlaybookResolution(schedule.id, scheduleResolutionSignature(schedule), true);
      expect(store.getWithComputed(schedule.id)!.playbookResolution).toBe('resolvable');

      // Edit the path — the cached entry's signature no longer matches.
      store.updateDefinition(schedule.id, { playbook: { path: 'b.md', parameters: {} } });
      expect(store.getWithComputed(schedule.id)!.playbookResolution).toBe('unknown');
    });
  });

  // issue #1582: cost/artifact enrichment on executionLedger rows.
  describe('executionLedger cost/artifact enrichment (#1582)', () => {
    function baseLedgerEntry(overrides: Record<string, unknown>): Record<string, unknown> {
      return {
        id: 's1:cron:2026-01-01T00:00:00.000Z',
        scheduleId: 's1',
        trigger: 'cron',
        decision: 'cron_due',
        evaluatedAt: '2026-01-01T00:00:01.000Z',
        outcome: 'completed',
        ...overrides,
      };
    }

    async function loadWithLedger(entries: Record<string, unknown>[]) {
      const raw = [{
        id: 's1',
        name: 'Enriched',
        enabled: true,
        cron: '0 0 * * *',
        playbook: { path: 'a.md', parameters: {} },
        cwd: '/tmp',
        agentType: 'claude',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        executionLedger: entries,
      }];
      await writeFile(join(dir, 'schedules.json'), JSON.stringify(raw), 'utf-8');
      const reloaded = new ScheduleStore(dir);
      await reloaded.load();
      return reloaded.list()[0].executionLedger;
    }

    it('loads a legacy entry with no cost/artifact fields unchanged (no migration)', async () => {
      const ledger = await loadWithLedger([baseLedgerEntry({ taskId: 'task-legacy' })]);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).not.toHaveProperty('tokenUsage');
      expect(ledger[0]).not.toHaveProperty('artifacts');
      expect(ledger[0].taskId).toBe('task-legacy');
    });

    it('round-trips a well-formed tokenUsage + artifacts entry', async () => {
      const ledger = await loadWithLedger([baseLedgerEntry({
        taskId: 'task-1',
        tokenUsage: {
          inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 2,
          costUsd: 0.42, provider: 'anthropic', model: 'claude-opus-4-8', pricingQuality: 'exact',
        },
        artifacts: ['https://github.com/kookr-ai/kookr/pull/1', ''],
      })]);
      expect(ledger[0].tokenUsage).toEqual({
        inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 2,
        costUsd: 0.42, provider: 'anthropic', model: 'claude-opus-4-8', pricingQuality: 'exact',
      });
      // Empty-string artifact is dropped by normalization.
      expect(ledger[0].artifacts).toEqual(['https://github.com/kookr-ai/kookr/pull/1']);
    });

    // Invariant: a malformed/partial tokenUsage never survives normalization —
    // it is dropped rather than patched with zeros, so a missing field always
    // means "not measured", never a fabricated $0. Property-checked over a
    // table of malformed shapes.
    it('drops malformed tokenUsage instead of fabricating a partial/zero cost', async () => {
      const malformed: unknown[] = [
        { inputTokens: 1 }, // missing the rest
        { inputTokens: '1', outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: 5 }, // wrong type
        { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }, // missing costUsd
        'not-an-object',
        null,
        42,
      ];
      for (const tokenUsage of malformed) {
        const ledger = await loadWithLedger([baseLedgerEntry({ taskId: 't', tokenUsage })]);
        expect(ledger).toHaveLength(1);
        expect(ledger[0]).not.toHaveProperty('tokenUsage');
      }
    });

    // Invariant: normalization is idempotent — persisting a normalized ledger
    // and reloading it yields an identical row (no field churn across reloads).
    it('is idempotent across a persist + reload of the normalized ledger', async () => {
      await loadWithLedger([baseLedgerEntry({
        taskId: 'task-1',
        completedAt: '2026-01-01T00:00:02.000Z',
        tokenUsage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 },
        artifacts: ['https://github.com/kookr-ai/kookr/pull/2', ''],
      })]);
      // Store A loads the raw file, then re-persists its NORMALIZED form.
      const storeA = new ScheduleStore(dir);
      await storeA.load();
      const first = storeA.list()[0].executionLedger;
      await storeA.persist();
      // Store B reloads the persisted normalized form — must match byte-for-byte.
      const storeB = new ScheduleStore(dir);
      await storeB.load();
      const second = storeB.list()[0].executionLedger;
      expect(second).toEqual(first);
      expect(second[0].artifacts).toEqual(['https://github.com/kookr-ai/kookr/pull/2']);
    });

    it('drops a non-array artifacts field', async () => {
      const ledger = await loadWithLedger([baseLedgerEntry({ taskId: 't', artifacts: 'not-an-array' })]);
      expect(ledger[0]).not.toHaveProperty('artifacts');
    });
  });

  // issue #1392: the per-schedule execution ledger is bounded so a
  // once-per-minute schedule cannot accrue ~1,440 rows/day of unbounded memory
  // and O(ledger) write amplification.
  describe('executionLedger cap (#1392)', () => {
    function ledgerEntry(
      seq: number,
      outcome: ScheduleExecutionLedgerEntry['outcome'] = 'completed',
    ): ScheduleExecutionLedgerEntry {
      const stamp = `2026-01-01T00:${String(seq % 60).padStart(2, '0')}:00.000Z`;
      return {
        id: `s1:cron:${seq}`,
        scheduleId: 's1',
        trigger: 'cron',
        decision: 'cron_due',
        evaluatedAt: stamp,
        outcome,
        taskId: `task-${seq}`,
      };
    }

    it('classifies mid-flight outcomes as pending and terminal ones as not', () => {
      expect(isPendingLedgerEntry(ledgerEntry(1, 'running'))).toBe(true);
      expect(isPendingLedgerEntry(ledgerEntry(1, 'queued'))).toBe(true);
      expect(isPendingLedgerEntry(ledgerEntry(1, 'queued_capacity'))).toBe(true);
      expect(isPendingLedgerEntry(ledgerEntry(1, 'completed'))).toBe(false);
      expect(isPendingLedgerEntry(ledgerEntry(1, 'skipped_coalesced'))).toBe(false);
      expect(isPendingLedgerEntry(ledgerEntry(1, 'dispatch_failed'))).toBe(false);
    });

    it('is a no-op when the ledger is within the cap', () => {
      const ledger = Array.from({ length: 3 }, (_, i) => ledgerEntry(i));
      expect(pruneExecutionLedger(ledger, 5)).toBe(ledger);
    });

    it('bounds to the cap and retains the most-recent entries', () => {
      const ledger = Array.from({ length: 25 }, (_, i) => ledgerEntry(i));
      const pruned = pruneExecutionLedger(ledger, 10);
      expect(pruned).toHaveLength(10);
      // Newest-N retained (ids 15..24, chronological order preserved).
      expect(pruned.map((e) => e.id)).toEqual(
        Array.from({ length: 10 }, (_, i) => `s1:cron:${15 + i}`),
      );
    });

    it('keeps a pending row that falls outside the newest-N window', () => {
      // Oldest row is pending; the rest are terminal. Pruning to 3 would drop it
      // by pure recency, but a later reconcile keys off it — it must survive.
      const ledger = [
        ledgerEntry(0, 'running'),
        ...Array.from({ length: 9 }, (_, i) => ledgerEntry(i + 1)),
      ];
      const pruned = pruneExecutionLedger(ledger, 3);
      // 3 newest terminal + the retained pending row, pending first (chrono order).
      expect(pruned).toHaveLength(4);
      expect(pruned[0]).toMatchObject({ id: 's1:cron:0', outcome: 'running' });
      expect(pruned.slice(1).map((e) => e.id)).toEqual(['s1:cron:7', 's1:cron:8', 's1:cron:9']);
    });

    it('defaults the cap to MAX_LEDGER_ENTRIES', () => {
      const ledger = Array.from({ length: MAX_LEDGER_ENTRIES + 5 }, (_, i) => ledgerEntry(i));
      const pruned = pruneExecutionLedger(ledger);
      expect(pruned).toHaveLength(MAX_LEDGER_ENTRIES);
      expect(pruned[pruned.length - 1].id).toBe(`s1:cron:${MAX_LEDGER_ENTRIES + 4}`);
    });

    it('bounds an oversized legacy ledger on load', async () => {
      const over = MAX_LEDGER_ENTRIES + 50;
      const entries = Array.from({ length: over }, (_, i) => ({
        id: `s1:cron:${i}`,
        scheduleId: 's1',
        trigger: 'cron',
        decision: 'cron_due',
        evaluatedAt: '2026-01-01T00:00:00.000Z',
        outcome: 'completed',
        taskId: `task-${i}`,
      }));
      const raw = [{
        id: 's1',
        name: 'Legacy bloat',
        enabled: true,
        cron: '* * * * *',
        playbook: { path: 'a.md', parameters: {} },
        cwd: '/tmp',
        agentType: 'claude',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        executionLedger: entries,
      }];
      await writeFile(join(dir, 'schedules.json'), JSON.stringify(raw), 'utf-8');
      const reloaded = new ScheduleStore(dir);
      await reloaded.load();
      const ledger = reloaded.list()[0].executionLedger;
      expect(ledger).toHaveLength(MAX_LEDGER_ENTRIES);
      // Trimmed from the OLD end: the retained window is the newest MAX rows,
      // so both boundaries pin the recency direction (an off-by-one trimming the
      // wrong end would keep the last id but shift the first).
      expect(ledger[0].id).toBe(`s1:cron:${over - MAX_LEDGER_ENTRIES}`);
      expect(ledger[ledger.length - 1].id).toBe(`s1:cron:${over - 1}`);
    });
  });
});
