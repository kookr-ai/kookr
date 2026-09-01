import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CapacityLedger } from '../core/capacity-ledger.js';
import { loadPipelineStarvationState } from '../core/pipeline-starvation-state.js';
import type { Schedule } from '../core/schedule.js';
import { TaskStore, type Task } from '../core/tasks.js';
import type { LaunchOpts, LaunchResult } from '../shared/contracts/launch.js';
import { PipelineStarvationService } from './pipeline-starvation-service.js';
import { PostRecoveryService } from './post-recovery-service.js';

const NOW = Date.parse('2026-08-10T15:00:00.000Z');
const REPO = 'kookr-ai/kookr';

function capacityLedger(): CapacityLedger {
  return {
    maxActive: 8,
    active: 2,
    free: 6,
    freeForGeneralSources: 6,
    pendingQueueDepth: 0,
    byClass: { working: 2, finishedAwaitingAck: 0, hungSuspect: 0, launching: 0 },
    reservedActiveSlots: 0,
  } as CapacityLedger;
}

describe('post-recovery scout to pipeline-starvation batch handoff integration (#2922)', () => {
  let tempDir: string;
  let previousBatchKick: string | undefined;
  let previousPluginDir: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'kookr-recovery-batch-handoff-'));
    previousBatchKick = process.env.KOOKR_PIPELINE_BATCH_KICK;
    previousPluginDir = process.env.KOOKR_PLUGIN_DIR;
    process.env.KOOKR_PIPELINE_BATCH_KICK = '1';
    process.env.KOOKR_PLUGIN_DIR = join(process.cwd(), 'plugin');
  });

  afterEach(async () => {
    if (previousBatchKick === undefined) delete process.env.KOOKR_PIPELINE_BATCH_KICK;
    else process.env.KOOKR_PIPELINE_BATCH_KICK = previousBatchKick;

    if (previousPluginDir === undefined) delete process.env.KOOKR_PLUGIN_DIR;
    else process.env.KOOKR_PLUGIN_DIR = previousPluginDir;

    await rm(tempDir, { recursive: true, force: true });
  });

  it('launches one batch from the durable arm and ignores terminal-event replay', async () => {
    const checkout = join(tempDir, 'checkout');
    const kickStateDir = join(tempDir, 'post-recovery-state');
    const starvationStateDir = join(tempDir, 'starvation-state');
    await mkdir(checkout);

    const taskStore = new TaskStore();
    const launches: LaunchOpts[] = [];
    const launcher = async (opts: LaunchOpts): Promise<LaunchResult<Task>> => {
      launches.push(opts);
      const task = taskStore.createTask({
        prompt: opts.prompt,
        cwd: opts.cwd,
        criteria: opts.criteria,
        parentTaskId: opts.parentTaskId,
        name: opts.name,
        playbookId: opts.playbookId,
        playbookParameterValues: opts.playbookParameterValues,
        projectId: opts.projectId,
        launchSource: opts.launchSource,
        autoCloseOnSignal: opts.autoCloseOnSignal,
      });
      return { task, queued: false, idempotentReplay: false };
    };
    const schedules: Schedule[] = [{
      id: 'batch',
      name: 'Kookr parallel issue batch',
      enabled: true,
      cron: '0 * * * *',
      cwd: checkout,
      playbook: {
        path: 'parallel-issue-batch.md',
        parameters: { repoFullName: REPO, localPath: checkout },
      },
      executionLedger: [],
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    }];

    const postRecovery = new PostRecoveryService({
      listSchedules: () => schedules,
      setEnabled: () => undefined,
      taskStore,
      getCapacityLedger: capacityLedger,
      launcher,
      isDispatchHealthy: () => true,
      kookrDir: tempDir,
      kickStateDir,
      starvationStateDir,
      now: () => NOW,
    });

    const recoveryKick = await postRecovery.runQueueFillKicks();
    expect(recoveryKick).toEqual([{
      repo: REPO,
      kicked: true,
      scoutTaskId: expect.any(String),
      utcDay: '2026-08-10',
    }]);

    const scoutTaskId = recoveryKick[0]!.scoutTaskId!;
    const scoutLaunches = launches.filter((launch) =>
      launch.playbookId?.includes('repository-idea-scout'));
    expect(scoutLaunches).toHaveLength(1);
    expect(taskStore.getTask(scoutTaskId)).toMatchObject({
      id: scoutTaskId,
      playbookId: expect.stringContaining('repository-idea-scout'),
      playbookParameterValues: { repoFullName: REPO, localPath: checkout },
    });

    const armed = await loadPipelineStarvationState(REPO, {
      stateDir: starvationStateDir,
      nowMs: NOW,
    });
    expect(armed).toMatchObject({
      repo: REPO,
      lastStarvationScoutTaskId: scoutTaskId,
      kickBatchWhenScoutCompletes: true,
      kickBatchWhenScoutCompletesAt: new Date(NOW).toISOString(),
    });

    taskStore.startTask(scoutTaskId);
    taskStore.completeTask(scoutTaskId);

    const pipelineStarvation = new PipelineStarvationService({
      taskStore,
      launcher,
      broadcast: () => undefined,
      kookrDir: tempDir,
      stateDir: starvationStateDir,
      now: () => NOW,
    });
    const batchKick = await pipelineStarvation.maybeKickBatchOnScoutTerminal(
      scoutTaskId,
      { kind: 'completed' },
    );

    expect(batchKick?.result).toBe('batch_kicked');
    const batchLaunches = launches.filter((launch) =>
      launch.playbookId?.includes('parallel-issue-batch'));
    expect(batchLaunches).toHaveLength(1);
    expect(batchLaunches[0]).toMatchObject({
      parentTaskId: scoutTaskId,
      playbookParameterValues: expect.objectContaining({ repoFullName: REPO }),
      idempotencyKey: 'starvation-batch-kick:kookr-ai-kookr:992430',
    });

    const consumed = await loadPipelineStarvationState(REPO, {
      stateDir: starvationStateDir,
      nowMs: NOW,
    });
    expect(consumed.kickBatchWhenScoutCompletes).toBeUndefined();
    expect(consumed.kickBatchWhenScoutCompletesAt).toBeUndefined();
    expect(consumed.lastBatchKickAt).toBe(new Date(NOW).toISOString());

    await pipelineStarvation.maybeKickBatchOnScoutTerminal(
      scoutTaskId,
      { kind: 'completed' },
    );
    expect(launches.filter((launch) =>
      launch.playbookId?.includes('parallel-issue-batch'))).toHaveLength(1);
  });
});
