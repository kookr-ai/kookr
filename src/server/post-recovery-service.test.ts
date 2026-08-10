import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapacityLedger } from '../core/capacity-ledger.js';
import type { Schedule } from '../core/schedule.js';
import type { Task, TaskStore } from '../core/tasks.js';
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
