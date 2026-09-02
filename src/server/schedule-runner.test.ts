import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScheduleStore } from '../core/schedule.js';
import {
  ScheduleRunner,
  defaultExecScheduleProbe,
  type ScheduleRunnerDeps,
  isTaskBlockingSchedule,
  SCHEDULE_GATE_MAX_TASK_AGE_MS,
  FIRE_WALL_CLOCK_CAP_MS,
  SCHEDULE_MAX_FIRES_PER_TICK,
} from './schedule-runner.js';
import { ScheduleService } from './schedule-service.js';
import { ScheduleValidator } from './schedule-validator.js';
import { PendingQueueFullError } from './launch-service.js';
import { aTask } from '../core/__fixtures__/task-builders.js';

const INVALID_PLAYBOOK_PATH_ERROR = 'Playbook path must stay inside the selected playbooks directory';

/** Synthetic relaunch-arbiter key the catch-up path uses for `scheduleId` (#1900). */
const catchUpKey = (scheduleId: string) => ({ repo: `schedule:${scheduleId}`, number: 0 });

describe('ScheduleRunner', () => {
  let dir: string;
  let store: ScheduleStore;
  let service: ScheduleService;
  let validator: ScheduleValidator;
  let launched: Array<{
    prompt: string;
    cwd: string;
    agentType?: string;
    effort?: string;
    model?: string;
    modelTier?: string;
    launchSource?: string;
    dependencies?: string[];
    autoCloseOnSignal?: boolean;
    playbookParameterValues?: Record<string, string>;
    playbookSource?: {
      id: string;
      scope: string;
      sourceCwd: string;
      sourceDigest: string;
    };
  }>;
  let taskIdCounter: number;
  let activeTaskIds: Set<string>;
  /** Task ids the mock launcher pended instead of launching (issue #1526 Phase A: at-capacity fires queue). */
  let pendingTaskIds: Set<string>;
  let activeCount: number;
  let maxActive: number;
  let runners: Set<ScheduleRunner>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'runner-test-'));
    store = new ScheduleStore(dir);
    validator = new ScheduleValidator();
    service = new ScheduleService({ store, validator });
    launched = [];
    taskIdCounter = 0;
    activeTaskIds = new Set();
    pendingTaskIds = new Set();
    activeCount = 0;
    maxActive = 10;
    runners = new Set();

    await mkdir(join(dir, '.kookr', 'playbooks'), { recursive: true });
    await writeFile(join(dir, '.kookr', 'playbooks', 'test.md'), `---
name: Test Playbook
description: A test playbook
parameters: []
checklist:
  - Step 1
---

Do the test thing.
`);
  });

  afterEach(async () => {
    await Promise.all([...runners].map((runner) => runner.stop()));
    delete process.env.KOOKR_NO_CATCHUP;
    delete process.env.KOOKR_AUTO_CATCHUP;
    delete process.env.KOOKR_MANUAL_CATCHUP;
    await rm(dir, { recursive: true, force: true });
  });

  function createRunner(overrides: Partial<ScheduleRunnerDeps> = {}) {
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      // Mirrors real launchTask semantics (src/server/launch-service.ts): at
      // or over capacity, the task is created and pended rather than
      // launched (issue #1526 Phase A) — `queued: true`, no active-count
      // increment. Below capacity, unchanged: launches immediately.
      launcher: async (opts) => {
        const taskId = `task-${++taskIdCounter}`;
        launched.push({
          prompt: opts.prompt,
          cwd: opts.cwd,
          agentType: opts.agentType,
          effort: opts.effort,
          model: opts.model,
          modelTier: opts.modelTier,
          launchSource: opts.launchSource,
          dependencies: opts.dependencies,
          priorAgentSubstitutions: opts.priorAgentSubstitutions,
          autoCloseOnSignal: opts.autoCloseOnSignal,
          playbookParameterValues: opts.playbookParameterValues,
          playbookSource: opts.playbookSource,
        });
        const queued = activeCount >= maxActive;
        if (queued) {
          pendingTaskIds.add(taskId);
        } else {
          activeTaskIds.add(taskId);
          activeCount += 1;
        }
        return { task: aTask({ id: taskId, prompt: opts.prompt, cwd: opts.cwd }), queued };
      },
      getActiveCount: () => activeCount,
      getMaxActiveTasks: () => maxActive,
      isTaskBlockingSchedule: (taskId) => activeTaskIds.has(taskId) || pendingTaskIds.has(taskId),
      getBlockingTaskStatus: (taskId) => {
        if (activeTaskIds.has(taskId)) return 'inProgress';
        if (pendingTaskIds.has(taskId)) return 'pending';
        return undefined;
      },
      ...overrides,
    });
    runners.add(runner);
    return runner;
  }

  function replaceSchedule(id: string, patch: Partial<ReturnType<ScheduleStore['get']> extends infer T ? NonNullable<T> : never>) {
    const schedule = store.get(id)!;
    store.replace({ ...schedule, ...patch });
    return store.get(id)!;
  }

  it('fires a due schedule on tick', async () => {
    const schedule = store.create({
      name: 'Test',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner();
    await runner.tick();

    expect(launched).toHaveLength(1);
    expect(store.get(schedule.id)!.latestExecution?.taskId).toBe('task-1');
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('running');
    expect(store.get(schedule.id)!.executionLedger).toEqual([
      expect.objectContaining({
        taskId: 'task-1',
        outcome: 'running',
        decision: 'cron_due',
        scheduledFor: expect.any(String),
      }),
    ]);
  });

  it('fires with the persisted parameters and exact source identity from a distinct task cwd', async () => {
    const targetCwd = join(dir, 'target');
    await mkdir(targetCwd, { recursive: true });
    await writeFile(join(dir, '.kookr', 'playbooks', 'parameterized.md'), `---
name: Parameterized
parameters:
  - name: repo
    required: true
---

Review {{repo}}.
`);
    const schedule = store.create({
      name: 'Configured review',
      cron: '* * * * *',
      playbook: {
        path: 'parameterized.md',
        parameters: { repo: 'owner/repo' },
        scope: 'project',
        sourceCwd: dir,
      },
      cwd: targetCwd,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    await createRunner().tick();

    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({
      prompt: expect.stringContaining('Review owner/repo.'),
      cwd: targetCwd,
      playbookParameterValues: { repo: 'owner/repo' },
      playbookSource: {
        id: 'parameterized.md',
        scope: 'project',
        sourceCwd: dir,
        sourceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
    });
  });

  it('forwards schedule effort and model pins into the launcher (#1518)', async () => {
    const schedule = store.create({
      name: 'Fable max',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
      agentType: 'claude-code',
      effort: 'max',
      model: 'claude-fable-5',
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner();
    await runner.tick();

    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({
      effort: 'max',
      model: 'claude-fable-5',
      agentType: 'claude-code',
      // issue #1526 Phase C / C3: schedule provenance — exempts the fire from
      // the spawn burst budget and stamps metadata.launchSource.
      launchSource: 'schedule',
    });
  });

  it('forwards portable small intent while following the live default agent', async () => {
    const schedule = store.create({
      name: 'Routine sentinel',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
      modelTier: 'small',
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    let liveDefault: 'claude-code' | 'codex-cli' = 'claude-code';
    const runner = createRunner({ getDefaultAgentType: () => liveDefault });
    liveDefault = 'codex-cli';
    await runner.tick();

    expect(launched[0]).toMatchObject({
      agentType: 'codex-cli',
      modelTier: 'small',
      launchSource: 'schedule',
    });
  });

  it('forwards playbook launch dependencies into one-shot scheduled launches', async () => {
    await writeFile(join(dir, '.kookr', 'playbooks', 'dependent.md'), `---
name: Dependent Playbook
description: A dependency-gated playbook
dependencies: [kb]
parameters: []
checklist: []
---

Do dependency-gated work.
`);
    const schedule = store.create({
      name: 'Dependent',
      cron: '* * * * *',
      playbook: { path: 'dependent.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner();
    await runner.tick();

    expect(launched[0]?.dependencies).toEqual(['kb']);
  });

  it.each([
    ['enabled', true],
    ['explicitly disabled', false],
    ['unset', undefined],
  ] as const)('R10.6 forwards the playbook completion policy when %s', async (_label, autoCloseOnSignal) => {
    await writeFile(join(dir, '.kookr', 'playbooks', 'completion-policy.md'), `---
name: Completion Policy
description: Exercise scheduled completion policy propagation
${autoCloseOnSignal === undefined ? '' : `autoCloseOnSignal: ${autoCloseOnSignal}\n`}parameters: []
checklist: []
---

Run the scheduled task.
`);
    const schedule = store.create({
      name: 'Completion policy',
      cron: '* * * * *',
      playbook: { path: 'completion-policy.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner();
    await runner.tick();

    expect(launched[0]?.autoCloseOnSignal).toBe(autoCloseOnSignal);
  });

  it('records a dependency-parked one-shot separately from a capacity queue', async () => {
    await writeFile(join(dir, '.kookr', 'playbooks', 'dependent-parked.md'), `---
name: Parked Dependency Playbook
description: A dependency-gated playbook
dependencies: [kb]
parameters: []
checklist: []
---

Do dependency-gated work.
`);
    const schedule = store.create({
      name: 'Dependency parked',
      cron: '* * * * *',
      playbook: { path: 'dependent-parked.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });
    const runner = createRunner({
      launcher: vi.fn(async () => ({
        task: aTask({ id: 'task-dependency-parked', prompt: 'Do dependency-gated work.', cwd: dir }),
        queued: true,
        parked: true,
        dependencyAdmission: {
          status: 'parked',
          reason: 'dependency_degraded',
          dependencies: [{ dependency: 'kb', state: 'degraded' }],
          parkedAt: new Date().toISOString(),
        },
      })),
    });

    const result = await runner.runNow(schedule.id);

    expect(result).toMatchObject({
      taskId: 'task-dependency-parked',
      queued: true,
      parked: true,
      outcome: 'parked_dependency',
      reasonCode: 'dependency_degraded',
    });
    expect(store.get(schedule.id)?.latestExecution).toMatchObject({
      taskId: 'task-dependency-parked',
      outcome: 'parked_dependency',
      reasonCode: 'dependency_degraded',
    });
  });

  it('refuses to fire an archived schedule via Run Now and does not re-materialize its rollup (issue #2981)', async () => {
    const schedule = store.create({
      name: 'Archived Loop',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    store.archive(schedule.id, 'no live supply or demand');
    // Archiving drops the ROI rollup — the guard must not bring it back.
    expect(store.getRollup(schedule.id)).toBeUndefined();

    const runner = createRunner();
    const result = await runner.runNow(schedule.id);

    expect(result).toEqual({ error: 'Schedule is archived' });
    expect(launched).toHaveLength(0);
    // No fire bookkeeping ran (no reserved receipt) and the rollup stays gone.
    expect(store.get(schedule.id)?.currentExecution).toBeUndefined();
    expect(store.getRollup(schedule.id)).toBeUndefined();
  });

  it('inherits getDefaultAgentType when schedule has no agentType pin', async () => {
    const schedule = store.create({
      name: 'Unpinned inherit',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
      // no agentType
    });
    expect(schedule.agentType).toBeUndefined();
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner({
      getDefaultAgentType: () => 'grok-build',
      getAvailableAgentTypes: () => ['claude-code', 'codex-cli', 'grok-build'],
    });
    await runner.tick();

    expect(launched).toHaveLength(1);
    expect(launched[0]?.agentType).toBe('grok-build');
  });

  describe('pinned-agent fallback on unavailability (issue #1895 / #1699 WS1.3)', () => {
    it('pass-through when the pinned agent is available', async () => {
      const schedule = store.create({
        name: 'Pinned available',
        cron: '* * * * *',
        playbook: { path: 'test.md', parameters: {} },
        cwd: dir,
        agentType: 'codex-cli',
        effort: 'high',
      });
      replaceSchedule(schedule.id, {
        createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      });

      const substitutions: number[] = [];
      const runner = createRunner({
        getAvailableAgentTypes: () => ['claude-code', 'codex-cli'],
        recordAgentSubstitution: () => {
          substitutions.push(1);
        },
      });
      await runner.tick();

      expect(launched).toHaveLength(1);
      expect(launched[0]).toMatchObject({
        agentType: 'codex-cli',
        effort: 'high',
      });
      expect(substitutions).toHaveLength(0);
      expect(store.get(schedule.id)!.latestExecution).toMatchObject({
        outcome: 'running',
        reasonCode: 'none',
      });
    });

    it('substitutes an unavailable pin to an available agent and stamps reasonCode', async () => {
      const schedule = store.create({
        name: 'Pinned unavailable',
        cron: '* * * * *',
        playbook: { path: 'test.md', parameters: {} },
        cwd: dir,
        agentType: 'codex-cli',
        // Effort pin is for codex; must be dropped on substitution so the
        // substitute (claude) is not rejected for an invalid effort.
        effort: 'minimal',
      });
      replaceSchedule(schedule.id, {
        createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      });

      const substitutions: number[] = [];
      const runner = createRunner({
        // codex-cli is not registered (preflight-absent) — only claude is.
        getAvailableAgentTypes: () => ['claude-code'],
        recordAgentSubstitution: () => {
          substitutions.push(1);
        },
      });
      await runner.tick();

      expect(launched).toHaveLength(1);
      expect(launched[0]).toMatchObject({
        agentType: 'claude-code',
      });
      // Effort pin for the unavailable agent must not travel with the substitute.
      expect(launched[0]!.effort).toBeUndefined();
      expect(substitutions).toHaveLength(1);
      const latest = store.get(schedule.id)!.latestExecution;
      expect(latest).toMatchObject({
        outcome: 'running',
        reasonCode: 'agent_substituted',
      });
      expect(latest?.message).toMatch(/codex-cli.*claude-code/);
      // Never a dispatch_failed for a pinned-but-unavailable agent.
      expect(latest?.outcome).not.toBe('dispatch_failed');
    });

    it('preserves a compatible effort pin independently when provider fallback drops the model pin', async () => {
      const schedule = store.create({
        name: 'Pinned fallback intent',
        cron: '* * * * *',
        playbook: { path: 'test.md', parameters: {} },
        cwd: dir,
        agentType: 'codex-cli',
        model: 'codex-provider-model',
        effort: 'high',
      });
      replaceSchedule(schedule.id, {
        createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      });

      const runner = createRunner({
        getAvailableAgentTypes: () => ['claude-code'],
      });
      await runner.tick();

      expect(launched).toHaveLength(1);
      expect(launched[0]).toMatchObject({ agentType: 'claude-code', effort: 'high' });
      expect(launched[0]!.model).toBeUndefined();
    });

    it('parks via provider_paused when no substitute is registered', async () => {
      const schedule = store.create({
        name: 'No agents',
        cron: '* * * * *',
        playbook: { path: 'test.md', parameters: {} },
        cwd: dir,
        agentType: 'codex-cli',
      });
      replaceSchedule(schedule.id, {
        createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      });

      const runner = createRunner({
        getAvailableAgentTypes: () => [],
      });
      await runner.tick();

      expect(launched).toHaveLength(0);
      expect(store.get(schedule.id)!.latestExecution).toMatchObject({
        outcome: 'skipped_provider_paused',
        reasonCode: 'provider_paused',
      });
      expect(store.get(schedule.id)!.latestExecution?.outcome).not.toBe('dispatch_failed');
    });

    it('does not spawn a blacklisted pin and substitutes onto a remaining agent (issue #3025)', async () => {
      const schedule = store.create({
        name: 'Blacklisted pin',
        cron: '* * * * *',
        playbook: { path: 'test.md', parameters: {} },
        cwd: dir,
        agentType: 'claude-code',
      });
      replaceSchedule(schedule.id, {
        createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      });

      const runner = createRunner({
        getAvailableAgentTypes: () => ['claude-code', 'codex-cli', 'grok-build'],
        getBlacklistedAgentTypes: () => ['claude-code'],
      });
      await runner.tick();

      expect(launched).toHaveLength(1);
      expect(launched[0]!.agentType).toBe('codex-cli');
      expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('agent_substituted');
    });

    it('parks when the pinned agent is blacklisted and no substitute remains (issue #3025)', async () => {
      const schedule = store.create({
        name: 'All blacklisted',
        cron: '* * * * *',
        playbook: { path: 'test.md', parameters: {} },
        cwd: dir,
        agentType: 'claude-code',
      });
      replaceSchedule(schedule.id, {
        createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      });

      const runner = createRunner({
        getAvailableAgentTypes: () => ['claude-code', 'codex-cli'],
        getBlacklistedAgentTypes: () => ['claude-code', 'codex-cli'],
      });
      await runner.tick();

      expect(launched).toHaveLength(0);
      expect(store.get(schedule.id)!.latestExecution).toMatchObject({
        outcome: 'skipped_provider_paused',
        reasonCode: 'provider_paused',
      });
    });

    it('substitutes a deprioritized pin when a healthy alternative remains', async () => {
      const schedule = store.create({
        name: 'Deprioritized pin',
        cron: '* * * * *',
        playbook: { path: 'test.md', parameters: {} },
        cwd: dir,
        agentType: 'grok-build',
      });
      replaceSchedule(schedule.id, {
        createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      });

      const substitutions: number[] = [];
      const runner = createRunner({
        getAvailableAgentTypes: () => ['claude-code', 'codex-cli', 'grok-build'],
        getDeprioritizedAgentTypes: () => ['grok-build'],
        recordAgentSubstitution: () => {
          substitutions.push(1);
        },
      });
      await runner.tick();

      expect(launched).toHaveLength(1);
      expect(launched[0]!.agentType).toBe('claude-code');
      expect(launched[0]!.priorAgentSubstitutions).toEqual([
        { reason: 'schedule_sub', from: 'grok-build', to: 'claude-code' },
      ]);
      expect(substitutions).toHaveLength(1);
      expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('agent_substituted');
    });

    it('parks when the only substitute is disallowed (issue #2001)', async () => {
      const schedule = store.create({
        name: 'No allowed fallback',
        cron: '* * * * *',
        playbook: { path: 'test.md', parameters: {} },
        cwd: dir,
        agentType: 'grok-build',
      });
      replaceSchedule(schedule.id, {
        createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      });

      const runner = createRunner({
        getAvailableAgentTypes: () => ['codex-cli', 'grok-build'],
        getDeprioritizedAgentTypes: () => ['grok-build'],
        getAgentFallbackPolicy: () => ({ disallow: ['codex-cli'] }),
      });
      await runner.tick();

      expect(launched).toHaveLength(0);
      expect(store.get(schedule.id)!.latestExecution).toMatchObject({
        outcome: 'skipped_provider_paused',
        reasonCode: 'provider_paused',
      });
    });

    it('does not land on codex-cli under default-style denylist when grok is deprioritized (issue #2001)', async () => {
      const schedule = store.create({
        name: 'Grok default',
        cron: '* * * * *',
        playbook: { path: 'test.md', parameters: {} },
        cwd: dir,
        agentType: 'grok-build',
      });
      replaceSchedule(schedule.id, {
        createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      });

      const runner = createRunner({
        getAvailableAgentTypes: () => ['claude-code', 'codex-cli', 'grok-build'],
        getDeprioritizedAgentTypes: () => ['grok-build'],
        getAgentFallbackPolicy: () => ({ disallow: ['codex-cli'] }),
      });
      await runner.tick();

      expect(launched).toHaveLength(1);
      expect(launched[0]!.agentType).toBe('claude-code');
      expect(launched[0]!.agentType).not.toBe('codex-cli');
    });
  });

  describe('Grok auth availability gate (issue #2194)', () => {
    it('substitutes away from grok-build when Grok session auth is unusable and a non-Grok agent is healthy', async () => {
      const schedule = store.create({
        name: 'Default grok, auth expired',
        cron: '* * * * *',
        playbook: { path: 'test.md', parameters: {} },
        cwd: dir,
        // no pin — inherits defaultAgentType
      });
      replaceSchedule(schedule.id, {
        createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      });

      const refresh = vi.fn(async () => {});
      const runner = createRunner({
        getDefaultAgentType: () => 'grok-build',
        getAvailableAgentTypes: () => ['claude-code', 'codex-cli', 'grok-build'],
        isGrokAuthUsable: () => false,
        refreshGrokAuthAvailability: refresh,
        getAgentFallbackPolicy: () => ({ disallow: ['codex-cli'] }),
      });
      await runner.tick();

      expect(refresh).toHaveBeenCalled();
      expect(launched).toHaveLength(1);
      expect(launched[0]!.agentType).toBe('claude-code');
      expect(launched[0]!.agentType).not.toBe('grok-build');
      expect(store.get(schedule.id)!.latestExecution).toMatchObject({
        outcome: 'running',
        reasonCode: 'agent_substituted',
      });
    });

    it('still dispatches a schedule already resolved to a non-Grok agent when Grok auth is expired', async () => {
      const schedule = store.create({
        name: 'Pinned claude',
        cron: '* * * * *',
        playbook: { path: 'test.md', parameters: {} },
        cwd: dir,
        agentType: 'claude-code',
      });
      replaceSchedule(schedule.id, {
        createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      });

      const runner = createRunner({
        getAvailableAgentTypes: () => ['claude-code', 'codex-cli', 'grok-build'],
        isGrokAuthUsable: () => false,
        refreshGrokAuthAvailability: async () => {},
      });
      await runner.tick();

      expect(launched).toHaveLength(1);
      expect(launched[0]!.agentType).toBe('claude-code');
      expect(store.get(schedule.id)!.latestExecution).toMatchObject({
        outcome: 'running',
        reasonCode: 'none',
      });
      // Regression pin: Grok session expiry must never re-couple a healthy
      // non-Grok fire to a dispatch_failed thrash.
      expect(store.get(schedule.id)!.latestExecution?.outcome).not.toBe('dispatch_failed');
    });

    it('records dispatch_failed / auth_expired when Grok-only and session auth is unusable', async () => {
      const schedule = store.create({
        name: 'Grok only',
        cron: '* * * * *',
        playbook: { path: 'test.md', parameters: {} },
        cwd: dir,
        agentType: 'grok-build',
      });
      replaceSchedule(schedule.id, {
        createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      });

      const runner = createRunner({
        getAvailableAgentTypes: () => ['grok-build'],
        isGrokAuthUsable: () => false,
        refreshGrokAuthAvailability: async () => {},
      });
      await runner.tick();

      expect(launched).toHaveLength(0);
      expect(store.get(schedule.id)!.latestExecution).toMatchObject({
        outcome: 'dispatch_failed',
        reasonCode: 'auth_expired',
      });
      expect(store.get(schedule.id)!.latestExecution?.message).toMatch(/grok login/i);
    });

    it('classifies a late GrokAuthPreflightError from the launcher as auth_expired', async () => {
      const schedule = store.create({
        name: 'Late auth fail',
        cron: '* * * * *',
        playbook: { path: 'test.md', parameters: {} },
        cwd: dir,
        agentType: 'grok-build',
      });
      replaceSchedule(schedule.id, {
        createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      });

      const err = Object.assign(
        new Error(
          'Grok authentication expired or is too close to expiry at 2026-08-08T13:11:01.000Z. Run `grok login --device-code`',
        ),
        { code: 'grok_auth_preflight', name: 'GrokAuthPreflightError' },
      );
      const runner = createRunner({
        // Gate thinks auth is ok (stale) so resolve lets grok through; launcher
        // then refuses — must still land as auth_expired, not generic launch_error.
        getAvailableAgentTypes: () => ['grok-build'],
        isGrokAuthUsable: () => true,
        launcher: async () => {
          throw err;
        },
      });
      await runner.tick();

      expect(store.get(schedule.id)!.latestExecution).toMatchObject({
        outcome: 'dispatch_failed',
        reasonCode: 'auth_expired',
      });
    });
  });

  it('skips disabled schedules', async () => {
    const schedule = store.create({
      name: 'Disabled',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
      enabled: false,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner();
    await runner.tick();

    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution).toBeUndefined();
  });

  it('skips when previous run is still active', async () => {
    const schedule = store.create({
      name: 'Active',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner();
    await runner.tick();
    expect(launched).toHaveLength(1);

    replaceSchedule(schedule.id, {
      lastScheduledFor: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    await runner.tick();

    expect(launched).toHaveLength(1);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_active');
    expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('previous_run_active');
    expect(store.get(schedule.id)!.executionLedger.at(-1)).toEqual(expect.objectContaining({
      outcome: 'skipped_active',
      reasonCode: 'previous_run_active',
      blockingTaskId: 'task-1',
    }));
    // The blocking pointer must survive the skipped_active write, or a
    // second consecutive skip would lose track of the still-active task.
    expect(store.get(schedule.id)!.latestExecution?.taskId).toBe('task-1');
  });

  it('preserves the blocking pointer across two consecutive skipped_active writes', async () => {
    const schedule = store.create({
      name: 'ActiveTwice',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    });

    const runner = createRunner();
    await runner.tick();
    expect(launched).toHaveLength(1);

    // Two consecutive skips while the task is still active — before the fix,
    // the first skip already wiped latestExecution.taskId.
    for (let i = 0; i < 2; i++) {
      replaceSchedule(schedule.id, { lastScheduledFor: new Date(Date.now() - 2 * 60_000).toISOString() });
      await runner.tick();
      expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_active');
      expect(store.get(schedule.id)!.latestExecution?.taskId).toBe('task-1');
    }
    expect(launched).toHaveLength(1);
    expect(store.get(schedule.id)!.enabled).toBe(true);
    expect(store.get(schedule.id)!.consecutiveFailures ?? 0).toBe(0);
    expect(store.get(schedule.id)!.stopReason).toBeUndefined();
  });

  it('three overlap-skips do not fail-close the schedule (issue #2458)', async () => {
    const schedule = store.create({
      name: 'Lucy Orchestration Effectiveness',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    });

    const runner = createRunner();
    await runner.tick();
    expect(launched).toHaveLength(1);

    for (let i = 0; i < 3; i++) {
      replaceSchedule(schedule.id, { lastScheduledFor: new Date(Date.now() - 2 * 60_000).toISOString() });
      await runner.tick();
    }

    const after = store.get(schedule.id)!;
    expect(launched).toHaveLength(1);
    expect(after.latestExecution?.outcome).toBe('skipped_active');
    expect(after.latestExecution?.reasonCode).toBe('previous_run_active');
    expect(after.latestExecution?.message).toBe('Previous run still active');
    expect(after.consecutiveFailures ?? 0).toBe(0);
    expect(after.lastRunStatus).toBe('skipped');
    expect(after.enabled).toBe(true);
    expect(after.stopReason).toBeUndefined();
    expect(after.operatorHold).toBeUndefined();
  });

  it('re-arms a leftover launch_error pause on tick when the daemon is healthy (issue #2459)', async () => {
    const healthyService = new ScheduleService({
      store,
      validator,
      getFailureAlertThreshold: () => 3,
      getDaemonHealthy: () => true,
      getReadyAt: () => '2026-08-13T08:34:00.000Z',
    });
    const schedule = store.create({
      name: 'Lucy Deploy Convergence',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    for (const at of ['2026-08-12T12:30:00.000Z', '2026-08-12T12:45:00.000Z', '2026-08-12T13:00:00.000Z']) {
      const receipt = await healthyService.reserveExecution(store.get(schedule.id)!, 'cron', at);
      await healthyService.markExecutionOutcome(
        schedule.id,
        receipt.id,
        'dispatch_failed',
        'launch_error',
        'Initial prompt submission was not confirmed',
      );
    }
    expect(store.get(schedule.id)!.enabled).toBe(false);
    expect(store.get(schedule.id)!.operatorHold).toBe(true);
    const paused = store.get(schedule.id)!;
    store.replace({
      ...paused,
      latestExecution: paused.latestExecution
        ? { ...paused.latestExecution, evaluatedAt: '2026-08-12T13:00:00.000Z' }
        : paused.latestExecution,
    });

    const runner = createRunner({ service: healthyService });
    await runner.tick();

    const after = store.get(schedule.id)!;
    expect(after.enabled).toBe(true);
    expect(after.operatorHold).toBeUndefined();
    expect(after.stopReason).toBeUndefined();
    expect(after.consecutiveFailures).toBe(0);
  });

  it('does not re-arm a live launch_error pause that happened after ready (issue #2459 / #2353)', async () => {
    const healthyService = new ScheduleService({
      store,
      validator,
      getFailureAlertThreshold: () => 3,
      getDaemonHealthy: () => true,
      getReadyAt: () => '2026-08-12T08:00:00.000Z',
    });
    const schedule = store.create({
      name: 'Live Launch Error',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    for (const at of ['2026-08-13T12:30:00.000Z', '2026-08-13T12:45:00.000Z', '2026-08-13T13:00:00.000Z']) {
      const receipt = await healthyService.reserveExecution(store.get(schedule.id)!, 'cron', at);
      await healthyService.markExecutionOutcome(
        schedule.id,
        receipt.id,
        'dispatch_failed',
        'launch_error',
        'Initial prompt submission was not confirmed',
      );
    }
    expect(store.get(schedule.id)!.enabled).toBe(false);

    const runner = createRunner({ service: healthyService });
    await runner.tick();

    expect(store.get(schedule.id)!.enabled).toBe(false);
    expect(store.get(schedule.id)!.stopReason).toBe('consecutive_failures');
  });

  it('does not re-arm a cancelled-timeout pause on a healthy tick (issue #2459 / #2353)', async () => {
    const healthyService = new ScheduleService({
      store,
      validator,
      getFailureAlertThreshold: () => 3,
      getDaemonHealthy: () => true,
      getReadyAt: () => '2026-08-13T08:34:00.000Z',
    });
    const schedule = store.create({
      name: 'Requirements-Redundancy',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });

    for (const [i, at] of ['2026-08-12T10:00:00.000Z', '2026-08-12T10:05:00.000Z', '2026-08-12T10:10:00.000Z'].entries()) {
      const receipt = await healthyService.reserveExecution(store.get(schedule.id)!, 'cron', at);
      await healthyService.markExecutionAccepted(schedule.id, receipt.id, `timeout-${i}`, false);
      await healthyService.recordTaskTerminalOutcome(`timeout-${i}`, 'cancelled', 'timeout');
    }
    expect(store.get(schedule.id)!.enabled).toBe(false);

    const runner = createRunner({ service: healthyService });
    await runner.tick();

    expect(store.get(schedule.id)!.enabled).toBe(false);
    expect(store.get(schedule.id)!.stopReason).toBe('consecutive_failures');
    expect(store.get(schedule.id)!.operatorHold).toBe(true);
  });

  it('fires when previous run is stale (older than threshold)', async () => {
    // Reproduces the codex-rebase incident: prior task hung in inProgress for
    // many hours; the staleness gate should let the next cron tick through
    // instead of silently skipping forever.
    const schedule = store.create({
      name: 'Stale',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      latestExecution: {
        receiptId: 'prior-receipt',
        executionToken: 'prior-token',
        evaluatedAt: new Date(Date.now() - 13 * 3_600_000).toISOString(),
        triggeredAt: new Date(Date.now() - 13 * 3_600_000).toISOString(),
        trigger: 'cron',
        taskId: 'stale-task',
        outcome: 'running',
        reasonCode: 'none',
      },
    });

    // The deps closure decides freshness — return false to mimic prod's stale
    // bypass path (task exists and is `inProgress`, but updatedAt is >12h ago).
    const runner = createRunner({ isTaskBlockingSchedule: () => false });
    await runner.tick();

    expect(launched).toHaveLength(1);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('running');
    expect(store.get(schedule.id)!.latestExecution?.taskId).toBe('task-1');
  });

  it('queues instead of skipping when at max active tasks (issue #1526 Phase A)', async () => {
    activeCount = 10;

    const schedule = store.create({
      name: 'Capped',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
      maxTriggers: 2,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner();
    await runner.tick();

    // The fire goes through the normal launcher — a task IS created, just
    // pended instead of launched. Nothing is silently dropped.
    expect(launched).toHaveLength(1);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('queued_capacity');
    expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('capacity');
    expect(store.get(schedule.id)!.latestExecution?.taskId).toBe('task-1');
    expect(store.get(schedule.id)!.executionLedger.at(-1)).toEqual(expect.objectContaining({
      outcome: 'queued_capacity',
      reasonCode: 'capacity',
      taskId: 'task-1',
    }));
    // A capacity-queued fire still consumes its cron trigger quota — it DID fire.
    expect(store.get(schedule.id)!.remainingTriggers).toBe(1);
    expect(store.get(schedule.id)!.enabled).toBe(true);
  });

  it('coalesces a second fire while the previous fire is still pending (issue #1526 Phase A)', async () => {
    activeCount = 10; // at capacity — every fire queues instead of launching

    const schedule = store.create({
      name: 'Coalesce',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner();
    await runner.tick();
    expect(launched).toHaveLength(1);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('queued_capacity');

    replaceSchedule(schedule.id, {
      lastScheduledFor: new Date(Date.now() - 2 * 60_000).toISOString(),
    });
    await runner.tick();

    // No second task created — the first fire's task is still pending.
    expect(launched).toHaveLength(1);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_coalesced');
    expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('previous_run_pending');
    expect(store.get(schedule.id)!.executionLedger.at(-1)).toEqual(expect.objectContaining({
      outcome: 'skipped_coalesced',
      reasonCode: 'previous_run_pending',
      blockingTaskId: 'task-1',
    }));
  });

  it('preserves the blocking pointer across THREE fires with distinct prompts — no burst-launch (issue #1526 Phase A regression)', async () => {
    // Regression for the coalesce-pointer-wipe bug: markExecutionOutcome used
    // to write latestExecution.taskId from receipt.taskId alone, which is
    // always undefined for a skip — so a second consecutive skip wiped the
    // pointer fire() relies on, and a third fire would launch a duplicate.
    // A schedule with a genuinely dynamic/templated prompt (not a static one
    // launchTask's prompt-hash dedup could incidentally save) is exactly the
    // case that bites: each fire below resolves a DIFFERENT literal prompt,
    // so nothing but the blocking-pointer chain itself can prevent a burst.
    activeCount = 10; // at capacity — every fire queues instead of launching

    const schedule = store.create({
      name: 'ThreeFireCoalesce',
      cron: '* * * * *',
      playbook: { path: 'dynamic.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    async function writeDynamicPlaybook(marker: string): Promise<void> {
      await writeFile(join(dir, '.kookr', 'playbooks', 'dynamic.md'), `---
name: Dynamic Playbook
description: A playbook whose body changes per fire
parameters: []
checklist:
  - Step 1
---

Do the test thing (${marker}).
`);
    }

    const runner = createRunner();

    // Fire 1: queues task-1 with prompt A.
    await writeDynamicPlaybook('fire-1');
    await runner.tick();
    expect(launched).toHaveLength(1);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('queued_capacity');
    expect(store.get(schedule.id)!.latestExecution?.taskId).toBe('task-1');

    // Fire 2: prompt B — must coalesce against task-1, not launch.
    await writeDynamicPlaybook('fire-2');
    replaceSchedule(schedule.id, { lastScheduledFor: new Date(Date.now() - 2 * 60_000).toISOString() });
    await runner.tick();
    expect(launched).toHaveLength(1);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_coalesced');
    // The pointer must survive this write for fire 3 to see it.
    expect(store.get(schedule.id)!.latestExecution?.taskId).toBe('task-1');

    // Fire 3: prompt C — the bug let this one through and launched task-2.
    await writeDynamicPlaybook('fire-3');
    replaceSchedule(schedule.id, { lastScheduledFor: new Date(Date.now() - 2 * 60_000).toISOString() });
    await runner.tick();

    expect(launched).toHaveLength(1); // still exactly one launcher call
    expect(launched[0].prompt).toContain('fire-1'); // the one call was fire 1's
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_coalesced');
    expect(store.get(schedule.id)!.latestExecution?.taskId).toBe('task-1');
    expect(store.get(schedule.id)!.executionLedger.at(-1)).toEqual(expect.objectContaining({
      outcome: 'skipped_coalesced',
      reasonCode: 'previous_run_pending',
      blockingTaskId: 'task-1',
    }));

    // recordTaskTerminalOutcome must still be able to find this schedule by
    // its (preserved) latestExecution.taskId after two consecutive skips.
    await service.recordTaskTerminalOutcome('task-1', 'completed');
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('completed');
  });

  it('fires normally below capacity — queued_capacity/coalescing do not activate', async () => {
    const schedule = store.create({
      name: 'BelowCapacity',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner();
    await runner.tick();

    expect(launched).toHaveLength(1);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('running');
  });

  it('suppresses firing while the server is draining (issue #659)', async () => {
    const schedule = store.create({
      name: 'Draining',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
      maxTriggers: 2,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner({ isAccepting: () => false });
    await runner.tick();

    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_draining');
    expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('draining');
    expect(store.get(schedule.id)!.latestExecution?.message).toContain('draining');
    // The cron budget must not be consumed by a drain skip.
    expect(store.get(schedule.id)!.remainingTriggers).toBe(2);
    expect(store.get(schedule.id)!.enabled).toBe(true);
  });

  it('records skipped_server_restarting when drain coincides with restart marker (issue #1983)', async () => {
    const schedule = store.create({
      name: 'Restarting',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
      maxTriggers: 2,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner({
      isAccepting: () => false,
      isServerRestarting: () => true,
    });
    await runner.tick();

    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_server_restarting');
    expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('server_restarting');
    expect(store.get(schedule.id)!.latestExecution?.message).toMatch(/restarting|redeploy/i);
    // Same non-fire guarantee as drain: budget untouched, schedule stays enabled.
    expect(store.get(schedule.id)!.remainingTriggers).toBe(2);
    expect(store.get(schedule.id)!.enabled).toBe(true);
  });

  it('keeps generic skipped_draining when drain is set but restart marker is absent (issue #1983)', async () => {
    const schedule = store.create({
      name: 'ManualDrain',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner({
      isAccepting: () => false,
      isServerRestarting: () => false,
    });
    await runner.tick();

    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_draining');
    expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('draining');
  });

  it('fires normally once the server stops draining', async () => {
    const schedule = store.create({
      name: 'Resumed',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner({ isAccepting: () => true });
    await runner.tick();

    expect(launched).toHaveLength(1);
  });

  it('suppresses firing while the automation kill-switch is engaged (issue #1710)', async () => {
    const schedule = store.create({
      name: 'SafeMode',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
      maxTriggers: 2,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner({ isAutomationEnabled: () => false });
    await runner.tick();

    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_safe_mode');
    expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('safe_mode');
    expect(store.get(schedule.id)!.latestExecution?.message).toContain('SAFE MODE');
    expect(store.get(schedule.id)!.remainingTriggers).toBe(2);
    expect(store.get(schedule.id)!.enabled).toBe(true);
  });

  it('fires normally once the automation kill-switch is disengaged', async () => {
    const schedule = store.create({
      name: 'SafeModeResumed',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner({ isAutomationEnabled: () => true });
    await runner.tick();

    expect(launched).toHaveLength(1);
  });

  it('still fires the cross-repo orchestrator schedule during SAFE MODE, with safeModeExempt (issue #2672)', async () => {
    // The orchestrator schedule must keep ticking while paused so the fleet can
    // auto-resume after a quota window resets. Its own agent launch is let
    // through the launch-service gate via serverOpts.safeModeExempt.
    await writeFile(join(dir, '.kookr', 'playbooks', 'cross-repo-orchestrator.md'), `---
name: Cross-Repo Autonomous Orchestrator
description: orchestrator
parameters: []
checklist:
  - Snapshot and honor the pause
---

Snapshot the fleet.
`);
    const schedule = store.create({
      name: 'Cross-Repo Autonomous Orchestrator',
      cron: '* * * * *',
      playbook: { path: 'cross-repo-orchestrator.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const seen: Array<{ prompt: string; safeModeExempt?: boolean }> = [];
    const runner = createRunner({
      isAutomationEnabled: () => false,
      launcher: async (opts, serverOpts) => {
        seen.push({ prompt: opts.prompt, safeModeExempt: serverOpts?.safeModeExempt });
        return { task: { id: 'orch-1' } as any, queued: false };
      },
    });
    await runner.tick();

    // Fired despite SAFE MODE (not skipped_safe_mode), and carried the exempt flag.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.safeModeExempt).toBe(true);
    expect(store.get(schedule.id)!.latestExecution?.outcome).not.toBe('skipped_safe_mode');
  });

  it('passes automationProjectId on a successful fire', async () => {
    const schedule = store.create({
      name: 'Stamp',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });
    const stamps: Array<string | undefined> = [];
    const runner = createRunner({
      resolveAutomationProjectId: async () => 'github.com/jeanibarz/lucy',
      launcher: async (opts, serverOpts) => {
        stamps.push(serverOpts?.automationProjectId);
        const taskId = `task-${++taskIdCounter}`;
        launched.push({ prompt: opts.prompt, cwd: opts.cwd });
        activeTaskIds.add(taskId);
        activeCount += 1;
        return { task: aTask({ id: taskId, prompt: opts.prompt, cwd: opts.cwd }), queued: false };
      },
    });
    await runner.tick();
    expect(stamps).toEqual(['github.com/jeanibarz/lucy']);
    expect(launched).toHaveLength(1);
  });

  it('skips with skipped_project_automation when the project is paused and leaves enabled unchanged', async () => {
    const schedule = store.create({
      name: 'Lucy batch',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner({
      getPausedProjectIds: () => new Set(['github.com/jeanibarz/lucy']),
      resolveAutomationProjectId: async () => 'github.com/jeanibarz/lucy',
    });
    await runner.tick();

    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_project_automation');
    expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('project_automation');
    expect(store.get(schedule.id)!.enabled).toBe(true);
  });

  it('global SAFE MODE skip still records skipped_safe_mode even when the project is also paused', async () => {
    const schedule = store.create({
      name: 'Both levers',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner({
      isAutomationEnabled: () => false,
      getPausedProjectIds: () => new Set(['github.com/jeanibarz/lucy']),
      resolveAutomationProjectId: async () => 'github.com/jeanibarz/lucy',
    });
    await runner.tick();

    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_safe_mode');
    expect(store.get(schedule.id)!.enabled).toBe(true);
  });

  it('feeder-shaped schedule (Lucy cwd, kookr-queue-feeder.md) skips when Lucy is paused', async () => {
    await writeFile(join(dir, '.kookr', 'playbooks', 'kookr-queue-feeder.md'), `---
name: Queue Feeder
description: feeder
parameters: []
checklist:
  - Feed
---

Feed the queue.
`);
    const schedule = store.create({
      name: 'Kookr Queue Feeder',
      cron: '* * * * *',
      playbook: { path: 'kookr-queue-feeder.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner({
      getPausedProjectIds: () => new Set(['github.com/jeanibarz/lucy']),
      resolveAutomationProjectId: async (s) => {
        const { resolveScheduleAutomationProjectId } = await import('../core/automation-kill-switch.js');
        return resolveScheduleAutomationProjectId({
          playbookPath: s.playbook.path,
          cwdProjectId: 'github.com/jeanibarz/lucy',
        });
      },
    });
    await runner.tick();

    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_project_automation');
  });

  it('reflection-shaped schedule does not skip when Lucy is paused', async () => {
    await writeFile(join(dir, '.kookr', 'playbooks', 'kb-scout-reflection.md'), `---
name: KB-Scout reflection
description: reflection
parameters: []
checklist:
  - Reflect
---

Reflect.
`);
    const schedule = store.create({
      name: 'KB-Scout daily reflection',
      cron: '* * * * *',
      playbook: { path: 'kb-scout-reflection.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner({
      getPausedProjectIds: () => new Set(['github.com/jeanibarz/lucy']),
      resolveAutomationProjectId: async (s) => {
        const { resolveScheduleAutomationProjectId } = await import('../core/automation-kill-switch.js');
        return resolveScheduleAutomationProjectId({
          playbookPath: s.playbook.path,
          cwdProjectId: 'github.com/jeanibarz/dotclaude',
        });
      },
    });
    await runner.tick();
    expect(launched).toHaveLength(1);
    expect(store.get(schedule.id)!.latestExecution?.outcome).not.toBe('skipped_project_automation');
  });

  it('reflection-shaped schedule skips when kb-scout-evol is paused', async () => {
    await writeFile(join(dir, '.kookr', 'playbooks', 'kb-scout-reflection.md'), `---
name: KB-Scout reflection
description: reflection
parameters: []
checklist:
  - Reflect
---

Reflect.
`);
    const schedule = store.create({
      name: 'KB-Scout daily reflection (paused)',
      cron: '* * * * *',
      playbook: { path: 'kb-scout-reflection.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner({
      getPausedProjectIds: () => new Set(['github.com/jeanibarz/kb-scout-evol']),
      resolveAutomationProjectId: async (s) => {
        const { resolveScheduleAutomationProjectId } = await import('../core/automation-kill-switch.js');
        return resolveScheduleAutomationProjectId({
          playbookPath: s.playbook.path,
          cwdProjectId: 'github.com/jeanibarz/dotclaude',
        });
      },
    });
    await runner.tick();
    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_project_automation');
  });

  it('mapError of a project-paused kill-switch error is project_automation, not safe_mode or launch_error', async () => {
    const { mapErrorToReasonCode } = await import('./schedule-runner.js');
    const { AutomationKillSwitchError } = await import('./launch-service.js');
    expect(mapErrorToReasonCode(new AutomationKillSwitchError('project_automation')))
      .toBe('project_automation');
    expect(mapErrorToReasonCode(new AutomationKillSwitchError('safe_mode'))).toBe('safe_mode');
    expect(mapErrorToReasonCode(new AutomationKillSwitchError('project_automation')))
      .not.toBe('launch_error');
  });

  it('fails when playbook file is missing', async () => {
    const schedule = store.create({
      name: 'Missing Playbook',
      cron: '* * * * *',
      playbook: { path: 'nonexistent.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner();
    await runner.tick();

    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('dispatch_failed');
    expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('missing_playbook');
  });

  it('rejects a stored traversal playbook path before launching', async () => {
    await writeFile(join(dir, 'escape.md'), `---
name: Escaped Playbook
parameters: []
---

Do not launch this.
`);
    const schedule = store.create({
      name: 'Traversal Playbook',
      cron: '* * * * *',
      playbook: { path: '../../escape.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner();
    await runner.tick();

    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('dispatch_failed');
    expect(store.get(schedule.id)!.latestExecution?.message).toBe(INVALID_PLAYBOOK_PATH_ERROR);
  });

  it('fails when cwd does not exist', async () => {
    const missingCwd = join(dir, 'missing-cwd');
    const schedule = store.create({
      name: 'Bad CWD',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: missingCwd,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner();
    await runner.tick();

    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('dispatch_failed');
    expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('missing_cwd');
  });

  it('runNow fires immediately regardless of cron', async () => {
    const schedule = store.create({
      name: 'Manual',
      cron: '0 0 1 1 *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });

    const runner = createRunner();
    const result = await runner.runNow(schedule.id);

    expect(result.taskId).toBe('task-1');
    expect(launched).toHaveLength(1);
    expect(store.get(schedule.id)!.latestExecution?.trigger).toBe('manual');
    expect(store.get(schedule.id)!.executionLedger).toEqual([
      expect.objectContaining({
        trigger: 'manual',
        decision: 'manual_run',
        outcome: 'running',
        taskId: 'task-1',
      }),
    ]);
  });

  it('consumes finite cron trigger quota and auto-stops once exhausted', async () => {
    const schedule = store.create({
      name: 'Finite',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
      maxTriggers: 2,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    });

    const runner = createRunner();
    await runner.tick();

    expect(store.get(schedule.id)!.remainingTriggers).toBe(1);
    expect(store.get(schedule.id)!.enabled).toBe(true);

    activeTaskIds.clear();
    activeCount = 0;
    replaceSchedule(schedule.id, {
      lastScheduledFor: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    await runner.tick();

    expect(launched).toHaveLength(2);
    expect(store.get(schedule.id)!.remainingTriggers).toBe(0);
    expect(store.get(schedule.id)!.enabled).toBe(false);
    expect(store.get(schedule.id)!.stopReason).toBe('trigger_limit_reached');
    expect(store.get(schedule.id)!.exhaustedAt).toEqual(expect.any(String));
  });

  it('runNow remains available for exhausted schedules and does not consume cron quota', async () => {
    const schedule = store.create({
      name: 'Exhausted',
      cron: '0 0 1 1 *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
      maxTriggers: 1,
    });
    replaceSchedule(schedule.id, {
      enabled: false,
      remainingTriggers: 0,
      stopReason: 'trigger_limit_reached',
      exhaustedAt: new Date().toISOString(),
    });

    const runner = createRunner();
    const result = await runner.runNow(schedule.id);

    expect(result.taskId).toBe('task-1');
    expect(launched).toHaveLength(1);
    expect(store.get(schedule.id)!.latestExecution?.trigger).toBe('manual');
    expect(store.get(schedule.id)!.remainingTriggers).toBe(0);
    expect(store.get(schedule.id)!.stopReason).toBe('trigger_limit_reached');
  });

  it('runNow returns error for unknown schedule', async () => {
    const runner = createRunner();
    const result = await runner.runNow('nonexistent');
    expect(result.error).toBe('Schedule not found');
  });

  it('records a missed startup run for manual recovery when KOOKR_MANUAL_CATCHUP is set', async () => {
    const schedule = store.create({
      name: 'ManualCatchup',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    process.env.KOOKR_MANUAL_CATCHUP = '1';
    const runner = createRunner();
    runner.start();
    await vi.waitFor(() => {
      expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_manual');
    });
    await runner.stop();

    expect(launched).toHaveLength(0);
    expect(service.getStatusSnapshot().catchUpEnabled).toBe(false);
    expect(store.get(schedule.id)!.executionLedger[0]).toEqual(expect.objectContaining({
      decision: 'manual_catch_up',
      outcome: 'skipped_manual',
      reasonCode: 'manual_catch_up_required',
      scheduledFor: expect.any(String),
    }));

    await runner.tick();

    expect(launched).toHaveLength(0);
    expect(new Date(store.getWithComputed(schedule.id)!.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it('catches up a missed schedule within 24h on start when explicitly enabled', async () => {
    const schedule = store.create({
      name: 'Catchup',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    process.env.KOOKR_AUTO_CATCHUP = '1';
    const runner = createRunner();
    runner.start();
    await vi.waitFor(() => {
      expect(launched).toHaveLength(1);
    });
    await runner.stop();

    expect(service.getStatusSnapshot().catchUpEnabled).toBe(true);
    expect(store.get(schedule.id)!.executionLedger[0]).toEqual(expect.objectContaining({
      decision: 'catch_up',
      outcome: 'running',
    }));
  });

  it('catches up a missed schedule by default with no env override, exactly once per boot (#1900)', async () => {
    const schedule = store.create({
      name: 'DefaultCatchup',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    // No KOOKR_AUTO_CATCHUP / KOOKR_MANUAL_CATCHUP / KOOKR_NO_CATCHUP: the
    // #1900 default is `auto`.
    const runner = createRunner();
    runner.start();
    await vi.waitFor(() => {
      expect(launched).toHaveLength(1);
    });
    await runner.stop();

    expect(service.getStatusSnapshot().catchUpMode).toBe('auto');
    expect(service.getStatusSnapshot().catchUpEnabled).toBe(true);
    expect(store.get(schedule.id)!.executionLedger[0]).toEqual(expect.objectContaining({
      decision: 'catch_up',
      outcome: 'running',
    }));

    // Single-run-per-boot: the next cron tick must not re-fire the same missed
    // slot (the watermark advanced past it).
    await runner.tick();
    expect(launched).toHaveLength(1);
  });

  it('gates the catch-up fire behind the relaunch arbiter and holds the lease under the fired task (#1900)', async () => {
    const schedule = store.create({
      name: 'LeaseGatedCatchup',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const acquired: Array<{ key: string; holderId: string }> = [];
    const arbiter = {
      evaluate: () => ({ admit: true as const }),
      tryAcquire: (key: { repo: string; number: number }, holderId: string) => {
        acquired.push({ key: `${key.repo}#${key.number}`, holderId });
        return { ok: true as const, lease: { key, holderId, acquiredAt: '' }, reentrant: false };
      },
    };

    const runner = createRunner({ relaunchArbiter: arbiter });
    runner.start();
    await vi.waitFor(() => {
      expect(launched).toHaveLength(1);
    });
    await runner.stop();

    // The fire went through, and the lease was acquired under the fired task id.
    expect(store.get(schedule.id)!.executionLedger[0]).toEqual(expect.objectContaining({
      decision: 'catch_up',
      outcome: 'running',
    }));
    expect(acquired).toEqual([
      { key: `schedule:${schedule.id}#0`, holderId: 'task-1' },
    ]);
  });

  it('skips the catch-up fire when the relaunch arbiter denies admission (#1900)', async () => {
    const schedule = store.create({
      name: 'LeaseHeldCatchup',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    let tryAcquireCalled = false;
    const arbiter = {
      evaluate: () => ({
        admit: false as const,
        reason: 'held' as const,
        lease: { key: catchUpKey(schedule.id), holderId: 'other-actuator', acquiredAt: '' },
      }),
      tryAcquire: () => {
        tryAcquireCalled = true;
        return { ok: true as const, lease: { key: catchUpKey(schedule.id), holderId: 'x', acquiredAt: '' }, reentrant: false };
      },
    };

    const runner = createRunner({ relaunchArbiter: arbiter });
    runner.start();
    await vi.waitFor(() => {
      expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_relaunch_locked');
    });
    await runner.stop();

    // No task was launched (denied before fire), and no lease was acquired.
    expect(launched).toHaveLength(0);
    expect(tryAcquireCalled).toBe(false);
    expect(store.get(schedule.id)!.executionLedger[0]).toEqual(expect.objectContaining({
      decision: 'catch_up',
      outcome: 'skipped_relaunch_locked',
      reasonCode: 'relaunch_lease_held',
      scheduledFor: expect.any(String),
    }));
    // The held-branch message names the current holder so the ledger explains
    // which actuator won the lease.
    expect(store.get(schedule.id)!.latestExecution?.message).toContain('other-actuator');

    // Watermark advanced: the withheld slot is not re-evaluated next tick.
    await runner.tick();
    expect(launched).toHaveLength(0);
  });

  it('does not acquire the relaunch lease when the catch-up fire launches no task (#1900)', async () => {
    const schedule = store.create({
      name: 'FailedCatchupFire',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    let tryAcquireCalled = false;
    const arbiter = {
      evaluate: () => ({ admit: true as const }),
      tryAcquire: () => {
        tryAcquireCalled = true;
        return { ok: true as const, lease: { key: catchUpKey(schedule.id), holderId: 'x', acquiredAt: '' }, reentrant: false };
      },
    };

    // Launcher throws → fire() records dispatch_failed and returns { error }
    // with no taskId, so no lease should be acquired (nothing was launched).
    const runner = createRunner({
      relaunchArbiter: arbiter,
      launcher: async () => {
        throw new Error('boom');
      },
    });
    runner.start();
    await vi.waitFor(() => {
      expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('dispatch_failed');
    });
    await runner.stop();

    expect(tryAcquireCalled).toBe(false);
  });

  it('denies catch-up with a backoff reason after the arbiter starts a cooldown window (#1900)', async () => {
    const schedule = store.create({
      name: 'BackoffCatchup',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const arbiter = {
      evaluate: () => ({
        admit: false as const,
        reason: 'backoff' as const,
        retryAfterMs: 90_000,
        cooldownUntil: new Date(Date.now() + 90_000).toISOString(),
      }),
      tryAcquire: () => ({ ok: true as const, lease: { key: catchUpKey(schedule.id), holderId: 'x', acquiredAt: '' }, reentrant: false }),
    };

    const runner = createRunner({ relaunchArbiter: arbiter });
    runner.start();
    await vi.waitFor(() => {
      expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_relaunch_locked');
    });
    await runner.stop();

    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('relaunch_lease_held');
    expect(store.get(schedule.id)!.latestExecution?.message).toContain('backoff');
  });

  it('unwinds the launched catch-up task when a concurrent actuator wins the lease mid-fire (#1914)', async () => {
    const schedule = store.create({
      name: 'LeaseLostCatchup',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    // Admit before firing, then LOSE the acquire after the task launched — the
    // window another actuator can take the schedule's lease during `await fire()`.
    const arbiter = {
      evaluate: () => ({ admit: true as const }),
      tryAcquire: () => ({
        ok: false as const,
        reason: 'held' as const,
        lease: { key: catchUpKey(schedule.id), holderId: 'other-actuator', acquiredAt: '' },
      }),
    };
    const unwound: Array<{ taskId: string; detail: string }> = [];

    const runner = createRunner({
      relaunchArbiter: arbiter,
      terminateCatchUpDuplicate: (taskId, detail) => {
        unwound.push({ taskId, detail });
      },
    });
    runner.start();
    await vi.waitFor(() => {
      expect(launched).toHaveLength(1);
    });
    await runner.stop();

    // The just-launched duplicate is unwound under the fired task id, and the
    // detail names the actuator that won the lease.
    expect(unwound).toEqual([
      { taskId: 'task-1', detail: 'relaunch lease taken mid-fire by other-actuator' },
    ]);
  });

  it('unwinds the launched catch-up task when the lease enters backoff mid-fire (#1914)', async () => {
    const schedule = store.create({
      name: 'LeaseBackoffMidFireCatchup',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const arbiter = {
      evaluate: () => ({ admit: true as const }),
      tryAcquire: () => ({
        ok: false as const,
        reason: 'backoff' as const,
        retryAfterMs: 90_000,
        cooldownUntil: new Date(Date.now() + 90_000).toISOString(),
      }),
    };
    const unwound: Array<{ taskId: string; detail: string }> = [];

    const runner = createRunner({
      relaunchArbiter: arbiter,
      terminateCatchUpDuplicate: (taskId, detail) => {
        unwound.push({ taskId, detail });
      },
    });
    runner.start();
    await vi.waitFor(() => {
      expect(launched).toHaveLength(1);
    });
    await runner.stop();

    expect(unwound).toHaveLength(1);
    expect(unwound[0].taskId).toBe('task-1');
    expect(unwound[0].detail).toContain('backoff mid-fire');
  });

  it('leaves the launched catch-up task running when the acquire wins (no unwind) (#1914)', async () => {
    const schedule = store.create({
      name: 'LeaseWonCatchup',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const arbiter = {
      evaluate: () => ({ admit: true as const }),
      tryAcquire: (key: { repo: string; number: number }, holderId: string) => ({
        ok: true as const,
        lease: { key, holderId, acquiredAt: '' },
        reentrant: false,
      }),
    };
    const unwound: string[] = [];

    const runner = createRunner({
      relaunchArbiter: arbiter,
      terminateCatchUpDuplicate: (taskId) => {
        unwound.push(taskId);
      },
    });
    runner.start();
    await vi.waitFor(() => {
      expect(launched).toHaveLength(1);
    });
    await runner.stop();

    // Acquire succeeded → the fired task is the legitimate holder, never unwound.
    expect(unwound).toEqual([]);
  });

  it('records stale catch-up skips in the execution ledger', async () => {
    const schedule = store.create({
      name: 'StaleCatchup',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 26 * 60 * 60_000).toISOString(),
    });

    const runner = createRunner();
    runner.start();
    await vi.waitFor(() => {
      expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_stale');
    });
    await runner.stop();

    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('stale_catch_up');
    await runner.tick();
    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.executionLedger).toEqual([
      expect.objectContaining({
        decision: 'stale_catch_up',
        outcome: 'skipped_stale',
        reasonCode: 'stale_catch_up',
        scheduledFor: expect.any(String),
      }),
    ]);
  });

  it('waits for in-flight catch-up work on stop', async () => {
    const schedule = store.create({
      name: 'PendingCatchup',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    let releaseLaunch!: () => void;
    let launchStarted = false;
    const launchBlocked = new Promise<{ task: { id: string }; queued: boolean }>((resolve) => {
      releaseLaunch = () => resolve({ task: { id: 'task-1' }, queued: false });
    });
    const runner = createRunner({
      launcher: async () => {
        launchStarted = true;
        return launchBlocked;
      },
    });

    process.env.KOOKR_AUTO_CATCHUP = '1';
    runner.start();
    await vi.waitFor(() => {
      expect(launchStarted).toBe(true);
    });

    let stopped = false;
    const stopPromise = runner.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopped).toBe(false);

    releaseLaunch();
    await stopPromise;

    expect(stopped).toBe(true);
    expect(store.get(schedule.id)!.latestExecution?.taskId).toBe('task-1');
  });

  it('skips all startup catch-up handling when KOOKR_NO_CATCHUP is set', async () => {
    const schedule = store.create({
      name: 'NoCatchup',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    process.env.KOOKR_NO_CATCHUP = '1';
    process.env.KOOKR_AUTO_CATCHUP = '1';
    const runner = createRunner();
    runner.start();
    await vi.waitFor(() => {
      expect(store.get(schedule.id)!.lastScheduledFor).toEqual(expect.any(String));
    });
    await runner.stop();

    expect(launched).toHaveLength(0);
    expect(service.getStatusSnapshot().catchUpEnabled).toBe(false);
    expect(service.getStatusSnapshot().catchUpMode).toBe('off');
    expect(store.get(schedule.id)!.latestExecution).toBeUndefined();

    await runner.tick();

    expect(launched).toHaveLength(0);
    expect(new Date(store.getWithComputed(schedule.id)!.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it('skips stale startup catch-up ledger handling when KOOKR_NO_CATCHUP is set', async () => {
    const schedule = store.create({
      name: 'NoStaleCatchup',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 26 * 60 * 60_000).toISOString(),
    });

    process.env.KOOKR_NO_CATCHUP = '1';
    const runner = createRunner();
    runner.start();
    await vi.waitFor(() => {
      expect(store.get(schedule.id)!.lastScheduledFor).toEqual(expect.any(String));
    });
    await runner.stop();

    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution).toBeUndefined();
    expect(store.get(schedule.id)!.executionLedger).toEqual([]);
  });

  it('prevents overlapping ticks', async () => {
    const schedule = store.create({
      name: 'Overlap',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    let resolveFirst!: () => void;
    const firstLaunch = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let launchCount = 0;

    const runner = createRunner({
      launcher: async () => {
        launchCount += 1;
        if (launchCount === 1) {
          await firstLaunch;
        }
        return { task: { id: `task-${launchCount}` } as any, queued: false };
      },
    });

    const tick1 = runner.tick();
    const tick2 = runner.tick();

    resolveFirst();
    await tick1;
    await tick2;

    expect(launchCount).toBe(1);
  });

  describe('tier-aware firing and resolution health (R9)', () => {
    let pluginRoot: string;

    beforeEach(async () => {
      pluginRoot = join(dir, 'plugin');
      await mkdir(join(pluginRoot, 'playbooks'), { recursive: true });
      await mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true });
      await writeFile(join(pluginRoot, '.claude-plugin', 'plugin.json'), '{"name":"kookr-toolkit"}');
      await writeFile(join(pluginRoot, 'playbooks', 'plug.md'), `---
name: Plugin Playbook
description: A plugin playbook
parameters: []
checklist:
  - Step 1
---

Do the plugin thing.
`);
      process.env.KOOKR_PLUGIN_DIR = pluginRoot;
    });

    afterEach(() => {
      delete process.env.KOOKR_PLUGIN_DIR;
    });

    function makeDue(id: string) {
      replaceSchedule(id, { createdAt: new Date(Date.now() - 2 * 60_000).toISOString() });
    }

    it('fires a plugin-scoped schedule whose cwd lacks the file', async () => {
      // `dir` has no plug.md in its project tier — only the plugin tier does.
      const schedule = store.create({
        name: 'Plugin Job',
        cron: '* * * * *',
        playbook: { path: 'plug.md', parameters: {}, scope: 'plugin' },
        cwd: dir,
      });
      makeDue(schedule.id);

      await createRunner().tick();

      expect(launched).toHaveLength(1);
      expect(launched[0].prompt).toContain('Do the plugin thing');
    });

    it('pinned-tier-deleted fails loudly with NO cross-tier substitution', async () => {
      // test.md exists in the PROJECT tier but the schedule is pinned to plugin,
      // which has no test.md. Must fail missing_playbook, never substitute.
      const schedule = store.create({
        name: 'Mispinned',
        cron: '* * * * *',
        playbook: { path: 'test.md', parameters: {}, scope: 'plugin' },
        cwd: dir,
      });
      makeDue(schedule.id);

      await createRunner().tick();

      expect(launched).toHaveLength(0);
      expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('dispatch_failed');
      expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('missing_playbook');
    });

    it('cache miss renders unknown before the first refresh', () => {
      const schedule = store.create({
        name: 'Fresh',
        cron: '0 9 * * *',
        playbook: { path: 'test.md', parameters: {} },
        cwd: dir,
      });
      expect(store.getWithComputed(schedule.id)!.playbookResolution).toBe('unknown');
    });

    it('marks a resolvable schedule resolvable and an unresolvable one unresolvable', () => {
      const ok = store.create({
        name: 'OK',
        cron: '0 9 * * *',
        playbook: { path: 'test.md', parameters: {} },
        cwd: dir,
      });
      const broken = store.create({
        name: 'Broken',
        cron: '0 9 * * *',
        playbook: { path: 'gone.md', parameters: {} },
        cwd: dir,
      });

      createRunner().refreshPlaybookResolution();

      expect(store.getWithComputed(ok.id)!.playbookResolution).toBe('resolvable');
      expect(store.getWithComputed(broken.id)!.playbookResolution).toBe('unresolvable');
    });

    it('marks a symlink that escapes the playbooks directory as unresolvable', async () => {
      const escaped = join(dir, 'outside.md');
      await writeFile(escaped, '---\nname: Outside\nparameters: []\n---\nbody\n');
      await symlink(escaped, join(dir, '.kookr', 'playbooks', 'linked.md'));
      const schedule = store.create({
        name: 'Escaping Link',
        cron: '0 9 * * *',
        playbook: { path: 'linked.md', parameters: {} },
        cwd: dir,
      });

      createRunner().refreshPlaybookResolution();

      expect(store.getWithComputed(schedule.id)!.playbookResolution).toBe('unresolvable');
    });

    it('reports a DISABLED broken schedule as unresolvable', () => {
      const broken = store.create({
        name: 'Disabled Broken',
        cron: '0 9 * * *',
        playbook: { path: 'gone.md', parameters: {} },
        cwd: dir,
        enabled: false,
      });

      createRunner().refreshPlaybookResolution();

      expect(store.getWithComputed(broken.id)!.playbookResolution).toBe('unresolvable');
    });

    it('renders unknown after a cwd/path edit invalidates the cached signature', () => {
      const schedule = store.create({
        name: 'Edited',
        cron: '0 9 * * *',
        playbook: { path: 'test.md', parameters: {} },
        cwd: dir,
      });
      createRunner().refreshPlaybookResolution();
      expect(store.getWithComputed(schedule.id)!.playbookResolution).toBe('resolvable');

      // Edit the path — the cached entry's signature no longer matches.
      replaceSchedule(schedule.id, { playbook: { path: 'other.md', parameters: {} } });
      expect(store.getWithComputed(schedule.id)!.playbookResolution).toBe('unknown');
    });

    it('emits a warn on a resolvable→unresolvable transition', async () => {
      const schedule = store.create({
        name: 'Flips',
        cron: '0 9 * * *',
        playbook: { path: 'flip.md', parameters: {} },
        cwd: dir,
      });
      const file = join(dir, '.kookr', 'playbooks', 'flip.md');
      await writeFile(file, '---\nname: Flip\nparameters: []\n---\nbody\n');

      const runner = createRunner();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      runner.refreshPlaybookResolution(); // seed: resolvable
      await rm(file, { force: true });
      runner.refreshPlaybookResolution(); // transition: unresolvable
      const warned = warnSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('became unresolvable'));
      warnSpy.mockRestore();

      expect(store.getWithComputed(schedule.id)!.playbookResolution).toBe('unresolvable');
      expect(warned).toBe(true);
    });

    it('emits NO spurious warn for an already-broken schedule across restarts', () => {
      store.create({
        name: 'Born Broken',
        cron: '0 9 * * *',
        playbook: { path: 'gone.md', parameters: {} },
        cwd: dir,
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Two fresh runners simulate a restart — each seeds its own baseline.
      createRunner().refreshPlaybookResolution();
      createRunner().refreshPlaybookResolution();
      const warned = warnSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('became unresolvable'));
      warnSpy.mockRestore();

      expect(warned).toBe(false);
    });

    it('emits NO warn when the SAME runner re-observes an unchanged-broken schedule (false→false)', () => {
      store.create({
        name: 'Stays Broken',
        cron: '0 9 * * *',
        playbook: { path: 'gone.md', parameters: {} },
        cwd: dir,
      });

      const runner = createRunner();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Same runner, two ticks: seed (unresolvable) then re-observe still
      // unresolvable. The `prev.resolvable` guard must suppress a re-warn —
      // only a true→false transition warns, not steady-state brokenness.
      runner.refreshPlaybookResolution();
      runner.refreshPlaybookResolution();
      const warned = warnSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('became unresolvable'));
      warnSpy.mockRestore();

      expect(warned).toBe(false);
    });
  });
  describe('schedule loop arming via launchLoopedPlaybook (#1899 / #1699 WS2.1)', () => {
    it('carries portable small intent into looped schedule dispatch', async () => {
      const schedule = store.create({
        name: 'SmallLoopArm',
        cron: '* * * * *',
        playbook: { path: 'test.md', parameters: {} },
        cwd: dir,
        loop: {},
        modelTier: 'small',
      });
      replaceSchedule(schedule.id, {
        createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      });

      const loopedTiers: Array<string | undefined> = [];
      const runner = createRunner({
        loopedLauncher: async (s) => {
          loopedTiers.push(s.modelTier);
          return { task: { id: 'small-loop-task' } as any, queued: false };
        },
      });

      await runner.tick();
      expect(loopedTiers).toEqual(['small']);
    });

    it('arms an always-running loop via loopedLauncher when the schedule carries a loop config', async () => {
      const schedule = store.create({
        name: 'LoopArm',
        cron: '* * * * *',
        playbook: { path: 'test.md', parameters: { repo: 'kookr-ai/kookr' } },
        cwd: dir,
        loop: {},
        effort: 'max',
        model: 'claude-fable-5',
      });
      replaceSchedule(schedule.id, {
        createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      });

      const loopedLaunches: Array<{ id: string; name: string }> = [];
      const runner = createRunner({
        // One-shot launcher must NOT be called for loop-configured schedules.
        launcher: async () => {
          throw new Error('one-shot launcher must not be used for loop-configured schedules');
        },
        loopedLauncher: async (s) => {
          loopedLaunches.push({ id: s.id, name: s.name });
          const taskId = `loop-task-${++taskIdCounter}`;
          activeTaskIds.add(taskId);
          activeCount += 1;
          return { task: { id: taskId } as any, queued: false };
        },
      });

      await runner.tick();

      expect(loopedLaunches).toEqual([{ id: schedule.id, name: 'LoopArm' }]);
      expect(launched).toHaveLength(0);
      expect(store.get(schedule.id)!.latestExecution).toEqual(expect.objectContaining({
        taskId: 'loop-task-1',
        outcome: 'running',
      }));
      expect(store.get(schedule.id)!.executionLedger[0]).toEqual(expect.objectContaining({
        taskId: 'loop-task-1',
        outcome: 'running',
        decision: 'cron_due',
      }));
    });

    it('classifies a manually armed dependency-parked loop separately from capacity', async () => {
      const schedule = store.create({
        name: 'DependencyParkedLoop',
        cron: '0 0 1 1 *',
        playbook: { path: 'test.md', parameters: {} },
        cwd: dir,
        loop: {},
      });
      const runner = createRunner({
        launcher: async () => {
          throw new Error('one-shot launcher must not be used for loop-configured schedules');
        },
        loopedLauncher: async () => ({
          task: aTask({ id: 'loop-task-parked', prompt: 'parked loop', cwd: dir }),
          queued: true,
          parked: true,
          dependencyAdmission: {
            status: 'parked',
            reason: 'dependency_degraded',
            dependencies: [{ dependency: 'kb', state: 'degraded' }],
            parkedAt: new Date().toISOString(),
          },
        }),
      });

      const result = await runner.runNow(schedule.id);

      expect(result).toEqual({
        taskId: 'loop-task-parked',
        queued: true,
        parked: true,
        outcome: 'parked_dependency',
        reasonCode: 'dependency_degraded',
      });
      expect(store.get(schedule.id)?.latestExecution).toMatchObject({
        taskId: 'loop-task-parked',
        outcome: 'parked_dependency',
        reasonCode: 'dependency_degraded',
      });
    });

    it('substitutes an unavailable pin on loop arm and drops effort/model pins (#1895)', async () => {
      const schedule = store.create({
        name: 'LoopSubstitute',
        cron: '* * * * *',
        playbook: { path: 'test.md', parameters: {} },
        cwd: dir,
        loop: {},
        agentType: 'codex-cli',
        // codex-only effort — must not travel with the claude substitute.
        effort: 'minimal',
      });
      replaceSchedule(schedule.id, {
        createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      });

      const looped: Array<{ agentType?: string; effort?: string; model?: string }> = [];
      const substitutions: number[] = [];
      const runner = createRunner({
        getAvailableAgentTypes: () => ['claude-code'],
        recordAgentSubstitution: () => {
          substitutions.push(1);
        },
        launcher: async () => {
          throw new Error('one-shot launcher must not be used for loop-configured schedules');
        },
        loopedLauncher: async (s) => {
          looped.push({ agentType: s.agentType, effort: s.effort, model: s.model });
          const taskId = `loop-task-${++taskIdCounter}`;
          activeTaskIds.add(taskId);
          activeCount += 1;
          return { task: { id: taskId } as any, queued: false };
        },
      });

      await runner.tick();

      expect(looped).toEqual([{ agentType: 'claude-code', effort: undefined, model: undefined }]);
      expect(substitutions).toHaveLength(1);
      expect(store.get(schedule.id)!.latestExecution).toMatchObject({
        outcome: 'running',
        reasonCode: 'agent_substituted',
      });
    });

    it('holds the relaunch lease under the armed loop task so a second fire is excluded (#1899)', async () => {
      const schedule = store.create({
        name: 'LoopLease',
        cron: '* * * * *',
        playbook: { path: 'test.md', parameters: {} },
        cwd: dir,
        loop: { iterationCap: 10 },
      });
      replaceSchedule(schedule.id, {
        createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      });

      const acquired: Array<{ key: string; holderId: string }> = [];
      const holders = new Map<string, string>();
      const arbiter = {
        evaluate: (key: { repo: string; number: number }) => {
          const k = `${key.repo}#${key.number}`;
          const holder = holders.get(k);
          if (holder) {
            return {
              admit: false as const,
              reason: 'held' as const,
              lease: { key, holderId: holder, acquiredAt: '' },
            };
          }
          return { admit: true as const };
        },
        tryAcquire: (key: { repo: string; number: number }, holderId: string) => {
          const k = `${key.repo}#${key.number}`;
          acquired.push({ key: k, holderId });
          const existing = holders.get(k);
          if (existing && existing !== holderId) {
            return {
              ok: false as const,
              reason: 'held' as const,
              lease: { key, holderId: existing, acquiredAt: '' },
            };
          }
          holders.set(k, holderId);
          return { ok: true as const, lease: { key, holderId, acquiredAt: '' }, reentrant: false };
        },
      };

      let loopCalls = 0;
      const runner = createRunner({
        relaunchArbiter: arbiter,
        loopedLauncher: async () => {
          loopCalls += 1;
          const taskId = `loop-task-${loopCalls}`;
          activeTaskIds.add(taskId);
          activeCount += 1;
          return { task: { id: taskId } as any, queued: false };
        },
      });

      await runner.tick();
      expect(loopCalls).toBe(1);
      expect(acquired).toEqual([
        { key: `schedule:${schedule.id}#0`, holderId: 'loop-task-1' },
      ]);

      // Clear the previous-run blocking gate so the only mutual-exclusion left
      // is the relaunch arbiter (AC: arbiter prevents a second loop).
      activeTaskIds.clear();
      pendingTaskIds.clear();
      activeCount = 0;
      const afterFirst = store.get(schedule.id)!;
      store.replace({
        ...afterFirst,
        latestExecution: afterFirst.latestExecution
          ? { ...afterFirst.latestExecution, outcome: 'completed', taskId: undefined }
          : undefined,
        lastScheduledFor: new Date(Date.now() - 2 * 60_000).toISOString(),
      });

      await runner.tick();

      // Second fire was denied by the arbiter (lease still held by loop-task-1).
      expect(loopCalls).toBe(1);
      expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_relaunch_locked');
      expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('relaunch_lease_held');
      expect(store.get(schedule.id)!.latestExecution?.message).toContain('loop-task-1');
    });

    it('skips loop arm when the relaunch arbiter denies admission before launch (#1899)', async () => {
      const schedule = store.create({
        name: 'LoopDenied',
        cron: '* * * * *',
        playbook: { path: 'test.md', parameters: {} },
        cwd: dir,
        loop: {},
      });
      replaceSchedule(schedule.id, {
        createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      });

      let loopedCalled = false;
      let tryAcquireCalled = false;
      const runner = createRunner({
        relaunchArbiter: {
          evaluate: () => ({
            admit: false as const,
            reason: 'held' as const,
            lease: { key: catchUpKey(schedule.id), holderId: 'other-actuator', acquiredAt: '' },
          }),
          tryAcquire: () => {
            tryAcquireCalled = true;
            return { ok: true as const, lease: { key: catchUpKey(schedule.id), holderId: 'x', acquiredAt: '' }, reentrant: false };
          },
        },
        loopedLauncher: async () => {
          loopedCalled = true;
          return { task: { id: 'should-not-launch' } as any, queued: false };
        },
      });

      await runner.tick();

      expect(loopedCalled).toBe(false);
      expect(tryAcquireCalled).toBe(false);
      expect(store.get(schedule.id)!.executionLedger[0]).toEqual(expect.objectContaining({
        outcome: 'skipped_relaunch_locked',
        reasonCode: 'relaunch_lease_held',
      }));
      expect(store.get(schedule.id)!.latestExecution?.message).toContain('other-actuator');
    });

    it('records dispatch_failed when a loop-configured schedule has no loopedLauncher wired (#1899)', async () => {
      const schedule = store.create({
        name: 'LoopUnwired',
        cron: '* * * * *',
        playbook: { path: 'test.md', parameters: {} },
        cwd: dir,
        loop: {},
      });
      replaceSchedule(schedule.id, {
        createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      });

      // createRunner without loopedLauncher — loop config must not fall through
      // to the one-shot launcher (that would silently drop the loop intent).
      let oneShotCalled = false;
      const runner = createRunner({
        launcher: async () => {
          oneShotCalled = true;
          return { task: { id: 'one-shot' } as any, queued: false };
        },
      });

      await runner.tick();

      expect(oneShotCalled).toBe(false);
      expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('dispatch_failed');
      expect(store.get(schedule.id)!.latestExecution?.message).toMatch(/no looped launcher/i);
    });

    it('unwinds a loop-arm task that loses the relaunch-lease CAS mid-fire (#1899 / #1914)', async () => {
      const schedule = store.create({
        name: 'LoopLeaseLost',
        cron: '* * * * *',
        playbook: { path: 'test.md', parameters: {} },
        cwd: dir,
        loop: {},
      });
      replaceSchedule(schedule.id, {
        createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      });

      const unwound: Array<{ taskId: string; detail: string }> = [];
      const runner = createRunner({
        relaunchArbiter: {
          evaluate: () => ({ admit: true as const }),
          tryAcquire: () => ({
            ok: false as const,
            reason: 'held' as const,
            lease: { key: catchUpKey(schedule.id), holderId: 'other-actuator', acquiredAt: '' },
          }),
        },
        terminateCatchUpDuplicate: (taskId, detail) => {
          unwound.push({ taskId, detail });
        },
        loopedLauncher: async () => {
          const taskId = 'loop-dup-1';
          activeTaskIds.add(taskId);
          activeCount += 1;
          return { task: { id: taskId } as any, queued: false };
        },
      });

      await runner.tick();

      expect(unwound).toEqual([
        { taskId: 'loop-dup-1', detail: 'relaunch lease taken mid-fire by other-actuator' },
      ]);
    });
  });

  describe('fair, bounded due-fire selection (issue #2773)', () => {
    /** Create a schedule that is due now (backdated one cron interval). */
    function makeDue(name: string, extra: Partial<Parameters<ScheduleStore['create']>[0]> = {}) {
      const s = store.create({
        name,
        cron: '* * * * *',
        playbook: { path: 'test.md', parameters: {} },
        cwd: dir,
        ...extra,
      });
      replaceSchedule(s.id, { createdAt: new Date(Date.now() - 2 * 60_000).toISOString() });
      return store.get(s.id)!;
    }

    /** Re-arm a schedule so it is due again (clears the advanced cron watermark). */
    function rearm(id: string) {
      const s = store.get(id)!;
      store.replace({
        ...s,
        createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        lastScheduledFor: undefined,
      });
    }

    /** The task id of a schedule's latest execution, or undefined if it never fired. */
    const taskOf = (id: string) => store.get(id)!.latestExecution?.taskId;

    it('caps due fires at the per-tick budget and defers the rest WITHOUT reserving', async () => {
      const scheds = [0, 1, 2, 3, 4].map((i) => makeDue(`S${i}`));

      await createRunner({ maxFiresPerTick: 2 }).tick();

      // Exactly the budget fired, and they are the head of the (un-rotated) list.
      expect(launched).toHaveLength(2);
      const fired = scheds.filter((x) => store.get(x.id)!.latestExecution?.taskId);
      expect(fired.map((x) => x.name)).toEqual(['S0', 'S1']);

      // The deferred schedules were never reserved: no ledger row, no current
      // execution, and — crucially — the cron watermark is untouched so the
      // occurrence is preserved (no duplicate reservation) for a later tick.
      for (const x of scheds.slice(2)) {
        const after = store.get(x.id)!;
        expect(after.currentExecution).toBeUndefined();
        expect(after.latestExecution).toBeUndefined();
        expect(after.lastScheduledFor).toBeUndefined();
        expect(after.executionLedger ?? []).toHaveLength(0);
      }
    });

    it('gives deferred-due schedules priority next tick and eventually fires every schedule once', async () => {
      const scheds = [0, 1, 2, 3].map((i) => makeDue(`S${i}`));
      const runner = createRunner({ maxFiresPerTick: 2 });

      await runner.tick(); // fires S0, S1; defers S2, S3
      expect(launched).toHaveLength(2);
      const afterFirst = scheds.map((x) => taskOf(x.id));
      // Order-agnostic (fires run concurrently): the first two fired, the last
      // two did not.
      expect(afterFirst.slice(0, 2).every(Boolean)).toBe(true);
      expect(afterFirst.slice(2).every((t) => t === undefined)).toBe(true);

      await runner.tick(); // cursor starts at the first deferred (S2): fires S2, S3
      expect(launched).toHaveLength(4);
      const afterSecond = scheds.map((x) => taskOf(x.id));
      // Every schedule has now fired exactly once, and the already-fired pair
      // was NOT re-fired — their own task ids are unchanged (fair, single-shot).
      expect(afterSecond.every(Boolean)).toBe(true);
      expect(afterSecond[0]).toBe(afterFirst[0]);
      expect(afterSecond[1]).toBe(afterFirst[1]);
    });

    it('rotates the leading schedule across ticks and wraps past the end of the list', async () => {
      const a = makeDue('A');
      const b = makeDue('B');
      const c = makeDue('C');
      // Disable the previous-run gate so a re-armed schedule can fire again on a
      // later tick (the mock launcher keeps every task "active" forever); this
      // test exercises cursor rotation, not the coalesce gate.
      const runner = createRunner({ maxFiresPerTick: 1, isTaskBlockingSchedule: () => false });

      // Budget 1 over three always-due schedules: exactly one fires per tick,
      // and the deferred backlog makes the next-in-order schedule lead the next
      // tick. The winner must rotate A → B → C and then WRAP back to A — not
      // stick on the head, and not run off the end of the list.
      const leaders: string[] = [];
      let prev: Record<string, string | undefined> = { [a.id]: undefined, [b.id]: undefined, [c.id]: undefined };
      for (let i = 0; i < 4; i++) {
        await runner.tick();
        const now: Record<string, string | undefined> = { [a.id]: taskOf(a.id), [b.id]: taskOf(b.id), [c.id]: taskOf(c.id) };
        const changed = [a, b, c].filter((s) => now[s.id] !== prev[s.id]);
        expect(changed).toHaveLength(1); // exactly one fired this tick (budget 1)
        leaders.push(changed[0]!.name);
        prev = now;
        rearm(a.id);
        rearm(b.id);
        rearm(c.id);
      }
      expect(leaders).toEqual(['A', 'B', 'C', 'A']);
    });

    it('clamps a below-1 budget to 1 rather than firing nothing', async () => {
      makeDue('A');
      makeDue('B');

      // A misconfigured budget of 0 must not wedge the scheduler into firing
      // nothing — it is clamped to 1 so at least one due schedule still fires.
      await createRunner({ maxFiresPerTick: 0 }).tick();

      expect(launched).toHaveLength(1);
    });

    it('degrades to head-of-list order when the cursor schedule is deleted between ticks', async () => {
      const a = makeDue('A');
      const b = makeDue('B');
      const c = makeDue('C');
      // Disable the previous-run gate so A can fire again on the second tick
      // (the mock launcher keeps every task "active" forever).
      const runner = createRunner({ maxFiresPerTick: 1, isTaskBlockingSchedule: () => false });

      await runner.tick(); // fires A; defers B, C; cursor → B (first deferred)
      const aAfterFirst = taskOf(a.id);

      // Delete the schedule the cursor points at before the next tick; the
      // rotation must degrade to head-of-list order rather than throw.
      await service.delete(b.id);
      rearm(a.id);
      rearm(c.id);

      await runner.tick(); // cursor "B" is gone → start from the head (A)
      expect(taskOf(a.id)).not.toBe(aAfterFirst); // A led again (head), no throw
    });

    it('defaults the per-tick fire budget to 16', () => {
      expect(SCHEDULE_MAX_FIRES_PER_TICK).toBe(16);
    });

    it('a slow (hung) fire cannot prevent other due schedules from being selected on later ticks', async () => {
      const hangDir = join(dir, 'hang');
      await mkdir(hangDir, { recursive: true });
      // Distinct cwd so the launcher can key on it, but resolve the shared
      // playbook from the project tier at `dir` (sourceCwd), not the empty cwd.
      const slow = makeDue('Slow', {
        cwd: hangDir,
        playbook: { path: 'test.md', parameters: {}, scope: 'project', sourceCwd: dir },
      });
      const b = makeDue('B');
      const c = makeDue('C');

      const runner = createRunner({
        maxFiresPerTick: 1,
        fireTimeoutMs: 300,
        launcher: async (opts) => {
          const taskId = `task-${++taskIdCounter}`;
          launched.push({ prompt: opts.prompt, cwd: opts.cwd });
          if (opts.cwd === hangDir) {
            return new Promise<never>(() => {}); // hang forever — never settles
          }
          activeTaskIds.add(taskId);
          activeCount += 1;
          return { task: aTask({ id: taskId, prompt: opts.prompt, cwd: opts.cwd }), queued: false };
        },
      });

      // Tick 1: Slow is dispatched (budget 1), hangs, and the tick releases at
      // its wall-clock cap with Slow stuck in flight; B and C are deferred.
      await runner.tick();
      // Tick 2 + 3: the deferred B and C are selected in fair order despite Slow
      // still being stuck — the slow fire never blocks their selection.
      await runner.tick();
      await runner.tick();
      await runner.stop();

      expect(store.get(b.id)!.latestExecution?.taskId).toBeTruthy();
      expect(store.get(c.id)!.latestExecution?.taskId).toBeTruthy();
      // Slow's launcher was invoked exactly once and its reservation is still
      // pending: the in-flight guard kept the stuck fire from re-firing, so the
      // occurrence was never duplicated while B and C made progress.
      expect(launched.filter((l) => l.cwd === hangDir)).toHaveLength(1);
      expect(store.get(slow.id)!.currentExecution?.status).toBe('reserved');
    });

    it('a repeatedly failing schedule does not starve other due schedules across ticks', async () => {
      const failDir = join(dir, 'fail');
      await mkdir(failDir, { recursive: true });
      // Distinct cwd so the launcher can key on it, but resolve the shared
      // playbook from the project tier at `dir` (sourceCwd), not the empty cwd.
      const bad = makeDue('Bad', {
        cwd: failDir,
        playbook: { path: 'test.md', parameters: {}, scope: 'project', sourceCwd: dir },
      });
      const b = makeDue('B');
      const c = makeDue('C');

      let badAttempts = 0;
      const runner = createRunner({
        maxFiresPerTick: 2,
        launcher: async (opts) => {
          const taskId = `task-${++taskIdCounter}`;
          launched.push({ prompt: opts.prompt, cwd: opts.cwd });
          if (opts.cwd === failDir) {
            badAttempts += 1;
            throw new Error('boom');
          }
          activeTaskIds.add(taskId);
          activeCount += 1;
          return { task: aTask({ id: taskId, prompt: opts.prompt, cwd: opts.cwd }), queued: false };
        },
      });

      // Tick 1: [Bad, B, C] with budget 2 → Bad fires+fails, B fires; C deferred.
      await runner.tick();
      rearm(bad.id); // Bad comes due again — it keeps failing on every occurrence.
      // Tick 2: cursor starts at the deferred C → C fires, and Bad fires+fails
      // again (2nd failure). B already fired this occurrence.
      await runner.tick();

      // Bad failed on more than one tick, yet both B and C still fired: the
      // failing schedule never monopolized the budget nor starved its peers.
      expect(badAttempts).toBeGreaterThanOrEqual(2);
      expect(store.get(bad.id)!.latestExecution?.outcome).toBe('dispatch_failed');
      expect(store.get(b.id)!.latestExecution?.taskId).toBeTruthy();
      expect(store.get(c.id)!.latestExecution?.taskId).toBeTruthy();
    });

    it('startup catch-up is NOT bounded by the per-tick fire budget (all missed runs fire)', async () => {
      const scheds = [0, 1, 2, 3].map((i) => makeDue(`Missed${i}`));

      // A tiny per-tick budget must not throttle catch-up: every missed run is a
      // one-shot recovery fire, independent of the steady-state tick budget.
      const runner = createRunner({ maxFiresPerTick: 1 });
      runner.start();
      await vi.waitFor(() => {
        expect(launched).toHaveLength(scheds.length);
      });
      await runner.stop();

      for (const x of scheds) {
        expect(store.get(x.id)!.executionLedger[0]).toEqual(expect.objectContaining({
          decision: 'catch_up',
        }));
      }
    });
  });

});

describe('isTaskBlockingSchedule', () => {
  const now = new Date('2026-05-08T12:00:00Z');

  it('returns false when task is undefined', () => {
    expect(isTaskBlockingSchedule(undefined, now)).toBe(false);
  });

  it('returns false when task is in a terminal status', () => {
    const task = { status: 'completed' as const, updatedAt: now };
    expect(isTaskBlockingSchedule(task, now)).toBe(false);
  });

  it('returns true when task is fresh and active', () => {
    const task = {
      status: 'inProgress' as const,
      updatedAt: new Date(now.getTime() - 60_000),
    };
    expect(isTaskBlockingSchedule(task, now)).toBe(true);
  });

  it('returns false when active task exceeds the staleness threshold', () => {
    const task = {
      status: 'inProgress' as const,
      updatedAt: new Date(now.getTime() - SCHEDULE_GATE_MAX_TASK_AGE_MS - 1),
    };
    expect(isTaskBlockingSchedule(task, now)).toBe(false);
  });

  it('keeps dependency-parked scheduled work blocking beyond the staleness threshold', () => {
    const task = {
      status: 'pending' as const,
      updatedAt: new Date(now.getTime() - SCHEDULE_GATE_MAX_TASK_AGE_MS - 1),
      launchAdmission: {
        status: 'parked' as const,
        reason: 'dependency_degraded' as const,
        dependencies: [{ dependency: 'kb', state: 'degraded' as const }],
        parkedAt: '2026-05-07T00:00:00.000Z',
      },
    };

    expect(isTaskBlockingSchedule(task, now)).toBe(true);
  });

  it('treats the boundary (age === threshold) as stale', () => {
    const task = {
      status: 'inProgress' as const,
      updatedAt: new Date(now.getTime() - SCHEDULE_GATE_MAX_TASK_AGE_MS),
    };
    expect(isTaskBlockingSchedule(task, now)).toBe(false);
  });

  it('treats just-under-the-boundary as fresh', () => {
    const task = {
      status: 'inProgress' as const,
      updatedAt: new Date(now.getTime() - SCHEDULE_GATE_MAX_TASK_AGE_MS + 1),
    };
    expect(isTaskBlockingSchedule(task, now)).toBe(true);
  });

  it('clamps future updatedAt to age 0 (clock-skew defense)', () => {
    // Without the Math.max(0, …) clamp, a future updatedAt would yield a
    // negative ageMs and silently bypass the freshness check forever.
    const task = {
      status: 'inProgress' as const,
      updatedAt: new Date(now.getTime() + 60 * 60_000),
    };
    expect(isTaskBlockingSchedule(task, now)).toBe(true);
  });
});

describe('ScheduleRunner launch timeout + dead-man wiring (issue #1526 Phase C)', () => {
  let dir: string;
  let store: ScheduleStore;
  let service: ScheduleService;
  let validator: ScheduleValidator;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'runner-c1-test-'));
    store = new ScheduleStore(dir);
    validator = new ScheduleValidator();
    service = new ScheduleService({ store, validator });
    await mkdir(join(dir, '.kookr', 'playbooks'), { recursive: true });
    await writeFile(join(dir, '.kookr', 'playbooks', 'test.md'), `---
name: Test Playbook
parameters: []
---

Do the thing.
`);
  });

  afterEach(async () => {
    // force:true still races a hung fire writing into the dir mid-rm; retry once.
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      await new Promise((r) => setTimeout(r, 50));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a launcher rejection shaped like LaunchTimeoutError records dispatch_failed / launch_error', async () => {
    const schedule = store.create({
      name: 'Times out',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    store.replace({
      ...store.get(schedule.id)!,
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const timeoutError = Object.assign(
      new Error('Agent launch timed out after 180s (agent claude-code, task t1) — launch abandoned'),
      { name: 'LaunchTimeoutError', code: 'launch_timeout' },
    );
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      launcher: async () => { throw timeoutError; },
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
    });
    await runner.tick();

    const after = store.get(schedule.id)!;
    expect(after.latestExecution?.outcome).toBe('dispatch_failed');
    expect(after.latestExecution?.reasonCode).toBe('launch_error');
    expect(after.latestExecution?.message).toContain('timed out');
    // The receipt is terminal — nothing left 'reserved' to wedge the schedule.
    expect(after.currentExecution?.status).toBe('terminal');
  });

  it('a fire rejected by the pending-queue depth limit records dispatch_failed / pending_queue_full (issue #1526 C3)', async () => {
    const schedule = store.create({
      name: 'Queue full',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    store.replace({
      ...store.get(schedule.id)!,
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      launcher: async () => {
        throw new PendingQueueFullError({
          maxActiveTasks: 10,
          active: 10,
          free: 0,
          byClass: { working: 1, finishedAwaitingAck: 8, hungSuspect: 1, launching: 0 },
          effectiveWorking: 1,
          phantomActive: 9,
          pendingQueueDepth: 24,
          oldestPendingAgeMs: 60_000,
          oldestFinishedAwaitingAckAgeMs: null,
        }, 24);
      },
      getActiveCount: () => 10,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
    });
    await runner.tick();

    const after = store.get(schedule.id)!;
    // Never silently dropped: the ledger shows the fire AND why it failed,
    // with a reason distinct from a broken launcher.
    expect(after.latestExecution?.outcome).toBe('dispatch_failed');
    expect(after.latestExecution?.reasonCode).toBe('pending_queue_full');
    expect(after.latestExecution?.message).toContain('Pending queue is full');
    expect(after.currentExecution?.status).toBe('terminal');
  });

  it('the dead-man switch is evaluated once per tick with the full schedule list', async () => {
    const check = vi.fn();
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      launcher: async () => ({ task: { id: 'unused' } as any, queued: false }),
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
      deadMan: { check },
    });

    await runner.tick();
    await runner.tick();

    expect(check).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenCalledWith(store.list());
  });

  it('pushes the dead-man self-heal stats onto the status snapshot each tick (issue #1903)', async () => {
    const stats = vi.fn(() => ({
      attempts: 4,
      successes: 1,
      episodeAttempts: 2,
      escalated: true,
      firing: true,
    }));
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      launcher: async () => ({ task: { id: 'unused' } as any, queued: false }),
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
      deadMan: { check: vi.fn(), stats },
    });

    await runner.tick();

    expect(stats).toHaveBeenCalled();
    // Only the observable subset is surfaced (episodeAttempts/firing are internal).
    expect(service.getStatusSnapshot().deadManSelfHeal).toEqual({
      attempts: 4,
      successes: 1,
      escalated: true,
    });
  });

  it('omits deadManSelfHeal from the snapshot until self-heal has acted (issue #1903)', async () => {
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      launcher: async () => ({ task: { id: 'unused' } as any, queued: false }),
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
      // stats() always returns an object, but with no activity yet.
      deadMan: {
        check: vi.fn(),
        stats: () => ({ attempts: 0, successes: 0, episodeAttempts: 0, escalated: false, firing: false }),
      },
    });

    await runner.tick();

    // Absent when unconfigured / never-run, matching the field's documented contract.
    expect(service.getStatusSnapshot().deadManSelfHeal).toBeUndefined();
  });

  it('clears the snapshot self-heal state on recovery once it has surfaced (issue #1903)', async () => {
    // Regression: the push was gated on `attempts > 0 || escalated`, so the
    // recovery tick (attempts→0, escalated cleared) was dropped and the stale
    // in-episode value froze — e.g. a cap=0 escalate→recover left escalated:true
    // standing on /api/health forever. Once surfaced, every tick must re-sync.
    const stats = vi
      .fn()
      // Tick 1: escalated episode in flight (surfaces the field).
      .mockReturnValueOnce({ attempts: 0, successes: 0, episodeAttempts: 0, escalated: true, firing: true })
      // Tick 2: recovered — everything reset.
      .mockReturnValueOnce({ attempts: 0, successes: 0, episodeAttempts: 0, escalated: false, firing: false });
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      launcher: async () => ({ task: { id: 'unused' } as any, queued: false }),
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
      deadMan: { check: vi.fn(), stats },
    });

    await runner.tick();
    expect(service.getStatusSnapshot().deadManSelfHeal).toEqual({ attempts: 0, successes: 0, escalated: true });

    await runner.tick();
    // Not frozen at escalated:true — the recovery is reflected.
    expect(service.getStatusSnapshot().deadManSelfHeal).toEqual({ attempts: 0, successes: 0, escalated: false });
  });

  it('selfHealRefire() forces a re-fire of the named schedules WITHOUT re-running the dead-man check, and is a no-op after stop() (issue #1903)', async () => {
    const waitFor = async (cond: () => boolean, ms = 1000): Promise<void> => {
      const start = Date.now();
      while (!cond() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 5));
    };

    const check = vi.fn();
    const launched: string[] = [];
    const sched = store.create({
      name: 'Starved',
      cron: '0 0 1 1 *', // far-future due time: NOT due now, so only a forced re-fire launches it
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      launcher: async () => {
        launched.push(sched.id);
        return { task: { id: 'task-heal' } as any, queued: false };
      },
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
      deadMan: { check },
    });

    runner.selfHealRefire([sched.id]);
    await waitFor(() => launched.length > 0); // let the deferred re-fire + its async fire settle

    expect(launched).toEqual([sched.id]); // exactly one forced re-fire
    // Crux of the #1903 correctness fix: the actuator must NOT loop back through
    // deadMan.check() (which would re-arm self-heal and burst the cap).
    expect(check).not.toHaveBeenCalled();

    await runner.stop();
    runner.selfHealRefire([sched.id]);
    await new Promise((r) => setTimeout(r, 30));
    expect(launched).toEqual([sched.id]); // stopped runner ignores the re-fire
  });

  it('selfHealRefire() skips a schedule whose cron fire is still in flight — no double launch (issue #1903)', async () => {
    let launchCount = 0;
    const sched = store.create({
      name: 'DueStarved',
      cron: '* * * * *', // due every minute
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    // Backdate so it is due now.
    store.replace({ ...store.get(sched.id)!, createdAt: new Date(Date.now() - 2 * 60_000).toISOString() });
    // Cap must sit above real fs-persist cost under full-suite load (same
    // rationale as the hung-fire wall-clock test below). A 50ms cap could
    // expire during reserveExecution, so tick() returned before the hung
    // launcher was entered and launchCount stayed 0.
    const CAP = 1_000;
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      fireTimeoutMs: CAP,
      launcher: async () => {
        launchCount += 1;
        return new Promise<never>(() => {}); // hang: the cron fire never settles → stays in flight
      },
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
      deadMan: { check: vi.fn() },
    });

    // The cron fire launches (once) and hangs; the tick releases at the cap with
    // the fire still in `inFlightFires`.
    await runner.tick();
    expect(launchCount).toBe(1);

    // A self-heal re-fire of the same in-flight schedule must NOT launch a second
    // task — the in-flight guard skips it (coalesce alone can't: no accepted
    // taskId yet).
    runner.selfHealRefire([sched.id]);
    await new Promise((r) => setTimeout(r, 40)); // let the deferred re-fire run
    expect(launchCount).toBe(1);

    // Stop so afterEach can rm the temp dir without racing the hung fire's
    // rollup write (ENOTEMPTY under suite load).
    await runner.stop();
  });

  it('the re-queue-after-reset sweep is evaluated once per tick (issue #1896)', async () => {
    const sweep = vi.fn();
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      launcher: async () => ({ task: { id: 'unused' } as any, queued: false }),
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
      resetScheduler: { sweep },
    });

    await runner.tick();
    await runner.tick();

    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('a throwing reset-scheduler sweep does not abort the tick — due fires still run (issue #1896)', async () => {
    const schedule = store.create({
      name: 'Test',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    store.replace({
      ...store.get(schedule.id)!,
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const launched: string[] = [];
    const sweep = vi.fn(() => {
      throw new Error('sweep boom');
    });
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      launcher: async (opts) => {
        launched.push(opts.prompt);
        return { task: { id: `task-${launched.length}` } as any, queued: false };
      },
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
      resetScheduler: { sweep },
    });

    await expect(runner.tick()).resolves.toBeUndefined();
    expect(sweep).toHaveBeenCalledTimes(1);
    // The sweep runs before the fire loop; a sweep throw must not prevent the
    // due schedule from firing.
    expect(launched).toHaveLength(1);
  });

  it('suppresses the reset sweep under the automation kill-switch (issue #1896)', async () => {
    const sweep = vi.fn();
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      launcher: async () => ({ task: { id: 'unused' } as any, queued: false }),
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
      isAutomationEnabled: () => false,
      resetScheduler: { sweep },
    });

    await runner.tick();

    expect(sweep).not.toHaveBeenCalled();
  });

  it('keeps the wall-clock cap below the tick interval (issue #1708 invariant)', () => {
    // The whole decoupling relies on a stalled fire settling within one tick so
    // it can never bleed into the next; the source comment claims "kept below
    // TICK_INTERVAL_MS" (60_000). Lock that relationship in.
    expect(FIRE_WALL_CLOCK_CAP_MS).toBeLessThan(60_000);
  });

  it('wall-clock-bounds a hung fire() so other fires and the dead-man still run (issue #1708)', async () => {
    // Two due schedules. The FIRST schedule's launcher hangs forever; the
    // second launches normally. A single hung fire() must not block the other
    // fire OR the dead-man self-check — the whole point of #1708.
    await writeFile(join(dir, '.kookr', 'playbooks', 'hang.md'), `---
name: Hang Playbook
parameters: []
---

HANG forever.
`);
    await writeFile(join(dir, '.kookr', 'playbooks', 'ok.md'), `---
name: OK Playbook
parameters: []
---

Launch fine.
`);

    // `hung` is created first so it is first in store.list() insertion order —
    // under a (rejected) sequential-but-bounded implementation the ok fire
    // would not even start until hung's cap elapsed. The concurrency assertion
    // below relies on this ordering.
    const hung = store.create({
      name: 'Hangs',
      cron: '* * * * *',
      playbook: { path: 'hang.md', parameters: {} },
      cwd: dir,
    });
    store.replace({ ...store.get(hung.id)!, createdAt: new Date(Date.now() - 2 * 60_000).toISOString() });
    const ok = store.create({
      name: 'Fires fine',
      cron: '* * * * *',
      playbook: { path: 'ok.md', parameters: {} },
      cwd: dir,
    });
    store.replace({ ...store.get(ok.id)!, createdAt: new Date(Date.now() - 2 * 60_000).toISOString() });

    const CAP = 1_000;
    const start = Date.now();
    let hungLauncherEntered = false;
    let okLaunchedAtMs: number | undefined;
    // Capture the hung schedule's receipt status AT dead-man-check time to prove
    // the check runs BEFORE the fires reserve (decoupled), not merely once.
    let hungStatusAtCheck: string | undefined = 'sentinel';
    const deadManCheck = vi.fn((schedules: Array<ReturnType<ScheduleStore['get']>>) => {
      const h = schedules.find((s) => s?.id === hung.id);
      hungStatusAtCheck = h?.currentExecution?.status;
    });
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      // Short cap so the hung launcher is bounded in real time without slowing
      // the suite; production default is FIRE_WALL_CLOCK_CAP_MS. Comfortably
      // above the healthy fire's real fs-persist cost so only the stuck fire
      // trips it.
      fireTimeoutMs: CAP,
      launcher: async (opts) => {
        if (opts.prompt.includes('HANG')) {
          hungLauncherEntered = true;
          return new Promise<never>(() => {}); // never settles — models a stuck launcher
        }
        okLaunchedAtMs = Date.now() - start;
        return { task: { id: 'task-ok' } as any, queued: false };
      },
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
      deadMan: { check: deadManCheck },
    });

    await runner.tick();
    const elapsed = Date.now() - start;

    // The tick was bounded — it did NOT wait on the never-settling launcher
    // (which would hang the tick forever without the cap).
    expect(elapsed).toBeLessThan(CAP * 3);
    // The stuck launcher WAS entered — the cap is what let the tick move on.
    expect(hungLauncherEntered).toBe(true);
    // Concurrency: the ok fire launched WELL BEFORE hung's cap elapsed. Under a
    // sequential-but-bounded loop (hung first) ok would not launch until ~CAP;
    // proving it launched early is what proves a hung fire does not *block* the
    // others, not merely that they eventually run.
    expect(okLaunchedAtMs).toBeDefined();
    expect(okLaunchedAtMs!).toBeLessThan(CAP / 2);
    // The dead-man self-check ran, and ran BEFORE the fires reserved (its
    // captured view of the hung schedule had no receipt yet) — i.e. decoupled
    // from, not gated behind, the fire loop.
    expect(deadManCheck).toHaveBeenCalledTimes(1);
    expect(hungStatusAtCheck).toBeUndefined();
    // The healthy schedule's fire completed and recorded an accepted execution.
    const okAfter = store.get(ok.id)!;
    expect(okAfter.currentExecution?.status).toBe('accepted');
    expect(okAfter.latestExecution?.taskId).toBe('task-ok');
    // The hung schedule is bounded: its reservation exists but never advanced
    // past 'reserved' within the tick (its fire is still hanging in the
    // background, where its own error path will eventually record the outcome).
    const hungAfter = store.get(hung.id)!;
    expect(hungAfter.currentExecution?.status).toBe('reserved');
  });

  it('does not re-fire (duplicate) a schedule whose previous fire is still in flight past the cap (issue #1708)', async () => {
    // Regression guard: bounding a fire releases the tick's `firing` gate while
    // the launcher is still stuck. Without an in-flight guard, the NEXT tick
    // would see the same occurrence as due (reserveExecution already advanced
    // lastScheduledFor) and, with disableDedup set, launch a SECOND task.
    await writeFile(join(dir, '.kookr', 'playbooks', 'stuck.md'), `---
name: Stuck Playbook
parameters: []
---

Launch and stall.
`);
    const schedule = store.create({
      name: 'Stuck',
      cron: '* * * * *',
      playbook: { path: 'stuck.md', parameters: {} },
      cwd: dir,
    });
    store.replace({ ...store.get(schedule.id)!, createdAt: new Date(Date.now() - 2 * 60_000).toISOString() });

    let launchCount = 0;
    // Resolves the instant the launcher is entered — a deterministic signal that
    // the first fire reached its launcher, independent of the wall-clock cap
    // (issue #2542).
    let signalLauncherEntered!: () => void;
    const launcherEntered = new Promise<void>((resolve) => {
      signalLauncherEntered = resolve;
    });
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      fireTimeoutMs: 200,
      launcher: async () => {
        launchCount += 1;
        signalLauncherEntered();
        return new Promise<never>(() => {}); // never settles — the fire stays in flight
      },
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
    });

    // Force the schedule due again for the given tick. reserveExecution advances
    // lastScheduledFor, so without this reset a later tick might not be due and
    // the test would pass vacuously — we want due-ness so the in-flight guard is
    // provably the ONLY thing preventing a second launch.
    const forceDue = () =>
      store.replace({ ...store.get(schedule.id)!, lastScheduledFor: new Date(Date.now() - 2 * 60_000).toISOString() });

    // First tick launches once and is bounded by the cap. Wait on the
    // launcher-entered signal — NOT the wall-clock cap — before asserting the
    // launch happened (issue #2542): fire()'s fs-persist prefix races the 200ms
    // cap, so under parallel-load CPU contention the cap can fire before fire()
    // reaches the launcher, leaving launchCount at 0 here. `launcherEntered`
    // resolves deterministically the moment the launcher runs, regardless of
    // scheduler slack; awaiting `firstTick` afterward lets the cap release the
    // tick's `firing` gate so the subsequent ticks below actually run their
    // fire loop.
    const firstTick = runner.tick();
    // Bound the signal wait so a genuine regression — fire()'s pre-launcher
    // prefix failing before it ever reaches the launcher — fails fast with a
    // clear message instead of hanging to the vitest test timeout (which, since
    // .hooks/pre-push runs the suite, would wedge the very gate this fix keeps
    // green). The happy path resolves via `launcherEntered` far under this
    // bound; the timer is a diagnostic guard, not a race the assertion depends
    // on, and is cleared the instant the signal wins so it never lingers.
    let entryGuard: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      launcherEntered.finally(() => { if (entryGuard) clearTimeout(entryGuard); }),
      new Promise<never>((_, reject) => {
        entryGuard = setTimeout(
          () => reject(new Error('launcher was never entered within 5s — fire() prefix likely threw before reaching the launcher (issue #2542)')),
          5_000,
        );
      }),
    ]);
    expect(launchCount).toBe(1);
    await firstTick;

    // Subsequent ticks — schedule due each time, fire still in flight — must
    // NOT launch again.
    forceDue();
    await runner.tick();
    forceDue();
    await runner.tick();
    expect(launchCount).toBe(1);
  });

  it('feeds the resolution alerter the unresolvable schedules (issue #1661)', async () => {
    // A legacy (no-scope) schedule whose playbook does NOT exist in the project
    // tier — cwd exists, but `.kookr/playbooks/missing.md` does not. This is the
    // shape of the 68e9cb52 incident.
    const broken = store.create({
      name: 'Lucy parallel issue batch',
      cron: '* * * * *',
      playbook: { path: 'missing.md', parameters: {} },
      cwd: dir,
    });
    // A resolvable schedule (test.md exists in the project tier) — must NOT be
    // reported as unresolvable, but SHOULD appear in the resolved-ids set.
    const healthy = store.create({
      name: 'Healthy',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });

    const check = vi.fn();
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      launcher: async () => ({ task: { id: 'unused' } as any, queued: false }),
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
      resolutionAlerter: { check },
    });

    runner.refreshPlaybookResolution();

    expect(check).toHaveBeenCalledTimes(1);
    const [reported, resolvedIds] = check.mock.calls[0];
    expect(reported).toEqual([
      expect.objectContaining({
        id: broken.id,
        name: 'Lucy parallel issue batch',
        playbookPath: 'missing.md',
        scope: 'project',
        legacy: true,
      }),
    ]);
    // The healthy schedule is not in the unresolvable report...
    expect(reported).toHaveLength(1);
    // ...but IS in the genuinely-resolved set that gates recovery alerts.
    expect(resolvedIds).toEqual([healthy.id]);
  });

  it('feeds the batch-pin alerter the pinned recurring batches and every evaluated id (issue #2982)', () => {
    // The 2026-09-02 incident shape: a recurring Parallel Issue Batch pinned to
    // an explicit issue list. detectDrainedPinRisk keys only off the config, so
    // the playbook path need not resolve for this detector.
    const pinned = store.create({
      name: 'Kookr parallel issue batch',
      cron: '23 2,14 * * *',
      playbook: { path: 'parallel-issue-batch.md', parameters: { issueSelector: '2756 2757 2758' } },
      cwd: dir,
    });
    // A healthy batch with a blank selector (the working Lucy config) — must be
    // evaluated but NOT reported as pinned.
    const healthy = store.create({
      name: 'Lucy parallel issue batch',
      cron: '7 */2 * * *',
      playbook: { path: 'parallel-issue-batch.md', parameters: { issueSelector: '' } },
      cwd: dir,
    });

    const check = vi.fn();
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      launcher: async () => ({ task: { id: 'unused' } as any, queued: false }),
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
      batchPinAlerter: { check },
    });

    runner.refreshPlaybookResolution();

    expect(check).toHaveBeenCalledTimes(1);
    const [reportedPins, evaluatedIds] = check.mock.calls[0];
    // Only the pinned batch is reported, with its parsed issue list...
    expect(reportedPins).toEqual([
      expect.objectContaining({
        id: pinned.id,
        name: 'Kookr parallel issue batch',
        issues: [2756, 2757, 2758],
        selector: '2756 2757 2758',
      }),
    ]);
    // ...while every evaluated schedule id (pinned + healthy) is forwarded so the
    // alerter can tell "pin cleared" from "schedule deleted".
    expect(new Set(evaluatedIds)).toEqual(new Set([pinned.id, healthy.id]));
  });
});

describe('cheap probe pre-check (issue #2569)', () => {
  let dir: string;
  let store: ScheduleStore;
  let service: ScheduleService;
  let validator: ScheduleValidator;
  let launched: Array<{ prompt: string }>;
  let runners: Set<ScheduleRunner>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'runner-probe-test-'));
    store = new ScheduleStore(dir);
    validator = new ScheduleValidator();
    service = new ScheduleService({ store, validator });
    launched = [];
    runners = new Set();
    await mkdir(join(dir, '.kookr', 'playbooks'), { recursive: true });
  });

  afterEach(async () => {
    await Promise.all([...runners].map((runner) => runner.stop()));
    await rm(dir, { recursive: true, force: true });
  });

  function createProbeRunner(runProbe: ScheduleRunnerDeps['runProbe']): ScheduleRunner {
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      launcher: async (opts) => {
        launched.push({ prompt: opts.prompt });
        return { task: { id: `task-${launched.length}` } as never, queued: false };
      },
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
      runProbe,
    });
    runners.add(runner);
    return runner;
  }

  async function writeConvergencePlaybook(): Promise<void> {
    await writeFile(join(dir, '.kookr', 'playbooks', 'kookr-deploy-convergence.md'), `---
name: Kookr Deploy Convergence
parameters:
  - name: branch
    default: main
  - name: graceMinutes
    default: "15"
  - name: act
    default: "true"
  - name: dryRun
    default: "false"
probe:
  command: pnpm deploy:convergence -- --branch "{{branch}}" --grace-minutes "{{graceMinutes}}"
  escalateOnExit: 2
---
Run the probe.
`);
  }

  function markDue(id: string): void {
    store.replace({
      ...store.get(id)!,
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });
  }

  it('completes a converged tick without launching an agent', async () => {
    await writeConvergencePlaybook();
    const schedule = store.create({
      name: 'Kookr Deploy Convergence',
      cron: '* * * * *',
      playbook: { path: 'kookr-deploy-convergence.md', parameters: { act: 'true' } },
      cwd: dir,
    });
    markDue(schedule.id);

    const probes: Array<{ argv: string[]; cwd: string }> = [];
    const runner = createProbeRunner(async (spec, cwd) => {
      probes.push({ argv: spec.argv, cwd });
      return {
        exitCode: 0,
        stdout: JSON.stringify({ receipt: 'deploy-convergence: converged · serving=abc main=abc' }),
        stderr: '',
      };
    });
    await runner.tick();

    expect(launched).toHaveLength(0);
    expect(probes).toHaveLength(1);
    expect(probes[0].argv).toContain('--act');
    const after = store.get(schedule.id)!;
    expect(after.latestExecution?.outcome).toBe('completed');
    expect(after.latestExecution?.reasonCode).toBe('probe_quiet');
    expect(after.latestExecution?.taskId).toBeUndefined();
    expect(after.lastRunStatus).toBe('completed');
    expect(after.latestExecution?.message).toContain('converged');
  });

  it('treats a probe blip as completed without launching', async () => {
    await writeConvergencePlaybook();
    const schedule = store.create({
      name: 'Kookr Deploy Convergence',
      cron: '* * * * *',
      playbook: { path: 'kookr-deploy-convergence.md', parameters: {} },
      cwd: dir,
    });
    markDue(schedule.id);

    const runner = createProbeRunner(async () => ({ exitCode: 1, stdout: '', stderr: 'health down' }));
    await runner.tick();

    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('probe_blip');
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('completed');
  });

  it('escalates a DIVERGENT tick to the existing playbook agent', async () => {
    await writeConvergencePlaybook();
    const schedule = store.create({
      name: 'Kookr Deploy Convergence',
      cron: '* * * * *',
      playbook: { path: 'kookr-deploy-convergence.md', parameters: { act: 'true' } },
      cwd: dir,
    });
    markDue(schedule.id);

    const probes: string[][] = [];
    const runner = createProbeRunner(async (spec) => {
      probes.push(spec.argv);
      return {
        exitCode: 2,
        stdout: JSON.stringify({ receipt: 'deploy-convergence: DIVERGENT · serving=old main=new' }),
        stderr: '',
      };
    });
    await runner.tick();

    expect(probes).toHaveLength(1);
    expect(probes[0]).toContain('--act');
    expect(launched).toHaveLength(1);
    expect(launched[0].prompt).toContain('Run the probe.');
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('running');
    expect(store.get(schedule.id)!.latestExecution?.taskId).toBe('task-1');
  });

  it('uses a declared probe command that is not the basename fallback', async () => {
    await writeFile(join(dir, '.kookr', 'playbooks', 'custom-probe.md'), `---
name: Custom Probe
probe:
  command: node scripts/custom-probe.mjs --branch "{{branch}}"
  escalateOnExit: 2
---
Custom body.
`);
    const schedule = store.create({
      name: 'Custom Probe',
      cron: '* * * * *',
      playbook: { path: 'custom-probe.md', parameters: { branch: 'staging' } },
      cwd: dir,
    });
    markDue(schedule.id);

    const probes: string[][] = [];
    const runner = createProbeRunner(async (spec) => {
      probes.push(spec.argv);
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    });
    await runner.tick();

    expect(probes).toEqual([['node', 'scripts/custom-probe.mjs', '--branch', 'staging']]);
    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('probe_quiet');
  });

  it('treats a throwing probe runner as a blip', async () => {
    await writeConvergencePlaybook();
    const schedule = store.create({
      name: 'Kookr Deploy Convergence',
      cron: '* * * * *',
      playbook: { path: 'kookr-deploy-convergence.md', parameters: {} },
      cwd: dir,
    });
    markDue(schedule.id);

    const runner = createProbeRunner(async () => {
      throw new Error('probe exploded');
    });
    await runner.tick();

    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('completed');
    expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('probe_blip');
    expect(store.get(schedule.id)!.latestExecution?.taskId).toBeUndefined();
  });

  it('does not escalate a dry-run DIVERGENT tick', async () => {
    await writeConvergencePlaybook();
    const schedule = store.create({
      name: 'Kookr Deploy Convergence',
      cron: '* * * * *',
      playbook: {
        path: 'kookr-deploy-convergence.md',
        parameters: { dryRun: 'true', act: 'true' },
      },
      cwd: dir,
    });
    markDue(schedule.id);

    const runner = createProbeRunner(async (spec) => {
      expect(spec.argv).not.toContain('--act');
      expect(spec.escalateOnExit).toEqual([]);
      return { exitCode: 2, stdout: 'DIVERGENT', stderr: '' };
    });
    await runner.tick();

    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('probe_quiet');
  });

  it('uses the Lucy fallback so that schedule is cheap without a Lucy PR', async () => {
    const schedule = store.create({
      name: 'Lucy Deploy Convergence',
      cron: '* * * * *',
      playbook: { path: 'lucy-deploy-convergence.md', parameters: { act: 'true' } },
      cwd: dir,
    });
    markDue(schedule.id);

    const probes: string[][] = [];
    const runner = createProbeRunner(async (spec) => {
      probes.push(spec.argv);
      return { exitCode: 0, stdout: 'converged', stderr: '' };
    });
    await runner.tick();

    expect(launched).toHaveLength(0);
    expect(probes[0][0]).toBe('node');
    expect(probes[0]).toContain('scripts/deploy-convergence-check.mjs');
    expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('probe_quiet');
  });

  it('maps a real execFile exit 2 through defaultExecScheduleProbe', async () => {
    const result = await defaultExecScheduleProbe(
      {
        argv: ['node', '-e', 'process.exit(2)'],
        escalateOnExit: [2],
        timeoutMs: 5_000,
      },
      dir,
    );
    expect(result.exitCode).toBe(2);
  });
});

describe('playbook cwd lag warning (issue #2945)', () => {
  let dir: string;
  let store: ScheduleStore;
  let service: ScheduleService;
  let validator: ScheduleValidator;
  let launched: Array<{
    prompt: string;
    playbookSource?: {
      id: string;
      scope: string;
      sourceCwd: string;
      sourceDigest: string;
      ref?: string;
      upstreamRef?: string;
      behindBy?: number;
      drifted?: boolean;
    };
  }>;
  let runners: Set<ScheduleRunner>;

  const driftedInspect = async () => ({
    ref: 'aaa111bbb222ccc333ddd444eee555fff666000',
    upstreamRef: 'origin/main',
    behindBy: 2,
    drifted: true as const,
    blobDiffers: true,
    warning: 'WARNING: This scheduled playbook\'s cwd checkout lags its upstream. HEAD aaa111bbb222 is 2 commits behind `origin/main`. The playbook file `.kookr/playbooks/test.md` differs from upstream. A fix already merged upstream may not be in effect. Fast-forward this checkout before re-deriving a local fix. This warning does not block the run.',
  });

  const currentInspect = async () => ({
    ref: 'fff000eee555ddd444ccc333bbb222aaa111999',
    upstreamRef: 'origin/main',
    behindBy: 0,
    drifted: false as const,
    blobDiffers: false,
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'runner-cwd-lag-'));
    store = new ScheduleStore(dir);
    validator = new ScheduleValidator();
    service = new ScheduleService({ store, validator });
    launched = [];
    runners = new Set();
    await mkdir(join(dir, '.kookr', 'playbooks'), { recursive: true });
    await writeFile(join(dir, '.kookr', 'playbooks', 'test.md'), `---
name: Test Playbook
description: A test playbook
parameters: []
checklist:
  - Step 1
---

Do the test thing.
`);
  });

  afterEach(async () => {
    await Promise.all([...runners].map((runner) => runner.stop()));
    await rm(dir, { recursive: true, force: true });
  });

  function createRunner(overrides: Partial<ScheduleRunnerDeps> = {}) {
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      launcher: async (opts) => {
        launched.push({
          prompt: opts.prompt,
          playbookSource: opts.playbookSource,
        });
        return { task: aTask({ id: `task-${launched.length}`, prompt: opts.prompt, cwd: opts.cwd }), queued: false };
      },
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
      inspectPlaybookCheckoutDrift: driftedInspect,
      ...overrides,
    });
    runners.add(runner);
    return runner;
  }

  function markDue(id: string): void {
    store.replace({
      ...store.get(id)!,
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });
  }

  it('injects a drift warning into the spawn briefing and records provenance on the receipt', async () => {
    const inspect = vi.fn(driftedInspect);
    const schedule = store.create({
      name: 'Lucy Workflow Reflection',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    markDue(schedule.id);

    await createRunner({ inspectPlaybookCheckoutDrift: inspect }).tick();
    expect(inspect).toHaveBeenCalledWith(dir, '.kookr/playbooks/test.md');

    expect(launched).toHaveLength(1);
    expect(launched[0]!.prompt).toContain('lags its upstream');
    expect(launched[0]!.prompt).toContain('Do the test thing.');
    expect(launched[0]!.playbookSource).toMatchObject({
      id: 'test.md',
      scope: 'project',
      sourceCwd: dir,
    });
    expect(launched[0]!.playbookSource).not.toHaveProperty('behindBy');
    expect(store.get(schedule.id)!.latestExecution).toMatchObject({
      outcome: 'running',
      playbookSource: {
        ref: 'aaa111bbb222ccc333ddd444eee555fff666000',
        upstreamRef: 'origin/main',
        behindBy: 2,
        drifted: true,
      },
    });
    expect(store.get(schedule.id)!.executionLedger[0]).toMatchObject({
      playbookSource: {
        ref: 'aaa111bbb222ccc333ddd444eee555fff666000',
        behindBy: 2,
        drifted: true,
      },
    });
    expect(store.get(schedule.id)!.currentExecution?.playbookSource).toEqual({
      ref: 'aaa111bbb222ccc333ddd444eee555fff666000',
      upstreamRef: 'origin/main',
      behindBy: 2,
      drifted: true,
    });
  });

  it('does not warn or change the prompt when the checkout is current', async () => {
    const schedule = store.create({
      name: 'Current',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    markDue(schedule.id);

    await createRunner({ inspectPlaybookCheckoutDrift: currentInspect }).tick();

    expect(launched).toHaveLength(1);
    expect(launched[0]!.prompt).toBe('Do the test thing.');
    expect(launched[0]!.prompt).not.toContain('WARNING');
    expect(launched[0]!.playbookSource).not.toHaveProperty('behindBy');
    expect(store.get(schedule.id)!.latestExecution?.playbookSource).toMatchObject({
      ref: 'fff000eee555ddd444ccc333bbb222aaa111999',
      behindBy: 0,
      drifted: false,
    });
  });

  it('does not launch when failOnPlaybookDrift is set and the checkout lags', async () => {
    const schedule = store.create({
      name: 'Fail closed',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
      failOnPlaybookDrift: true,
    });
    markDue(schedule.id);

    await createRunner().tick();

    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution).toMatchObject({
      outcome: 'skipped_playbook_drift',
      reasonCode: 'playbook_cwd_lag',
      playbookSource: {
        behindBy: 2,
        drifted: true,
      },
    });
    expect(store.get(schedule.id)!.latestExecution?.message).toContain('fail closed');
    expect(store.get(schedule.id)!.lastRunStatus).toBe('skipped');
  });

  it('still launches when failOnPlaybookDrift is set but the checkout is current', async () => {
    const schedule = store.create({
      name: 'Fail closed but current',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
      failOnPlaybookDrift: true,
    });
    markDue(schedule.id);

    await createRunner({ inspectPlaybookCheckoutDrift: currentInspect }).tick();

    expect(launched).toHaveLength(1);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('running');
  });

  it('still launches when the inspector throws', async () => {
    const schedule = store.create({
      name: 'Inspector boom',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    markDue(schedule.id);

    await createRunner({
      inspectPlaybookCheckoutDrift: async () => {
        throw new Error('git hung');
      },
    }).tick();

    expect(launched).toHaveLength(1);
    expect(store.get(schedule.id)!.latestExecution?.playbookSource).toBeUndefined();
  });

  it('persists failOnPlaybookDrift across reload', async () => {
    const schedule = store.create({
      name: 'Persist flag',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
      failOnPlaybookDrift: true,
    });
    await store.persist();
    const reloaded = new ScheduleStore(dir);
    await reloaded.load();
    expect(reloaded.get(schedule.id)!.failOnPlaybookDrift).toBe(true);

    reloaded.updateDefinition(schedule.id, { failOnPlaybookDrift: null });
    await reloaded.persist();
    const again = new ScheduleStore(dir);
    await again.load();
    expect(again.get(schedule.id)!.failOnPlaybookDrift).toBeUndefined();
  });

  it('forwards the drift warning as a promptPrefix to a looped launcher', async () => {
    const schedule = store.create({
      name: 'Looped lag',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
      loop: {},
    });
    markDue(schedule.id);

    let prefix: string | undefined;
    await createRunner({
      launcher: async () => {
        throw new Error('one-shot launcher must not be used for loop-configured schedules');
      },
      loopedLauncher: async (_s, extras) => {
        prefix = extras?.promptPrefix;
        return { task: aTask({ id: 'loop-lag-task' }), queued: false };
      },
    }).tick();

    expect(prefix).toContain('lags its upstream');
    expect(store.get(schedule.id)!.latestExecution?.playbookSource?.drifted).toBe(true);
  });

  it('skips inspection for plugin-tier playbooks', async () => {
    const inspect = vi.fn(driftedInspect);
    const schedule = store.create({
      name: 'Plugin playbook',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {}, scope: 'plugin' },
      cwd: dir,
    });
    markDue(schedule.id);

    // Plugin-tier resolution needs the file in the plugin dir, which this
    // isolated temp cwd does not have — fire will fail validation. Stub the
    // inspector anyway and assert it is never consulted.
    await createRunner({ inspectPlaybookCheckoutDrift: inspect }).tick();

    expect(inspect).not.toHaveBeenCalled();
  });

  it('survives a persist/reload so the receipt still names the playbook commit', async () => {
    const schedule = store.create({
      name: 'Persist',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    markDue(schedule.id);
    await createRunner().tick();

    const reloaded = new ScheduleStore(dir);
    await reloaded.load();
    expect(reloaded.get(schedule.id)!.executionLedger[0]?.playbookSource).toEqual({
      ref: 'aaa111bbb222ccc333ddd444eee555fff666000',
      upstreamRef: 'origin/main',
      behindBy: 2,
      drifted: true,
    });
    expect(reloaded.get(schedule.id)!.failOnPlaybookDrift).toBeUndefined();
  });
});
