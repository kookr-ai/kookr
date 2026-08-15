import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScheduleStore, MAX_LEDGER_ENTRIES } from '../core/schedule.js';
import { TaskStore } from '../core/tasks.js';
import {
  deriveLedgerEnrichment,
  isRestartInterruptedReason,
  nextConsecutiveFailures,
  shouldAutoPauseForConsecutiveFailures,
  ScheduleService,
  type ScheduleLedgerEnrichment,
} from './schedule-service.js';
import { ScheduleValidator } from './schedule-validator.js';
import type { ServerMessage } from '../shared/contracts/messages.js';

function withService(testFn: (service: ScheduleService, store: ScheduleStore, dir: string) => void | Promise<void>): Promise<void> | void {
  const dir = mkdtempSync(join(tmpdir(), 'schedule-service-test-'));
  const store = new ScheduleStore(dir);
  const service = new ScheduleService({ store, validator: new ScheduleValidator() });
  const result = testFn(service, store, dir);
  if (result && typeof result === 'object' && 'then' in result) {
    return result.finally(() => rmSync(dir, { recursive: true, force: true }));
  }
  rmSync(dir, { recursive: true, force: true });
}

function writePlaybook(cwd: string): void {
  mkdirSync(join(cwd, '.kookr', 'playbooks'), { recursive: true });
  writeFileSync(join(cwd, '.kookr', 'playbooks', 'daily.md'), `---
name: Daily
parameters: []
---
Do the work.
`);
}

describe('ScheduleService validation', () => {
  it('rejects cron expressions that fire more often than every five minutes on create', async () => {
    await withService(async (service, store, dir) => {
      writePlaybook(dir);

      await expect(service.createDefinition({
        name: 'Too fast',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: dir,
      })).rejects.toMatchObject({
        fieldErrors: {
          cron: 'Cron expression must not fire more often than every 5 minutes',
        },
      });

      expect(store.list()).toHaveLength(0);
    });
  });

  it('accepts the five-minute cron boundary on create', async () => {
    await withService(async (service, store, dir) => {
      writePlaybook(dir);

      await service.createDefinition({
        name: 'Every five',
        cron: '*/5 * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: dir,
      });

      expect(store.list()).toHaveLength(1);
    });
  });

  it('rejects impractical cron expressions on definition update', async () => {
    await withService(async (service, store, dir) => {
      writePlaybook(dir);
      const schedule = store.create({
        name: 'Hourly',
        cron: '0 * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: dir,
      });

      await expect(service.updateDefinition(schedule.id, { cron: '*/4 * * * *' })).rejects.toMatchObject({
        fieldErrors: {
          cron: 'Cron expression must not fire more often than every 5 minutes',
        },
      });

      expect(store.get(schedule.id)!.cron).toBe('0 * * * *');
    });
  });
});

describe('ScheduleService default agentType', () => {
  it('leaves agentType unset when create payload omits it (inherits at fire time)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'schedule-service-default-agent-'));
    try {
      writePlaybook(dir);
      const store = new ScheduleStore(dir);
      const service = new ScheduleService({
        store,
        validator: new ScheduleValidator(),
        getDefaultAgentType: () => 'grok-build',
      });

      const schedule = await service.createDefinition({
        name: 'Server default agent',
        cron: '0 * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: dir,
      });

      // No pin stored — schedule-runner resolves settings.defaultAgentType per fire.
      expect(schedule.agentType).toBeUndefined();
      expect(store.get(schedule.id)!.agentType).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps an explicit agentType pin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'schedule-service-explicit-agent-'));
    try {
      writePlaybook(dir);
      const store = new ScheduleStore(dir);
      const service = new ScheduleService({
        store,
        validator: new ScheduleValidator(),
        getDefaultAgentType: () => 'grok-build',
      });

      const schedule = await service.createDefinition({
        name: 'Explicit agent',
        cron: '0 * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: dir,
        agentType: 'codex-cli',
      });

      expect(schedule.agentType).toBe('codex-cli');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clears a pin via agentType null so the schedule inherits again', async () => {
    await withService(async (service, store, dir) => {
      writePlaybook(dir);

      const schedule = await service.createDefinition({
        name: 'Clearable pin',
        cron: '0 * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: dir,
        agentType: 'codex-cli',
      });
      expect(schedule.agentType).toBe('codex-cli');

      const cleared = await service.updateDefinition(schedule.id, { agentType: null });
      expect(cleared.agentType).toBeUndefined();
      expect(store.get(schedule.id)!.agentType).toBeUndefined();
    });
  });
});

