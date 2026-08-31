import { chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapacityLedger } from '../core/capacity-ledger.js';
import type { Schedule } from '../core/schedule.js';
import type { Task, TaskStore } from '../core/tasks.js';

vi.mock('./use-cases/playbook-launch.js', () => ({
  preparePlaybookLaunchWithMetadata: vi.fn(async () => ({
    launchOpts: {
      prompt: 'idea scout mock',
      cwd: '/tmp/lucy',
      playbookId: 'repository-idea-scout.md',
    },
  })),
}));

import {
  collectProductBatchRepos,
  PostRecoveryService,
  POST_RECOVERY_PROVENANCE,
} from './post-recovery-service.js';

function makeLedger(overrides: Partial<CapacityLedger> = {}): CapacityLedger {
  return {
    maxActive: 16,
    active: 7,
    free: 9,
    freeForGeneralSources: 9,
    pendingQueueDepth: 0,
    byClass: { working: 7, finishedAwaitingAck: 0, hungSuspect: 0, launching: 0 },
    reservedActiveSlots: 0,
    ...overrides,
  } as CapacityLedger;
}

function schedule(partial: Partial<Schedule> & Pick<Schedule, 'id' | 'name' | 'playbook'>): Schedule {
  return {
    enabled: false,
    cron: '0 * * * *',
    cwd: '/tmp',
    executionLedger: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...partial,
  };
}

function makeTaskStore(tasks: Task[] = []): TaskStore {
  return {
    listTasks: () => tasks,
    getTask: (id: string) => tasks.find((t) => t.id === id),
  } as unknown as TaskStore;
}

describe('collectProductBatchRepos', () => {
  it('dedupes by repo and prefers enabled localPath', () => {
    const schedules = [
      schedule({
        id: '1',
        name: 'Lucy batch (Grok)',
        enabled: false,
        playbook: {
          path: 'parallel-issue-batch.md',
          parameters: { repoFullName: 'jeanibarz/lucy', localPath: '/old/lucy' },
        },
      }),
      schedule({
        id: '2',
        name: 'Lucy batch (Codex)',
        enabled: true,
        playbook: {
          path: 'parallel-issue-batch.md',
          parameters: { repoFullName: 'jeanibarz/lucy', localPath: '/home/jean/git/lucy' },
        },
      }),
      schedule({
        id: '3',
        name: 'Kookr batch',
        enabled: true,
        playbook: {
          path: 'plugin/parallel-issue-batch.md',
          parameters: { repoFullName: 'kookr-ai/kookr', localPath: '/home/jean/git/kookr' },
        },
      }),
      schedule({
        id: '4',
        name: 'Idea scout',
        enabled: true,
        playbook: { path: 'repository-idea-scout.md', parameters: { repoFullName: 'x/y' } },
      }),
    ];
    expect(collectProductBatchRepos(schedules)).toEqual([
      { repo: 'jeanibarz/lucy', localPath: '/home/jean/git/lucy' },
      { repo: 'kookr-ai/kookr', localPath: '/home/jean/git/kookr' },
    ]);
  });
});

