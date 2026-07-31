import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore, type Task } from '../core/tasks.js';
import {
  BATCH_OUTCOME_SCHEMA_VERSION,
  type BatchOutcomeRecord,
} from '../core/pipeline-starvation.js';
import {
  PipelineStarvationService,
  STARVATION_TRIGGER_PROVENANCE,
} from './pipeline-starvation-service.js';
import type { LaunchOpts, LaunchResult } from '../shared/contracts/launch.js';
import type { ServerMessage } from '../shared/contracts/messages.js';

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

    clock = NOW + 3 * 60 * 60 * 1000; // +3h still inside 4h scout dedup and 12h alert window
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
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'state.md'), '# scout\n\n<promise>DONE</promise>\n', 'utf-8');

    const result = await service.handleBatchOutcome({
      outcome: outcome(),
      localPath: checkout,
    });
    expect(result.decision.spawnScout).toBe(false);
    expect(result.decision.spawnSkipReason).toMatch(/successful ideation/i);
    expect(launches).toHaveLength(0);
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
});