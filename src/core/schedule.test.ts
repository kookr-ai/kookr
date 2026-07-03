import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScheduleStore, ScheduleValidationError, scheduleResolutionSignature } from './schedule.js';

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
    expect(schedule.agentType).toBe('claude-code');
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
});