describe('PostRecoveryService', () => {
  let tempDir: string;
  let nowMs: number;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'kookr-post-recovery-'));
    nowMs = Date.parse('2026-08-10T15:00:00.000Z');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('re-arms allowlisted disabled schedules without hold and audits', async () => {
    const setEnabled = vi.fn(async (id: string, enabled: boolean) => ({ id, enabled }));
    const schedules = [
      schedule({
        id: 'eff',
        name: 'Lucy Orchestration Effectiveness',
        enabled: false,
        playbook: { path: 'lucy-orchestration-effectiveness.md', parameters: {} },
      }),
      schedule({
        id: 'held',
        name: 'Lucy Product Surface Journey',
        enabled: false,
        operatorHold: true,
        playbook: { path: 'lucy-product-surface-journey.md', parameters: {} },
      }),
      schedule({
        id: 'batch',
        name: 'Lucy parallel issue batch (Grok Build)',
        enabled: false,
        playbook: {
          path: 'parallel-issue-batch.md',
          parameters: { repoFullName: 'jeanibarz/lucy' },
        },
      }),
    ];

    const service = new PostRecoveryService({
      listSchedules: () => schedules,
      setEnabled,
      taskStore: makeTaskStore(),
      getCapacityLedger: () => makeLedger({ free: 0, freeForGeneralSources: 0, pendingQueueDepth: 1 }),
      launcher: vi.fn(),
      kookrDir: tempDir,
      kickStateDir: join(tempDir, 'kick-state'),
      now: () => nowMs,
    });

    const result = await service.rearmCriticalSchedules();
    expect(result.rearmed).toEqual([{ id: 'eff', name: 'Lucy Orchestration Effectiveness' }]);
    expect(setEnabled).toHaveBeenCalledOnce();
    expect(setEnabled).toHaveBeenCalledWith('eff', true);
    // Held product journey is NOT re-armed
    expect(setEnabled).not.toHaveBeenCalledWith('held', true);
    // Non-allowlisted batch is NOT re-armed
    expect(setEnabled).not.toHaveBeenCalledWith('batch', true);

    const audit = await readFile(join(tempDir, 'audit.jsonl'), 'utf-8');
    const row = JSON.parse(audit.trim().split('\n')[0]!);
    expect(row.action).toBe('critical_schedule_rearm');
    expect(row.provenance).toBe(POST_RECOVERY_PROVENANCE);
    expect(row.scheduleId).toBe('eff');
  });

  it('R10.7: retries only a failed enable on a later tick, even after in-memory mutation', async () => {
    const schedules = [
      schedule({
        id: 'persisted',
        name: 'Lucy Orchestration Effectiveness',
        enabled: false,
        playbook: { path: 'lucy-orchestration-effectiveness.md', parameters: {} },
      }),
      schedule({
        id: 'retry',
        name: 'Lucy Product Surface Journey',
        enabled: false,
        playbook: { path: 'lucy-product-surface-journey.md', parameters: {} },
      }),
    ];
    let retryAttempts = 0;
    const setEnabled = vi.fn(async (id: string) => {
      const current = schedules.find((candidate) => candidate.id === id)!;
      current.enabled = true;
      if (id === 'retry' && ++retryAttempts === 1) {
        // ScheduleService mutates memory before awaiting persistence. The retry
        // must retain failure provenance instead of trusting enabled=true.
        throw new Error('transient disk rejection');
      }
    });
    const service = new PostRecoveryService({
      listSchedules: () => schedules,
      setEnabled,
      taskStore: makeTaskStore(),
      getCapacityLedger: () => makeLedger(),
      launcher: vi.fn(),
      kookrDir: tempDir,
      now: () => nowMs,
      criticalRearmRetryDelayMs: 60_000,
      criticalRearmMaxAttempts: 3,
    });

    const first = await service.tick();
    expect(first.rearm.rearmed).toEqual([
      { id: 'persisted', name: 'Lucy Orchestration Effectiveness' },
    ]);
    expect(first.rearm.skipped).toEqual([
      {
        id: 'retry',
        name: 'Lucy Product Surface Journey',
        reason: 'retry_scheduled:attempt_1_of_3:transient disk rejection',
      },
    ]);

    await service.tick();
    expect(setEnabled).toHaveBeenCalledTimes(2);

    nowMs += 60_000;
    const retry = await service.tick();
    expect(retry.rearm.rearmed).toEqual([
      { id: 'retry', name: 'Lucy Product Surface Journey' },
    ]);
    expect(setEnabled.mock.calls.filter(([id]) => id === 'persisted')).toHaveLength(1);
    expect(setEnabled.mock.calls.filter(([id]) => id === 'retry')).toHaveLength(2);
  });

  it.each([
    {
      name: 'operator hold',
      mutate: (schedules: Schedule[]) => {
        schedules[0]!.enabled = false;
        schedules[0]!.operatorHold = true;
        schedules[0]!.holdSource = 'operator';
      },
      reason: 'retry_cancelled:operator_hold',
    },
    {
      name: 'schedule removal',
      mutate: (schedules: Schedule[]) => {
        schedules.splice(0, 1);
      },
      reason: 'retry_cancelled:schedule_removed',
    },
    {
      name: 'trigger exhaustion',
      mutate: (schedules: Schedule[]) => {
        schedules[0]!.enabled = false;
        schedules[0]!.maxTriggers = 1;
        schedules[0]!.remainingTriggers = 0;
      },
      reason: 'retry_cancelled:trigger_limit_exhausted',
    },
    {
      name: 'allowlist removal',
      mutate: (schedules: Schedule[]) => {
        schedules[0]!.enabled = false;
        schedules[0]!.name = 'Ordinary nightly check';
        schedules[0]!.playbook.path = 'ordinary-check.md';
      },
      reason: 'retry_cancelled:not_allowlisted',
    },
  ])('R10.7: cancels a pending retry after $name', async ({ mutate, reason }) => {
    const schedules = [
      schedule({
        id: 'retry',
        name: 'Lucy Orchestration Effectiveness',
        enabled: false,
        playbook: { path: 'lucy-orchestration-effectiveness.md', parameters: {} },
      }),
    ];
    const setEnabled = vi.fn(async () => {
      schedules[0]!.enabled = true;
      throw new Error('transient disk rejection');
    });
    const logs: string[] = [];
    const service = new PostRecoveryService({
      listSchedules: () => schedules,
      setEnabled,
      taskStore: makeTaskStore(),
      getCapacityLedger: () => makeLedger(),
      launcher: vi.fn(),
      kookrDir: tempDir,
      now: () => nowMs,
      log: (line) => logs.push(line),
      criticalRearmRetryDelayMs: 60_000,
      criticalRearmMaxAttempts: 3,
    });

    await service.tick();
    mutate(schedules);
    nowMs += 60_000;
    const cancelled = await service.tick();

    expect(cancelled.rearm.skipped).toEqual([
      { id: 'retry', name: 'Lucy Orchestration Effectiveness', reason },
    ]);
    expect(setEnabled).toHaveBeenCalledOnce();
    expect(logs).toContain(
      `[post-recovery] re-arm retry cancelled for "Lucy Orchestration Effectiveness" (retry): ${reason.replace('retry_cancelled:', '')}`,
    );

    nowMs += 60_000;
    await service.tick();
    expect(setEnabled).toHaveBeenCalledOnce();
  });

  it('R10.7: reports terminal exhaustion after three total enable attempts', async () => {
    const setEnabled = vi.fn(async () => {
      throw new Error('persistent disk rejection');
    });
    const logs: string[] = [];
    const service = new PostRecoveryService({
      listSchedules: () => [
        schedule({
          id: 'retry',
          name: 'Lucy Orchestration Effectiveness',
          enabled: false,
          playbook: { path: 'lucy-orchestration-effectiveness.md', parameters: {} },
        }),
      ],
      setEnabled,
      taskStore: makeTaskStore(),
      getCapacityLedger: () => makeLedger(),
      launcher: vi.fn(),
      kookrDir: tempDir,
      now: () => nowMs,
      log: (line) => logs.push(line),
      criticalRearmRetryDelayMs: 60_000,
      criticalRearmMaxAttempts: 3,
    });

    await service.tick();
    nowMs += 60_000;
    await service.tick();
    nowMs += 60_000;
    const exhausted = await service.tick();

    expect(exhausted.rearm.skipped).toEqual([
      {
        id: 'retry',
        name: 'Lucy Orchestration Effectiveness',
        reason: 'retry_exhausted:attempt_3_of_3:persistent disk rejection',
      },
    ]);
    expect(logs).toContain(
      '[post-recovery] re-arm retry exhausted for "Lucy Orchestration Effectiveness" (retry) after 3 attempts: persistent disk rejection',
    );

    nowMs += 60_000;
    await service.tick();
    expect(setEnabled).toHaveBeenCalledTimes(3);
  });

  it('R10.7: an audit-only failure never repeats a successful enable', async () => {
    const schedules = [
      schedule({
        id: 'enabled',
        name: 'Lucy Orchestration Effectiveness',
        enabled: false,
        playbook: { path: 'lucy-orchestration-effectiveness.md', parameters: {} },
      }),
    ];
    const setEnabled = vi.fn(async () => {
      schedules[0]!.enabled = true;
    });
    const logs: string[] = [];
    await mkdir(join(tempDir, 'audit.jsonl'));
    const service = new PostRecoveryService({
      listSchedules: () => schedules,
      setEnabled,
      taskStore: makeTaskStore(),
      getCapacityLedger: () => makeLedger(),
      launcher: vi.fn(),
      kookrDir: tempDir,
      now: () => nowMs,
      log: (line) => logs.push(line),
      criticalRearmRetryDelayMs: 60_000,
      criticalRearmMaxAttempts: 3,
    });

    const first = await service.tick();
    expect(first.rearm.rearmed).toEqual([
      { id: 'enabled', name: 'Lucy Orchestration Effectiveness' },
    ]);
    expect(first.rearm.auditFailed).toHaveLength(1);
    expect(first.rearm.auditFailed[0]).toMatchObject({
      id: 'enabled',
      name: 'Lucy Orchestration Effectiveness',
    });
    expect(logs.some((line) => line.includes('re-arm audit failed'))).toBe(true);

    nowMs += 60_000;
    await service.tick();
    expect(setEnabled).toHaveBeenCalledOnce();
  });

  it('does not re-arm when operatorHold is set', async () => {
    const setEnabled = vi.fn();
    const service = new PostRecoveryService({
      listSchedules: () => [
        schedule({
          id: 'eff',
          name: 'Lucy Orchestration Effectiveness',
          enabled: false,
          operatorHold: true,
          playbook: { path: 'lucy-orchestration-effectiveness.md', parameters: {} },
        }),
      ],
      setEnabled,
      taskStore: makeTaskStore(),
      getCapacityLedger: () => makeLedger(),
      launcher: vi.fn(),
      kookrDir: tempDir,
      now: () => nowMs,
    });
    const result = await service.rearmCriticalSchedules();
    expect(result.rearmed).toEqual([]);
    expect(result.skipped).toEqual([
      { id: 'eff', name: 'Lucy Orchestration Effectiveness', reason: 'operator_hold' },
    ]);
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('re-arms the bootstrap merge watchdog OUT of a cascade-origin hold and audits (issue #2530)', async () => {
    const setEnabled = vi.fn(async (id: string, enabled: boolean) => ({ id, enabled }));
    const service = new PostRecoveryService({
      listSchedules: () => [
        schedule({
          id: 'watchdog',
          name: 'PR Merge/Rebase Watchdog',
          enabled: false,
          // #2353 sets operatorHold on every consecutive_failures auto-pause —
          // this is a cascade artifact, not a genuine operator park.
          operatorHold: true,
          stopReason: 'consecutive_failures',
          playbook: { path: 'pr-merge-rebase-watchdog.md', parameters: {} },
        }),
      ],
      setEnabled,
      taskStore: makeTaskStore(),
      getCapacityLedger: () => makeLedger(),
      launcher: vi.fn(),
      kookrDir: tempDir,
      now: () => nowMs,
    });

    const result = await service.rearmCriticalSchedules();
    expect(result.rearmed).toEqual([{ id: 'watchdog', name: 'PR Merge/Rebase Watchdog' }]);
    expect(setEnabled).toHaveBeenCalledWith('watchdog', true);

    const audit = await readFile(join(tempDir, 'audit.jsonl'), 'utf-8');
    const row = JSON.parse(audit.trim().split('\n')[0]!);
    expect(row.action).toBe('critical_schedule_rearm');
    expect(row.scheduleId).toBe('watchdog');
  });

  it('still respects a GENUINE operator park of the merge watchdog (issue #2530)', async () => {
    const setEnabled = vi.fn();
    const service = new PostRecoveryService({
      listSchedules: () => [
        schedule({
          id: 'watchdog',
          name: 'PR Merge/Rebase Watchdog',
          enabled: false,
          // Manual disable: operatorHold with no consecutive_failures stopReason.
          operatorHold: true,
          playbook: { path: 'pr-merge-rebase-watchdog.md', parameters: {} },
        }),
      ],
      setEnabled,
      taskStore: makeTaskStore(),
      getCapacityLedger: () => makeLedger(),
      launcher: vi.fn(),
      kookrDir: tempDir,
      now: () => nowMs,
    });
    const result = await service.rearmCriticalSchedules();
    expect(result.rearmed).toEqual([]);
    expect(result.skipped).toEqual([
      { id: 'watchdog', name: 'PR Merge/Rebase Watchdog', reason: 'operator_hold' },
    ]);
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('kicks at most one scout per repo per UTC day when idle capacity returns', async () => {
    const launcher = vi.fn(async () => ({
      task: { id: 'scout-1', status: 'running' } as Task,
      queued: false,
    }));
    const schedules = [
      schedule({
        id: 'batch',
        name: 'Lucy batch',
        enabled: true,
        playbook: {
          path: 'parallel-issue-batch.md',
          parameters: {
            repoFullName: 'jeanibarz/lucy',
            localPath: '/home/jean/git/lucy',
          },
        },
      }),
    ];

    const service = new PostRecoveryService({
      listSchedules: () => schedules,
      setEnabled: vi.fn(),
      taskStore: makeTaskStore(),
      getCapacityLedger: () => makeLedger({ free: 7, freeForGeneralSources: 7, pendingQueueDepth: 0 }),
      launcher,
      isDispatchHealthy: () => true,
      kookrDir: tempDir,
      kickStateDir: join(tempDir, 'kick-state'),
      starvationStateDir: join(tempDir, 'starvation'),
      now: () => nowMs,
      log: () => {},
    });

    // preparePlaybookLaunchWithMetadata needs a real playbook tree — mock launcher
    // is only called after prepare. If prepare fails, kick records error. Stub by
    // spying prepare is heavy; instead assert decision path via second tick
    // after a successful first kick written to durable state.
    //
    // First: force-write a kick state as if a prior kick today already happened.
    const kickDir = join(tempDir, 'kick-state');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(kickDir, { recursive: true });
    await writeFile(
      join(kickDir, 'jeanibarz-lucy.json'),
      JSON.stringify({
        schemaVersion: 1,
        repo: 'jeanibarz/lucy',
        lastKickUtcDay: '2026-08-10',
        lastKickAt: '2026-08-10T01:00:00.000Z',
        lastKickScoutTaskId: 'prior',
        updatedAt: '2026-08-10T01:00:00.000Z',
      }),
    );

    const kicks = await service.runQueueFillKicks();
    expect(kicks).toEqual([
      {
        repo: 'jeanibarz/lucy',
        kicked: false,
        reason: 'already_kicked_utc_day',
        utcDay: '2026-08-10',
      },
    ]);
    expect(launcher).not.toHaveBeenCalled();
  });

  it('skips kick when dispatch unhealthy or scout already in flight', async () => {
    const launcher = vi.fn();
    const schedules = [
      schedule({
        id: 'batch',
        name: 'Lucy batch',
        enabled: true,
        playbook: {
          path: 'parallel-issue-batch.md',
          parameters: { repoFullName: 'jeanibarz/lucy', localPath: '/tmp/lucy' },
        },
      }),
    ];

    const unhealthy = new PostRecoveryService({
      listSchedules: () => schedules,
      setEnabled: vi.fn(),
      taskStore: makeTaskStore(),
      getCapacityLedger: () => makeLedger(),
      launcher,
      isDispatchHealthy: () => false,
      kookrDir: tempDir,
      kickStateDir: join(tempDir, 'kick-a'),
      now: () => nowMs,
    });
    expect((await unhealthy.runQueueFillKicks())[0]?.reason).toBe('dispatch_unhealthy');

    const inFlightTask = {
      id: 's1',
      status: 'running',
      playbookId: 'repository-idea-scout.md',
      projectId: 'github.com/jeanibarz/lucy',
      playbookParameterValues: { repoFullName: 'jeanibarz/lucy' },
      name: 'Idea scout (starvation refill): jeanibarz/lucy',
      prompt: 'repository idea scout for jeanibarz/lucy',
    } as unknown as Task;

    const busy = new PostRecoveryService({
      listSchedules: () => schedules,
      setEnabled: vi.fn(),
      taskStore: makeTaskStore([inFlightTask]),
      getCapacityLedger: () => makeLedger(),
      launcher,
      isDispatchHealthy: () => true,
      kookrDir: tempDir,
      kickStateDir: join(tempDir, 'kick-b'),
      now: () => nowMs,
    });
    expect((await busy.runQueueFillKicks())[0]?.reason).toBe('scout_or_batch_in_flight');
    expect(launcher).not.toHaveBeenCalled();
  });

  it('happy-path kick: launches scout once, persists UTC day, second tick is idempotent', async () => {
    const launcher = vi.fn(async (opts) => {
      expect(opts.idempotencyKey).toBe('post-recovery-queue-fill:jeanibarz-lucy:2026-08-10');
      expect(opts.playbookId).toBe('repository-idea-scout.md');
      return {
        task: { id: 'scout-happy', status: 'running' } as Task,
        queued: false,
      };
    });
    const schedules = [
      schedule({
        id: 'batch',
        name: 'Lucy batch',
        enabled: true,
        playbook: {
          path: 'parallel-issue-batch.md',
          parameters: {
            repoFullName: 'jeanibarz/lucy',
            localPath: '/home/jean/git/lucy',
          },
        },
      }),
    ];
    const kickDir = join(tempDir, 'kick-happy');
    const starvationDir = join(tempDir, 'starvation-happy');
    const service = new PostRecoveryService({
      listSchedules: () => schedules,
      setEnabled: vi.fn(),
      taskStore: makeTaskStore(),
      getCapacityLedger: () => makeLedger({ free: 7, freeForGeneralSources: 7, pendingQueueDepth: 0 }),
      launcher,
      isDispatchHealthy: () => true,
      kookrDir: tempDir,
      kickStateDir: kickDir,
      starvationStateDir: starvationDir,
      now: () => nowMs,
      log: () => {},
    });

    const first = await service.runQueueFillKicks();
    expect(first).toEqual([
      {
        repo: 'jeanibarz/lucy',
        kicked: true,
        scoutTaskId: 'scout-happy',
        utcDay: '2026-08-10',
      },
    ]);
    expect(launcher).toHaveBeenCalledOnce();

    const statePath = join(kickDir, 'jeanibarz-lucy.json');
    const stateRaw = await readFile(statePath, 'utf-8');
    const state = JSON.parse(stateRaw) as { lastKickUtcDay: string; lastKickScoutTaskId: string };
    expect(state.lastKickUtcDay).toBe('2026-08-10');
    expect(state.lastKickScoutTaskId).toBe('scout-happy');
    if (process.platform === 'linux' || process.platform === 'darwin') {
      const mode = (await stat(statePath)).mode & 0o777;
      expect(mode & 0o077).toBe(0);
      expect(mode).toBe(0o600);
    }

    const audit = await readFile(join(tempDir, 'audit.jsonl'), 'utf-8');
    expect(audit).toContain('post_recovery_queue_fill_kick');
    expect(audit).toContain('scout-happy');

    const second = await service.runQueueFillKicks();
    expect(second[0]).toMatchObject({
      repo: 'jeanibarz/lucy',
      kicked: false,
      reason: 'already_kicked_utc_day',
      utcDay: '2026-08-10',
    });
    expect(launcher).toHaveBeenCalledOnce(); // still one
  });

  it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')(
    'rewrites kick-state owner-only even when umask would leave the file world-readable (#2869)',
    async () => {
      const launcher = vi.fn(async () => ({
        task: { id: 'scout-mode', status: 'running' } as Task,
        queued: false,
      }));
      const schedules = [
        schedule({
          id: 'batch',
          name: 'Lucy batch',
          enabled: true,
          playbook: {
            path: 'parallel-issue-batch.md',
            parameters: {
              repoFullName: 'jeanibarz/lucy',
              localPath: '/tmp/lucy',
            },
          },
        }),
      ];
      let clock = nowMs;
      const kickDir = join(tempDir, 'kick-mode');
      const service = new PostRecoveryService({
        listSchedules: () => schedules,
        setEnabled: vi.fn(),
        taskStore: makeTaskStore(),
        getCapacityLedger: () => makeLedger({ free: 7, freeForGeneralSources: 7, pendingQueueDepth: 0 }),
        launcher,
        isDispatchHealthy: () => true,
        kookrDir: tempDir,
        kickStateDir: kickDir,
        starvationStateDir: join(tempDir, 'starvation-mode'),
        now: () => clock,
        log: () => {},
      });

      const previousUmask = process.umask(0o000);
      try {
        const first = await service.runQueueFillKicks();
        expect(first[0]).toMatchObject({
          repo: 'jeanibarz/lucy',
          kicked: true,
          utcDay: '2026-08-10',
        });
        const statePath = join(kickDir, 'jeanibarz-lucy.json');
        const afterCreate = (await stat(statePath)).mode & 0o777;
        expect(afterCreate & 0o077).toBe(0);
        expect(afterCreate).toBe(0o600);

        // Rename keeps the temp file's mode, not the destination's. A 0644
        // leftover must not survive the next UTC-day rewrite.
        await chmod(statePath, 0o644);
        expect((await stat(statePath)).mode & 0o777).toBe(0o644);
        clock = nowMs + 24 * 60 * 60 * 1000;
        const second = await service.runQueueFillKicks();
        expect(second[0]).toMatchObject({
          repo: 'jeanibarz/lucy',
          kicked: true,
          utcDay: '2026-08-11',
        });
        expect(launcher).toHaveBeenCalledTimes(2);
        const afterRewrite = (await stat(statePath)).mode & 0o777;
        expect(afterRewrite & 0o077).toBe(0);
        expect(afterRewrite).toBe(0o600);
      } finally {
        process.umask(previousUmask);
      }
    },
  );

  it('create-then-launch_error does not persist the UTC-day kick or stamp lastStarvationScoutAt (#2744)', async () => {
    const { TaskStore } = await import('../core/tasks.js');
    const store = new TaskStore();
    const launcher = vi.fn(async (opts) => {
      const task = store.createTask({
        prompt: opts.prompt,
        cwd: opts.cwd,
        name: opts.name,
        playbookId: opts.playbookId,
        projectId: opts.projectId,
      });
      store.setDisposition(task.id, {
        reason: 'launch_error',
        at: '2026-08-10T09:20:37.000Z',
        source: 'launch-service',
        detail: 'Grok authentication expired',
      });
      store.terminateTask(task.id);
      return { task: store.getTask(task.id)!, queued: false };
    });
    const kickDir = join(tempDir, 'kick-launch-error');
    const starvationDir = join(tempDir, 'starvation-launch-error');
    const service = new PostRecoveryService({
      listSchedules: () => [
        schedule({
          id: 'batch',
          name: 'Lucy batch',
          enabled: true,
          playbook: {
            path: 'parallel-issue-batch.md',
            parameters: {
              repoFullName: 'jeanibarz/lucy',
              localPath: '/tmp/lucy',
            },
          },
        }),
      ],
      setEnabled: vi.fn(),
      taskStore: store,
      getCapacityLedger: () => makeLedger({ free: 7, freeForGeneralSources: 7, pendingQueueDepth: 0 }),
      launcher,
      isDispatchHealthy: () => true,
      kookrDir: tempDir,
      kickStateDir: kickDir,
      starvationStateDir: starvationDir,
      now: () => nowMs,
      log: () => {},
    });

    const first = await service.runQueueFillKicks();
    expect(first[0]).toMatchObject({
      repo: 'jeanibarz/lucy',
      kicked: false,
      utcDay: '2026-08-10',
    });
    expect(first[0]?.reason).toMatch(/died at launch/i);
    expect(launcher).toHaveBeenCalledOnce();
    expect(launcher.mock.calls[0]?.[0]?.idempotencyKey).toBe(
      'post-recovery-queue-fill:jeanibarz-lucy:2026-08-10',
    );

    const { readdir } = await import('node:fs/promises');
    await expect(readdir(kickDir)).rejects.toThrow();

    const { loadPipelineStarvationState } = await import('../core/pipeline-starvation-state.js');
    const starvation = await loadPipelineStarvationState('jeanibarz/lucy', {
      stateDir: starvationDir,
      nowMs,
    });
    expect(starvation.lastStarvationScoutAt).toBeUndefined();

    const audit = await readFile(join(tempDir, 'audit.jsonl'), 'utf-8');
    expect(audit).toContain('post_recovery_queue_fill_kick_failed');
    expect(audit).not.toContain('"action":"post_recovery_queue_fill_kick"');

    const second = await service.runQueueFillKicks();
    expect(second[0]?.kicked).toBe(false);
    expect(launcher).toHaveBeenCalledTimes(2);
    expect(launcher.mock.calls[1]?.[0]?.idempotencyKey).toBe(
      'post-recovery-queue-fill:jeanibarz-lucy:2026-08-10:r1',
    );
  });

  it('skips when parallel-issue-batch is already in flight for the repo', async () => {
    const launcher = vi.fn();
    const batchInFlight = {
      id: 'batch-1',
      status: 'running',
      playbookId: 'parallel-issue-batch.md',
      projectId: 'github.com/jeanibarz/lucy',
      playbookParameterValues: { repoFullName: 'jeanibarz/lucy' },
      name: 'Parallel issue batch: jeanibarz/lucy',
      prompt: 'batch',
    } as unknown as Task;
    const service = new PostRecoveryService({
      listSchedules: () => [
        schedule({
          id: 'batch',
          name: 'Lucy batch',
          enabled: true,
          playbook: {
            path: 'parallel-issue-batch.md',
            parameters: { repoFullName: 'jeanibarz/lucy', localPath: '/tmp/lucy' },
          },
        }),
      ],
      setEnabled: vi.fn(),
      taskStore: makeTaskStore([batchInFlight]),
      getCapacityLedger: () => makeLedger(),
      launcher,
      isDispatchHealthy: () => true,
      kookrDir: tempDir,
      kickStateDir: join(tempDir, 'kick-batch-flight'),
      now: () => nowMs,
    });
    const kicks = await service.runQueueFillKicks();
    expect(kicks[0]).toMatchObject({
      kicked: false,
      reason: 'scout_or_batch_in_flight',
      repo: 'jeanibarz/lucy',
    });
    expect(launcher).not.toHaveBeenCalled();
  });

  it('skips kick when free < N or queue non-empty', async () => {
    const schedules = [
      schedule({
        id: 'batch',
        name: 'Kookr batch',
        enabled: true,
        playbook: {
          path: 'parallel-issue-batch.md',
          parameters: { repoFullName: 'kookr-ai/kookr' },
        },
      }),
    ];
    const base = {
      listSchedules: () => schedules,
      setEnabled: vi.fn(),
      taskStore: makeTaskStore(),
      launcher: vi.fn(),
      kookrDir: tempDir,
      now: () => nowMs,
    };

    const lowFree = new PostRecoveryService({
      ...base,
      getCapacityLedger: () => makeLedger({ free: 2, freeForGeneralSources: 2 }),
      kickStateDir: join(tempDir, 'k1'),
    });
    expect((await lowFree.runQueueFillKicks())[0]?.reason).toBe('insufficient_free_slots');

    const queued = new PostRecoveryService({
      ...base,
      getCapacityLedger: () => makeLedger({ pendingQueueDepth: 3 }),
      kickStateDir: join(tempDir, 'k2'),
    });
    expect((await queued.runQueueFillKicks())[0]?.reason).toBe('queue_not_empty');
  });
});
