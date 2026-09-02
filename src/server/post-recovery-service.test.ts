import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdapterRegistry, type AgentAdapter } from '../adapters/agent-adapter.js';
import type { CapacityLedger } from '../core/capacity-ledger.js';
import type { Schedule } from '../core/schedule.js';
import { TaskStore, type Task } from '../core/tasks.js';
import { POST_RECOVERY_MIN_FREE_SLOTS } from '../core/post-recovery-queue-fill.js';
import { launchTask, type LaunchServiceDeps } from './launch-service.js';

// A hook the SAFE-MODE-during-preparation test flips just before the mocked
// playbook preparation resolves, simulating the kill-switch engaging after the
// recovery tick's initial check but before launch preparation completes.
const prepareLaunchControl = vi.hoisted(() => ({
  beforeResolve: undefined as (() => void) | undefined,
}));

vi.mock('./use-cases/playbook-launch.js', () => ({
  preparePlaybookLaunchWithMetadata: vi.fn(async () => {
    prepareLaunchControl.beforeResolve?.();
    return {
      launchOpts: {
        prompt: 'idea scout mock',
        cwd: '/tmp/lucy',
        playbookId: 'repository-idea-scout.md',
      },
    };
  }),
}));

import {
  boundedBatchArmError,
  collectProductBatchRepos,
  PostRecoveryService,
  POST_RECOVERY_BATCH_ARM_ERROR_MAX,
  POST_RECOVERY_QUEUE_FILL_HEALTH_RESULT_LIMIT,
  POST_RECOVERY_PROVENANCE,
  type PostRecoveryServiceDeps,
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

describe('boundedBatchArmError (#2856)', () => {
  it('passes short messages through unchanged (trimmed)', () => {
    expect(boundedBatchArmError('  ENOTDIR: not a directory  ')).toBe('ENOTDIR: not a directory');
  });

  it('keeps a message exactly at the limit intact, without an ellipsis', () => {
    const atLimit = 'x'.repeat(POST_RECOVERY_BATCH_ARM_ERROR_MAX);
    const bounded = boundedBatchArmError(atLimit);
    expect(bounded).toBe(atLimit);
    expect(bounded.length).toBe(POST_RECOVERY_BATCH_ARM_ERROR_MAX);
    expect(bounded.endsWith('…')).toBe(false);
  });

  it('truncates an over-limit message to the bound plus a single ellipsis', () => {
    const longError = 'y'.repeat(POST_RECOVERY_BATCH_ARM_ERROR_MAX + 500);
    const bounded = boundedBatchArmError(longError);
    // slice(0, MAX) + '…' → MAX + 1 UTF-16 code units (U+2026 is one code unit).
    expect(bounded.length).toBe(POST_RECOVERY_BATCH_ARM_ERROR_MAX + 1);
    expect(bounded.endsWith('…')).toBe(true);
    expect(bounded.slice(0, POST_RECOVERY_BATCH_ARM_ERROR_MAX)).toBe(
      'y'.repeat(POST_RECOVERY_BATCH_ARM_ERROR_MAX),
    );
  });
});

describe('PostRecoveryService', () => {
  let tempDir: string;
  let nowMs: number;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'kookr-post-recovery-'));
    nowMs = Date.parse('2026-08-10T15:00:00.000Z');
    prepareLaunchControl.beforeResolve = undefined;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function productSchedule(repo = 'jeanibarz/lucy', id = 'batch'): Schedule {
    return schedule({
      id,
      name: `${repo} batch`,
      enabled: true,
      playbook: {
        path: 'parallel-issue-batch.md',
        parameters: { repoFullName: repo, localPath: `/checkout/${id}` },
      },
    });
  }

  function healthService(options: {
    schedules?: Schedule[];
    launcher?: PostRecoveryServiceDeps['launcher'];
    getCapacityLedger?: PostRecoveryServiceDeps['getCapacityLedger'];
    accepting?: boolean;
    automationEnabled?: boolean;
    stateKey?: string;
    tasks?: Task[];
  } = {}): PostRecoveryService {
    const stateKey = options.stateKey ?? 'health';
    return new PostRecoveryService({
      listSchedules: () => options.schedules ?? [],
      setEnabled: vi.fn(),
      taskStore: makeTaskStore(options.tasks),
      getCapacityLedger: options.getCapacityLedger ?? (() => makeLedger()),
      launcher: options.launcher ?? vi.fn(),
      isDispatchHealthy: () => true,
      isAccepting: () => options.accepting ?? true,
      isAutomationEnabled: () => options.automationEnabled ?? true,
      kookrDir: tempDir,
      kickStateDir: join(tempDir, `kick-${stateKey}`),
      starvationStateDir: join(tempDir, `starvation-${stateKey}`),
      now: () => nowMs,
      log: () => {},
    });
  }

  describe('queue-fill health snapshot (issue #2895)', () => {
    it('starts with an explicit bounded not_started snapshot', () => {
      const service = healthService();

      expect(service.getQueueFillHealthSnapshot()).toEqual({
        schemaVersion: 'post-recovery-queue-fill.v1',
        state: 'not_started',
        evaluatedAt: null,
        ageMs: null,
        reason: null,
        resultLimit: POST_RECOVERY_QUEUE_FILL_HEALTH_RESULT_LIMIT,
        truncated: false,
        results: [],
      });
    });

    it('records stable whole-tick suppression reasons for drain and SAFE MODE', async () => {
      const drain = healthService({ accepting: false, stateKey: 'drain' });
      await drain.tick();
      expect(drain.getQueueFillHealthSnapshot()).toMatchObject({
        state: 'suppressed',
        reason: 'operator_drain',
        evaluatedAt: '2026-08-10T15:00:00.000Z',
        ageMs: 0,
        results: [],
      });

      const safeMode = healthService({ automationEnabled: false, stateKey: 'safe-mode' });
      await safeMode.tick();
      expect(safeMode.getQueueFillHealthSnapshot()).toMatchObject({
        state: 'suppressed',
        reason: 'safe_mode',
        evaluatedAt: '2026-08-10T15:00:00.000Z',
        ageMs: 0,
        results: [],
      });
    });

    it('distinguishes a completed evaluation with no repository candidates', async () => {
      const service = healthService();

      await service.tick();

      expect(service.getQueueFillHealthSnapshot()).toMatchObject({
        state: 'completed',
        reason: null,
        evaluatedAt: '2026-08-10T15:00:00.000Z',
        ageMs: 0,
        truncated: false,
        results: [],
      });
    });

    it('projects ordinary skips with stable per-repo reason and freshness fields', async () => {
      const service = healthService({
        schedules: [productSchedule()],
        getCapacityLedger: () => makeLedger({ free: 0, freeForGeneralSources: 0 }),
      });

      await service.tick();

      expect(service.getQueueFillHealthSnapshot().results).toEqual([
        {
          repository: 'jeanibarz/lucy',
          utcDay: '2026-08-10',
          kicked: false,
          reason: 'insufficient_free_slots',
          evaluatedAt: '2026-08-10T15:00:00.000Z',
          ageMs: 0,
        },
      ]);
    });

    it('projects a scout launch without claiming implementation-batch re-entry', async () => {
      const service = healthService({
        schedules: [productSchedule()],
        launcher: vi.fn(async () => ({
          task: { id: 'scout-health', status: 'running' } as Task,
          queued: false,
        })),
        stateKey: 'success',
      });

      await service.tick();

      expect(service.getQueueFillHealthSnapshot().results).toHaveLength(1);
      expect(service.getQueueFillHealthSnapshot().results[0]).toMatchObject({
        repository: 'jeanibarz/lucy',
        utcDay: '2026-08-10',
        kicked: true,
        reason: 'scout_launched',
        evaluatedAt: '2026-08-10T15:00:00.000Z',
        ageMs: 0,
        scoutTaskId: 'scout-health',
      });
    });

    it('retains the scout ID when the daily latch cannot be persisted after launch', async () => {
      const stateKey = 'persist-failure';
      await writeFile(join(tempDir, `kick-${stateKey}`), 'not a directory');
      const service = healthService({
        schedules: [productSchedule(), productSchedule('z/second', 'second')],
        launcher: vi.fn(async () => ({
          task: { id: 'scout-persist-failure', status: 'running' } as Task,
          queued: false,
        })),
        getCapacityLedger: () => makeLedger({
          free: POST_RECOVERY_MIN_FREE_SLOTS,
          freeForGeneralSources: POST_RECOVERY_MIN_FREE_SLOTS,
        }),
        stateKey,
      });

      await service.tick();

      expect(service.getQueueFillHealthSnapshot().results[0]).toMatchObject({
        repository: 'jeanibarz/lucy',
        kicked: true,
        reason: 'scout_launched_latch_persist_failed',
        scoutTaskId: 'scout-persist-failure',
      });
      expect(service.getQueueFillHealthSnapshot().results[1]).toMatchObject({
        repository: 'z/second',
        kicked: false,
        reason: 'insufficient_free_slots',
      });
      expect(service.getQueueFillHealthSnapshot().results).toHaveLength(2);
    });

    it('maps terminated-at-launch and exhausted retries to stable public reasons', async () => {
      const terminated = healthService({
        schedules: [productSchedule()],
        launcher: vi.fn(async () => ({
          task: {
            id: 'scout-terminated',
            status: 'terminated',
            disposition: {
              reason: 'launch_error',
              at: '2026-08-10T15:00:00.000Z',
              source: 'launch-service',
              detail: 'private provider detail',
            },
          } as Task,
          queued: false,
        })),
        stateKey: 'terminated',
      });
      await terminated.tick();
      expect(terminated.getQueueFillHealthSnapshot().results[0]).toMatchObject({
        kicked: false,
        reason: 'scout_terminated_at_launch',
        scoutTaskId: 'scout-terminated',
      });

      const failedScouts = Array.from({ length: 3 }, (_, index) => ({
        id: `failed-scout-${index}`,
        status: 'terminated',
        playbookId: 'repository-idea-scout.md',
        projectId: 'github.com/jeanibarz/lucy',
        playbookParameterValues: { repoFullName: 'jeanibarz/lucy' },
        name: 'Idea scout: jeanibarz/lucy',
        prompt: 'repository idea scout for jeanibarz/lucy',
        createdAt: new Date('2026-08-10T12:00:00.000Z'),
        disposition: {
          reason: 'launch_error',
          at: '2026-08-10T12:00:00.000Z',
          source: 'launch-service',
        },
      })) as unknown as Task[];
      const exhausted = healthService({
        schedules: [productSchedule()],
        tasks: failedScouts,
        stateKey: 'exhausted',
      });
      await exhausted.tick();
      expect(exhausted.getQueueFillHealthSnapshot().results[0]).toMatchObject({
        kicked: false,
        reason: 'launch_error_retry_exhausted',
      });
    });

    it('redacts raw launch exceptions and local paths behind a stable failure code', async () => {
      const service = healthService({
        schedules: [productSchedule()],
        launcher: vi.fn(async () => {
          throw new Error('spawn failed at /private/operator/checkout');
        }),
        stateKey: 'launch-error',
      });

      await service.tick();

      const snapshot = service.getQueueFillHealthSnapshot();
      expect(snapshot.results[0]).toMatchObject({
        repository: 'jeanibarz/lucy',
        kicked: false,
        reason: 'scout_launch_failed',
      });
      expect(JSON.stringify(snapshot)).not.toContain('/private/operator');
      expect(JSON.stringify(snapshot)).not.toContain('spawn failed');
    });

    it('replaces prior rows, reports freshness, and caps the latest evaluation', async () => {
      const schedules = [productSchedule('z/first', 'first')];
      const service = healthService({
        schedules,
        getCapacityLedger: () => makeLedger({ free: 0, freeForGeneralSources: 0 }),
        stateKey: 'replacement',
      });
      await service.tick();

      nowMs += 5_000;
      schedules.splice(
        0,
        schedules.length,
        ...Array.from(
          { length: POST_RECOVERY_QUEUE_FILL_HEALTH_RESULT_LIMIT + 2 },
          (_, index) => productSchedule(`owner/repo-${String(index).padStart(2, '0')}`, `repo-${index}`),
        ),
      );
      await service.tick();

      nowMs += 2_000;
      const snapshot = service.getQueueFillHealthSnapshot();
      expect(snapshot.results).toHaveLength(POST_RECOVERY_QUEUE_FILL_HEALTH_RESULT_LIMIT);
      expect(snapshot.truncated).toBe(true);
      expect(snapshot.ageMs).toBe(2_000);
      expect(snapshot.results.every((row) => row.ageMs === 2_000)).toBe(true);
      expect(snapshot.results.some((row) => row.repository === 'z/first')).toBe(false);
    });

    it('records overlap suppression and a stable whole-tick error without exception detail', async () => {
      let releaseEnable!: () => void;
      const enableGate = new Promise<void>((resolve) => { releaseEnable = resolve; });
      let enableStarted!: () => void;
      const enableStartedGate = new Promise<void>((resolve) => { enableStarted = resolve; });
      const overlapping = new PostRecoveryService({
        listSchedules: () => [schedule({
          id: 'critical',
          name: 'Lucy Orchestration Effectiveness',
          enabled: false,
          playbook: { path: 'lucy-orchestration-effectiveness.md', parameters: {} },
        })],
        setEnabled: async () => {
          enableStarted();
          await enableGate;
        },
        taskStore: makeTaskStore(),
        getCapacityLedger: () => makeLedger(),
        launcher: vi.fn(),
        now: () => nowMs,
      });
      const firstTick = overlapping.tick();
      await enableStartedGate;
      await overlapping.tick();
      expect(overlapping.getQueueFillHealthSnapshot()).toMatchObject({
        state: 'suppressed',
        reason: 'tick_overlap',
      });
      releaseEnable();
      await firstTick;

      const failing = healthService({
        getCapacityLedger: () => {
          throw new Error('secret store failure at /private/path');
        },
        stateKey: 'tick-error',
      });
      await failing.tick();
      const failedSnapshot = failing.getQueueFillHealthSnapshot();
      expect(failedSnapshot).toMatchObject({
        state: 'error',
        reason: 'tick_error',
        results: [],
      });
      expect(JSON.stringify(failedSnapshot)).not.toContain('/private/path');
    });
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

  it('R10.7: re-reads each retry immediately before enabling it', async () => {
    const schedules = [
      schedule({
        id: 'a',
        name: 'Lucy Orchestration Effectiveness A',
        enabled: false,
        playbook: { path: 'lucy-orchestration-effectiveness.md', parameters: {} },
      }),
      schedule({
        id: 'b',
        name: 'Lucy Orchestration Effectiveness B',
        enabled: false,
        playbook: { path: 'lucy-orchestration-effectiveness.md', parameters: {} },
      }),
    ];
    const attempts = new Map<string, number>();
    let releaseRetryA!: () => void;
    let markRetryAStarted!: () => void;
    const retryAStarted = new Promise<void>((resolve) => {
      markRetryAStarted = resolve;
    });
    const setEnabled = vi.fn(async (id: string) => {
      const attempt = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, attempt);
      const current = schedules.find((candidate) => candidate.id === id)!;
      current.enabled = true;
      if (attempt === 1) {
        throw new Error('transient disk rejection');
      }
      if (id === 'a') {
        markRetryAStarted();
        await new Promise<void>((resolve) => {
          releaseRetryA = resolve;
        });
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
    });

    await service.tick();
    nowMs += 60_000;
    const retryTick = service.tick();
    await retryAStarted;
    schedules[1]!.enabled = false;
    schedules[1]!.operatorHold = true;
    schedules[1]!.holdSource = 'operator';
    releaseRetryA();
    const result = await retryTick;

    expect(result.rearm.rearmed).toEqual([
      { id: 'a', name: 'Lucy Orchestration Effectiveness A' },
    ]);
    expect(result.rearm.skipped).toEqual([
      {
        id: 'b',
        name: 'Lucy Orchestration Effectiveness B',
        reason: 'retry_cancelled:operator_hold',
      },
    ]);
    expect(setEnabled.mock.calls.filter(([id]) => id === 'b')).toHaveLength(1);
  });

  it('R10.7: measures retry delay from when a failed enable settles', async () => {
    const schedules = [
      schedule({
        id: 'retry',
        name: 'Lucy Orchestration Effectiveness',
        enabled: false,
        playbook: { path: 'lucy-orchestration-effectiveness.md', parameters: {} },
      }),
    ];
    let rejectFirstAttempt!: () => void;
    let markFirstAttemptStarted!: () => void;
    const firstAttemptStarted = new Promise<void>((resolve) => {
      markFirstAttemptStarted = resolve;
    });
    const setEnabled = vi.fn(async () => {
      if (setEnabled.mock.calls.length === 1) {
        markFirstAttemptStarted();
        await new Promise<void>((_resolve, reject) => {
          rejectFirstAttempt = () => reject(new Error('slow disk rejection'));
        });
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
    });

    const firstTick = service.tick();
    await firstAttemptStarted;
    nowMs += 59_000;
    rejectFirstAttempt();
    await firstTick;

    nowMs += 1_000;
    await service.tick();
    expect(setEnabled).toHaveBeenCalledOnce();

    nowMs += 59_000;
    await service.tick();
    expect(setEnabled).toHaveBeenCalledTimes(2);
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
      // Recovery scouts carry the first-class autonomous source (issue #2899).
      expect(opts.launchSource).toBe('post-recovery');
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
        batchArmStatus: 'armed',
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
    // Ordinary launch audit carries the armed status; no degraded row is written.
    const armedRow = JSON.parse(
      audit.trim().split('\n').find((l) => l.includes('post_recovery_queue_fill_kick'))!,
    ) as Record<string, unknown>;
    expect(armedRow.batchArmStatus).toBe('armed');
    expect(audit).not.toContain('post_recovery_batch_arm_failed');

    // The scout-complete batch arm was durably persisted (issue #2856).
    const { loadPipelineStarvationState } = await import('../core/pipeline-starvation-state.js');
    const starvation = await loadPipelineStarvationState('jeanibarz/lucy', {
      stateDir: starvationDir,
      nowMs,
    });
    expect(starvation.kickBatchWhenScoutCompletes).toBe(true);
    expect(starvation.lastStarvationScoutTaskId).toBe('scout-happy');

    const second = await service.runQueueFillKicks();
    expect(second[0]).toMatchObject({
      repo: 'jeanibarz/lucy',
      kicked: false,
      reason: 'already_kicked_utc_day',
      utcDay: '2026-08-10',
    });
    expect(launcher).toHaveBeenCalledOnce(); // still one
  });

  it('TS-LAUNCH-POST-RECOVERY-004: SAFE MODE engaged during preparation rejects at the launch boundary (issue #2899)', async () => {
    // The tick's entry SAFE MODE check (post-recovery-service.ts) passes while
    // automation is enabled; the kill-switch then engages during asynchronous
    // playbook preparation. Because the recovery scout carries the first-class
    // `post-recovery` source, the launch service re-checks SAFE MODE at the
    // trusted launch boundary and rejects it — no task, no agent session.
    let automationEnabled = true;
    prepareLaunchControl.beforeResolve = () => {
      automationEnabled = false;
    };
    const taskStore = new TaskStore();
    const adapterLaunch = vi.fn(async () => 'must-not-launch');
    const adapter: AgentAdapter = {
      agentType: 'claude-code',
      launch: adapterLaunch,
      sendInput: vi.fn(),
      sendKeystroke: vi.fn(),
      stop: vi.fn(),
      captureDisplay: vi.fn(async () => ''),
      onEvent: vi.fn(),
      onRefreshNeeded: vi.fn(),
      injectHookEvent: vi.fn(),
      getEffectiveHookSettings: vi.fn(() => undefined),
    };
    const adapterRegistry = new AdapterRegistry();
    adapterRegistry.register(adapter);
    const launchDeps: LaunchServiceDeps = {
      taskStore,
      adapterRegistry,
      flushTasks: vi.fn(async () => {}),
      lifecycleDeps: {
        monitor: { registerAgent: vi.fn() },
        watchdog: { registerAgent: vi.fn() },
        hookWatcher: { isWatching: vi.fn(() => false), watch: vi.fn() },
        githubScanner: {
          scanTask: vi.fn(),
          isActive: vi.fn(() => false),
          processTaskPrompt: vi.fn(),
        },
        autoNameTask: vi.fn(),
      } as unknown as LaunchServiceDeps['lifecycleDeps'],
      isAutomationEnabled: () => automationEnabled,
    };
    const launcher = vi.fn((opts) => launchTask(launchDeps, opts));
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
      taskStore,
      getCapacityLedger: () => makeLedger({
        free: 7,
        freeForGeneralSources: 7,
        pendingQueueDepth: 0,
      }),
      launcher,
      isDispatchHealthy: () => true,
      isAutomationEnabled: () => automationEnabled,
      kookrDir: tempDir,
      kickStateDir: join(tempDir, 'kick-safe-mode-race'),
      starvationStateDir: join(tempDir, 'starvation-safe-mode-race'),
      now: () => nowMs,
      log: () => {},
    });

    const result = await service.tick();

    // The kill-switch flipped mid-preparation, so the tick's entry check could
    // not catch it — the launcher was still invoked once.
    expect(automationEnabled).toBe(false);
    expect(launcher).toHaveBeenCalledOnce();
    // ...and the launch boundary rejected the autonomous scout.
    expect(result.kicks).toHaveLength(1);
    expect(result.kicks[0]).toMatchObject({
      repo: 'jeanibarz/lucy',
      kicked: false,
    });
    expect(result.kicks[0]?.reason).toContain('SAFE MODE');
    expect(taskStore.listTasks()).toHaveLength(0);
    expect(adapterLaunch).not.toHaveBeenCalled();
  });

  it('degraded kick: batch-arm persistence failure reports failed + degraded audit while still consuming the day (#2856)', async () => {
    const launcher = vi.fn(async () => ({
      task: { id: 'scout-degraded', status: 'running' } as Task,
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
    const kickDir = join(tempDir, 'kick-degraded');
    // Force a deterministic arm-state persistence failure: point the starvation
    // state dir at a regular FILE, so loadPipelineStarvationState reads under a
    // file (ENOTDIR, not ENOENT) and throws. The scout still launches (mocked).
    const starvationPath = join(tempDir, 'starvation-degraded-file');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(starvationPath, 'not a directory');

    const service = new PostRecoveryService({
      listSchedules: () => schedules,
      setEnabled: vi.fn(),
      taskStore: makeTaskStore(),
      getCapacityLedger: () =>
        makeLedger({ free: 7, freeForGeneralSources: 7, pendingQueueDepth: 0 }),
      launcher,
      isDispatchHealthy: () => true,
      kookrDir: tempDir,
      kickStateDir: kickDir,
      starvationStateDir: starvationPath,
      now: () => nowMs,
      log: () => {},
    });

    const first = await service.runQueueFillKicks();
    // Scout stays kicked; batchArmStatus reports the degradation.
    expect(first).toEqual([
      {
        repo: 'jeanibarz/lucy',
        kicked: true,
        scoutTaskId: 'scout-degraded',
        utcDay: '2026-08-10',
        batchArmStatus: 'failed',
      },
    ]);
    expect(launcher).toHaveBeenCalledOnce();

    // The daily kick still persisted (day consumed) so no second scout launches.
    const stateRaw = await readFile(join(kickDir, 'jeanibarz-lucy.json'), 'utf-8');
    const state = JSON.parse(stateRaw) as { lastKickUtcDay: string; lastKickScoutTaskId: string };
    expect(state.lastKickUtcDay).toBe('2026-08-10');
    expect(state.lastKickScoutTaskId).toBe('scout-degraded');

    // Both the ordinary launch audit (retained) and the degraded audit exist.
    const audit = await readFile(join(tempDir, 'audit.jsonl'), 'utf-8');
    const rows = audit
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const launchRow = rows.find((r) => r.action === 'post_recovery_queue_fill_kick');
    const degradedRow = rows.find((r) => r.action === 'post_recovery_batch_arm_failed');
    expect(launchRow?.batchArmStatus).toBe('failed');
    expect(launchRow?.scoutTaskId).toBe('scout-degraded');
    expect(degradedRow).toBeDefined();
    expect(degradedRow?.scoutTaskId).toBe('scout-degraded');
    expect(degradedRow?.repo).toBe('jeanibarz/lucy');
    expect(degradedRow?.utcDay).toBe('2026-08-10');
    expect(typeof degradedRow?.error).toBe('string');
    expect((degradedRow?.error as string).length).toBeGreaterThan(0);
    // Error detail is bounded (POST_RECOVERY_BATCH_ARM_ERROR_MAX + ellipsis).
    expect((degradedRow?.error as string).length).toBeLessThanOrEqual(501);

    // The day is consumed: a second tick does not launch a second scout.
    const second = await service.runQueueFillKicks();
    expect(second[0]).toMatchObject({
      kicked: false,
      reason: 'already_kicked_utc_day',
    });
    expect(launcher).toHaveBeenCalledOnce();
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