describe('ScheduleService status', () => {
  it('reports healthy after runner start before the first completed tick', () => {
    withService((service) => {
      service.recordRunnerStarted('auto');

      const snapshot = service.getStatusSnapshot();
      expect(snapshot).toEqual(expect.objectContaining({
        runnerStartedAt: expect.any(String),
        schedulerHealthy: true,
        catchUpMode: 'auto',
        catchUpEnabled: true,
      }));
      expect(snapshot).not.toHaveProperty('lastTickCompletedAt');
    });
  });

  it('reports unhealthy while a schedule file load error is present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'schedule-service-test-'));
    try {
      writeFileSync(join(dir, 'schedules.json'), '{');
      const store = new ScheduleStore(dir);
      const service = new ScheduleService({ store, validator: new ScheduleValidator() });

      await store.load();

      expect(service.getStatusSnapshot()).toEqual(expect.objectContaining({
        schedulerHealthy: false,
        loadError: expect.stringContaining('Failed to load schedules'),
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports unhealthy while a runner error is present and clears it on a successful tick', () => {
    withService((service) => {
      service.recordRunnerStarted('auto');
      service.recordRunnerError('[schedule] Tick error: boom');

      expect(service.getStatusSnapshot()).toEqual(expect.objectContaining({
        schedulerHealthy: false,
        lastError: '[schedule] Tick error: boom',
      }));

      service.recordTickCompleted();

      const snapshot = service.getStatusSnapshot();
      expect(snapshot).toEqual(expect.objectContaining({
        schedulerHealthy: true,
        lastTickCompletedAt: expect.any(String),
      }));
      expect(snapshot).not.toHaveProperty('lastError');
    });
  });

  it('updates the execution ledger when a scheduled task reaches a terminal state', async () => {
    await withService(async (service, store) => {
      const schedule = store.create({
        name: 'Terminal',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });
      const receipt = await service.reserveExecution(schedule, 'cron', '2026-01-01T09:00:00.000Z');
      await service.markExecutionAccepted(schedule.id, receipt.id, 'task-1', false);

      await service.recordTaskTerminalOutcome('task-1', 'completed');

      expect(store.get(schedule.id)!.executionLedger).toEqual([
        expect.objectContaining({
          taskId: 'task-1',
          outcome: 'completed',
          reasonCode: 'none',
          completedAt: expect.any(String),
        }),
      ]);
    });
  });

  // issue #1582: cost/artifacts are joined onto the ledger row at write time.
  describe('ledger cost/artifact enrichment on completion (#1582)', () => {
    function withEnrichedService(
      resolveLedgerEnrichment: (taskId: string) => ScheduleLedgerEnrichment | undefined,
      testFn: (service: ScheduleService, store: ScheduleStore) => Promise<void>,
    ): Promise<void> {
      const dir = mkdtempSync(join(tmpdir(), 'schedule-service-enrich-'));
      const store = new ScheduleStore(dir);
      const service = new ScheduleService({ store, validator: new ScheduleValidator(), resolveLedgerEnrichment });
      return testFn(service, store).finally(() => rmSync(dir, { recursive: true, force: true }));
    }

    it('joins cost + artifact links onto the completed row', async () => {
      const enrichment: ScheduleLedgerEnrichment = {
        tokenUsage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.5 },
        artifacts: ['https://github.com/kookr-ai/kookr/pull/42'],
      };
      await withEnrichedService((taskId) => (taskId === 'task-1' ? enrichment : undefined), async (service, store) => {
        const schedule = store.create({ name: 'Enriched', cron: '* * * * *', playbook: { path: 'daily.md', parameters: {} }, cwd: '/tmp' });
        const receipt = await service.reserveExecution(schedule, 'cron', '2026-01-01T09:00:00.000Z');
        await service.markExecutionAccepted(schedule.id, receipt.id, 'task-1', false);

        await service.recordTaskTerminalOutcome('task-1', 'completed');

        const row = store.get(schedule.id)!.executionLedger[0];
        expect(row.outcome).toBe('completed');
        expect(row.tokenUsage).toEqual(enrichment.tokenUsage);
        expect(row.artifacts).toEqual(['https://github.com/kookr-ai/kookr/pull/42']);

        // AC #1: the enriched row is exposed through the schedule API response.
        const apiRow = service.listResponse().schedules[0].executionLedger[0];
        expect(apiRow.tokenUsage).toEqual(enrichment.tokenUsage);
        expect(apiRow.artifacts).toEqual(['https://github.com/kookr-ai/kookr/pull/42']);
      });
    });

    // Invariant: a task with tokenUsage=null writes a clean row with NO cost
    // field — never a fabricated zero presented as measured cost.
    it('writes cleanly with no cost field when the task measured no usage', async () => {
      await withEnrichedService(() => ({}), async (service, store) => {
        const schedule = store.create({ name: 'NullUsage', cron: '* * * * *', playbook: { path: 'daily.md', parameters: {} }, cwd: '/tmp' });
        const receipt = await service.reserveExecution(schedule, 'cron', '2026-01-01T09:00:00.000Z');
        await service.markExecutionAccepted(schedule.id, receipt.id, 'task-2', false);

        await service.recordTaskTerminalOutcome('task-2', 'completed');

        const row = store.get(schedule.id)!.executionLedger[0];
        expect(row.outcome).toBe('completed');
        expect(row).not.toHaveProperty('tokenUsage');
        expect(row).not.toHaveProperty('artifacts');
      });
    });

    it('writes cleanly with no cost field when no resolver is wired at all', async () => {
      await withService(async (service, store) => {
        const schedule = store.create({ name: 'NoResolver', cron: '* * * * *', playbook: { path: 'daily.md', parameters: {} }, cwd: '/tmp' });
        const receipt = await service.reserveExecution(schedule, 'cron', '2026-01-01T09:00:00.000Z');
        await service.markExecutionAccepted(schedule.id, receipt.id, 'task-3', false);

        await service.recordTaskTerminalOutcome('task-3', 'completed');

        const row = store.get(schedule.id)!.executionLedger[0];
        expect(row.outcome).toBe('completed');
        expect(row).not.toHaveProperty('tokenUsage');
        expect(row).not.toHaveProperty('artifacts');
      });
    });
  });

  describe('deriveLedgerEnrichment (#1582)', () => {
    it('returns an empty object for an absent task (no fabricated cost)', () => {
      expect(deriveLedgerEnrichment(undefined)).toEqual({});
    });

    it('omits tokenUsage when the task measured none', () => {
      expect(deriveLedgerEnrichment({ completionDigest: { prUrls: ['https://x/pr/1'] } })).toEqual({
        artifacts: ['https://x/pr/1'],
      });
    });

    it('joins tokenUsage and digest PR URLs, dropping empty strings', () => {
      expect(deriveLedgerEnrichment({
        tokenUsage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.1 },
        completionDigest: { prUrls: ['https://x/pr/1', ''] },
      })).toEqual({
        tokenUsage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.1 },
        artifacts: ['https://x/pr/1'],
      });
    });

    it('omits artifacts when the digest has no PR URLs', () => {
      expect(deriveLedgerEnrichment({ completionDigest: { prUrls: [] } })).toEqual({});
      expect(deriveLedgerEnrichment({ completionDigest: {} })).toEqual({});
    });

    it('joins the digest merge commit as the live-verification containment key (#1596)', () => {
      expect(deriveLedgerEnrichment({
        completionDigest: { prUrls: ['https://x/pr/1'], mergeCommit: 'a'.repeat(40) },
      })).toEqual({
        artifacts: ['https://x/pr/1'],
        mergeCommit: 'a'.repeat(40),
      });
    });

    it('omits mergeCommit when the digest has none or it is empty (#1596)', () => {
      expect(deriveLedgerEnrichment({ completionDigest: { prUrls: ['https://x/pr/1'] } }).mergeCommit).toBeUndefined();
      expect(deriveLedgerEnrichment({ completionDigest: { mergeCommit: '' } }).mergeCommit).toBeUndefined();
    });
  });

  it('records queued_capacity/capacity for a capacity-queued execution (issue #1526 Phase A)', async () => {
    await withService(async (service, store) => {
      const schedule = store.create({
        name: 'Capacity',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });
      const receipt = await service.reserveExecution(schedule, 'cron', '2026-01-01T09:00:00.000Z');
      await service.markExecutionAccepted(schedule.id, receipt.id, 'task-1', true);

      const updated = store.get(schedule.id)!;
      expect(updated.latestExecution).toEqual(expect.objectContaining({
        taskId: 'task-1',
        outcome: 'queued_capacity',
        reasonCode: 'capacity',
      }));
      expect(updated.executionLedger).toEqual([
        expect.objectContaining({
          taskId: 'task-1',
          outcome: 'queued_capacity',
          reasonCode: 'capacity',
        }),
      ]);
    });
  });

  it('records deferred catch-up without leaving the stale due slot replayable', async () => {
    await withService(async (service, store) => {
      const schedule = store.create({
        name: 'Deferred',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });
      const dueAt = new Date(Date.now() - 2 * 60_000).toISOString();

      await service.recordCatchUpDeferred(schedule.id, dueAt, 'Run manually');

      const updated = store.getWithComputed(schedule.id)!;
      expect(updated.latestExecution).toEqual(expect.objectContaining({
        scheduledFor: dueAt,
        outcome: 'skipped_manual',
        reasonCode: 'manual_catch_up_required',
      }));
      expect(updated.executionLedger).toEqual([
        expect.objectContaining({
          decision: 'manual_catch_up',
          outcome: 'skipped_manual',
          reasonCode: 'manual_catch_up_required',
          scheduledFor: dueAt,
        }),
      ]);
      expect(new Date(updated.lastScheduledFor!).getTime()).toBeGreaterThan(new Date(dueAt).getTime());
      expect(new Date(updated.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    });
  });

  it('stamps launch phase timings onto a dispatch_failed ledger row (issue #1589)', async () => {
    await withService(async (service, store) => {
      const schedule = store.create({
        name: 'GrokSync',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });
      const receipt = await service.reserveExecution(schedule, 'cron', '2026-01-01T09:00:00.000Z');

      const launchPhaseTimings = {
        phases: [
          { phase: 'preflight' as const, durationMs: 12, completed: true },
          { phase: 'reserve' as const, durationMs: 1, completed: true },
          { phase: 'session-create' as const, durationMs: 180_000, completed: false },
        ],
        totalMs: 180_013,
        incompletePhase: 'session-create' as const,
      };

      await service.markExecutionOutcome(
        schedule.id,
        receipt.id,
        'dispatch_failed',
        'launch_error',
        'Agent launch timed out after 180s',
        { launchPhaseTimings },
      );

      const row = store.get(schedule.id)!.executionLedger[0];
      expect(row.outcome).toBe('dispatch_failed');
      expect(row.launchPhaseTimings).toEqual(launchPhaseTimings);
      // The diagnosis is now readable straight off the persisted API projection.
      const apiRow = service.listResponse().schedules[0].executionLedger[0];
      expect(apiRow.launchPhaseTimings?.incompletePhase).toBe('session-create');
    });
  });

  it('updates the execution ledger when startup reconciliation finds a completed task', async () => {
    await withService(async (service, store) => {
      const taskStore = new TaskStore();
      const task = taskStore.createTask('Run scheduled work', '/tmp');
      taskStore.startTask(task.id);
      const completedTask = taskStore.completeTask(task.id);
      const schedule = store.create({
        name: 'Reconcile',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });
      const receipt = await service.reserveExecution(schedule, 'cron', '2026-01-01T09:00:00.000Z');
      await service.markExecutionAccepted(schedule.id, receipt.id, task.id, false);

      await service.reconcileOnStartup(taskStore);

      expect(store.get(schedule.id)!.executionLedger).toEqual([
        expect.objectContaining({
          taskId: completedTask.id,
          outcome: 'completed',
          reasonCode: 'reconciled_after_restart',
          completedAt: completedTask.updatedAt.toISOString(),
        }),
      ]);
    });
  });

  it('startup reconciliation also picks up a queued_capacity execution (issue #1526 Phase A)', async () => {
    await withService(async (service, store) => {
      const taskStore = new TaskStore();
      const task = taskStore.createTask('Run scheduled work', '/tmp');
      taskStore.startTask(task.id);
      const completedTask = taskStore.completeTask(task.id);
      const schedule = store.create({
        name: 'ReconcileQueued',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });
      const receipt = await service.reserveExecution(schedule, 'cron', '2026-01-01T09:00:00.000Z');
      // queued=true — the fire was still pending (capacity-queued) at the time of restart.
      await service.markExecutionAccepted(schedule.id, receipt.id, task.id, true);

      await service.reconcileOnStartup(taskStore);

      expect(store.get(schedule.id)!.executionLedger).toEqual([
        expect.objectContaining({
          taskId: completedTask.id,
          outcome: 'completed',
          reasonCode: 'reconciled_after_restart',
        }),
      ]);
    });
  });

  it('startup reconciliation also picks up the LEGACY literal outcome "queued" from on-disk state (issue #1526 Phase A)', async () => {
    // This is the exact case the live drain will hit: on-disk schedule state
    // persisted BEFORE this change can have latestExecution.outcome === 'queued'
    // (no code path produces it anymore, but old rows on disk still have it).
    // Bypasses markExecutionAccepted entirely — seeds the store directly, the
    // way a pre-deploy tasks.json/schedules.json would already look.
    await withService(async (service, store) => {
      const taskStore = new TaskStore();
      const task = taskStore.createTask('Run scheduled work', '/tmp');
      taskStore.startTask(task.id);
      const completedTask = taskStore.completeTask(task.id);

      const schedule = store.create({
        name: 'LegacyQueued',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });
      const evaluatedAt = '2026-01-01T09:00:00.000Z';
      store.replace({
        ...schedule,
        latestExecution: {
          executionToken: 'legacy-token',
          evaluatedAt,
          triggeredAt: evaluatedAt,
          trigger: 'cron',
          taskId: task.id,
          outcome: 'queued',
          reasonCode: 'none',
        },
        executionLedger: [{
          id: 'legacy-ledger-entry',
          scheduleId: schedule.id,
          trigger: 'cron',
          decision: 'cron_due',
          evaluatedAt,
          taskId: task.id,
          outcome: 'queued',
          reasonCode: 'none',
        }],
      });

      await service.reconcileOnStartup(taskStore);

      expect(store.get(schedule.id)!.latestExecution).toEqual(expect.objectContaining({
        taskId: completedTask.id,
        outcome: 'completed',
        reasonCode: 'reconciled_after_restart',
      }));
      expect(store.get(schedule.id)!.executionLedger).toEqual([
        expect.objectContaining({
          taskId: completedTask.id,
          outcome: 'completed',
          reasonCode: 'reconciled_after_restart',
        }),
      ]);
    });
  });

  it('finalizes a wedged RESERVED receipt even when a PREVIOUS run left latestExecution.taskId (issue #1526 Phase C / #1528)', async () => {
    // The live #1528 shape: a schedule with a healthy prior run (latest
    // outcome 'completed', taskId set) reserved a new execution, then the
    // launch wedged and the process restarted. The old fallback
    // `currentExecution.taskId ?? latest?.taskId` borrowed the PREVIOUS
    // run's taskId, skipped the unknown_after_restart branch, and left the
    // receipt 'reserved' forever.
    await withService(async (service, store) => {
      const taskStore = new TaskStore();
      const oldTask = taskStore.createTask('Previous healthy run', '/tmp');
      taskStore.startTask(oldTask.id);
      taskStore.completeTask(oldTask.id);

      const schedule = store.create({
        name: 'WedgedReserved',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });
      // Healthy prior run: accepted then completed.
      const firstReceipt = await service.reserveExecution(schedule, 'cron', '2026-01-01T08:00:00.000Z');
      await service.markExecutionAccepted(schedule.id, firstReceipt.id, oldTask.id, false);
      await service.recordTaskTerminalOutcome(oldTask.id, 'completed');

      // New fire reserved, launch wedged, process died before accept/fail.
      const wedgedReceipt = await service.reserveExecution(store.get(schedule.id)!, 'cron', '2026-01-01T09:00:00.000Z');
      expect(store.get(schedule.id)!.currentExecution!.status).toBe('reserved');

      await service.reconcileOnStartup(taskStore);

      const after = store.get(schedule.id)!;
      // The dead receipt is finalized — no longer 'reserved'.
      expect(after.currentExecution!.id).toBe(wedgedReceipt.id);
      expect(after.currentExecution!.status).toBe('unknown_after_restart');
      // The PREVIOUS run's latestExecution is preserved, not clobbered.
      expect(after.latestExecution).toEqual(expect.objectContaining({
        taskId: oldTask.id,
        outcome: 'completed',
      }));
      // The wedged fire got its own terminal ledger row.
      expect(after.executionLedger).toEqual(expect.arrayContaining([
        expect.objectContaining({
          receiptId: wedgedReceipt.id,
          outcome: 'unknown_after_restart',
          reasonCode: 'unknown_after_restart',
        }),
      ]));
    });
  });

  it('an ACCEPTED receipt still reconciles through its task after restart (unchanged behavior)', async () => {
    await withService(async (service, store) => {
      const taskStore = new TaskStore();
      const task = taskStore.createTask('Accepted then restarted', '/tmp');
      taskStore.startTask(task.id);
      const completedTask = taskStore.completeTask(task.id);

      const schedule = store.create({
        name: 'AcceptedSurvives',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });
      const receipt = await service.reserveExecution(schedule, 'cron', '2026-01-01T09:00:00.000Z');
      await service.markExecutionAccepted(schedule.id, receipt.id, task.id, false);

      await service.reconcileOnStartup(taskStore);

      const after = store.get(schedule.id)!;
      expect(after.currentExecution!.status).toBe('terminal');
      expect(after.latestExecution).toEqual(expect.objectContaining({
        taskId: completedTask.id,
        outcome: 'completed',
        reasonCode: 'reconciled_after_restart',
      }));
    });
  });
});

describe('ScheduleService execution-ledger cap (issue #1392)', () => {
  const EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0);
  const stampFor = (seq: number) => new Date(EPOCH + seq * 60_000).toISOString();

  it('bounds the persisted ledger to the cap while retaining the most-recent fires', async () => {
    await withService(async (service, store) => {
      const created = store.create({
        name: 'Per-minute',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });

      // Seed a ledger already AT the cap directly (fast — no per-row persist),
      // then drive K real fires. Each fire's ledger append (and the prune it
      // triggers) happens in markExecutionOutcome → upsertLedgerEntry;
      // reserveExecution only sets currentExecution. The effect is identical to
      // recording cap+K outcomes, but without hundreds of file writes.
      const seeded = Array.from({ length: MAX_LEDGER_ENTRIES }, (_, i) => ({
        id: `${created.id}:cron:${stampFor(i)}`,
        scheduleId: created.id,
        trigger: 'cron' as const,
        decision: 'cron_due' as const,
        scheduledFor: stampFor(i),
        evaluatedAt: stampFor(i),
        completedAt: stampFor(i),
        outcome: 'skipped_stale' as const,
        reasonCode: 'stale' as const,
      }));
      store.replace({ ...store.get(created.id)!, executionLedger: seeded });

      const K = 5;
      for (let k = 0; k < K; k += 1) {
        const scheduledFor = stampFor(MAX_LEDGER_ENTRIES + k);
        const receipt = await service.reserveExecution(store.get(created.id)!, 'cron', scheduledFor);
        await service.markExecutionOutcome(created.id, receipt.id, 'skipped_stale', 'stale');
      }

      const ledger = store.get(created.id)!.executionLedger;
      // Bound holds after cap+K appends.
      expect(ledger).toHaveLength(MAX_LEDGER_ENTRIES);
      // Most-recent K fires all retained, newest last (chronological order).
      const kept = new Set(ledger.map((e) => e.scheduledFor));
      for (let k = 0; k < K; k += 1) {
        expect(kept.has(stampFor(MAX_LEDGER_ENTRIES + k))).toBe(true);
      }
      expect(ledger[ledger.length - 1].scheduledFor).toBe(stampFor(MAX_LEDGER_ENTRIES + K - 1));
      // The oldest K seeded fires were pruned to make room.
      for (let i = 0; i < K; i += 1) {
        expect(kept.has(stampFor(i))).toBe(false);
      }
      expect(ledger[0].scheduledFor).toBe(stampFor(K));
    });
  });

  it('never prunes a still-pending fire even when it falls outside the newest-N window', async () => {
    await withService(async (service, store) => {
      const created = store.create({
        name: 'Pending survives',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });

      // Oldest row is a live `running` fire a later reconcile keys off; the rest
      // fill the ledger to the cap. It sits outside the newest-N window, so pure
      // recency would drop it — it must survive.
      const pending = {
        id: `${created.id}:cron:${stampFor(0)}`,
        scheduleId: created.id,
        trigger: 'cron' as const,
        decision: 'cron_due' as const,
        scheduledFor: stampFor(0),
        evaluatedAt: stampFor(0),
        outcome: 'running' as const,
        taskId: 'task-live',
      };
      const seeded = [
        pending,
        ...Array.from({ length: MAX_LEDGER_ENTRIES - 1 }, (_, i) => ({
          id: `${created.id}:cron:${stampFor(i + 1)}`,
          scheduleId: created.id,
          trigger: 'cron' as const,
          decision: 'cron_due' as const,
          scheduledFor: stampFor(i + 1),
          evaluatedAt: stampFor(i + 1),
          completedAt: stampFor(i + 1),
          outcome: 'skipped_stale' as const,
          reasonCode: 'stale' as const,
        })),
      ];
      store.replace({ ...store.get(created.id)!, executionLedger: seeded });

      // One more fire pushes the ledger over the cap.
      const receipt = await service.reserveExecution(store.get(created.id)!, 'cron', stampFor(MAX_LEDGER_ENTRIES));
      await service.markExecutionOutcome(created.id, receipt.id, 'skipped_stale', 'stale');

      const ledger = store.get(created.id)!.executionLedger;
      // The retained pending row is kept ON TOP of the newest-N terminal window,
      // so a live receipt a reconcile depends on is never dropped — total is
      // cap + (pending retained) rather than a hard cap. Pending counts are
      // bounded in practice (at most one outstanding fire per schedule).
      expect(ledger).toHaveLength(MAX_LEDGER_ENTRIES + 1);
      const pendingRow = ledger.find((e) => e.taskId === 'task-live');
      expect(pendingRow).toMatchObject({ outcome: 'running', scheduledFor: stampFor(0) });
      // It leads the ledger (chronological order preserved).
      expect(ledger[0].taskId).toBe('task-live');
      // Exactly one row breached the newest-N window — the pending one.
      expect(ledger.filter((e) => e.outcome !== 'skipped_stale')).toHaveLength(1);
    });
  });

  it('re-prunes a formerly-pending row once it resolves to terminal, converging back to the cap', async () => {
    await withService(async (service, store) => {
      const created = store.create({
        name: 'Pending resolves',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });

      // Seed one over the cap: the oldest row is a live `running` fire (retained
      // beyond the cap because a reconcile keys off it), the rest terminal.
      const seeded = [
        {
          id: `${created.id}:cron:${stampFor(0)}`,
          scheduleId: created.id,
          trigger: 'cron' as const,
          decision: 'cron_due' as const,
          scheduledFor: stampFor(0),
          evaluatedAt: stampFor(0),
          outcome: 'running' as const,
          taskId: 'task-live',
        },
        ...Array.from({ length: MAX_LEDGER_ENTRIES }, (_, i) => ({
          id: `${created.id}:cron:${stampFor(i + 1)}`,
          scheduleId: created.id,
          trigger: 'cron' as const,
          decision: 'cron_due' as const,
          scheduledFor: stampFor(i + 1),
          evaluatedAt: stampFor(i + 1),
          completedAt: stampFor(i + 1),
          outcome: 'skipped_stale' as const,
          reasonCode: 'stale' as const,
        })),
      ];
      store.replace({
        ...store.get(created.id)!,
        latestExecution: {
          executionToken: 'tok-live',
          evaluatedAt: stampFor(0),
          trigger: 'cron',
          taskId: 'task-live',
          outcome: 'running',
        },
        executionLedger: seeded,
      });
      expect(store.get(created.id)!.executionLedger).toHaveLength(MAX_LEDGER_ENTRIES + 1);

      // The live task finishes: its ledger row resolves in place (no prune —
      // updateLedgerEntryForTask is length-invariant), so the ledger is briefly
      // still one over the cap, now with zero pending rows.
      await service.recordTaskTerminalOutcome('task-live', 'completed');
      const afterResolve = store.get(created.id)!.executionLedger;
      expect(afterResolve).toHaveLength(MAX_LEDGER_ENTRIES + 1);
      expect(afterResolve.find((e) => e.taskId === 'task-live')).toMatchObject({ outcome: 'completed' });

      // The next append prunes with no pending row to protect, so the ledger
      // converges back to exactly the cap and the formerly-pending row (oldest)
      // is dropped.
      const receipt = await service.reserveExecution(store.get(created.id)!, 'cron', stampFor(MAX_LEDGER_ENTRIES + 1));
      await service.markExecutionOutcome(created.id, receipt.id, 'skipped_stale', 'stale');

      const converged = store.get(created.id)!.executionLedger;
      expect(converged).toHaveLength(MAX_LEDGER_ENTRIES);
      expect(converged.some((e) => e.taskId === 'task-live')).toBe(false);
    });
  });
});

describe('nextConsecutiveFailures', () => {
  it('resets to 0 on a completed run', () => {
    expect(nextConsecutiveFailures(4, 'completed')).toBe(0);
    expect(nextConsecutiveFailures(undefined, 'completed')).toBe(0);
  });

  it('increments on a failed or cancelled run', () => {
    expect(nextConsecutiveFailures(undefined, 'failed')).toBe(1);
    expect(nextConsecutiveFailures(2, 'failed')).toBe(3);
    expect(nextConsecutiveFailures(0, 'cancelled')).toBe(1);
    expect(nextConsecutiveFailures(1, 'cancelled')).toBe(2);
  });
});

describe('shouldAutoPauseForConsecutiveFailures (issue #2353)', () => {
  it('pauses only when enabled and streak is at/over a positive threshold', () => {
    expect(shouldAutoPauseForConsecutiveFailures(3, 3, true)).toBe(true);
    expect(shouldAutoPauseForConsecutiveFailures(2, 3, true)).toBe(false);
    expect(shouldAutoPauseForConsecutiveFailures(5, 3, false)).toBe(false);
    expect(shouldAutoPauseForConsecutiveFailures(5, 0, true)).toBe(false);
    expect(shouldAutoPauseForConsecutiveFailures(5, -1, true)).toBe(false);
  });
});

describe('ScheduleService consecutive-failure alerting (issue #1665)', () => {
  function alertServiceHarness(threshold: number): {
    service: ScheduleService;
    store: ScheduleStore;
    dir: string;
    alerts: Array<Extract<ServerMessage, { type: 'alert' }>>;
    cleanup: () => void;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'schedule-service-alert-test-'));
    const store = new ScheduleStore(dir);
    const alerts: Array<Extract<ServerMessage, { type: 'alert' }>> = [];
    const service = new ScheduleService({
      store,
      validator: new ScheduleValidator(),
      emitAlert: (message) => alerts.push(message),
      getFailureAlertThreshold: () => threshold,
    });
    return { service, store, dir, alerts, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  async function failOnce(service: ScheduleService, store: ScheduleStore, scheduleId: string, scheduledFor: string): Promise<void> {
    const receipt = await service.reserveExecution(store.get(scheduleId)!, 'cron', scheduledFor);
    await service.markExecutionOutcome(scheduleId, receipt.id, 'dispatch_failed', 'launch_error', 'boom');
  }

  it('increments consecutiveFailures on failures and resets it on a completed run', async () => {
    const { service, store, cleanup } = alertServiceHarness(3);
    try {
      const schedule = store.create({
        name: 'FailingSchedule',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });

      await failOnce(service, store, schedule.id, '2026-01-01T09:00:00.000Z');
      expect(store.get(schedule.id)!.consecutiveFailures).toBe(1);
      await failOnce(service, store, schedule.id, '2026-01-01T09:05:00.000Z');
      expect(store.get(schedule.id)!.consecutiveFailures).toBe(2);

      // A completed run resets the streak. Drive it through the terminal path.
      const receipt = await service.reserveExecution(store.get(schedule.id)!, 'cron', '2026-01-01T09:10:00.000Z');
      await service.markExecutionAccepted(schedule.id, receipt.id, 'task-ok', false);
      await service.recordTaskTerminalOutcome('task-ok', 'completed');
      expect(store.get(schedule.id)!.consecutiveFailures).toBe(0);

      // The counter is surfaced on the API projection without hand-reading the store.
      expect(service.listResponse().schedules[0].consecutiveFailures).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('emits exactly one warning alert when the streak crosses the threshold', async () => {
    const { service, store, alerts, cleanup } = alertServiceHarness(2);
    try {
      const schedule = store.create({
        name: 'CrossingSchedule',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });

      await failOnce(service, store, schedule.id, '2026-01-01T09:00:00.000Z');
      expect(alerts).toHaveLength(0); // below threshold

      await failOnce(service, store, schedule.id, '2026-01-01T09:05:00.000Z');
      expect(alerts).toHaveLength(1); // crossed 2
      expect(alerts[0].severity).toBe('warning');
      expect(alerts[0].operationalAlert?.key).toBe(`schedule:failures:${schedule.id}`);
      expect(alerts[0].summary).toContain('CrossingSchedule');
      // The last error message is folded into the operator-facing details.
      expect(alerts[0].details).toContain('boom');

      // A third failure does NOT re-alert (edge-triggered, still firing).
      await failOnce(service, store, schedule.id, '2026-01-01T09:10:00.000Z');
      expect(alerts).toHaveLength(1);
      expect(store.get(schedule.id)!.consecutiveFailures).toBe(3);
    } finally {
      cleanup();
    }
  });

  it('emits an info recovery alert when a completed run clears a firing streak', async () => {
    const { service, store, alerts, cleanup } = alertServiceHarness(2);
    try {
      const schedule = store.create({
        name: 'RecoverySchedule',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });

      await failOnce(service, store, schedule.id, '2026-01-01T09:00:00.000Z');
      await failOnce(service, store, schedule.id, '2026-01-01T09:05:00.000Z');
      expect(alerts.filter((a) => a.operationalAlert?.state === 'fired')).toHaveLength(1);

      const receipt = await service.reserveExecution(store.get(schedule.id)!, 'cron', '2026-01-01T09:10:00.000Z');
      await service.markExecutionAccepted(schedule.id, receipt.id, 'task-ok', false);
      await service.recordTaskTerminalOutcome('task-ok', 'completed');

      const recovery = alerts.filter((a) => a.operationalAlert?.state === 'recovered');
      expect(recovery).toHaveLength(1);
      expect(recovery[0].severity).toBe('info');
    } finally {
      cleanup();
    }
  });

  it('treats benign skips as neutral — deferrals never trip the counter or alert', async () => {
    // Regression for the false-positive the correctness review caught: a healthy
    // schedule whose task outlives its cron interval records skipped_active /
    // skipped_coalesced every tick; those, an operator drain, and other benign
    // skips must NOT be counted as failures.
    for (const benign of ['skipped_active', 'skipped_coalesced', 'skipped_draining', 'skipped_server_restarting', 'skipped_safe_mode', 'skipped_manual', 'deduplicated'] as const) {
      const { service, store, alerts, cleanup } = alertServiceHarness(2);
      try {
        const schedule = store.create({
          name: `Benign-${benign}`,
          cron: '* * * * *',
          playbook: { path: 'daily.md', parameters: {} },
          cwd: '/tmp',
        });

        // Seed one real failure so we can prove the skip carries it forward, not resets it.
        await failOnce(service, store, schedule.id, '2026-01-01T09:00:00.000Z');
        expect(store.get(schedule.id)!.consecutiveFailures).toBe(1);

        // Two benign skips in a row must not climb past 1 nor cross the threshold.
        for (const at of ['2026-01-01T09:05:00.000Z', '2026-01-01T09:10:00.000Z']) {
          const r = await service.reserveExecution(store.get(schedule.id)!, 'cron', at);
          await service.markExecutionOutcome(schedule.id, r.id, benign, 'none');
        }
        expect(store.get(schedule.id)!.consecutiveFailures).toBe(1);
        expect(alerts).toHaveLength(0);
      } finally {
        cleanup();
      }
    }
  });

  it('counts a cancelled terminal run through recordTaskTerminalOutcome and can fire on it', async () => {
    const { service, store, alerts, cleanup } = alertServiceHarness(2);
    try {
      const schedule = store.create({
        name: 'CancelledSchedule',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });

      // A dispatch failure then a cancelled terminal run crosses the threshold of 2.
      await failOnce(service, store, schedule.id, '2026-01-01T09:00:00.000Z');
      expect(store.get(schedule.id)!.consecutiveFailures).toBe(1);

      const receipt = await service.reserveExecution(store.get(schedule.id)!, 'cron', '2026-01-01T09:05:00.000Z');
      await service.markExecutionAccepted(schedule.id, receipt.id, 'task-cancel', false);
      await service.recordTaskTerminalOutcome('task-cancel', 'cancelled');

      expect(store.get(schedule.id)!.consecutiveFailures).toBe(2);
      expect(alerts.filter((a) => a.operationalAlert?.state === 'fired')).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('reconcileOnStartup evaluates the alert edge on a reconciled crossing (no silent edge loss)', async () => {
    const { service, store, alerts, cleanup } = alertServiceHarness(2);
    try {
      const taskStore = new TaskStore();
      const task = taskStore.createTask('Run scheduled work', '/tmp');
      taskStore.startTask(task.id);
      taskStore.cancelTask(task.id);

      const schedule = store.create({
        name: 'ReconcileCrossing',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });
      // Seed: one prior failure (counter = 1, threshold - 1) plus a mid-flight
      // run pointing at the cancelled task.
      await failOnce(service, store, schedule.id, '2026-01-01T09:00:00.000Z');
      const receipt = await service.reserveExecution(store.get(schedule.id)!, 'cron', '2026-01-01T09:05:00.000Z');
      await service.markExecutionAccepted(schedule.id, receipt.id, task.id, false);
      expect(store.get(schedule.id)!.consecutiveFailures).toBe(1);
      const before = alerts.length;

      await service.reconcileOnStartup(taskStore);

      // The reconciled cancellation crosses the threshold and fires exactly once.
      expect(store.get(schedule.id)!.consecutiveFailures).toBe(2);
      expect(alerts.length - before).toBe(1);
      expect(alerts[alerts.length - 1].operationalAlert?.state).toBe('fired');
    } finally {
      cleanup();
    }
  });

  it('does not emit when no threshold getter/alert sink is wired', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'schedule-service-noalert-test-'));
    try {
      const store = new ScheduleStore(dir);
      // No emitAlert, default threshold (3).
      const service = new ScheduleService({ store, validator: new ScheduleValidator() });
      const schedule = store.create({
        name: 'NoSink',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });
      for (let i = 0; i < 5; i++) {
        const receipt = await service.reserveExecution(store.get(schedule.id)!, 'cron', `2026-01-01T0${i}:00:00.000Z`);
        await service.markExecutionOutcome(schedule.id, receipt.id, 'dispatch_failed', 'launch_error', 'boom');
      }
      // Counter still maintained even without an alert sink.
      expect(store.get(schedule.id)!.consecutiveFailures).toBe(5);
      // Auto-pause (issue #2353) still applies with the default threshold of 3.
      expect(store.get(schedule.id)!.enabled).toBe(false);
      expect(store.get(schedule.id)!.stopReason).toBe('consecutive_failures');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('auto-pauses the schedule when consecutiveFailures reaches the threshold (issue #2353)', async () => {
    const { service, store, alerts, cleanup } = alertServiceHarness(3);
    try {
      const schedule = store.create({
        name: 'AutoPauseSchedule',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });

      await failOnce(service, store, schedule.id, '2026-01-01T09:00:00.000Z');
      await failOnce(service, store, schedule.id, '2026-01-01T09:05:00.000Z');
      expect(store.get(schedule.id)!.enabled).toBe(true);
      expect(store.get(schedule.id)!.stopReason).toBeUndefined();

      await failOnce(service, store, schedule.id, '2026-01-01T09:10:00.000Z');
      const paused = store.get(schedule.id)!;
      expect(paused.enabled).toBe(false);
      expect(paused.stopReason).toBe('consecutive_failures');
      expect(paused.operatorHold).toBe(true);
      expect(paused.consecutiveFailures).toBe(3);

      const status = service.getStatusSnapshot();
      expect(status.schedulesPausedByFailure).toEqual([
        {
          id: schedule.id,
          name: 'AutoPauseSchedule',
          consecutiveFailures: 3,
        },
      ]);

      const fired = alerts.filter((a) => a.operationalAlert?.state === 'fired');
      expect(fired).toHaveLength(1);
      expect(fired[0].summary).toContain('auto-paused');
      expect(fired[0].details).toContain('stopReason=consecutive_failures');

      // Further failures while paused do not re-alert and do not re-enable.
      await failOnce(service, store, schedule.id, '2026-01-01T09:15:00.000Z');
      expect(alerts.filter((a) => a.operationalAlert?.state === 'fired')).toHaveLength(1);
      expect(store.get(schedule.id)!.enabled).toBe(false);
      expect(store.get(schedule.id)!.consecutiveFailures).toBe(4);
    } finally {
      cleanup();
    }
  });

  it('re-enable clears the consecutive-failure counter and stopReason (issue #2353)', async () => {
    const { service, store, cleanup } = alertServiceHarness(2);
    try {
      const schedule = store.create({
        name: 'ReenableSchedule',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });

      await failOnce(service, store, schedule.id, '2026-01-01T09:00:00.000Z');
      await failOnce(service, store, schedule.id, '2026-01-01T09:05:00.000Z');
      expect(store.get(schedule.id)!.enabled).toBe(false);
      expect(store.get(schedule.id)!.stopReason).toBe('consecutive_failures');
      expect(store.get(schedule.id)!.consecutiveFailures).toBe(2);

      const resumed = await service.setEnabled(schedule.id, true);
      expect(resumed.enabled).toBe(true);
      expect(resumed.stopReason).toBeUndefined();
      expect(resumed.consecutiveFailures).toBe(0);
      expect(resumed.operatorHold).toBeUndefined();
      expect(service.getStatusSnapshot().schedulesPausedByFailure).toBeUndefined();

      // A single new failure after re-enable starts the streak over (does not
      // immediately re-pause at the old counter).
      await failOnce(service, store, schedule.id, '2026-01-01T09:10:00.000Z');
      expect(store.get(schedule.id)!.enabled).toBe(true);
      expect(store.get(schedule.id)!.consecutiveFailures).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('persists consecutive_failures stopReason across store reload (issue #2353)', async () => {
    const { service, store, dir, cleanup } = alertServiceHarness(2);
    try {
      const schedule = store.create({
        name: 'PersistPause',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });
      await failOnce(service, store, schedule.id, '2026-01-01T09:00:00.000Z');
      await failOnce(service, store, schedule.id, '2026-01-01T09:05:00.000Z');
      await store.persist();

      const reloaded = new ScheduleStore(dir);
      await reloaded.load();
      const row = reloaded.get(schedule.id)!;
      expect(row.enabled).toBe(false);
      expect(row.stopReason).toBe('consecutive_failures');
      expect(row.consecutiveFailures).toBe(2);
      expect(row.operatorHold).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('enforceFailureAutoPauses parks schedules already over the threshold (issue #2353)', async () => {
    const { service, store, alerts, cleanup } = alertServiceHarness(3);
    try {
      const schedule = store.create({
        name: 'PreExistingThrash',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });
      // Simulate a pre-#2353 persisted streak that never auto-paused.
      store.replace({
        ...store.get(schedule.id)!,
        consecutiveFailures: 7,
        lastRunStatus: 'failed',
      });
      expect(store.get(schedule.id)!.enabled).toBe(true);

      const paused = await service.enforceFailureAutoPauses();
      expect(paused).toBe(1);
      expect(store.get(schedule.id)!.enabled).toBe(false);
      expect(store.get(schedule.id)!.stopReason).toBe('consecutive_failures');
      expect(store.get(schedule.id)!.operatorHold).toBe(true);
      expect(alerts.some((a) => a.summary.includes('auto-paused'))).toBe(true);

      // Idempotent: second enforce does nothing.
      expect(await service.enforceFailureAutoPauses()).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('reconcile maps terminated (timeout) tasks to cancelled so the streak increments (issue #2353)', async () => {
    const { service, store, cleanup } = alertServiceHarness(3);
    try {
      const taskStore = new TaskStore();
      const task = taskStore.createTask('Run scheduled work', '/tmp');
      taskStore.startTask(task.id);
      taskStore.terminateTask(task.id, { reason: 'timeout', detail: 'hung' });

      const schedule = store.create({
        name: 'TimeoutReconcile',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });
      const receipt = await service.reserveExecution(store.get(schedule.id)!, 'cron', '2026-01-01T09:00:00.000Z');
      await service.markExecutionAccepted(schedule.id, receipt.id, task.id, false);

      await service.reconcileOnStartup(taskStore);

      const after = store.get(schedule.id)!;
      expect(after.lastRunStatus).toBe('cancelled');
      expect(after.consecutiveFailures).toBe(1);
      expect(after.latestExecution?.outcome).toBe('cancelled');
    } finally {
      cleanup();
    }
  });
});

describe('ScheduleService overlap-skip vs consecutiveFailures (issue #2458)', () => {
  function overlapHarness(): {
    service: ScheduleService;
    store: ScheduleStore;
    cleanup: () => void;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'schedule-overlap-2458-'));
    const store = new ScheduleStore(dir);
    const service = new ScheduleService({
      store,
      validator: new ScheduleValidator(),
      getFailureAlertThreshold: () => 3,
    });
    return { service, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  async function overlapOnce(
    service: ScheduleService,
    store: ScheduleStore,
    scheduleId: string,
    scheduledFor: string,
  ): Promise<void> {
    const receipt = await service.reserveExecution(store.get(scheduleId)!, 'cron', scheduledFor);
    await service.markExecutionOutcome(
      scheduleId,
      receipt.id,
      'skipped_active',
      'previous_run_active',
      'Previous run still active',
      { blockingTaskId: 'task-still-running' },
    );
  }

  it('three consecutive "Previous run still active" outcomes leave enabled and do not increment', async () => {
    const { service, store, cleanup } = overlapHarness();
    try {
      const schedule = store.create({
        name: 'Lucy Orchestration Effectiveness',
        cron: '*/30 * * * *',
        playbook: { path: 'lucy-orchestration-effectiveness.md', parameters: {} },
        cwd: '/tmp',
      });

      await overlapOnce(service, store, schedule.id, '2026-08-12T10:30:00.000Z');
      await overlapOnce(service, store, schedule.id, '2026-08-12T11:00:00.000Z');
      await overlapOnce(service, store, schedule.id, '2026-08-12T11:30:00.000Z');

      const after = store.get(schedule.id)!;
      expect(after.enabled).toBe(true);
      expect(after.consecutiveFailures ?? 0).toBe(0);
      expect(after.stopReason).toBeUndefined();
      expect(after.operatorHold).toBeUndefined();
      expect(after.lastRunStatus).toBeUndefined();
      expect(after.latestExecution).toMatchObject({
        outcome: 'skipped_active',
        reasonCode: 'previous_run_active',
        message: 'Previous run still active',
      });
    } finally {
      cleanup();
    }
  });

  it('a later cancel of the blocking task does not rewrite the skip as a failure', async () => {
    const { service, store, cleanup } = overlapHarness();
    try {
      const schedule = store.create({
        name: 'OverlapThenCancel',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });

      const accepted = await service.reserveExecution(store.get(schedule.id)!, 'cron', '2026-08-12T10:00:00.000Z');
      await service.markExecutionAccepted(schedule.id, accepted.id, 'task-still-running', false);
      await overlapOnce(service, store, schedule.id, '2026-08-12T10:30:00.000Z');
      expect(store.get(schedule.id)!.latestExecution?.taskId).toBe('task-still-running');
      expect(store.get(schedule.id)!.consecutiveFailures ?? 0).toBe(0);

      await service.recordTaskTerminalOutcome('task-still-running', 'cancelled');

      const after = store.get(schedule.id)!;
      expect(after.latestExecution?.outcome).toBe('skipped_active');
      expect(after.latestExecution?.reasonCode).toBe('previous_run_active');
      expect(after.latestExecution?.message).toBe('Previous run still active');
      expect(after.lastRunStatus).not.toBe('cancelled');
      expect(after.consecutiveFailures ?? 0).toBe(0);
      expect(after.enabled).toBe(true);
      expect(after.stopReason).toBeUndefined();
      const ledger = after.executionLedger;
      expect(ledger.find((row) => row.outcome === 'skipped_active')).toMatchObject({
        reasonCode: 'previous_run_active',
        taskId: 'task-still-running',
      });
      expect(ledger.find((row) => row.outcome === 'cancelled')).toMatchObject({
        taskId: 'task-still-running',
      });
    } finally {
      cleanup();
    }
  });

  it('real consecutive dispatch_failed / launch_error still trip the #2353 pause', async () => {
    const { service, store, cleanup } = overlapHarness();
    try {
      const schedule = store.create({
        name: 'Requirements-Redundancy',
        cron: '* * * * *',
        playbook: { path: 'research.md', parameters: {} },
        cwd: '/tmp',
      });

      for (const at of ['2026-08-12T10:00:00.000Z', '2026-08-12T10:05:00.000Z', '2026-08-12T10:10:00.000Z']) {
        const receipt = await service.reserveExecution(store.get(schedule.id)!, 'cron', at);
        await service.markExecutionOutcome(schedule.id, receipt.id, 'dispatch_failed', 'launch_error', 'boom');
      }

      const paused = store.get(schedule.id)!;
      expect(paused.enabled).toBe(false);
      expect(paused.stopReason).toBe('consecutive_failures');
      expect(paused.operatorHold).toBe(true);
      expect(paused.consecutiveFailures).toBe(3);
    } finally {
      cleanup();
    }
  });
});

describe('isRestartInterruptedReason (issue #2512)', () => {
  it('exempts `server-restart` regardless of the redeploy marker', () => {
    expect(isRestartInterruptedReason('server-restart', true)).toBe(true);
    expect(isRestartInterruptedReason('server-restart', false)).toBe(true);
  });

  it('exempts `unknown` ONLY when a graceful redeploy was in flight', () => {
    // `unknown` alone is ambiguous — it also covers a crash while the server was
    // down. Only the redeploy marker confirms a graceful stop caused it.
    expect(isRestartInterruptedReason('unknown', true)).toBe(true);
    expect(isRestartInterruptedReason('unknown', false)).toBe(false);
  });

  it('keeps deliberate reaps and an absent reason counting, marker or not', () => {
    for (const reason of ['timeout', 'manual', 'supervisor', 'provider_transient', 'oom'] as const) {
      expect(isRestartInterruptedReason(reason, true)).toBe(false);
      expect(isRestartInterruptedReason(reason, false)).toBe(false);
    }
    expect(isRestartInterruptedReason(undefined, true)).toBe(false);
  });
});

describe('ScheduleService restart reconciliation vs consecutiveFailures (issue #2512)', () => {
  // `serverRestarting` mimics a fresh `server-restarting.json` marker — a
  // graceful redeploy actually in flight. Defaults to true (the outage case);
  // pass false to model a hard crash while the server was down (no marker).
  function harness(serverRestarting = true): {
    service: ScheduleService;
    store: ScheduleStore;
    alerts: Array<Extract<ServerMessage, { type: 'alert' }>>;
    cleanup: () => void;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'schedule-restart-2512-'));
    const store = new ScheduleStore(dir);
    const alerts: Array<Extract<ServerMessage, { type: 'alert' }>> = [];
    const service = new ScheduleService({
      store,
      validator: new ScheduleValidator(),
      getFailureAlertThreshold: () => 3,
      emitAlert: (message) => alerts.push(message),
      isServerRestarting: () => serverRestarting,
    });
    return { service, store, alerts, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  // A scheduled fire that was mid-flight when the process restarted: an accepted
  // task whose sessions die during a redeploy is terminated `unknown` by
  // reconcile(), so at boot its schedule sees a terminal task and records a
  // `cancelled` reconciled_after_restart outcome. That must NOT count.
  function midFlightThenTerminated(reason: 'server-restart' | 'unknown' | 'timeout'): {
    taskStore: TaskStore;
    taskId: string;
  } {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Run scheduled work', '/tmp');
    taskStore.startTask(task.id);
    taskStore.terminateTask(task.id, { reason });
    return { taskStore, taskId: task.id };
  }

  async function seedMidFlight(
    service: ScheduleService,
    store: ScheduleStore,
    scheduleId: string,
    taskId: string,
    scheduledFor: string,
  ): Promise<void> {
    const receipt = await service.reserveExecution(store.get(scheduleId)!, 'cron', scheduledFor);
    await service.markExecutionAccepted(scheduleId, receipt.id, taskId, false);
  }

  it('three restart-reconciled cancels in a row leave the schedule enabled (the 2026-08-14 outage)', async () => {
    const { service, store, alerts, cleanup } = harness();
    try {
      const schedule = store.create({
        name: 'Kookr Queue Feeder',
        cron: '* * * * *',
        playbook: { path: 'queue-feeder.md', parameters: {} },
        cwd: '/tmp',
      });

      // Simulate three restart storms: each boot reconciles a mid-flight fire
      // whose task the restart killed (reconcile → `unknown`).
      let n = 0;
      for (const at of ['2026-08-14T10:00:00.000Z', '2026-08-14T10:05:00.000Z', '2026-08-14T10:10:00.000Z']) {
        const { taskStore, taskId } = midFlightThenTerminated('unknown');
        await seedMidFlight(service, store, schedule.id, taskId, at);
        await service.reconcileOnStartup(taskStore);
        n += 1;
      }
      expect(n).toBe(3);

      const after = store.get(schedule.id)!;
      expect(after.consecutiveFailures ?? 0).toBe(0);
      expect(after.enabled).toBe(true);
      expect(after.stopReason).toBeUndefined();
      expect(after.operatorHold).toBeUndefined();
      // Still recorded truthfully as reconciled cancels, just not counted.
      expect(after.latestExecution?.outcome).toBe('cancelled');
      expect(after.latestExecution?.reasonCode).toBe('reconciled_after_restart');
      // No fail-closed alert fires for restart churn.
      expect(alerts).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('exempts a boot-reconciled cancel regardless of terminationReason (server-restart or unknown)', async () => {
    for (const reason of ['server-restart', 'unknown'] as const) {
      const { service, store, cleanup } = harness();
      try {
        const schedule = store.create({
          name: `Reconciled-${reason}`,
          cron: '* * * * *',
          playbook: { path: 'daily.md', parameters: {} },
          cwd: '/tmp',
        });
        const { taskStore, taskId } = midFlightThenTerminated(reason);
        await seedMidFlight(service, store, schedule.id, taskId, '2026-08-14T09:05:00.000Z');

        await service.reconcileOnStartup(taskStore);

        const after = store.get(schedule.id)!;
        expect(after.consecutiveFailures ?? 0).toBe(0);
        expect(after.enabled).toBe(true);
        expect(after.latestExecution?.outcome).toBe('cancelled');
        expect(after.latestExecution?.reasonCode).toBe('reconciled_after_restart');
      } finally {
        cleanup();
      }
    }
  });

  it('COUNTS a boot-reconciled `unknown` when NO redeploy marker is present (hard crash while down)', async () => {
    // Codex review finding: `unknown` alone does not prove restart causation — a
    // genuine crash while the server was down also reconciles to `unknown`.
    // Without the graceful-redeploy marker it must keep counting so repeated
    // real crashes still fail-close (#2353). server-restart, being unambiguous,
    // is still exempted even here.
    const { service, store, cleanup } = harness(/* serverRestarting */ false);
    try {
      const schedule = store.create({
        name: 'HardCrashWhileDown',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });
      const unknownRun = midFlightThenTerminated('unknown');
      await seedMidFlight(service, store, schedule.id, unknownRun.taskId, '2026-08-14T09:00:00.000Z');
      await service.reconcileOnStartup(unknownRun.taskStore);
      expect(store.get(schedule.id)!.consecutiveFailures).toBe(1);

      // A `server-restart` reason is still exempt even without a marker.
      const restartRun = midFlightThenTerminated('server-restart');
      await seedMidFlight(service, store, schedule.id, restartRun.taskId, '2026-08-14T09:05:00.000Z');
      await service.reconcileOnStartup(restartRun.taskStore);
      expect(store.get(schedule.id)!.consecutiveFailures).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('a boot-reconciled COMPLETED run still resets a pre-existing streak', async () => {
    const { service, store, cleanup } = harness();
    try {
      const schedule = store.create({
        name: 'ReconciledCompleted',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });
      // Seed a genuine failure so we can prove a clean reconciled finish clears it.
      const failReceipt = await service.reserveExecution(store.get(schedule.id)!, 'cron', '2026-08-14T09:00:00.000Z');
      await service.markExecutionOutcome(schedule.id, failReceipt.id, 'dispatch_failed', 'launch_error', 'boom');
      expect(store.get(schedule.id)!.consecutiveFailures).toBe(1);

      // A mid-flight fire whose task finished cleanly across the restart.
      const taskStore = new TaskStore();
      const task = taskStore.createTask('Run scheduled work', '/tmp');
      taskStore.startTask(task.id);
      taskStore.completeTask(task.id);
      await seedMidFlight(service, store, schedule.id, task.id, '2026-08-14T09:05:00.000Z');

      await service.reconcileOnStartup(taskStore);

      const after = store.get(schedule.id)!;
      expect(after.consecutiveFailures).toBe(0);
      expect(after.latestExecution?.outcome).toBe('completed');
    } finally {
      cleanup();
    }
  });

  it('a restart-reconciled cancel carries a pre-existing streak forward unchanged (no reset, no increment)', async () => {
    const { service, store, cleanup } = harness();
    try {
      const schedule = store.create({
        name: 'PreExistingStreak',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });
      const failReceipt = await service.reserveExecution(store.get(schedule.id)!, 'cron', '2026-08-14T08:55:00.000Z');
      await service.markExecutionOutcome(schedule.id, failReceipt.id, 'dispatch_failed', 'launch_error', 'boom');
      expect(store.get(schedule.id)!.consecutiveFailures).toBe(1);

      const { taskStore, taskId } = midFlightThenTerminated('unknown');
      await seedMidFlight(service, store, schedule.id, taskId, '2026-08-14T09:00:00.000Z');
      await service.reconcileOnStartup(taskStore);

      // Neither reset (the real streak survives) nor incremented (not the schedule's fault).
      expect(store.get(schedule.id)!.consecutiveFailures).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('a LIVE cancel (recordTaskTerminalOutcome) still counts — genuine mid-run failure', async () => {
    // The live path only ever sees a task that died during normal operation, not
    // one interrupted by a restart (those are still mid-flight at process death
    // and handled by reconcileOnStartup). So it must keep counting.
    const { service, store, alerts, cleanup } = harness();
    try {
      const schedule = store.create({
        name: 'LiveCrash',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });

      let n = 0;
      for (const at of ['2026-08-14T10:00:00.000Z', '2026-08-14T10:05:00.000Z', '2026-08-14T10:10:00.000Z']) {
        const receipt = await service.reserveExecution(store.get(schedule.id)!, 'cron', at);
        await service.markExecutionAccepted(schedule.id, receipt.id, `task-live-${n++}`, false);
        await service.recordTaskTerminalOutcome(`task-live-${n - 1}`, 'cancelled');
      }

      const after = store.get(schedule.id)!;
      expect(after.consecutiveFailures).toBe(3);
      expect(after.enabled).toBe(false);
      expect(after.stopReason).toBe('consecutive_failures');
      expect(after.latestExecution?.reasonCode).toBe('none');
      expect(alerts.filter((a) => a.operationalAlert?.state === 'fired')).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});

function stampLastEvaluatedAt(store: ScheduleStore, scheduleId: string, evaluatedAt: string): void {
  const current = store.get(scheduleId)!;
  store.replace({
    ...current,
    latestExecution: current.latestExecution
      ? { ...current.latestExecution, evaluatedAt }
      : current.latestExecution,
  });
}

describe('ScheduleService transient-failure re-arm (issue #2459)', () => {
  function rearmHarness(): {
    service: ScheduleService;
    store: ScheduleStore;
    cleanup: () => void;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'schedule-rearm-2459-'));
    const store = new ScheduleStore(dir);
    const service = new ScheduleService({
      store,
      validator: new ScheduleValidator(),
      getFailureAlertThreshold: () => 3,
    });
    return { service, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  async function failLaunch(
    service: ScheduleService,
    store: ScheduleStore,
    scheduleId: string,
    scheduledFor: string,
  ): Promise<void> {
    const receipt = await service.reserveExecution(store.get(scheduleId)!, 'cron', scheduledFor);
    await service.markExecutionOutcome(
      scheduleId,
      receipt.id,
      'dispatch_failed',
      'launch_error',
      'Initial prompt submission was not confirmed after 3 confirmation attempt(s)',
    );
  }

  it('re-arms a launch_error pause when the daemon is healthy', async () => {
    const { service, store, cleanup } = rearmHarness();
    try {
      const schedule = store.create({
        name: 'Lucy Deploy Convergence',
        cron: '*/15 * * * *',
        playbook: { path: 'lucy-deploy-convergence.md', parameters: {} },
        cwd: '/tmp',
      });

      await failLaunch(service, store, schedule.id, '2026-08-12T12:30:00.000Z');
      await failLaunch(service, store, schedule.id, '2026-08-12T12:45:00.000Z');
      await failLaunch(service, store, schedule.id, '2026-08-12T13:00:00.000Z');
      expect(store.get(schedule.id)!.enabled).toBe(false);
      expect(store.get(schedule.id)!.operatorHold).toBe(true);
      stampLastEvaluatedAt(store, schedule.id, '2026-08-12T13:00:00.000Z');

      const noArg = await service.rearmTransientFailureHolds();
      expect(noArg.rearmed).toEqual([]);
      expect(store.get(schedule.id)!.enabled).toBe(false);

      const unhealthy = await service.rearmTransientFailureHolds(false, '2026-08-13T08:34:00.000Z');
      expect(unhealthy.rearmed).toEqual([]);
      expect(store.get(schedule.id)!.enabled).toBe(false);

      const liveStreak = await service.rearmTransientFailureHolds(true, '2026-08-12T10:00:00.000Z');
      expect(liveStreak.rearmed).toEqual([]);
      expect(store.get(schedule.id)!.enabled).toBe(false);

      const leftover = await service.rearmTransientFailureHolds(true, '2026-08-13T08:34:00.000Z');
      expect(leftover.rearmed).toEqual([
        {
          id: schedule.id,
          name: 'Lucy Deploy Convergence',
          reasonCode: 'launch_error',
        },
      ]);
      const after = store.get(schedule.id)!;
      expect(after.enabled).toBe(true);
      expect(after.operatorHold).toBeUndefined();
      expect(after.stopReason).toBeUndefined();
      expect(after.consecutiveFailures).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('does not re-arm a genuine timeout / cancelled streak (#2353)', async () => {
    const { service, store, cleanup } = rearmHarness();
    try {
      const schedule = store.create({
        name: 'Requirements-Redundancy',
        cron: '* * * * *',
        playbook: { path: 'research.md', parameters: {} },
        cwd: '/tmp',
      });

      for (const [i, at] of ['2026-08-12T10:00:00.000Z', '2026-08-12T10:05:00.000Z', '2026-08-12T10:10:00.000Z'].entries()) {
        const receipt = await service.reserveExecution(store.get(schedule.id)!, 'cron', at);
        await service.markExecutionAccepted(schedule.id, receipt.id, `task-timeout-${i}`, false);
        await service.recordTaskTerminalOutcome(`task-timeout-${i}`, 'cancelled');
      }

      const paused = store.get(schedule.id)!;
      expect(paused.enabled).toBe(false);
      expect(paused.stopReason).toBe('consecutive_failures');
      expect(paused.consecutiveFailures).toBe(3);
      expect(paused.latestExecution?.outcome).toBe('cancelled');

      const result = await service.rearmTransientFailureHolds(true);
      expect(result.rearmed).toEqual([]);
      expect(store.get(schedule.id)!.enabled).toBe(false);
      expect(store.get(schedule.id)!.stopReason).toBe('consecutive_failures');
      expect(store.get(schedule.id)!.operatorHold).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('skips an exhausted leftover hold without aborting the rest of the scan', async () => {
    const { service, store, cleanup } = rearmHarness();
    try {
      const exhausted = store.create({
        name: 'Exhausted leftover',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
        maxTriggers: 1,
      });
      const eligible = store.create({
        name: 'Eligible leftover',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });
      for (const id of [exhausted.id, eligible.id]) {
        for (const at of ['2026-08-12T12:30:00.000Z', '2026-08-12T12:45:00.000Z', '2026-08-12T13:00:00.000Z']) {
          const receipt = await service.reserveExecution(store.get(id)!, 'cron', at);
          await service.markExecutionOutcome(id, receipt.id, 'dispatch_failed', 'launch_error', 'boom');
        }
        stampLastEvaluatedAt(store, id, '2026-08-12T13:00:00.000Z');
      }
      store.replace({
        ...store.get(exhausted.id)!,
        remainingTriggers: 0,
        stopReason: 'consecutive_failures',
      });

      const result = await service.rearmTransientFailureHolds(true, '2026-08-13T08:34:00.000Z');
      expect(result.rearmed.map((row) => row.id)).toEqual([eligible.id]);
      expect(store.get(exhausted.id)!.enabled).toBe(false);
      expect(store.get(eligible.id)!.enabled).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('does not re-arm when getDaemonHealthy is false and no override is passed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'schedule-rearm-unhealthy-'));
    try {
      const store = new ScheduleStore(dir);
      const service = new ScheduleService({
        store,
        validator: new ScheduleValidator(),
        getFailureAlertThreshold: () => 3,
        getDaemonHealthy: () => false,
        getReadyAt: () => '2026-08-13T08:34:00.000Z',
      });
      const schedule = store.create({
        name: 'Unhealthy daemon',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });
      for (const at of ['2026-08-12T12:30:00.000Z', '2026-08-12T12:45:00.000Z', '2026-08-12T13:00:00.000Z']) {
        const receipt = await service.reserveExecution(store.get(schedule.id)!, 'cron', at);
        await service.markExecutionOutcome(schedule.id, receipt.id, 'dispatch_failed', 'launch_error', 'boom');
      }
      stampLastEvaluatedAt(store, schedule.id, '2026-08-12T13:00:00.000Z');
      const result = await service.rearmTransientFailureHolds();
      expect(result.rearmed).toEqual([]);
      expect(store.get(schedule.id)!.enabled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
