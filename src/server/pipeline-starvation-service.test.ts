import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore, type Task } from '../core/tasks.js';
import {
  BATCH_OUTCOME_SCHEMA_VERSION,
  SCOUT_ANTI_THRASH_MS,
  type BatchOutcomeRecord,
} from '../core/pipeline-starvation.js';
import {
  BATCH_KICK_HANDLE_SOURCE,
  BATCH_KICK_SCOUT_COMPLETE_SOURCE,
  PipelineStarvationService,
  RECONCILE_TERMINAL_SOURCE,
  STARVATION_TRIGGER_PROVENANCE,
} from './pipeline-starvation-service.js';
import type { LaunchOpts, LaunchResult } from '../shared/contracts/launch.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import {
  listSignalFiles,
  operationalAlertToSignal,
  readSignal,
  writeOperatorSignal,
} from '../observability/signal-delivery/index.js';

const NOW = Date.parse('2026-07-30T08:15:00.000Z');

function outcome(overrides: Partial<BatchOutcomeRecord> = {}): BatchOutcomeRecord {
  return {
    schemaVersion: BATCH_OUTCOME_SCHEMA_VERSION,
    outcome: 'blocked-empty',
    repo: 'jeanibarz/lucy',
    runKey: 'run-1',
    reason: 'No safe, unblocked, single-PR issue remains in jeanibarz/lucy',
    openIssueCount: 24,
    disqualified: [
      { issue: 10, reason: 'already has open PR' },
      { issue: 11, reason: 'label:blocked' },
    ],
    generatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

describe('PipelineStarvationService (#1715)', () => {
  let stateDir: string;
  let kookrDir: string;
  let ideaScoutBase: string;
  let checkout: string;
  let prevPluginDir: string | undefined;
  let launches: LaunchOpts[];
  let alerts: ServerMessage[];
  let store: TaskStore;
  let service: PipelineStarvationService;
  let clock: number;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'kookr-starv-state-'));
    kookrDir = await mkdtemp(join(tmpdir(), 'kookr-starv-kookr-'));
    ideaScoutBase = await mkdtemp(join(tmpdir(), 'kookr-starv-scout-'));
    checkout = await mkdtemp(join(tmpdir(), 'kookr-starv-checkout-'));
    prevPluginDir = process.env.KOOKR_PLUGIN_DIR;
    // Point the plugin playbook resolver at this worktree's plugin/.
    process.env.KOOKR_PLUGIN_DIR = join(process.cwd(), 'plugin');

    launches = [];
    alerts = [];
    store = new TaskStore();
    clock = NOW;

    service = new PipelineStarvationService({
      taskStore: store,
      launcher: async (opts) => {
        launches.push(opts);
        const task = store.createTask({
          prompt: opts.prompt,
          cwd: opts.cwd,
          name: opts.name,
          playbookId: opts.playbookId,
          projectId: opts.projectId,
          parentTaskId: opts.parentTaskId,
          playbookParameterValues: opts.playbookParameterValues,
        });
        const result: LaunchResult<Task> = { task, queued: false, idempotentReplay: false };
        return result;
      },
      broadcast: (msg) => { alerts.push(msg); },
      kookrDir,
      stateDir,
      ideaScoutStateDirForRepo: () => ideaScoutBase,
      now: () => clock,
    });
  });

  afterEach(() => {
    if (prevPluginDir === undefined) delete process.env.KOOKR_PLUGIN_DIR;
    else process.env.KOOKR_PLUGIN_DIR = prevPluginDir;
  });

  test('first blocked-empty spawns one scout, writes audit provenance, no alert', async () => {
    const result = await service.handleBatchOutcome({
      outcome: outcome(),
      localPath: checkout,
      parentTaskId: undefined,
    });

    expect(result.decision.spawnScout).toBe(true);
    expect(result.spawnedScoutTaskId).toBeTruthy();
    expect(result.state.lastStarvationScoutAt).toBe(new Date(NOW).toISOString());
    expect(result.alertEmitted).toBe(false);
    expect(launches).toHaveLength(1);
    expect(launches[0]!.playbookId).toMatch(/repository-idea-scout/);
    expect(launches[0]!.idempotencyKey).toMatch(/^starvation-scout:jeanibarz-lucy:/);
    expect(launches[0]!.autoCloseOnSignal).toBe(true);
    expect(launches[0]!.prompt.toLowerCase()).toMatch(/idea scout|repository idea scout/);

    const audit = await readFile(join(kookrDir, 'audit.jsonl'), 'utf-8');
    expect(audit).toContain('pipeline_starvation_scout_spawn');
    expect(audit).toContain(STARVATION_TRIGGER_PROVENANCE);
    expect(audit).not.toContain('pipeline_starvation_alert');

    expect(result.state.lastStarvationScoutTaskId).toBe(result.spawnedScoutTaskId);
    expect(result.summary).toMatch(/spawned scout taskId=/);
  });

  test('second consecutive blocked-empty within 12h emits one starvation alert and dedups scout', async () => {
    const first = await service.handleBatchOutcome({
      outcome: outcome({ runKey: 'run-1' }),
      localPath: checkout,
    });
    expect(first.spawnedScoutTaskId).toBeTruthy();
    expect(first.alertEmitted).toBe(false);

    // +3h: inside the 12h alert window; the second scout is deduped by the
    // in-flight scout guard (the first spawn's task is still non-terminal),
    // not by the adaptive cooldown, which at consecutive=2 is only 2h (#2171).
    clock = NOW + 3 * 60 * 60 * 1000;
    const second = await service.handleBatchOutcome({
      outcome: outcome({ runKey: 'run-2', generatedAt: new Date(clock).toISOString() }),
      localPath: checkout,
    });

    expect(second.decision.consecutiveBlockedEmpty).toBe(2);
    expect(second.spawnedScoutTaskId).toBeUndefined();
    expect(second.decision.spawnScout).toBe(false);
    expect(second.alertEmitted).toBe(true);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      type: 'alert',
      severity: 'warning',
      operationalAlert: {
        key: 'pipeline:starvation:jeanibarz/lucy',
        metric: 'pipeline_starvation',
        state: 'fired',
      },
    });
    expect(launches).toHaveLength(1); // only the first spawn

    const audit = await readFile(join(kookrDir, 'audit.jsonl'), 'utf-8');
    expect(audit).toContain('pipeline_starvation_alert');
    expect(audit).toContain(STARVATION_TRIGGER_PROVENANCE);
  });

  test('skips spawn when scout is already in flight for the repo', async () => {
    store.createTask({
      prompt: 'Repository Idea Scout for jeanibarz/lucy',
      cwd: checkout,
      playbookId: 'repository-idea-scout.md',
      projectId: 'github.com/jeanibarz/lucy',
      name: 'Idea scout: jeanibarz/lucy',
    });
    // createTask leaves status open — non-terminal.

    const result = await service.handleBatchOutcome({
      outcome: outcome(),
      localPath: checkout,
    });
    expect(result.decision.spawnScout).toBe(false);
    expect(result.spawnedScoutTaskId).toBeUndefined();
    expect(launches).toHaveLength(0);
  });

  test('skips spawn when a successful ideation run finished recently', async () => {
    const runDir = join(ideaScoutBase, 'recent-run');
    await mkdir(join(runDir, 'recommendations', '01-leaf'), { recursive: true });
    await writeFile(join(runDir, 'state.md'), '# scout\n\n<promise>DONE</promise>\n', 'utf-8');
    await writeFile(
      join(runDir, 'recommendations', '01-leaf', 'issue-created.json'),
      JSON.stringify({ number: 42, title: 'feat: real leaf issue' }),
      'utf-8',
    );

    // Capacity shows work still queued → 4h ideation suppress holds (#2043).
    service = new PipelineStarvationService({
      taskStore: store,
      launcher: async (opts) => {
        launches.push(opts);
        const task = store.createTask({
          prompt: opts.prompt,
          cwd: opts.cwd,
          name: opts.name,
          playbookId: opts.playbookId,
          projectId: opts.projectId,
          parentTaskId: opts.parentTaskId,
          playbookParameterValues: opts.playbookParameterValues,
        });
        const result: LaunchResult<Task> = { task, queued: false, idempotentReplay: false };
        return result;
      },
      broadcast: (msg) => { alerts.push(msg); },
      kookrDir,
      stateDir,
      ideaScoutStateDirForRepo: () => ideaScoutBase,
      getCapacitySnapshot: () => ({ free: 2, pendingQueueDepth: 4 }),
      now: () => clock,
    });

    const result = await service.handleBatchOutcome({
      outcome: outcome(),
      localPath: checkout,
    });
    expect(result.decision.spawnScout).toBe(false);
    expect(result.decision.spawnSkipReason).toMatch(/successful ideation/i);
    expect(result.decision.followOnAction).toBe('batch_kick_only');
    expect(result.decision.ideationSuccessEmptyQueue).toBeUndefined();
    // Flag default off: no launch, but audit records flag_off (PR4).
    expect(launches).toHaveLength(0);
    expect(result.batchKickResult).toBe('batch_skipped_flag_off');
    // PR1: decision audit always written (including skips).
    const audit = await readFile(join(kookrDir, 'audit.jsonl'), 'utf-8');
    expect(audit).toContain('pipeline_starvation_decision');
    expect(audit).toContain('successful ideation');
    expect(audit).toContain('batchKickSkipped');
    expect(audit).toContain('flag_off');
    expect(audit).toContain('pipeline_starvation_batch_kick');
    expect(audit).toContain('batch_skipped_flag_off');
    expect(audit).toContain('"pendingQueueDepth":4');
    expect(audit).toContain('"ideationSuccessEmptyQueue":false');
  });

  test('belt-empty capacity bypasses 4h scout dedup after thrash floor (#2068/#2071)', async () => {
    // First empty spawns a scout (no capacity needed).
    const first = await service.handleBatchOutcome({
      outcome: outcome({ runKey: 'belt-1' }),
      localPath: checkout,
    });
    expect(first.spawnedScoutTaskId).toBeTruthy();
    expect(launches).toHaveLength(1);
    // Prior scout must be terminal for re-scout (#2068: after scout completed).
    store.startTask(first.spawnedScoutTaskId!);
    store.completeTask(first.spawnedScoutTaskId!);

    // Past anti-thrash floor, still inside 4h; free≥5 + empty queue → re-scout.
    clock = NOW + SCOUT_ANTI_THRASH_MS + 15 * 60 * 1000;
    service = new PipelineStarvationService({
      taskStore: store,
      launcher: async (opts) => {
        launches.push(opts);
        const task = store.createTask({
          prompt: opts.prompt,
          cwd: opts.cwd,
          name: opts.name,
          playbookId: opts.playbookId,
          projectId: opts.projectId,
          parentTaskId: opts.parentTaskId,
          playbookParameterValues: opts.playbookParameterValues,
        });
        const result: LaunchResult<Task> = { task, queued: false, idempotentReplay: false };
        return result;
      },
      broadcast: (msg) => { alerts.push(msg); },
      kookrDir,
      stateDir,
      ideaScoutStateDirForRepo: () => ideaScoutBase,
      getCapacitySnapshot: () => ({ free: 5, pendingQueueDepth: 0 }),
      now: () => clock,
    });

    const second = await service.handleBatchOutcome({
      outcome: outcome({ runKey: 'belt-2', generatedAt: new Date(clock).toISOString() }),
      localPath: checkout,
    });
    expect(second.decision.spawnScout).toBe(true);
    expect(second.decision.scoutDedupBypassedForBeltEmpty).toBe(true);
    expect(second.decision.starvationRefillPostcondition).toBe('pass');
    expect(second.spawnedScoutTaskId).toBeTruthy();
    expect(launches).toHaveLength(2);
    // Distinct idempotency keys so launch-path ledger does not replay terminal scout A.
    expect(launches[0]!.idempotencyKey).not.toBe(launches[1]!.idempotencyKey);
    expect(launches[1]!.idempotencyKey).toMatch(/^starvation-scout:jeanibarz-lucy:/);

    const audit = await readFile(join(kookrDir, 'audit.jsonl'), 'utf-8');
    expect(audit).toContain('"scoutDedupBypassedForBeltEmpty":true');
    expect(audit).toContain('"starvationRefillPostcondition":"pass"');
  });

  test('anti-thrash floor blocks belt-empty re-scout and counts residual (#2068)', async () => {
    const first = await service.handleBatchOutcome({
      outcome: outcome({ runKey: 'thrash-1' }),
      localPath: checkout,
    });
    expect(first.spawnedScoutTaskId).toBeTruthy();
    store.startTask(first.spawnedScoutTaskId!);
    store.completeTask(first.spawnedScoutTaskId!);

    // Still inside anti-thrash floor with idle capacity.
    clock = NOW + Math.floor(SCOUT_ANTI_THRASH_MS / 2);
    service = new PipelineStarvationService({
      taskStore: store,
      launcher: async (opts) => {
        launches.push(opts);
        const task = store.createTask({
          prompt: opts.prompt,
          cwd: opts.cwd,
          name: opts.name,
          playbookId: opts.playbookId,
          projectId: opts.projectId,
          parentTaskId: opts.parentTaskId,
          playbookParameterValues: opts.playbookParameterValues,
        });
        const result: LaunchResult<Task> = { task, queued: false, idempotentReplay: false };
        return result;
      },
      broadcast: (msg) => { alerts.push(msg); },
      kookrDir,
      stateDir,
      ideaScoutStateDirForRepo: () => ideaScoutBase,
      getCapacitySnapshot: () => ({ free: 7, pendingQueueDepth: 0 }),
      now: () => clock,
    });

    const second = await service.handleBatchOutcome({
      outcome: outcome({ runKey: 'thrash-2', generatedAt: new Date(clock).toISOString() }),
      localPath: checkout,
    });
    expect(second.decision.spawnScout).toBe(false);
    expect(second.decision.scoutCooldownSkipWhileBeltEmpty).toBe(true);
    expect(second.decision.starvationRefillPostcondition).toBe('fail');
    expect(second.spawnedScoutTaskId).toBeUndefined();
    expect(second.state.scoutCooldownSkipsWhileBeltEmpty).toBe(1);
    expect(launches).toHaveLength(1);

    const audit = await readFile(join(kookrDir, 'audit.jsonl'), 'utf-8');
    expect(audit).toContain('"scoutCooldownSkipWhileBeltEmpty":true');
    expect(audit).toContain('"starvationRefillPostcondition":"fail"');
  });

  test('empty-queue capacity after successful ideation re-opens scout (#2043)', async () => {
    const runDir = join(ideaScoutBase, 'empty-success-run');
    await mkdir(join(runDir, 'recommendations', '01-leaf'), { recursive: true });
    await writeFile(join(runDir, 'state.md'), '# scout\n\n<promise>DONE</promise>\n', 'utf-8');
    await writeFile(
      join(runDir, 'recommendations', '01-leaf', 'issue-created.json'),
      JSON.stringify({ number: 99, title: 'feat: leaf that batch cannot implement' }),
      'utf-8',
    );

    service = new PipelineStarvationService({
      taskStore: store,
      launcher: async (opts) => {
        launches.push(opts);
        const task = store.createTask({
          prompt: opts.prompt,
          cwd: opts.cwd,
          name: opts.name,
          playbookId: opts.playbookId,
          projectId: opts.projectId,
          parentTaskId: opts.parentTaskId,
          playbookParameterValues: opts.playbookParameterValues,
        });
        const result: LaunchResult<Task> = { task, queued: false, idempotentReplay: false };
        return result;
      },
      broadcast: (msg) => { alerts.push(msg); },
      kookrDir,
      stateDir,
      ideaScoutStateDirForRepo: () => ideaScoutBase,
      getCapacitySnapshot: () => ({ free: 7, pendingQueueDepth: 0 }),
      now: () => clock,
    });

    const result = await service.handleBatchOutcome({
      outcome: outcome({ runKey: 'empty-ideation-handle' }),
      localPath: checkout,
    });
    expect(result.decision.spawnScout).toBe(true);
    expect(result.decision.followOnAction).toBe('idea_scout');
    expect(result.decision.ideationSuccessEmptyQueue).toBe(true);
    expect(result.spawnedScoutTaskId).toBeTruthy();
    expect(launches).toHaveLength(1);
    expect(result.batchKickResult).toBeUndefined();

    const audit = await readFile(join(kookrDir, 'audit.jsonl'), 'utf-8');
    expect(audit).toContain('pipeline_starvation_decision');
    expect(audit).toContain('"ideationSuccessEmptyQueue":true');
    expect(audit).toContain('"free":7');
    expect(audit).toContain('"pendingQueueDepth":0');
    expect(audit).toContain('pipeline_starvation_scout_spawn');
  });

  test('DONE without issue-created does NOT suppress spawn (content-blind fix)', async () => {
    const runDir = join(ideaScoutBase, 'empty-done');
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'state.md'), '# scout\n\n<promise>DONE</promise>\n', 'utf-8');

    const result = await service.handleBatchOutcome({
      outcome: outcome({ runKey: 'empty-done-run' }),
      localPath: checkout,
    });
    expect(result.decision.spawnScout).toBe(true);
    expect(launches).toHaveLength(1);
  });

  test('non-blocked-empty outcomes are no-ops', async () => {
    const result = await service.handleBatchOutcome({
      outcome: outcome({ outcome: 'done' }),
      localPath: checkout,
    });
    expect(result.decision.applicable).toBe(false);
    expect(launches).toHaveLength(0);
    expect(alerts).toHaveLength(0);
  });

  test('replaying the same runKey does not re-spawn or false-alert', async () => {
    const first = await service.handleBatchOutcome({
      outcome: outcome({ runKey: 'same-run' }),
      localPath: checkout,
    });
    expect(first.spawnedScoutTaskId).toBeTruthy();
    expect(first.alertEmitted).toBe(false);

    clock = NOW + 60_000;
    const replay = await service.handleBatchOutcome({
      outcome: outcome({ runKey: 'same-run', generatedAt: new Date(clock).toISOString() }),
      localPath: checkout,
    });
    expect(replay.decision.alreadyHandled).toBe(true);
    expect(replay.alertEmitted).toBe(false);
    expect(launches).toHaveLength(1);
    expect(alerts).toHaveLength(0);
  });

  test('spawn failure is visible in summary and does not stamp lastStarvationScoutAt', async () => {
    service = new PipelineStarvationService({
      taskStore: store,
      launcher: async () => {
        throw new Error('cwd does not exist');
      },
      broadcast: (msg) => { alerts.push(msg); },
      kookrDir,
      stateDir,
      ideaScoutStateDirForRepo: () => ideaScoutBase,
      now: () => clock,
    });

    const result = await service.handleBatchOutcome({
      outcome: outcome({ runKey: 'fail-run' }),
      localPath: checkout,
    });
    expect(result.spawnedScoutTaskId).toBeUndefined();
    expect(result.summary).toMatch(/scout spawn failed/);
    expect(result.state.lastStarvationScoutAt).toBeUndefined();
    // Ledger still recorded so a later distinct run can alert on consecutive.
    expect(result.state.blockedEmptyAt).toHaveLength(1);
    expect(result.state.handledRunKeys).toContain('fail-run');

    const audit = await readFile(join(kookrDir, 'audit.jsonl'), 'utf-8');
    expect(audit).toContain('pipeline_starvation_scout_spawn_failed');
    expect(audit).toContain(STARVATION_TRIGGER_PROVENANCE);
  });

  test('create-then-launch_error does not stamp lastStarvationScoutAt (#2744)', async () => {
    service = new PipelineStarvationService({
      taskStore: store,
      launcher: async (opts) => {
        launches.push(opts);
        const t = store.createTask({
          prompt: opts.prompt,
          cwd: opts.cwd,
          name: opts.name,
          playbookId: opts.playbookId,
          projectId: opts.projectId,
          parentTaskId: opts.parentTaskId,
        });
        store.setDisposition(t.id, {
          reason: 'launch_error',
          at: new Date(clock).toISOString(),
          source: 'launch-service',
          detail: 'Grok authentication expired or is too close to expiry at 2026-08-19T01:31:15Z. Run `grok login --device-code`.',
        });
        store.terminateTask(t.id);
        const result: LaunchResult<Task> = {
          task: store.getTask(t.id)!,
          queued: false,
          idempotentReplay: false,
        };
        return result;
      },
      broadcast: (msg) => { alerts.push(msg); },
      kookrDir,
      stateDir,
      ideaScoutStateDirForRepo: () => ideaScoutBase,
      now: () => clock,
    });

    const result = await service.handleBatchOutcome({
      outcome: outcome({ runKey: 'launch-error-run' }),
      localPath: checkout,
    });
    expect(result.spawnedScoutTaskId).toBeUndefined();
    expect(result.state.lastStarvationScoutAt).toBeUndefined();
    expect(result.summary).toMatch(/died at launch/i);
    expect(result.state.blockedEmptyAt).toHaveLength(1);

    const audit = await readFile(join(kookrDir, 'audit.jsonl'), 'utf-8');
    expect(audit).toContain('pipeline_starvation_scout_spawn_failed');
    expect(audit).toContain('Grok authentication expired');
    expect(audit).not.toContain('"action":"pipeline_starvation_scout_spawn"');
  });

  test('after launch_error the next refill tick retries with a salted key and can stamp (#2744)', async () => {
    let attempts = 0;
    service = new PipelineStarvationService({
      taskStore: store,
      launcher: async (opts) => {
        launches.push(opts);
        attempts += 1;
        const t = store.createTask({
          prompt: opts.prompt,
          cwd: opts.cwd,
          name: opts.name,
          playbookId: opts.playbookId,
          projectId: opts.projectId,
          parentTaskId: opts.parentTaskId,
        });
        if (attempts === 1) {
          store.setDisposition(t.id, {
            reason: 'launch_error',
            at: new Date(clock).toISOString(),
            source: 'launch-service',
            detail: 'Grok authentication expired',
          });
          store.terminateTask(t.id);
        }
        const result: LaunchResult<Task> = {
          task: store.getTask(t.id)!,
          queued: false,
          idempotentReplay: false,
        };
        return result;
      },
      broadcast: (msg) => { alerts.push(msg); },
      kookrDir,
      stateDir,
      ideaScoutStateDirForRepo: () => ideaScoutBase,
      now: () => clock,
    });

    const first = await service.handleBatchOutcome({
      outcome: outcome({ runKey: 'auth-fail-1' }),
      localPath: checkout,
    });
    expect(first.state.lastStarvationScoutAt).toBeUndefined();
    expect(launches[0]!.idempotencyKey).toMatch(/^starvation-scout:jeanibarz-lucy:\d+$/);

    clock = NOW + 60_000;
    const second = await service.handleBatchOutcome({
      outcome: outcome({
        runKey: 'auth-recovered-2',
        generatedAt: new Date(clock).toISOString(),
      }),
      localPath: checkout,
    });
    expect(second.decision.spawnScout).toBe(true);
    expect(second.spawnedScoutTaskId).toBeTruthy();
    expect(second.state.lastStarvationScoutAt).toBe(new Date(clock).toISOString());
    expect(launches).toHaveLength(2);
    expect(launches[1]!.idempotencyKey).toMatch(/:r1$/);
  });

  test('emptyClass=concurrent does not spawn or inflate consecutive product empties', async () => {
    const product = await service.handleBatchOutcome({
      outcome: outcome({ runKey: 'product-1', emptyClass: 'product' }),
      localPath: checkout,
    });
    expect(product.decision.spawnScout).toBe(true);
    expect(product.state.blockedEmptyAt).toHaveLength(1);

    clock = NOW + 60_000;
    const concurrent = await service.handleBatchOutcome({
      outcome: outcome({
        runKey: 'concurrent-sibling',
        emptyClass: 'concurrent',
        reason: 'NO-OP: another inProgress Parallel Issue Batch for jeanibarz/lucy already exists',
        generatedAt: new Date(clock).toISOString(),
      }),
      localPath: checkout,
    });
    expect(concurrent.decision.applicable).toBe(false);
    expect(concurrent.decision.emptyClass).toBe('concurrent');
    expect(concurrent.spawnedScoutTaskId).toBeUndefined();
    expect(concurrent.alertEmitted).toBe(false);
    // Ledger unchanged — concurrent did not append.
    expect(concurrent.state.blockedEmptyAt).toHaveLength(1);
    expect(concurrent.state.handledRunKeys).not.toContain('concurrent-sibling');
    expect(launches).toHaveLength(1);

    const audit = await readFile(join(kookrDir, 'audit.jsonl'), 'utf-8');
    expect(audit).toContain('emptyClass=concurrent');
  });

  test('legacy concurrent reason without emptyClass is not product starvation', async () => {
    const result = await service.handleBatchOutcome({
      outcome: outcome({
        runKey: 'legacy-concurrent',
        reason:
          'another inProgress Parallel Issue Batch task abc for jeanibarz/lucy; NO-OP without spawning',
      }),
      localPath: checkout,
    });
    expect(result.decision.applicable).toBe(false);
    expect(result.spawnedScoutTaskId).toBeUndefined();
    expect(launches).toHaveLength(0);
    expect(result.state.blockedEmptyAt).toHaveLength(0);
  });

  test('terminal reconcile invokes handle for unhandled product blocked-empty', async () => {
    const batchDir = await mkdtemp(join(tmpdir(), 'kookr-batch-out-'));
    const outcomePath = join(batchDir, 'outcome.json');
    const rec = outcome({ runKey: 'missed-handle-run', emptyClass: 'product' });
    await writeFile(outcomePath, JSON.stringify(rec), 'utf-8');

    const task = store.createTask({
      prompt: 'Parallel Issue Batch for jeanibarz/lucy',
      cwd: checkout,
      playbookId: 'parallel-issue-batch.md',
      playbookParameterValues: { repoFullName: 'jeanibarz/lucy' },
      name: 'Batch: jeanibarz/lucy',
    });
    // Align runKey with task id path used in production (RUN_KEY=KOOKR_TASK_ID).
    const recForTask = { ...rec, runKey: task.id };
    await writeFile(outcomePath, JSON.stringify(recForTask), 'utf-8');

    service = new PipelineStarvationService({
      taskStore: store,
      launcher: async (opts) => {
        launches.push(opts);
        const t = store.createTask({
          prompt: opts.prompt,
          cwd: opts.cwd,
          name: opts.name,
          playbookId: opts.playbookId,
          projectId: opts.projectId,
          parentTaskId: opts.parentTaskId,
        });
        const result: LaunchResult<Task> = { task: t, queued: false, idempotentReplay: false };
        return result;
      },
      broadcast: (msg) => { alerts.push(msg); },
      kookrDir,
      stateDir,
      ideaScoutStateDirForRepo: () => ideaScoutBase,
      resolveBatchOutcomePath: () => outcomePath,
      now: () => clock,
    });

    const result = await service.maybeReconcileBatchTaskTerminal(task.id, { kind: 'completed' });
    expect(result).not.toBeNull();
    expect(result!.decision.applicable).toBe(true);
    expect(result!.spawnedScoutTaskId).toBeTruthy();
    expect(result!.summary).toMatch(/reconcile_terminal/);
    expect(launches).toHaveLength(1);

    const audit = await readFile(join(kookrDir, 'audit.jsonl'), 'utf-8');
    expect(audit).toContain(RECONCILE_TERMINAL_SOURCE);
    expect(audit).toContain('pipeline_starvation_scout_spawn');

    // Second terminal is idempotent (already in handledRunKeys).
    clock = NOW + 1_000;
    const again = await service.maybeReconcileBatchTaskTerminal(task.id, { kind: 'completed' });
    expect(again).toBeNull();
    expect(launches).toHaveLength(1);
  });

  test('terminal reconcile skips concurrent emptyClass', async () => {
    const batchDir = await mkdtemp(join(tmpdir(), 'kookr-batch-conc-'));
    const outcomePath = join(batchDir, 'outcome.json');
    const task = store.createTask({
      prompt: 'Parallel Issue Batch concurrent NO-OP',
      cwd: checkout,
      playbookId: 'parallel-issue-batch.md',
      playbookParameterValues: { repoFullName: 'jeanibarz/lucy' },
    });
    await writeFile(
      outcomePath,
      JSON.stringify(outcome({
        runKey: task.id,
        emptyClass: 'concurrent',
        reason: 'NO-OP: another inProgress Parallel Issue Batch already exists',
      })),
      'utf-8',
    );

    service = new PipelineStarvationService({
      taskStore: store,
      launcher: async (opts) => {
        launches.push(opts);
        throw new Error('should not launch');
      },
      broadcast: (msg) => { alerts.push(msg); },
      kookrDir,
      stateDir,
      ideaScoutStateDirForRepo: () => ideaScoutBase,
      resolveBatchOutcomePath: () => outcomePath,
      now: () => clock,
    });

    const result = await service.maybeReconcileBatchTaskTerminal(task.id, { kind: 'completed' });
    expect(result).toBeNull();
    expect(launches).toHaveLength(0);
  });

  describe('PR4 batch kick (R5)', () => {
    let prevBatchKick: string | undefined;

    beforeEach(() => {
      prevBatchKick = process.env.KOOKR_PIPELINE_BATCH_KICK;
    });

    afterEach(() => {
      if (prevBatchKick === undefined) delete process.env.KOOKR_PIPELINE_BATCH_KICK;
      else process.env.KOOKR_PIPELINE_BATCH_KICK = prevBatchKick;
    });

    async function seedSuccessfulIdeation(): Promise<void> {
      const runDir = join(ideaScoutBase, 'eligible-run');
      await mkdir(join(runDir, 'recommendations', '01-leaf'), { recursive: true });
      await writeFile(join(runDir, 'state.md'), '# scout\n\n<promise>DONE</promise>\n', 'utf-8');
      await writeFile(
        join(runDir, 'recommendations', '01-leaf', 'issue-created.json'),
        JSON.stringify({ number: 99, title: 'feat: implementable leaf' }),
        'utf-8',
      );
    }

    test('flag on + batch_kick_only launches parallel-issue-batch', async () => {
      process.env.KOOKR_PIPELINE_BATCH_KICK = '1';
      await seedSuccessfulIdeation();

      const result = await service.handleBatchOutcome({
        outcome: outcome({ runKey: 'kick-run-1' }),
        localPath: checkout,
      });

      expect(result.decision.followOnAction).toBe('batch_kick_only');
      expect(result.decision.spawnScout).toBe(false);
      expect(result.batchKickResult).toBe('batch_kicked');
      expect(result.batchKickTaskId).toBeTruthy();
      expect(launches).toHaveLength(1);
      expect(launches[0]!.playbookId).toMatch(/parallel-issue-batch/);
      expect(launches[0]!.idempotencyKey).toMatch(/^starvation-batch-kick:jeanibarz-lucy:/);
      expect(result.state.lastBatchKickAt).toBe(new Date(clock).toISOString());
      expect(result.summary).toMatch(/batch kicked taskId=/);

      const audit = await readFile(join(kookrDir, 'audit.jsonl'), 'utf-8');
      expect(audit).toContain('pipeline_starvation_batch_kick');
      expect(audit).toContain('batch_kicked');
      expect(audit).toContain(BATCH_KICK_HANDLE_SOURCE);
    });

    test('flag off still audits batch_skipped_flag_off without launch', async () => {
      delete process.env.KOOKR_PIPELINE_BATCH_KICK;
      await seedSuccessfulIdeation();

      const result = await service.handleBatchOutcome({
        outcome: outcome({ runKey: 'flag-off-run' }),
        localPath: checkout,
      });
      expect(result.batchKickResult).toBe('batch_skipped_flag_off');
      expect(launches).toHaveLength(0);
      expect(result.state.lastBatchKickAt).toBeUndefined();
    });

    test('concurrent in-flight batch skips with batch_skipped_concurrent', async () => {
      process.env.KOOKR_PIPELINE_BATCH_KICK = '1';
      await seedSuccessfulIdeation();
      store.createTask({
        prompt: 'Parallel Issue Batch for jeanibarz/lucy',
        cwd: checkout,
        playbookId: 'parallel-issue-batch.md',
        playbookParameterValues: { repoFullName: 'jeanibarz/lucy' },
        projectId: 'github.com/jeanibarz/lucy',
        name: 'Batch: jeanibarz/lucy',
      });

      const result = await service.handleBatchOutcome({
        outcome: outcome({ runKey: 'concurrent-kick' }),
        localPath: checkout,
      });
      expect(result.batchKickResult).toBe('batch_skipped_concurrent');
      expect(launches).toHaveLength(0);

      const audit = await readFile(join(kookrDir, 'audit.jsonl'), 'utf-8');
      expect(audit).toContain('batch_skipped_concurrent');
    });

    test('cooldown skips second kick within window', async () => {
      process.env.KOOKR_PIPELINE_BATCH_KICK = '1';
      await seedSuccessfulIdeation();

      const first = await service.handleBatchOutcome({
        outcome: outcome({ runKey: 'cd-1' }),
        localPath: checkout,
      });
      expect(first.batchKickResult).toBe('batch_kicked');
      // Prior kick must be terminal so concurrent single-flight does not win
      // over cooldown (production: prior batch finished quickly / failed).
      expect(first.batchKickTaskId).toBeTruthy();
      store.startTask(first.batchKickTaskId!);
      store.completeTask(first.batchKickTaskId!);

      clock = NOW + 60_000; // +1m still inside 30m cooldown
      const second = await service.handleBatchOutcome({
        outcome: outcome({
          runKey: 'cd-2',
          generatedAt: new Date(clock).toISOString(),
        }),
        localPath: checkout,
      });
      expect(second.batchKickResult).toBe('batch_skipped_cooldown');
      expect(launches).toHaveLength(1);
    });

    test('scout spawn arms kickBatchWhenScoutCompletes', async () => {
      process.env.KOOKR_PIPELINE_BATCH_KICK = '1';
      const result = await service.handleBatchOutcome({
        outcome: outcome({ runKey: 'arm-pending' }),
        localPath: checkout,
      });
      expect(result.spawnedScoutTaskId).toBeTruthy();
      expect(result.state.kickBatchWhenScoutCompletes).toBe(true);
      expect(result.state.kickBatchWhenScoutCompletesAt).toBe(new Date(clock).toISOString());
    });

    test('scout-complete kick launches batch when pending flag set', async () => {
      process.env.KOOKR_PIPELINE_BATCH_KICK = '1';
      // First empty arms scout + pending kick flag.
      const first = await service.handleBatchOutcome({
        outcome: outcome({ runKey: 'scout-arm' }),
        localPath: checkout,
      });
      expect(first.spawnedScoutTaskId).toBeTruthy();
      expect(first.state.kickBatchWhenScoutCompletes).toBe(true);
      const scoutTaskId = first.spawnedScoutTaskId!;

      // Scout task already exists in store from launcher mock.
      const kick = await service.maybeKickBatchOnScoutTerminal(scoutTaskId, { kind: 'completed' });
      expect(kick).not.toBeNull();
      expect(kick!.result).toBe('batch_kicked');
      expect(kick!.taskId).toBeTruthy();
      // idea-scout launch + batch kick
      expect(launches).toHaveLength(2);
      expect(launches[1]!.playbookId).toMatch(/parallel-issue-batch/);

      const audit = await readFile(join(kookrDir, 'audit.jsonl'), 'utf-8');
      expect(audit).toContain(BATCH_KICK_SCOUT_COMPLETE_SOURCE);
      expect(audit).toContain('batch_kicked');
    });

    test('scout-complete failure clears pending without kick', async () => {
      process.env.KOOKR_PIPELINE_BATCH_KICK = '1';
      const first = await service.handleBatchOutcome({
        outcome: outcome({ runKey: 'scout-fail' }),
        localPath: checkout,
      });
      const scoutTaskId = first.spawnedScoutTaskId!;

      const kick = await service.maybeKickBatchOnScoutTerminal(scoutTaskId, { kind: 'failed' });
      expect(kick).toBeNull();
      expect(launches).toHaveLength(1); // scout only

      // Reload state via another handle that is alreadyHandled-ish path: load by replaying
      // a second empty after flag clear — or just read the state file.
      const stateRaw = await readFile(
        join(stateDir, 'jeanibarz-lucy.json'),
        'utf-8',
      );
      const state = JSON.parse(stateRaw) as { kickBatchWhenScoutCompletes?: boolean };
      expect(state.kickBatchWhenScoutCompletes).toBeUndefined();
    });

    test('scout-complete concurrent skip still clears pending', async () => {
      process.env.KOOKR_PIPELINE_BATCH_KICK = '1';
      const first = await service.handleBatchOutcome({
        outcome: outcome({ runKey: 'scout-conc' }),
        localPath: checkout,
      });
      const scoutTaskId = first.spawnedScoutTaskId!;

      store.createTask({
        prompt: 'Parallel Issue Batch for jeanibarz/lucy',
        cwd: checkout,
        playbookId: 'parallel-issue-batch.md',
        playbookParameterValues: { repoFullName: 'jeanibarz/lucy' },
      });

      const kick = await service.maybeKickBatchOnScoutTerminal(scoutTaskId, { kind: 'completed' });
      expect(kick?.result).toBe('batch_skipped_concurrent');
      // no additional batch launch
      expect(launches).toHaveLength(1);

      const stateRaw = await readFile(join(stateDir, 'jeanibarz-lucy.json'), 'utf-8');
      const state = JSON.parse(stateRaw) as { kickBatchWhenScoutCompletes?: boolean };
      expect(state.kickBatchWhenScoutCompletes).toBeUndefined();
    });
  });

  test('done after starvation alert emits recovered operational alert', async () => {
    // Seed an episode via two product empties.
    await service.handleBatchOutcome({
      outcome: outcome({ runKey: 'ep-1' }),
      localPath: checkout,
    });
    clock = NOW + 3 * 60 * 60 * 1000;
    await service.handleBatchOutcome({
      outcome: outcome({ runKey: 'ep-2', generatedAt: new Date(clock).toISOString() }),
      localPath: checkout,
    });
    expect(alerts.some((a) => a.type === 'alert' && a.operationalAlert?.state === 'fired')).toBe(true);

    clock = NOW + 4 * 60 * 60 * 1000;
    const done = await service.handleBatchOutcome({
      outcome: outcome({
        outcome: 'done',
        runKey: 'ep-done',
        reason: 'Batch complete: 3 issues merged',
        generatedAt: new Date(clock).toISOString(),
      }),
      localPath: checkout,
    });
    expect(done.decision.applicable).toBe(false);
    expect(done.recoveredAlertEmitted).toBe(true);
    expect(alerts.some((a) => a.type === 'alert' && a.operationalAlert?.state === 'recovered')).toBe(true);

    const audit = await readFile(join(kookrDir, 'audit.jsonl'), 'utf-8');
    expect(audit).toContain('pipeline_starvation_alert_recovered');
  });

  test('starvation fire/recover spools operator signals via detectorBroadcast bridge (#1986)', async () => {
    const signalDir = await mkdtemp(join(tmpdir(), 'kookr-starv-signal-'));
    const pendingWrites: Promise<unknown>[] = [];
    // Mirrors index.ts detectorBroadcast: WS broadcast + operationalAlert→signal spool.
    const detectorBroadcast = (msg: ServerMessage) => {
      alerts.push(msg);
      const input = operationalAlertToSignal(msg);
      if (input) pendingWrites.push(writeOperatorSignal(signalDir, input));
    };
    service = new PipelineStarvationService({
      taskStore: store,
      launcher: async (opts) => {
        launches.push(opts);
        const task = store.createTask({
          prompt: opts.prompt,
          cwd: opts.cwd,
          name: opts.name,
          playbookId: opts.playbookId,
          projectId: opts.projectId,
          parentTaskId: opts.parentTaskId,
          playbookParameterValues: opts.playbookParameterValues,
        });
        const result: LaunchResult<Task> = { task, queued: false, idempotentReplay: false };
        return result;
      },
      broadcast: detectorBroadcast,
      kookrDir,
      stateDir,
      ideaScoutStateDirForRepo: () => ideaScoutBase,
      now: () => clock,
    });

    await service.handleBatchOutcome({
      outcome: outcome({ runKey: 'bridge-1' }),
      localPath: checkout,
    });
    clock = NOW + 3 * 60 * 60 * 1000;
    await service.handleBatchOutcome({
      outcome: outcome({ runKey: 'bridge-2', generatedAt: new Date(clock).toISOString() }),
      localPath: checkout,
    });
    await Promise.all(pendingWrites);
    pendingWrites.length = 0;

    const afterFire = await listSignalFiles(signalDir);
    expect(afterFire).toContain('op-pipeline-starvation-jeanibarz-lucy-alert.json');
    const fireSignal = await readSignal(signalDir, 'op-pipeline-starvation-jeanibarz-lucy-alert.json');
    expect(fireSignal).toMatchObject({
      kind: 'alert',
      key: 'op:pipeline:starvation:jeanibarz/lucy:alert',
      source: 'pipeline_starvation',
    });

    clock = NOW + 4 * 60 * 60 * 1000;
    await service.handleBatchOutcome({
      outcome: outcome({
        outcome: 'done',
        runKey: 'bridge-done',
        reason: 'Batch complete',
        generatedAt: new Date(clock).toISOString(),
      }),
      localPath: checkout,
    });
    await Promise.all(pendingWrites);

    const afterRecover = await listSignalFiles(signalDir);
    expect(afterRecover).toContain('op-pipeline-starvation-jeanibarz-lucy-clear.json');
    const clearSignal = await readSignal(signalDir, 'op-pipeline-starvation-jeanibarz-lucy-clear.json');
    expect(clearSignal).toMatchObject({
      kind: 'clear',
      key: 'op:pipeline:starvation:jeanibarz/lucy:clear',
    });
  });
});
