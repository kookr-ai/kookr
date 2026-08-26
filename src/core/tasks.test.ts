import { describe, test, expect, beforeEach, vi } from 'vitest';
import { TaskStore, InvalidTransitionError, isTerminalStatus, isActiveStatus, isRecoverableTermination, type Task, type TokenUsage, type TerminationReason } from './tasks.js';
import { COMPLETION_DIGEST_STORAGE_MAX_BYTES } from './completion-digest.js';
import type { AgentEvent, TaskStatus } from './types.js';

describe('TaskStore', () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  describe('runRalphMutation (issue #1461)', () => {
    test('runs mutator against the live stored task and returns its result', () => {
      const created = store.createTask('ralph owner', '/cwd');
      const result = store.runRalphMutation(created.id, (task) => {
        task.ralphLoop = {
          prompt: 'iterate',
          iterationCap: 3,
          currentIteration: 0,
          status: 'running',
          lastIterationStartedAt: 0,
          cumulativeIterations: 0,
        };
        task.updatedAt = new Date('2026-01-01T00:00:00.000Z');
        return task.ralphLoop.status;
      });
      expect(result).toBe('running');
      expect(store.getTask(created.id)!.ralphLoop?.status).toBe('running');
      expect(store.getTask(created.id)!.updatedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    });

    test('returns undefined for unknown task ids without invoking the mutator', () => {
      const mutator = vi.fn((task: Task) => task.id);
      expect(store.runRalphMutation('missing-id', mutator)).toBeUndefined();
      expect(mutator).not.toHaveBeenCalled();
    });

    test('returning the live task supports multi-step async flows', () => {
      const created = store.createTask('live ref', '/cwd');
      const live = store.runRalphMutation(created.id, (t) => t);
      expect(live).toBeDefined();
      live!.ralphLoop = {
        prompt: 'p',
        iterationCap: 1,
        currentIteration: 0,
        status: 'paused',
        lastIterationStartedAt: 0,
        cumulativeIterations: 0,
      };
      expect(store.getTask(created.id)!.ralphLoop?.status).toBe('paused');
    });
  });

  describe('Task CRUD', () => {
    test('createTask returns task with id and status open', () => {
      const task = store.createTask('Fix auth bug', '/workspace/project');

      expect(task.id).toBeDefined();
      expect(typeof task.id).toBe('string');
      expect(task.id.length).toBeGreaterThan(0);
      expect(task.status).toBe('open');
      expect(task.prompt).toBe('Fix auth bug');
      expect(task.cwd).toBe('/workspace/project');
      expect(task.createdAt).toBeInstanceOf(Date);
      expect(task.updatedAt).toBeInstanceOf(Date);
    });

    describe('launch provenance (issue #1583)', () => {
      test('schedule-fired task carries schedule provenance with the scheduleId', () => {
        const task = store.createTask({
          prompt: 'nightly sweep',
          cwd: '/cwd',
          launchSource: 'schedule',
          scheduleId: 'sched-7',
        });
        expect(task.provenance).toEqual({ kind: 'schedule', sourceId: 'sched-7' });
      });

      test('plain API creation carries manual provenance', () => {
        const task = store.createTask({ prompt: 'do work', cwd: '/cwd', launchSource: 'api' });
        expect(task.provenance).toEqual({ kind: 'manual', sourceId: 'api' });
      });

      test('API-created batch task (no schedule, no parent) carries manual provenance a rollup can attribute', () => {
        // Mirrors the six 07-26 'Parallel Issue Batch' tasks.
        const task = store.createTask({ prompt: 'Parallel Issue Batch', cwd: '/cwd', launchSource: 'api' });
        expect(task.provenance?.kind).toBe('manual');
        expect(task.provenance?.sourceId).toBe('api');
      });

      test('child spawn carries parent provenance with the parent task id', () => {
        const parent = store.createTask({ prompt: 'parent', cwd: '/cwd', launchSource: 'api' });
        const child = store.createTask({
          prompt: 'child',
          cwd: '/cwd',
          launchSource: 'api',
          parentTaskId: parent.id,
        });
        expect(child.provenance).toEqual({ kind: 'parent', sourceId: parent.id });
      });

      test('a creation with no launch signal defaults to explicit unknown provenance', () => {
        const task = store.createTask('bare', '/cwd');
        expect(task.provenance).toEqual({ kind: 'unknown' });
      });
    });

    test('getTask returns existing task', () => {
      const created = store.createTask('Fix bug', '/cwd');
      const retrieved = store.getTask(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.prompt).toBe('Fix bug');
    });

    test('getTask returns a snapshot instead of the stored mutable record', () => {
      const created = store.createTask('Fix bug', '/cwd');
      store.addSession(created.id, {
        tmuxSession: 'kookr-abc',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
      });

      const snapshot = store.getTask(created.id)!;
      snapshot.status = 'completed';
      snapshot.sessions[0]!.lastStatus = 'completed';
      snapshot.updatedAt = new Date('2001-01-01T00:00:00.000Z');

      const reread = store.getTask(created.id)!;
      expect(reread.status).toBe('inProgress');
      expect(reread.sessions[0]!.lastStatus).toBeUndefined();
      expect(reread.updatedAt.getTime()).not.toBe(snapshot.updatedAt.getTime());
    });

    test('createTask returns a snapshot instead of the stored mutable record', () => {
      const created = store.createTask('Fix bug', '/cwd');

      created.prompt = 'mutated outside store';
      created.sessions.push({
        tmuxSession: 'kookr-external',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
      });

      const reread = store.getTask(created.id)!;
      expect(reread.prompt).toBe('Fix bug');
      expect(reread.sessions).toHaveLength(0);
    });

    test('getTask returns undefined for unknown id', () => {
      const result = store.getTask('nonexistent-id');
      expect(result).toBeUndefined();
    });

    test('listTasks returns all tasks', () => {
      expect(store.listTasks()).toHaveLength(0);

      store.createTask('Task 1', '/cwd');
      store.createTask('Task 2', '/cwd');
      store.createTask('Task 3', '/cwd');

      expect(store.listTasks()).toHaveLength(3);
    });

    test('viewTasks returns every task without cloning (issue #1749 hot-path contract)', () => {
      expect(store.viewTasks()).toHaveLength(0);

      const created = store.createTask('Task 1', '/cwd');
      store.createTask('Task 2', '/cwd');

      const view = store.viewTasks();
      expect(view).toHaveLength(2);
      // The whole point of viewTasks is skipping the per-task structuredClone:
      // it must hand back the live records, identity-equal across calls.
      expect(view.find((t) => t.id === created.id)).toBe(store.viewTasks().find((t) => t.id === created.id));
      // While the cloning accessors keep returning detached snapshots.
      expect(store.listTasks().find((t) => t.id === created.id)).not.toBe(view.find((t) => t.id === created.id));
    });

    test('viewLiveTasks and countTasks isolate hot paths from terminal history', () => {
      const live = store.createTask('Live', '/cwd');
      store.startTask(live.id);
      const done = store.createTask('Done', '/cwd');
      store.startTask(done.id);
      store.completeTask(done.id);
      const cancelled = store.createTask('Cancelled', '/cwd');
      store.cancelTask(cancelled.id);
      const open = store.createTask('Open still live', '/cwd');

      expect(store.viewLiveTasks().map((t) => t.id).sort()).toEqual([live.id, open.id].sort());
      expect(store.viewLiveTasks().every((t) => !['completed', 'cancelled', 'terminated'].includes(t.status))).toBe(true);
      expect(store.countTasks()).toBe(4);
      expect(store.countTasks({ liveOnly: true })).toBe(2);
      expect(store.countTasks({ status: 'completed' })).toBe(1);
      expect(store.viewLiveTasks().some((t) => t.id === done.id || t.id === cancelled.id)).toBe(false);
    });

    test('listTasksForSnapshot filters aged terminal tasks BEFORE cloning (issue #1749 follow-up)', () => {
      const fresh = store.createTask('Fresh active', '/cwd');
      const agedDone = store.createTask('Aged done', '/cwd');
      store.startTask(agedDone.id);
      store.completeTask(agedDone.id);
      // Age the terminal task past the cutoff by back-dating its live record.
      const aged = store.getTaskForMutation(agedDone.id)!;
      const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      aged.updatedAt = old;
      if (aged.finishedAt) aged.finishedAt = old;
      const recentDone = store.createTask('Recent done', '/cwd');
      store.startTask(recentDone.id);
      store.completeTask(recentDone.id);

      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const filtered = store.listTasksForSnapshot({ excludeTerminalBeforeMs: cutoff });
      expect(filtered.map((t) => t.id).sort()).toEqual([fresh.id, recentDone.id].sort());
      // Survivors are detached clones, not live records.
      const clone = filtered.find((t) => t.id === fresh.id)!;
      expect(clone).not.toBe(store.viewTasks().find((t) => t.id === fresh.id));
      clone.prompt = 'mutated';
      expect(store.getTask(fresh.id)!.prompt).toBe('Fresh active');
      // No cutoff behaves exactly like getAllTasks.
      expect(store.listTasksForSnapshot().map((t) => t.id).sort())
        .toEqual(store.getAllTasks().map((t) => t.id).sort());
    });

    test('listTasksForSnapshot caps terminal tasks by recency', () => {
      const live = store.createTask('Live work', '/cwd');
      store.startTask(live.id);
      const terminalIds: string[] = [];
      for (let i = 0; i < 10; i++) {
        const done = store.createTask(`Done ${i}`, '/cwd');
        store.startTask(done.id);
        store.completeTask(done.id);
        const mut = store.getTaskForMutation(done.id)!;
        // Older i finishes earlier.
        const finishedAt = new Date(Date.now() - (10 - i) * 60_000);
        mut.updatedAt = finishedAt;
        mut.finishedAt = finishedAt;
        terminalIds.push(done.id);
      }

      const capped = store.listTasksForSnapshot({
        excludeTerminalBeforeMs: Date.now() - 7 * 24 * 60 * 60 * 1000,
        maxTerminalTasks: 3,
      });
      // Live always kept + 3 most recent terminals (highest i).
      expect(capped.map((t) => t.id).sort()).toEqual(
        [live.id, terminalIds[7], terminalIds[8], terminalIds[9]].sort(),
      );

      // Issue #2408: an aged terminal task owning a session is NOT exempt from
      // the age cutoff or the count cap — the clone set is bounded strictly by
      // age + count. Ghost-agent suppression for a dropped live-session owner
      // now runs off the `droppedTerminalSessions` collector this call fills,
      // not a clone-set exemption here.
      const agedWithSession = store.createTask('Aged with session', '/cwd');
      store.startTask(agedWithSession.id);
      store.addSession(agedWithSession.id, {
        tmuxSession: 'kookr-aged-session',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
      });
      store.completeTask(agedWithSession.id);
      const agedMut = store.getTaskForMutation(agedWithSession.id)!;
      const ancient = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      agedMut.updatedAt = ancient;
      agedMut.finishedAt = ancient;

      const bounded = store.listTasksForSnapshot({
        excludeTerminalBeforeMs: Date.now() - 7 * 24 * 60 * 60 * 1000,
        maxTerminalTasks: 1,
      });
      // Aged terminal task is dropped by the cutoff despite owning a session.
      expect(bounded.map((t) => t.id)).not.toContain(agedWithSession.id);
      expect(bounded.map((t) => t.id)).toContain(live.id);
      // Cap keeps only the single most-recent surviving terminal.
      const terminals = bounded.filter((t) => t.id !== live.id);
      expect(terminals).toHaveLength(1);
      expect(terminals[0]!.id).toBe(terminalIds[9]);
    });

    test('droppedTerminalSessions collects the tmuxSession of every terminal task the bound drops (issue #2408)', () => {
      const live = store.createTask('Live work', '/cwd');
      store.startTask(live.id);
      store.addSession(live.id, {
        tmuxSession: 'kookr-live-session',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
      });

      // An aged terminal task (dropped by the age cutoff).
      const aged = store.createTask('Aged done', '/cwd');
      store.startTask(aged.id);
      store.addSession(aged.id, {
        tmuxSession: 'kookr-aged-session',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
      });
      store.completeTask(aged.id);
      const agedMut = store.getTaskForMutation(aged.id)!;
      const ancient = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      agedMut.updatedAt = ancient;
      agedMut.finishedAt = ancient;

      // A recent terminal task capped out by maxTerminalTasks: 0.
      const recent = store.createTask('Recent done', '/cwd');
      store.startTask(recent.id);
      store.addSession(recent.id, {
        tmuxSession: 'kookr-recent-session',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
      });
      store.completeTask(recent.id);

      const dropped = new Set<string>();
      const kept = store.listTasksForSnapshot({
        excludeTerminalBeforeMs: Date.now() - 7 * 24 * 60 * 60 * 1000,
        maxTerminalTasks: 0,
        droppedTerminalSessions: dropped,
      });
      // Only the live task survives; both terminals are dropped.
      expect(kept.map((t) => t.id)).toEqual([live.id]);
      // Both dropped terminal sessions are reported; the live session is not.
      expect(dropped.has('kookr-aged-session')).toBe(true);
      expect(dropped.has('kookr-recent-session')).toBe(true);
      expect(dropped.has('kookr-live-session')).toBe(false);

      // A SURVIVING terminal task's session is never recorded: raise the cap so
      // the recent terminal is kept, and confirm only the still-dropped aged
      // session is reported.
      const dropped2 = new Set<string>();
      const kept2 = store.listTasksForSnapshot({
        excludeTerminalBeforeMs: Date.now() - 7 * 24 * 60 * 60 * 1000,
        maxTerminalTasks: 10,
        droppedTerminalSessions: dropped2,
      });
      expect(kept2.map((t) => t.id).sort()).toEqual([live.id, recent.id].sort());
      expect(dropped2.has('kookr-recent-session')).toBe(false);
      expect(dropped2.has('kookr-aged-session')).toBe(true);

      // Raw/debug path (no cutoff, no cap): nothing is dropped, so the
      // collector stays empty even though a terminal session exists.
      const dropped3 = new Set<string>();
      store.listTasksForSnapshot({ droppedTerminalSessions: dropped3 });
      expect(dropped3.size).toBe(0);
    });

    test('viewTaskBySession returns the live record; findTaskIdBySession returns only the id (issue #2413)', () => {
      const task = store.createTask('Owned work', '/cwd');
      store.startTask(task.id);
      store.addSession(task.id, {
        tmuxSession: 'kookr-owned-session',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
      });

      // Non-cloning: identity with the store's own live view.
      const viewed = store.viewTaskBySession('kookr-owned-session');
      expect(viewed).toBe(store.viewTasks().find((t) => t.id === task.id));
      expect(store.viewTaskBySession('kookr-unknown')).toBeUndefined();

      expect(store.findTaskIdBySession('kookr-owned-session')).toBe(task.id);
      expect(store.findTaskIdBySession('kookr-unknown')).toBeUndefined();

      // The cloning variant still detaches.
      const cloned = store.findTaskBySession('kookr-owned-session')!;
      expect(cloned).not.toBe(viewed);
      expect(cloned.id).toBe(task.id);
    });

    test('listSessionHealthRefs is live-only by default and returns plain value objects', () => {
      const live = store.createTask('Live work', '/cwd');
      store.startTask(live.id);
      store.addSession(live.id, {
        tmuxSession: 'kookr-live',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
        lastStatus: 'running',
        lastTurnState: 'running',
        transcriptPath: '/tmp/live.jsonl',
      });
      // Multi-session live task: every session is projected.
      store.addSession(live.id, {
        tmuxSession: 'kookr-live-b',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
        lastStatus: 'running',
      });

      // Live task with zero sessions contributes nothing.
      store.startTask(store.createTask('Bare live', '/cwd').id);

      const done = store.createTask('Done work', '/cwd');
      store.startTask(done.id);
      store.addSession(done.id, {
        tmuxSession: 'kookr-done',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
        lastStatus: 'completed',
        lastTurnState: 'completed_turn',
        transcriptPath: '/tmp/done.jsonl',
      });
      store.completeTask(done.id);

      const cancelled = store.createTask('Cancelled work', '/cwd');
      store.addSession(cancelled.id, {
        tmuxSession: 'kookr-cancelled',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
        lastStatus: 'running',
      });
      store.cancelTask(cancelled.id);

      const terminated = store.createTask('Terminated work', '/cwd');
      store.startTask(terminated.id);
      store.addSession(terminated.id, {
        tmuxSession: 'kookr-terminated',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
        lastStatus: 'running',
      });
      store.terminateTask(terminated.id);

      const liveRefs = store.listSessionHealthRefs();
      expect(liveRefs.map((r) => r.sessionId).sort()).toEqual([
        'kookr-live',
        'kookr-live-b',
      ]);
      expect(liveRefs.find((r) => r.sessionId === 'kookr-live')).toEqual({
        sessionId: 'kookr-live',
        taskStatus: 'inProgress',
        turnState: 'running',
        transcriptPath: '/tmp/live.jsonl',
      });

      const allRefs = store.listSessionHealthRefs({ includeTerminalTasks: true });
      expect(allRefs.map((r) => r.sessionId).sort()).toEqual([
        'kookr-cancelled',
        'kookr-done',
        'kookr-live',
        'kookr-live-b',
        'kookr-terminated',
      ]);
      expect(allRefs.find((r) => r.sessionId === 'kookr-terminated')?.taskStatus).toBe('terminated');
      expect(allRefs.find((r) => r.sessionId === 'kookr-done')?.taskStatus).toBe('completed');
      expect(allRefs.find((r) => r.sessionId === 'kookr-cancelled')?.taskStatus).toBe('cancelled');

      // Mutating a returned ref must not touch the store (plain value objects).
      const first = liveRefs.find((r) => r.sessionId === 'kookr-live')!;
      first.sessionId = 'mutated';
      expect(store.listSessionHealthRefs().map((r) => r.sessionId)).toContain('kookr-live');
    });

    test('listTasks returns snapshots instead of stored mutable records', () => {
      const created = store.createTask('Task 1', '/cwd');
      store.addSession(created.id, {
        tmuxSession: 'kookr-abc',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
        lastStatus: 'running',
      });
      store.updateTokenUsage(created.id, {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        costUsd: 0.25,
      });
      store.getTaskForMutation(created.id)!.ralphLoop = {
        prompt: 'loop',
        iterationCap: 3,
        currentIteration: 1,
        status: 'running',
        lastIterationStartedAt: 0,
        cumulativeIterations: 1,
        stallConfig: { declaredTargets: ['api'] },
        burnedOutTargets: [{
          target: 'api',
          consecutiveStallCount: 2,
          totalStallCount: 2,
          firstStalledAtIteration: 0,
          lastStallReason: 'same error',
          lastStallBlockers: ['timeout'],
          burned: true,
          lastAttemptedIteration: 1,
        }],
      };
      const [snapshot] = store.listTasks();

      snapshot!.prompt = 'mutated outside store';
      snapshot!.createdAt.setUTCFullYear(2001);
      snapshot!.sessions[0]!.lastStatus = 'completed';
      snapshot!.tokenUsage!.costUsd = 99;
      snapshot!.ralphLoop!.stallConfig!.declaredTargets!.push('mutated');
      snapshot!.ralphLoop!.burnedOutTargets![0]!.lastStallBlockers.push('mutated');

      const reread = store.getTask(created.id)!;
      expect(reread.prompt).toBe('Task 1');
      expect(reread.createdAt.getUTCFullYear()).not.toBe(2001);
      expect(reread.sessions[0]!.lastStatus).toBe('running');
      expect(reread.tokenUsage!.costUsd).toBe(0.25);
      expect(reread.ralphLoop!.stallConfig!.declaredTargets).toEqual(['api']);
      expect(reread.ralphLoop!.burnedOutTargets![0]!.lastStallBlockers).toEqual(['timeout']);
    });

    test('secondary read APIs return snapshots instead of stored mutable records', () => {
      const pending = store.createTask({
        prompt: 'Pending task',
        cwd: '/cwd',
        projectId: 'local/project',
      });
      store.pendTask(pending.id);
      const active = store.createTask({
        prompt: 'Active task',
        cwd: '/cwd',
        projectId: 'local/project',
      });
      store.addSession(active.id, {
        tmuxSession: 'kookr-active',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
        lastStatus: 'running',
      });

      store.getNextPending()!.prompt = 'mutated pending';
      store.listTasksByProject('local/project')
        .find((task) => task.id === active.id)!
        .sessions[0]!.lastStatus = 'completed';
      store.findTaskBySession('kookr-active')!.sessions[0]!.lastStatus = 'completed';
      store.getAllTasks()[0]!.prompt = 'mutated all task';
      store.getActiveSessions()[0]!.session.lastStatus = 'completed';

      expect(store.getTask(pending.id)!.prompt).toBe('Pending task');
      const activeSnapshot = store.getTask(active.id)!;
      expect(activeSnapshot.prompt).toBe('Active task');
      expect(activeSnapshot.sessions[0]!.lastStatus).toBe('running');
    });

    test('mutation APIs return snapshots instead of stored mutable records', () => {
      const task = store.createTask('Task', '/cwd');

      const started = store.startTask(task.id);
      started.prompt = 'mutated start';
      expect(store.getTask(task.id)!.prompt).toBe('Task');

      const session = {
        tmuxSession: 'kookr-abc',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
        lastStatus: 'running',
      } as const;
      const withSession = store.addSession(task.id, session);
      session.createdAt.setUTCFullYear(2001);
      withSession.sessions[0]!.lastStatus = 'completed';
      expect(store.getTask(task.id)!.sessions[0]!.createdAt.getUTCFullYear()).not.toBe(2001);
      expect(store.getTask(task.id)!.sessions[0]!.lastStatus).toBe('running');

      const updatedSession = store.updateSession(task.id, 'kookr-abc', { claudeSessionId: 'runtime-1' });
      updatedSession.sessions[0]!.claudeSessionId = 'mutated-runtime';
      expect(store.getTask(task.id)!.sessions[0]!.claudeSessionId).toBe('runtime-1');

      const renamed = store.renameTask(task.id, 'Renamed');
      renamed.name = 'mutated name';
      expect(store.getTask(task.id)!.name).toBe('Renamed');

      const tokenUsage = {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        costUsd: 0.01,
      };
      const usage = store.updateTokenUsage(task.id, tokenUsage);
      tokenUsage.costUsd = 7;
      usage.tokenUsage!.costUsd = 9;
      expect(store.getTask(task.id)!.tokenUsage!.costUsd).toBe(0.01);

      const cancelled = store.cancelTask(task.id);
      cancelled.prompt = 'mutated cancel';
      expect(store.getTask(task.id)!.prompt).toBe('Task');
    });

    test('stores criteria verdicts inside completion digest without losing digest metadata', () => {
      const task = store.createTask('Task', '/cwd');

      store.setCompletionDigest(task.id, {
        bullets: ['Changed files'],
        filesChanged: ['src/app.ts'],
      });
      store.setCriteriaVerdict(task.id, {
        items: [{ criterion: 'Run tests', verdict: 'pass', reason: 'Tests passed.' }],
        summary: { pass: 1, fail: 0, unknown: 0 },
        source: 'llm',
        evaluatedAt: '2026-06-11T12:00:00.000Z',
      });

      expect(store.getTask(task.id)?.completionDigest).toEqual({
        bullets: ['Changed files'],
        filesChanged: ['src/app.ts'],
        criteriaVerdict: expect.objectContaining({
          summary: { pass: 1, fail: 0, unknown: 0 },
        }),
      });
    });

    test('preserves an async criteria verdict when completion digest is finalized later', () => {
      const task = store.createTask('Task', '/cwd');

      store.setCriteriaVerdict(task.id, {
        items: [{ criterion: 'Open PR', verdict: 'unknown', reason: 'No event window.' }],
        summary: { pass: 0, fail: 0, unknown: 1 },
        source: 'no-event-window',
        evaluatedAt: '2026-06-11T12:00:00.000Z',
      });
      store.setCompletionDigest(task.id, {
        bullets: ['Created PR'],
        filesChanged: [],
        prUrls: ['https://github.com/kookr-ai/kookr/pull/1'],
      });

      expect(store.getTask(task.id)?.completionDigest).toEqual({
        bullets: ['Created PR'],
        filesChanged: [],
        prUrls: ['https://github.com/kookr-ai/kookr/pull/1'],
        criteriaVerdict: expect.objectContaining({
          source: 'no-event-window',
          summary: { pass: 0, fail: 0, unknown: 1 },
        }),
      });
    });

    test('setCompletionDigest hard-caps oversize bullets+filesChanged UTF-8 (issue #1780)', () => {
      const task = store.createTask('Task', '/cwd');
      const filesChanged = Array.from({ length: 5000 }, (_, i) => `src/deep/path/to/file-${i}.ts`);
      const bullets = ['Changed thousands of files in the upstream sync'];

      store.setCompletionDigest(task.id, {
        bullets,
        filesChanged,
        branch: 'codex/daily-sync',
        commits: Array.from({ length: 100 }, (_, i) => `abc${i}`),
        prUrls: ['https://github.com/kookr-ai/kookr/pull/1'],
      });

      const stored = store.getTask(task.id)!.completionDigest!;
      const payloadBytes =
        Buffer.byteLength(stored.bullets.join(''), 'utf-8')
        + Buffer.byteLength(stored.filesChanged.join(''), 'utf-8');
      expect(payloadBytes).toBeLessThanOrEqual(COMPLETION_DIGEST_STORAGE_MAX_BYTES);
      expect(stored.filesChanged.length).toBeLessThan(filesChanged.length);
      expect(stored.filesChanged.at(-1)).toMatch(/^…\+\d+ more$/);
      // Non-capped fields pass through unchanged.
      expect(stored.branch).toBe('codex/daily-sync');
      expect(stored.commits).toHaveLength(100);
      expect(stored.prUrls).toEqual(['https://github.com/kookr-ai/kookr/pull/1']);
      expect(stored.bullets[0]).toContain('Changed thousands');
    });

    test('loadTasks soft-trims oversized digests persisted before the write-time cap (issue #1780)', () => {
      const task = store.createTask('Legacy', '/cwd');
      // Bypass setCompletionDigest to simulate a pre-cap tasks.json row.
      const live = store.getTaskForMutation(task.id)!;
      live.completionDigest = {
        bullets: ['old huge digest'],
        filesChanged: Array.from({ length: 4000 }, (_, i) => `legacy/file-${i}.ts`),
      };

      store.loadTasks([store.getTask(task.id)!]);

      const loaded = store.getTask(task.id)!.completionDigest!;
      const payloadBytes =
        Buffer.byteLength(loaded.bullets.join(''), 'utf-8')
        + Buffer.byteLength(loaded.filesChanged.join(''), 'utf-8');
      expect(payloadBytes).toBeLessThanOrEqual(COMPLETION_DIGEST_STORAGE_MAX_BYTES);
      expect(loaded.filesChanged.at(-1)).toMatch(/^…\+\d+ more$/);
    });

    test('listTasks filters by status', () => {
      const t1 = store.createTask('Task 1', '/cwd');
      store.createTask('Task 2', '/cwd');
      store.startTask(t1.id);

      const openTasks = store.listTasks({ status: 'open' });
      expect(openTasks).toHaveLength(1);
      expect(openTasks[0].prompt).toBe('Task 2');

      const inProgressTasks = store.listTasks({ status: 'inProgress' });
      expect(inProgressTasks).toHaveLength(1);
      expect(inProgressTasks[0].prompt).toBe('Task 1');
    });

    test('createTask stores playbookParameterValues when provided', () => {
      const task = store.createTask({
        prompt: 'Analyze repo',
        cwd: '/workspace/project',
        playbookParameterValues: { repoFullName: 'owner/repo', batchSize: '5' },
      });

      expect(task.playbookParameterValues).toEqual({ repoFullName: 'owner/repo', batchSize: '5' });
    });

    test('createTask clones object-bearing inputs on ingress', () => {
      const playbookParameterValues = { repoFullName: 'owner/repo', batchSize: '5' };
      const launchHealthSummary = {
        degradedDependencies: ['kb'],
        findings: [{
          dependency: 'kb',
          status: 'failed' as const,
          category: 'unavailable',
          summary: 'KB unavailable',
          recommendedAction: 'Continue without KB.',
        }],
      };
      const task = store.createTask({
        prompt: 'Analyze repo',
        cwd: '/workspace/project',
        playbookParameterValues,
        launchHealthSummary,
      });

      playbookParameterValues.batchSize = '100';
      launchHealthSummary.degradedDependencies.push('git');
      launchHealthSummary.findings[0]!.summary = 'mutated';

      const reread = store.getTask(task.id)!;
      expect(reread.playbookParameterValues).toEqual({ repoFullName: 'owner/repo', batchSize: '5' });
      expect(reread.launchHealthSummary).toEqual({
        degradedDependencies: ['kb'],
        findings: [{
          dependency: 'kb',
          status: 'failed',
          category: 'unavailable',
          summary: 'KB unavailable',
          recommendedAction: 'Continue without KB.',
        }],
      });
    });

    test('createTask omits playbookParameterValues when not provided', () => {
      const task = store.createTask({ prompt: 'Fix bug', cwd: '/cwd' });

      expect(task.playbookParameterValues).toBeUndefined();
    });

    test('terminal transitions clear parked launch admission and health', () => {
      const parked = {
        status: 'parked' as const,
        reason: 'dependency_degraded' as const,
        dependencies: [{ dependency: 'kb', state: 'degraded' as const }],
        parkedAt: '2026-08-25T10:00:00.000Z',
      };
      const launchHealthSummary = {
        degradedDependencies: ['kb'],
        findings: [{
          dependency: 'kb',
          status: 'failed' as const,
          category: 'provider_api',
          summary: 'provider unavailable',
          recommendedAction: 'retry',
        }],
      };
      const cancelled = store.createTask({
        prompt: 'cancel me',
        cwd: '/cwd',
        launchAdmission: parked,
        launchHealthSummary,
      });
      store.cancelTask(cancelled.id);
      expect(store.getTask(cancelled.id)).toMatchObject({
        status: 'cancelled',
        launchAdmission: undefined,
        launchHealthSummary: undefined,
      });

      const terminated = store.createTask({
        prompt: 'terminate me',
        cwd: '/cwd',
        launchAdmission: parked,
        launchHealthSummary,
      });
      store.terminateTask(terminated.id);
      expect(store.getTask(terminated.id)).toMatchObject({
        status: 'terminated',
        launchAdmission: undefined,
        launchHealthSummary: undefined,
      });

      const probing = store.createTask({
        prompt: 'cancel in-flight probe',
        cwd: '/cwd',
        launchAdmission: {
          status: 'probing',
          reason: 'half_open_probe_in_flight',
          dependencies: [{ dependency: 'kb', state: 'half_open' }],
          startedAt: '2026-08-25T10:01:00.000Z',
        },
        launchHealthSummary,
      });
      store.cancelTask(probing.id);
      expect(store.getTask(probing.id)).toMatchObject({
        status: 'cancelled',
        launchAdmission: undefined,
        launchHealthSummary: undefined,
      });
    });

    test('pending capacity count excludes dependency parking but includes a half-open capacity wait', () => {
      const degraded = store.createTask({
        prompt: 'dependency parked',
        cwd: '/cwd',
        launchAdmission: {
          status: 'parked',
          reason: 'dependency_degraded',
          dependencies: [{ dependency: 'kb', state: 'degraded' }],
          parkedAt: new Date().toISOString(),
        },
      });
      store.pendTask(degraded.id);
      expect(store.getPendingCount()).toBe(0);

      const capacityWait = store.createTask({
        prompt: 'capacity wait',
        cwd: '/cwd',
        launchAdmission: {
          status: 'parked',
          reason: 'half_open_waiting_for_capacity',
          dependencies: [{ dependency: 'kb', state: 'half_open' }],
          parkedAt: new Date().toISOString(),
        },
      });
      store.pendTask(capacityWait.id);
      expect(store.getPendingCount()).toBe(1);
    });
  });

  // Issue #1554: every task is named from birth so no code path can reach a
  // terminal state with name=null.
  describe('creation-time naming', () => {
    test('createTask without a name applies a non-empty deterministic name and marks it autoNamed', () => {
      const task = store.createTask('Fix the auth bug in login flow', '/workspace/project');

      expect(task.name).toBe('Fix the auth bug in login flow');
      expect(task.name!.length).toBeGreaterThan(0);
      expect(task.autoNamed).toBe(true);
      // Persisted on the stored record, not just the returned snapshot.
      expect(store.getTask(task.id)!.name).toBe('Fix the auth bug in login flow');
      expect(store.getTask(task.id)!.autoNamed).toBe(true);
    });

    test('createTask with an explicit name keeps it and does not mark autoNamed', () => {
      const task = store.createTask({ prompt: 'Do the thing', cwd: '/cwd', name: 'My Playbook' });

      expect(task.name).toBe('My Playbook');
      expect(task.autoNamed).toBeUndefined();
    });

    test('createTask with a whitespace-only name falls back to the deterministic name', () => {
      const task = store.createTask({ prompt: 'Refactor database layer', cwd: '/cwd', name: '   ' });

      expect(task.name).toBe('Refactor database layer');
      expect(task.autoNamed).toBe(true);
    });

    test('names off the display prompt (userPrompt), not the raw launch prompt', () => {
      // createTask must route the placeholder through displayPromptForTask so
      // the injected launch-context preamble is stripped — the name is the
      // user's intent, not the worktree guardrail boilerplate.
      const task = store.createTask({
        prompt: 'You are currently in the main checkout `/repo` on branch `main`.\n- Create one: `git worktree add ...`\n\nFix the login bug',
        userPrompt: 'Fix the login bug',
        cwd: '/repo',
      });

      expect(task.name).toBe('Fix the login bug');
      expect(task.autoNamed).toBe(true);
    });

    test('a blank prompt still yields a non-empty name from the cwd basename', () => {
      const task = store.createTask('   ', '/workspace/project');

      expect(task.name).toBe('Task in project');
      expect(task.autoNamed).toBe(true);
    });

    test('renameTask clears the autoNamed marker (name becomes authoritative)', () => {
      const task = store.createTask('Fix bug', '/cwd');
      expect(task.autoNamed).toBe(true);

      const renamed = store.renameTask(task.id, 'Fix JWT Token Invalidation');
      expect(renamed.name).toBe('Fix JWT Token Invalidation');
      expect(renamed.autoNamed).toBeUndefined();
      expect(store.getTask(task.id)!.autoNamed).toBeUndefined();
    });
  });

  describe('autoCloseOnSignal policy', () => {
    test('stores the flag when explicitly true', () => {
      const task = store.createTask({ prompt: 'Fix bug', cwd: '/cwd', autoCloseOnSignal: true });
      expect(task.autoCloseOnSignal).toBe(true);
    });

    test('omits the flag when not provided and there is no parent', () => {
      const task = store.createTask({ prompt: 'Fix bug', cwd: '/cwd' });
      expect(task.autoCloseOnSignal).toBeUndefined();
    });

    test('child inherits the parent policy when unset', () => {
      const parent = store.createTask({ prompt: 'Batch', cwd: '/cwd', autoCloseOnSignal: true });
      const child = store.createTask({ prompt: 'Next unit', cwd: '/cwd', parentTaskId: parent.id });
      expect(child.autoCloseOnSignal).toBe(true);
    });

    test('grandchild inherits transitively through the chain', () => {
      const parent = store.createTask({ prompt: 'Batch', cwd: '/cwd', autoCloseOnSignal: true });
      const child = store.createTask({ prompt: 'Unit 1', cwd: '/cwd', parentTaskId: parent.id });
      const grandchild = store.createTask({ prompt: 'Unit 2', cwd: '/cwd', parentTaskId: child.id });
      expect(grandchild.autoCloseOnSignal).toBe(true);
    });

    test('explicit true on the child wins under a non-policy parent', () => {
      const parent = store.createTask({ prompt: 'Batch', cwd: '/cwd' });
      const child = store.createTask({
        prompt: 'Opted-in unit',
        cwd: '/cwd',
        parentTaskId: parent.id,
        autoCloseOnSignal: true,
      });
      expect(child.autoCloseOnSignal).toBe(true);
    });

    test('explicit false on the child overrides an inherited true', () => {
      const parent = store.createTask({ prompt: 'Batch', cwd: '/cwd', autoCloseOnSignal: true });
      const child = store.createTask({
        prompt: 'Opted-out unit',
        cwd: '/cwd',
        parentTaskId: parent.id,
        autoCloseOnSignal: false,
      });
      expect(child.autoCloseOnSignal).toBeUndefined();
    });

    test('opted-out child does not re-enable its own children', () => {
      const parent = store.createTask({ prompt: 'Batch', cwd: '/cwd', autoCloseOnSignal: true });
      const optedOut = store.createTask({
        prompt: 'Opted-out',
        cwd: '/cwd',
        parentTaskId: parent.id,
        autoCloseOnSignal: false,
      });
      const grandchild = store.createTask({ prompt: 'Unit', cwd: '/cwd', parentTaskId: optedOut.id });
      expect(grandchild.autoCloseOnSignal).toBeUndefined();
    });

    test('child of a non-policy parent stays off', () => {
      const parent = store.createTask({ prompt: 'Batch', cwd: '/cwd' });
      const child = store.createTask({ prompt: 'Unit', cwd: '/cwd', parentTaskId: parent.id });
      expect(child.autoCloseOnSignal).toBeUndefined();
    });
  });

  describe('Task lifecycle state machine', () => {
    test('open -> inProgress via startTask', () => {
      const task = store.createTask('Task', '/cwd');
      const updated = store.startTask(task.id);

      expect(updated.status).toBe('inProgress');
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(task.updatedAt.getTime());
    });

    test('inProgress -> completed via completeTask', () => {
      const task = store.createTask('Task', '/cwd');
      store.startTask(task.id);
      const completed = store.completeTask(task.id);

      expect(completed.status).toBe('completed');
    });

    test('inProgress -> cancelled via cancelTask', () => {
      const task = store.createTask('Task', '/cwd');
      store.startTask(task.id);
      const cancelled = store.cancelTask(task.id);

      expect(cancelled.status).toBe('cancelled');
    });

    test('open -> cancelled via cancelTask', () => {
      const task = store.createTask('Task', '/cwd');
      const cancelled = store.cancelTask(task.id);

      expect(cancelled.status).toBe('cancelled');
    });

    test('open -> completed throws InvalidTransition (cannot skip inProgress)', () => {
      const task = store.createTask('Task', '/cwd');

      expect(() => store.completeTask(task.id)).toThrow(InvalidTransitionError);
    });

    test('completed -> inProgress throws InvalidTransition (cannot go backwards)', () => {
      const task = store.createTask('Task', '/cwd');
      store.startTask(task.id);
      store.completeTask(task.id);

      expect(() => store.startTask(task.id)).toThrow(InvalidTransitionError);
    });

    test('inProgress -> open via reopenTask (agent session ended)', () => {
      const task = store.createTask('Task', '/cwd');
      store.startTask(task.id);
      const reopened = store.reopenTask(task.id);

      expect(reopened.status).toBe('open');
    });

    test('cancelled -> open via reopenTask (allows retry)', () => {
      const task = store.createTask('Task', '/cwd');
      store.startTask(task.id);
      store.cancelTask(task.id);
      const reopened = store.reopenTask(task.id);

      expect(reopened.status).toBe('open');
    });

    test('inProgress -> terminated via terminateTask (session died without ack)', () => {
      const task = store.createTask('Task', '/cwd');
      store.startTask(task.id);
      const terminated = store.terminateTask(task.id);

      expect(terminated.status).toBe('terminated');
      expect(terminated.terminatedAt).toBeInstanceOf(Date);
    });

    test('terminateTask defaults the reason to unknown (issue #1664)', () => {
      const task = store.createTask('Task', '/cwd');
      store.startTask(task.id);
      const terminated = store.terminateTask(task.id);

      expect(terminated.terminationReason).toBe('unknown');
      expect(terminated.terminationSignal).toBeUndefined();
      expect(terminated.terminationDetail).toBeUndefined();
    });

    test('terminateTask records the supplied cause (issue #1664)', () => {
      const task = store.createTask('Task', '/cwd');
      store.startTask(task.id);
      const terminated = store.terminateTask(task.id, {
        reason: 'timeout',
        signal: 'SIGKILL',
        detail: 'silent for 900s',
      });

      expect(terminated.terminationReason).toBe('timeout');
      expect(terminated.terminationSignal).toBe('SIGKILL');
      expect(terminated.terminationDetail).toBe('silent for 900s');
    });

    test('terminated -> completed via completeTask (user acknowledges finish)', () => {
      const task = store.createTask('Task', '/cwd');
      store.startTask(task.id);
      store.terminateTask(task.id);
      const acked = store.completeTask(task.id);

      expect(acked.status).toBe('completed');
    });

    test('terminated -> open via reopenTask (user reopens for retry)', () => {
      const task = store.createTask('Task', '/cwd');
      store.startTask(task.id);
      store.terminateTask(task.id);
      const reopened = store.reopenTask(task.id);

      expect(reopened.status).toBe('open');
    });

    test('terminated -> cancelled via cancelTask (user discards terminated task)', () => {
      const task = store.createTask('Task', '/cwd');
      store.startTask(task.id);
      store.terminateTask(task.id);
      const cancelled = store.cancelTask(task.id);

      expect(cancelled.status).toBe('cancelled');
    });

    test('completed -> open via reopenTask (allows re-running completed tasks)', () => {
      const task = store.createTask('Task', '/cwd');
      store.startTask(task.id);
      store.completeTask(task.id);
      const reopened = store.reopenTask(task.id);

      expect(reopened.status).toBe('open');
    });
  });

  describe('Session metadata', () => {
    test('addSession adds session to task', () => {
      const task = store.createTask('Task', '/cwd');
      const updated = store.addSession(task.id, {
        tmuxSession: 'kookr-abc',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
      });

      expect(updated.sessions).toHaveLength(1);
      expect(updated.sessions[0].tmuxSession).toBe('kookr-abc');
      expect(updated.sessions[0].agentType).toBe('claude-code');
    });

    test('updateSession updates session fields', () => {
      const task = store.createTask('Task', '/cwd');
      store.addSession(task.id, {
        tmuxSession: 'kookr-abc',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
      });

      const updated = store.updateSession(task.id, 'kookr-abc', {
        claudeSessionId: 'sess-uuid-123',
        transcriptPath: '/path/to/transcript.jsonl',
        lastStatus: 'running',
      });

      const session = updated.sessions[0];
      expect(session.claudeSessionId).toBe('sess-uuid-123');
      expect(session.transcriptPath).toBe('/path/to/transcript.jsonl');
      expect(session.lastStatus).toBe('running');
    });

    test('updateSession leaves Ralph loop ownership on the terminal session id', () => {
      // Repro shape for the iteration-stall bug: Ralph can attach before
      // SessionStart fills in runtime metadata. The loop no longer depends on
      // those late fields, so terminal-session ownership must stay stable.
      const task = store.createTask('Looped', '/cwd');
      store.addSession(task.id, {
        tmuxSession: 'kookr-loop',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
      });
      store.getTaskForMutation(task.id)!.ralphLoop = {
        prompt: 'p',
        iterationCap: 5,
        currentIteration: 0,
        status: 'running',
        lastIterationStartedAt: 0,
        cumulativeIterations: 0,
        ownerSessionId: 'kookr-loop',
      };

      store.updateSession(task.id, 'kookr-loop', {
        claudeSessionId: 'claude-sess-uuid',
        transcriptPath: '/path/to/transcript.jsonl',
      });

      expect(store.getTask(task.id)!.ralphLoop!.ownerSessionId).toBe('kookr-loop');
    });

    test('updateSession does not touch Ralph owner for unrelated sessions', () => {
      const task = store.createTask('Looped', '/cwd');
      store.addSession(task.id, {
        tmuxSession: 'kookr-owner',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
        claudeSessionId: 'sess-owner',
      });
      store.addSession(task.id, {
        tmuxSession: 'kookr-other',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
      });
      store.getTaskForMutation(task.id)!.ralphLoop = {
        prompt: 'p',
        iterationCap: 5,
        currentIteration: 0,
        status: 'running',
        lastIterationStartedAt: 0,
        cumulativeIterations: 0,
        ownerSessionId: 'kookr-owner',
      };

      store.updateSession(task.id, 'kookr-other', {
        claudeSessionId: 'sess-other',
        transcriptPath: '/wrong.jsonl',
      });

      expect(store.getTask(task.id)!.ralphLoop!.ownerSessionId).toBe('kookr-owner');
    });

    test('getActiveSessions returns sessions with lastStatus not completed', () => {
      const t1 = store.createTask('Task 1', '/cwd');
      store.addSession(t1.id, {
        tmuxSession: 'kookr-1',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
        lastStatus: 'running',
      });

      const t2 = store.createTask('Task 2', '/cwd');
      store.addSession(t2.id, {
        tmuxSession: 'kookr-2',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
        lastStatus: 'completed',
      });

      const active = store.getActiveSessions();
      expect(active).toHaveLength(1);
      expect(active[0].taskId).toBe(t1.id);
      expect(active[0].session.tmuxSession).toBe('kookr-1');
    });

    test('getActiveSessions returns session snapshots', () => {
      const task = store.createTask('Task', '/cwd');
      store.addSession(task.id, {
        tmuxSession: 'kookr-active',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
        lastStatus: 'running',
      });

      const [active] = store.getActiveSessions();
      active!.session.lastStatus = 'completed';

      expect(store.getTask(task.id)!.sessions[0]!.lastStatus).toBe('running');
    });

    test('findTaskBySession returns a task snapshot', () => {
      const task = store.createTask('Task', '/cwd');
      store.addSession(task.id, {
        tmuxSession: 'kookr-find',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
      });

      const found = store.findTaskBySession('kookr-find')!;
      found.prompt = 'mutated found task';
      found.sessions[0]!.lastStatus = 'completed';

      const reread = store.getTask(task.id)!;
      expect(reread.prompt).toBe('Task');
      expect(reread.sessions[0]!.lastStatus).toBeUndefined();
    });

    test('addSession auto-transitions task to inProgress', () => {
      const task = store.createTask('Task', '/cwd');
      expect(task.status).toBe('open');

      store.addSession(task.id, {
        tmuxSession: 'kookr-abc',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
      });

      const updated = store.getTask(task.id)!;
      expect(updated.status).toBe('inProgress');
    });
  });

  describe('createTask with optional criteria', () => {
    test('stores completion criteria', () => {
      const task = store.createTask('Fix auth', '/cwd', 'Tests pass and PR created');
      expect(task.criteria).toBe('Tests pass and PR created');
    });

    test('criteria is undefined when not provided', () => {
      const task = store.createTask('Fix auth', '/cwd');
      expect(task.criteria).toBeUndefined();
    });
  });

  describe('Project queries', () => {
    test('listTasksByProject returns task snapshots', () => {
      const task = store.createTask({ prompt: 'Task', cwd: '/cwd', projectId: 'github.com/acme/app' });
      store.addSession(task.id, {
        tmuxSession: 'kookr-project',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
        lastStatus: 'running',
      });

      const [projectTask] = store.listTasksByProject('github.com/acme/app');
      projectTask!.sessions[0]!.lastStatus = 'completed';

      expect(store.getTask(task.id)!.sessions[0]!.lastStatus).toBe('running');
    });
  });

  describe('Serialization', () => {
    test('getAllTasks returns all tasks as array', () => {
      store.createTask('Task 1', '/cwd');
      store.createTask('Task 2', '/cwd');

      const all = store.getAllTasks();
      expect(all).toHaveLength(2);
      expect(all[0].prompt).toBe('Task 1');
      expect(all[1].prompt).toBe('Task 2');
    });

    test('getAllTasks and loadTasks do not leak mutable task records', () => {
      const task = store.createTask('Task 1', '/cwd');
      store.addSession(task.id, {
        tmuxSession: 'kookr-all',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
        lastStatus: 'running',
      });
      const [snapshot] = store.getAllTasks();
      snapshot!.sessions[0]!.lastStatus = 'completed';
      expect(store.getTask(task.id)!.sessions[0]!.lastStatus).toBe('running');

      const imported: Task[] = [{
        id: 'imported-1',
        prompt: 'Imported task',
        cwd: '/imported',
        status: 'open',
        sessions: [{
          tmuxSession: 'kookr-imported',
          agentType: 'claude-code',
          cwd: '/imported',
          createdAt: new Date(),
          lastStatus: 'running',
        }],
        createdAt: new Date(),
        updatedAt: new Date(),
        agentType: 'claude-code',
      }];
      store.loadTasks(imported);
      imported[0]!.prompt = 'mutated source';
      imported[0]!.sessions[0]!.lastStatus = 'completed';

      expect(store.getTask('imported-1')!.prompt).toBe('Imported task');
      expect(store.getTask('imported-1')!.sessions[0]!.lastStatus).toBe('running');
    });

    test('loadTasks replaces all tasks from array', () => {
      store.createTask('Original', '/cwd');

      const imported: Task[] = [
        {
          id: 'imported-1',
          prompt: 'Imported task',
          cwd: '/imported',
          status: 'completed',
          sessions: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      store.loadTasks(imported);

      imported[0].prompt = 'Mutated after load';
      imported[0].sessions.push({
        tmuxSession: 'external-mutation',
        agentType: 'claude-code',
        cwd: '/imported',
        createdAt: new Date(),
      });

      expect(store.listTasks()).toHaveLength(1);
      expect(store.getTask('imported-1')!.prompt).toBe('Imported task');
      expect(store.getTask('imported-1')!.sessions).toHaveLength(0);
      expect(store.listTasks().find((t) => t.prompt === 'Original')).toBeUndefined();
    });
  });

  describe('Rename task', () => {
    test('renameTask sets the name field', () => {
      // Named from birth (issue #1554): the deterministic placeholder is the
      // prompt's first line; renameTask replaces it with an authoritative name.
      const task = store.createTask('Fix auth bug in login flow', '/cwd');
      expect(task.name).toBe('Fix auth bug in login flow');

      const renamed = store.renameTask(task.id, 'Auth fix');
      expect(renamed.name).toBe('Auth fix');
      expect(renamed.prompt).toBe('Fix auth bug in login flow'); // prompt unchanged
      expect(renamed.updatedAt.getTime()).toBeGreaterThanOrEqual(task.updatedAt.getTime());
    });

    test('renameTask with empty string clears the name', () => {
      const task = store.createTask('Fix bug', '/cwd');
      store.renameTask(task.id, 'Short name');
      expect(store.getTask(task.id)!.name).toBe('Short name');

      store.renameTask(task.id, '  ');
      expect(store.getTask(task.id)!.name).toBeUndefined();
    });

    test('renameTask trims whitespace', () => {
      const task = store.createTask('Fix bug', '/cwd');
      store.renameTask(task.id, '  Auth fix  ');
      expect(store.getTask(task.id)!.name).toBe('Auth fix');
    });

    test('renameTask with non-existing task throws', () => {
      expect(() => store.renameTask('nonexistent', 'name')).toThrow('Task not found');
    });
  });

  describe('Task priority', () => {
    test('setTaskPriority stores high priority and normal removes the field', () => {
      const task = store.createTask('Fix priority bug', '/cwd');

      const high = store.setTaskPriority(task.id, 'high');
      expect(high.priority).toBe('high');
      expect(store.getTask(task.id)!.priority).toBe('high');

      const normal = store.setTaskPriority(task.id, 'normal');
      expect(normal.priority).toBeUndefined();
      expect(store.getTask(task.id)!.priority).toBeUndefined();
      expect(normal.updatedAt.getTime()).toBeGreaterThanOrEqual(task.updatedAt.getTime());
    });

    test('setTaskPriority throws for unknown tasks', () => {
      expect(() => store.setTaskPriority('missing', 'high')).toThrow('Task not found: missing');
    });
  });

  describe('Parent-child task linking', () => {
    test('createTask with parentTaskId links child to parent', () => {
      const parent = store.createTask('Parent task', '/cwd');
      const child = store.createTask('Child task', '/cwd', undefined, parent.id);

      expect(child.parentTaskId).toBe(parent.id);
      const updatedParent = store.getTask(parent.id)!;
      expect(updatedParent.childTaskIds).toEqual([child.id]);
    });

    test('parent can have multiple children', () => {
      const parent = store.createTask('Parent', '/cwd');
      const child1 = store.createTask('Child 1', '/cwd', undefined, parent.id);
      const child2 = store.createTask('Child 2', '/cwd', 'criteria', parent.id);

      const updatedParent = store.getTask(parent.id)!;
      expect(updatedParent.childTaskIds).toEqual([child1.id, child2.id]);
      expect(child1.parentTaskId).toBe(parent.id);
      expect(child2.parentTaskId).toBe(parent.id);
    });

    test('createTask without parentTaskId has no parent link', () => {
      const task = store.createTask('Standalone', '/cwd');
      expect(task.parentTaskId).toBeUndefined();
      expect(task.childTaskIds).toBeUndefined();
    });

    test('createTask with non-existent parentTaskId throws', () => {
      expect(() =>
        store.createTask('Orphan', '/cwd', undefined, 'nonexistent-parent'),
      ).toThrow('Parent task not found: nonexistent-parent');
    });

    test('parent updatedAt is bumped when child is created', () => {
      const parent = store.createTask('Parent', '/cwd');
      const parentUpdatedBefore = parent.updatedAt.getTime();

      // Small delay to ensure timestamp difference
      store.createTask('Child', '/cwd', undefined, parent.id);
      const updatedParent = store.getTask(parent.id)!;
      expect(updatedParent.updatedAt.getTime()).toBeGreaterThanOrEqual(parentUpdatedBefore);
    });
  });

  describe('Aborted session status', () => {
    test('getActiveSessions excludes aborted sessions', () => {
      const t1 = store.createTask('Task 1', '/cwd');
      store.addSession(t1.id, {
        tmuxSession: 'kookr-1',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
        lastStatus: 'aborted',
      });

      const t2 = store.createTask('Task 2', '/cwd');
      store.addSession(t2.id, {
        tmuxSession: 'kookr-2',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
        lastStatus: 'running',
      });

      const active = store.getActiveSessions();
      expect(active).toHaveLength(1);
      expect(active[0].session.tmuxSession).toBe('kookr-2');
    });

    test('getActiveSessions excludes both completed and aborted', () => {
      const task = store.createTask('Task', '/cwd');
      store.addSession(task.id, {
        tmuxSession: 'kookr-a',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
        lastStatus: 'completed',
      });
      store.addSession(task.id, {
        tmuxSession: 'kookr-b',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
        lastStatus: 'aborted',
      });

      const active = store.getActiveSessions();
      expect(active).toHaveLength(0);
    });

    test('updateSession can set lastStatus to aborted', () => {
      const task = store.createTask('Task', '/cwd');
      store.addSession(task.id, {
        tmuxSession: 'kookr-1',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
      });

      const updated = store.updateSession(task.id, 'kookr-1', { lastStatus: 'aborted' });
      expect(updated.sessions[0].lastStatus).toBe('aborted');
    });
  });

  describe('Pending status and concurrency helpers', () => {
    test('open -> pending via pendTask', () => {
      const task = store.createTask('Task', '/cwd');
      const pended = store.pendTask(task.id);
      expect(pended.status).toBe('pending');
    });

    test('pending -> inProgress via startTask', () => {
      const task = store.createTask('Task', '/cwd');
      store.pendTask(task.id);
      const started = store.startTask(task.id);
      expect(started.status).toBe('inProgress');
    });

    test('addSession auto-transitions pending task to inProgress', () => {
      const task = store.createTask('Task', '/cwd');
      store.pendTask(task.id);
      expect(store.getTask(task.id)!.status).toBe('pending');

      store.addSession(task.id, {
        tmuxSession: 'kookr-abc',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
      });

      expect(store.getTask(task.id)!.status).toBe('inProgress');
    });

    test('pending -> cancelled via cancelTask', () => {
      const task = store.createTask('Task', '/cwd');
      store.pendTask(task.id);
      const cancelled = store.cancelTask(task.id);
      expect(cancelled.status).toBe('cancelled');
    });

    test('pending -> completed throws InvalidTransition', () => {
      const task = store.createTask('Task', '/cwd');
      store.pendTask(task.id);
      expect(() => store.completeTask(task.id)).toThrow(InvalidTransitionError);
    });

    test('getActiveCount returns number of inProgress tasks', () => {
      expect(store.getActiveCount()).toBe(0);

      const t1 = store.createTask('Task 1', '/cwd');
      store.startTask(t1.id);
      expect(store.getActiveCount()).toBe(1);

      const t2 = store.createTask('Task 2', '/cwd');
      store.startTask(t2.id);
      expect(store.getActiveCount()).toBe(2);

      store.completeTask(t1.id);
      expect(store.getActiveCount()).toBe(1);
    });

    test('getNextPending returns oldest pending task', () => {
      expect(store.getNextPending()).toBeUndefined();

      const t1 = store.createTask('Task 1', '/cwd');
      store.pendTask(t1.id);
      store.getTaskForMutation(t1.id)!.sessions.push({
        tmuxSession: 'kookr-pending',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
        lastStatus: 'running',
      });

      const t2 = store.createTask('Task 2', '/cwd');
      store.pendTask(t2.id);

      const next = store.getNextPending();
      expect(next).toBeDefined();
      expect(next!.id).toBe(t1.id); // FIFO: oldest first
      next!.sessions[0]!.lastStatus = 'completed';
      expect(store.getTask(t1.id)!.sessions[0]!.lastStatus).toBe('running');
    });

    test('getPendingCount returns number of pending tasks', () => {
      expect(store.getPendingCount()).toBe(0);

      const t1 = store.createTask('Task 1', '/cwd');
      store.pendTask(t1.id);
      expect(store.getPendingCount()).toBe(1);

      const t2 = store.createTask('Task 2', '/cwd');
      store.pendTask(t2.id);
      expect(store.getPendingCount()).toBe(2);

      store.cancelTask(t1.id);
      expect(store.getPendingCount()).toBe(1);
    });
  });

  describe('Delete task', () => {
    test('deleteTask removes task from store', () => {
      const task = store.createTask('Task', '/cwd');
      expect(store.getTask(task.id)).toBeDefined();

      store.deleteTask(task.id);
      expect(store.getTask(task.id)).toBeUndefined();
      expect(store.listTasks()).toHaveLength(0);
    });

    test('deleteTask unlinks from parent', () => {
      const parent = store.createTask('Parent', '/cwd');
      const child = store.createTask('Child', '/cwd', undefined, parent.id);

      store.deleteTask(child.id);
      const updatedParent = store.getTask(parent.id)!;
      expect(updatedParent.childTaskIds).toEqual([]);
    });

    test('deleteTask throws for non-existent task', () => {
      expect(() => store.deleteTask('nonexistent')).toThrow('Task not found');
    });
  });

  describe('Lifetime spending counter', () => {
    test('starts at zero', () => {
      expect(store.getLifetimeSpendUsd()).toBe(0);
    });

    test('accumulates spending via updateTokenUsage', () => {
      const task = store.createTask('Task', '/cwd');
      store.updateTokenUsage(task.id, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.50 });
      expect(store.getLifetimeSpendUsd()).toBeCloseTo(0.50);
    });

    test('accumulates deltas, not absolute values', () => {
      const task = store.createTask('Task', '/cwd');
      store.updateTokenUsage(task.id, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.50 });
      store.updateTokenUsage(task.id, { inputTokens: 2000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.80 });
      // Delta: 0.50 + 0.30 = 0.80
      expect(store.getLifetimeSpendUsd()).toBeCloseTo(0.80);
    });

    test('accumulates across multiple tasks', () => {
      const t1 = store.createTask('Task 1', '/cwd');
      const t2 = store.createTask('Task 2', '/cwd');
      store.updateTokenUsage(t1.id, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1.00 });
      store.updateTokenUsage(t2.id, { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.50 });
      expect(store.getLifetimeSpendUsd()).toBeCloseTo(1.50);
    });

    test('survives task deletion after recording spending', () => {
      const task = store.createTask('Task', '/cwd');
      store.updateTokenUsage(task.id, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 2.00 });
      store.startTask(task.id);
      store.completeTask(task.id);
      store.deleteTask(task.id);
      // Counter should still reflect the $2.00
      expect(store.getLifetimeSpendUsd()).toBeCloseTo(2.00);
    });

    test('ignores NaN cost values', () => {
      const task = store.createTask('Task', '/cwd');
      store.updateTokenUsage(task.id, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1.00 });
      store.updateTokenUsage(task.id, { inputTokens: 2000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: NaN });
      // NaN delta should be ignored, counter stays at 1.00
      expect(store.getLifetimeSpendUsd()).toBeCloseTo(1.00);
    });

    test('applies negative deltas for corrected costs', () => {
      const task = store.createTask('Task', '/cwd');
      store.updateTokenUsage(task.id, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1.00 });
      // A later transcript scan can replace fallback pricing with a lower
      // exact estimate; lifetime spend must follow the corrected task value.
      store.updateTokenUsage(task.id, { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.50 });
      expect(store.getLifetimeSpendUsd()).toBeCloseTo(0.50);
    });

    test('loadTasks with saved lifetime counter restores it', () => {
      const tasks = [
        { id: 'a', prompt: 'p', cwd: '/c', status: 'open' as const, sessions: [], tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1.00 }, createdAt: new Date(), updatedAt: new Date() },
      ];
      store.loadTasks(tasks, 5.00);
      expect(store.getLifetimeSpendUsd()).toBeCloseTo(5.00);
    });

    test('loadTasks bootstraps from task costs when no saved counter', () => {
      const tasks = [
        { id: 'a', prompt: 'p', cwd: '/c', status: 'open' as const, sessions: [], tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1.00 }, createdAt: new Date(), updatedAt: new Date() },
        { id: 'b', prompt: 'p2', cwd: '/c', status: 'open' as const, sessions: [], tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 2.50 }, createdAt: new Date(), updatedAt: new Date() },
      ];
      store.loadTasks(tasks);
      expect(store.getLifetimeSpendUsd()).toBeCloseTo(3.50);
    });
  });

  describe('setDisposition (issue #1588 — never silently prune a persisted task)', () => {
    test('records a queryable disposition without deleting or changing status', () => {
      const task = store.createTask('Task', '/cwd');
      store.setDisposition(task.id, {
        reason: 'launch_timeout',
        at: '2026-07-27T00:00:00.000Z',
        source: 'launch-service',
        detail: 'adapter hung',
      });
      const after = store.getTask(task.id)!;
      // Still present and still open — disposition is orthogonal to status.
      expect(after.status).toBe('open');
      expect(after.disposition).toEqual({
        reason: 'launch_timeout',
        at: '2026-07-27T00:00:00.000Z',
        source: 'launch-service',
        detail: 'adapter hung',
      });
    });

    test('bumps updatedAt so the aged-record prune recency window protects it', () => {
      const task = store.createTask('Task', '/cwd');
      // Force a deterministically-old updatedAt so this actually catches a
      // regression that drops the `updatedAt = new Date()` bump — createTask
      // and setDisposition otherwise run in the same tick.
      const oldMs = Date.now() - 60_000;
      store.getTaskForMutation(task.id)!.updatedAt = new Date(oldMs);
      store.setDisposition(task.id, { reason: 'launch_error', at: new Date().toISOString(), source: 'launch-service' });
      expect(store.getTask(task.id)!.updatedAt.getTime()).toBeGreaterThan(oldMs);
    });

    test('first-write-wins: a second disposition does not overwrite the root cause', () => {
      const task = store.createTask('Task', '/cwd');
      store.setDisposition(task.id, { reason: 'launch_error', at: '2026-07-27T00:00:00.000Z', source: 'launch-service' });
      store.setDisposition(task.id, { reason: 'stale_open_launch', at: '2026-07-27T01:00:00.000Z', source: 'startup-reconcile' });
      expect(store.getTask(task.id)!.disposition?.reason).toBe('launch_error');
    });

    test('no-op for an unknown task (does not throw)', () => {
      expect(() =>
        store.setDisposition('nonexistent', { reason: 'launch_error', at: new Date().toISOString(), source: 'launch-service' }),
      ).not.toThrow();
    });

    test('disposition survives a save/load round-trip', () => {
      const task = store.createTask('Task', '/cwd');
      store.setDisposition(task.id, { reason: 'launch_timeout', at: '2026-07-27T00:00:00.000Z', source: 'launch-service' });
      const dumped = store.getAllTasks();
      const restored = new TaskStore();
      restored.loadTasks(dumped);
      expect(restored.getTask(task.id)!.disposition?.reason).toBe('launch_timeout');
    });

    test('addSession refuses to attach to a terminal (disposed) task — no phantom session', () => {
      // A launch-timeout disposed + terminated the task; the abandoned launch
      // late-settling must not resurrect it with a phantom session.
      const task = store.createTask('Task', '/cwd');
      store.setDisposition(task.id, { reason: 'launch_timeout', at: new Date().toISOString(), source: 'launch-service' });
      store.terminateTask(task.id);
      expect(() =>
        store.addSession(task.id, { tmuxSession: 'kookr-late', agentType: 'claude-code', cwd: '/cwd', createdAt: new Date() }),
      ).toThrow(/terminal task/);
      expect(store.getTask(task.id)!.sessions).toHaveLength(0);
      expect(store.getTask(task.id)!.status).toBe('terminated');
    });

    test('addSession refuses a late attachment after a failed probe was re-parked', () => {
      const task = store.createTask({
        prompt: 'retry after provider recovery',
        cwd: '/cwd',
        launchAdmission: {
          status: 'parked',
          reason: 'dependency_degraded',
          dependencies: [{ dependency: 'kb', state: 'degraded' }],
          parkedAt: new Date().toISOString(),
        },
      });
      store.pendTask(task.id);

      expect(() => store.addSession(task.id, {
        tmuxSession: 'kookr-late-probe',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
      })).toThrow(/dependency-parked task/);
      expect(store.getTask(task.id)).toMatchObject({ status: 'pending', sessions: [] });
    });
  });

  describe('getAggregateTokenUsage (issue #1307)', () => {
    const usage = (costUsd: number, extra: Partial<TokenUsage> = {}): TokenUsage => ({
      inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 0, costUsd, ...extra,
    });

    test('returns undefined when neither task nor descendants have usage', () => {
      const parent = store.createTask('parent', '/cwd');
      store.createTask({ prompt: 'child', cwd: '/cwd', parentTaskId: parent.id });
      expect(store.getAggregateTokenUsage(parent.id)).toBeUndefined();
    });

    test('returns undefined for an unknown task', () => {
      expect(store.getAggregateTokenUsage('nope')).toBeUndefined();
    });

    test('rolls child token usage and cost up into the parent batch', () => {
      const parent = store.createTask('batch', '/cwd');
      const childA = store.createTask({ prompt: 'a', cwd: '/cwd', parentTaskId: parent.id });
      const childB = store.createTask({ prompt: 'b', cwd: '/cwd', parentTaskId: parent.id });
      store.updateTokenUsage(childA.id, usage(0.50, { provider: 'openai', model: 'gpt-5.3-codex' }));
      store.updateTokenUsage(childB.id, usage(0.30, { provider: 'openai', model: 'gpt-5.3-codex' }));

      const agg = store.getAggregateTokenUsage(parent.id);
      expect(agg).toMatchObject({
        inputTokens: 200, outputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 0,
        provider: 'openai', model: 'gpt-5.3-codex',
      });
      expect(agg!.costUsd).toBeCloseTo(0.80);
      // Each task's own usage is untouched — the aggregate is derived, so
      // cross-task totals (outcome ledger, lifetime spend) never double count.
      expect(store.getTask(childA.id)!.tokenUsage!.costUsd).toBeCloseTo(0.50);
      expect(store.getTask(parent.id)!.tokenUsage).toBeUndefined();
    });

    test('includes the parent own usage and recurses through grandchildren', () => {
      const parent = store.createTask('batch', '/cwd');
      const child = store.createTask({ prompt: 'c', cwd: '/cwd', parentTaskId: parent.id });
      const grandchild = store.createTask({ prompt: 'g', cwd: '/cwd', parentTaskId: child.id });
      store.updateTokenUsage(parent.id, usage(1.00, { provider: 'openai', model: 'gpt-5.3-codex' }));
      store.updateTokenUsage(child.id, usage(0.50, { provider: 'openai', model: 'gpt-5.3-codex' }));
      store.updateTokenUsage(grandchild.id, usage(0.25, { provider: 'openai', model: 'gpt-5.3-codex' }));

      const agg = store.getAggregateTokenUsage(parent.id);
      expect(agg!.inputTokens).toBe(300);
      expect(agg!.costUsd).toBeCloseTo(1.75);
    });

    test('omits provider/model when a batch mixes vendors', () => {
      const parent = store.createTask('batch', '/cwd');
      const codexChild = store.createTask({ prompt: 'codex', cwd: '/cwd', parentTaskId: parent.id });
      const claudeChild = store.createTask({ prompt: 'claude', cwd: '/cwd', parentTaskId: parent.id });
      store.updateTokenUsage(codexChild.id, usage(0.50, { provider: 'openai', model: 'gpt-5.3-codex' }));
      store.updateTokenUsage(claudeChild.id, usage(0.40, { provider: 'anthropic', model: 'claude-opus-4-7' }));

      const agg = store.getAggregateTokenUsage(parent.id);
      expect(agg!.costUsd).toBeCloseTo(0.90);
      expect(agg!.provider).toBeUndefined();
      expect(agg!.model).toBeUndefined();
    });

    test('propagates fallback pricing quality to a batch aggregate', () => {
      const parent = store.createTask('batch', '/cwd');
      const exactChild = store.createTask({ prompt: 'exact', cwd: '/cwd', parentTaskId: parent.id });
      const fallbackChild = store.createTask({ prompt: 'fallback', cwd: '/cwd', parentTaskId: parent.id });
      store.updateTokenUsage(exactChild.id, usage(0.50, { pricingQuality: 'exact' }));
      store.updateTokenUsage(fallbackChild.id, usage(0.40, { pricingQuality: 'fallback' }));

      // Child traversal is LIFO, so fallback is visited before exact; it must
      // remain sticky when the later exact contribution is processed.
      const aggregate = store.getAggregateTokenUsage(parent.id)!;
      expect(aggregate.pricingQuality).toBe('fallback');
      expect(aggregate.inputTokens).toBe(200);
      expect(aggregate.costUsd).toBeCloseTo(0.90);
    });

    test('reports exact pricing quality when every contribution is exact', () => {
      const parent = store.createTask('batch', '/cwd');
      const child = store.createTask({ prompt: 'exact', cwd: '/cwd', parentTaskId: parent.id });
      store.updateTokenUsage(child.id, usage(0.50, { pricingQuality: 'exact' }));

      expect(store.getAggregateTokenUsage(parent.id)?.pricingQuality).toBe('exact');
    });

    test('omits pricing quality when a legacy contribution has no quality', () => {
      const parent = store.createTask('batch', '/cwd');
      const exactChild = store.createTask({ prompt: 'exact', cwd: '/cwd', parentTaskId: parent.id });
      const legacyChild = store.createTask({ prompt: 'legacy', cwd: '/cwd', parentTaskId: parent.id });
      store.updateTokenUsage(exactChild.id, usage(0.50, { pricingQuality: 'exact' }));
      store.updateTokenUsage(legacyChild.id, usage(0.40));

      expect(store.getAggregateTokenUsage(parent.id)?.pricingQuality).toBeUndefined();
    });

    test('keeps a uniform provider while dropping the model when only models differ', () => {
      const parent = store.createTask('batch', '/cwd');
      const childA = store.createTask({ prompt: 'a', cwd: '/cwd', parentTaskId: parent.id });
      const childB = store.createTask({ prompt: 'b', cwd: '/cwd', parentTaskId: parent.id });
      store.updateTokenUsage(childA.id, usage(0.50, { provider: 'openai', model: 'gpt-5.3-codex' }));
      store.updateTokenUsage(childB.id, usage(0.30, { provider: 'openai', model: 'gpt-5.4' }));

      const agg = store.getAggregateTokenUsage(parent.id);
      expect(agg!.provider).toBe('openai');
      expect(agg!.model).toBeUndefined();
    });

    test('a non-finite child costUsd does not poison the aggregate cost', () => {
      const parent = store.createTask('batch', '/cwd');
      const childA = store.createTask({ prompt: 'a', cwd: '/cwd', parentTaskId: parent.id });
      const childB = store.createTask({ prompt: 'b', cwd: '/cwd', parentTaskId: parent.id });
      store.updateTokenUsage(childA.id, usage(0.50, { provider: 'openai', model: 'gpt-5.3-codex' }));
      store.updateTokenUsage(childB.id, usage(Number.NaN, { provider: 'openai', model: 'gpt-5.3-codex' }));

      const agg = store.getAggregateTokenUsage(parent.id);
      expect(agg!.costUsd).toBeCloseTo(0.50);
      expect(Number.isFinite(agg!.costUsd)).toBe(true);
    });
  });

  describe('Error cases', () => {
    test('transition with non-existing task throws', () => {
      expect(() => store.startTask('nonexistent')).toThrow('Task not found');
    });

    test('addSession with non-existing task throws', () => {
      expect(() =>
        store.addSession('nonexistent', {
          tmuxSession: 'kookr-abc',
          agentType: 'claude-code',
          cwd: '/cwd',
          createdAt: new Date(),
        }),
      ).toThrow('Task not found');
    });

    test('updateSession with non-existing task throws', () => {
      expect(() =>
        store.updateSession('nonexistent', 'kookr-abc', { lastStatus: 'running' }),
      ).toThrow('Task not found');
    });

    test('updateSession with non-existing session throws', () => {
      const task = store.createTask('Task', '/cwd');
      expect(() =>
        store.updateSession(task.id, 'nonexistent-session', { lastStatus: 'running' }),
      ).toThrow('Session not found');
    });
  });
});

describe('Task-relation graph (issue #599)', () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  test('createTask with parentTaskId records a high-confidence spawned_by relation', () => {
    const parent = store.createTask('Parent', '/cwd');
    const child = store.createTask('Child', '/cwd', undefined, parent.id);

    const relations = store.listRelations();
    expect(relations).toHaveLength(1);
    const [rel] = relations;
    expect(rel.sourceTaskId).toBe(child.id);
    expect(rel.targetTaskId).toBe(parent.id);
    expect(rel.type).toBe('spawned_by');
    expect(rel.confidence).toBe(1);
    expect(rel.source).toBe('api');
    expect(rel.lifecycle).toBe('active');
    expect(rel.evidence).toHaveLength(1);
    expect(rel.evidence[0].snippet).toContain('parentTaskId');
    expect(rel.evidence[0].observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('createTask without parentTaskId records no relations', () => {
    store.createTask('Standalone', '/cwd');
    expect(store.listRelations()).toHaveLength(0);
  });

  test('parentTaskId still mutates parentTaskId / childTaskIds (backward compat)', () => {
    const parent = store.createTask('Parent', '/cwd');
    const child = store.createTask('Child', '/cwd', undefined, parent.id);
    expect(child.parentTaskId).toBe(parent.id);
    expect(store.getTask(parent.id)!.childTaskIds).toEqual([child.id]);
  });

  test('upsertRelation deduplicates by (source, target, type)', () => {
    const a = store.createTask('A', '/cwd');
    const b = store.createTask('B', '/cwd');

    const first = store.upsertRelation({
      sourceTaskId: a.id,
      targetTaskId: b.id,
      type: 'related_to',
      confidence: 0.5,
      source: 'llm-inference',
      evidence: [{ snippet: 'first', observedAt: new Date(0).toISOString() }],
    });
    const second = store.upsertRelation({
      sourceTaskId: a.id,
      targetTaskId: b.id,
      type: 'related_to',
      confidence: 0.75,
      source: 'transcript',
      evidence: [{ snippet: 'second', observedAt: new Date(1000).toISOString() }],
    });

    const stored = store.listRelations({ sourceTaskId: a.id, targetTaskId: b.id, type: 'related_to' });
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(first.id);
    expect(stored[0].id).toBe(second.id);
    expect(stored[0].confidence).toBe(0.75);
    expect(stored[0].source).toBe('transcript');
    expect(stored[0].evidence.map((e) => e.snippet)).toEqual(['first', 'second']);
  });

  test('upsertRelation does not mutate parentTaskId even at confidence 1', () => {
    const a = store.createTask('A', '/cwd');
    const b = store.createTask('B', '/cwd');
    store.upsertRelation({
      sourceTaskId: a.id,
      targetTaskId: b.id,
      type: 'spawned_by',
      confidence: 1,
      source: 'llm-inference',
    });
    expect(store.getTask(a.id)!.parentTaskId).toBeUndefined();
    expect(store.getTask(b.id)!.childTaskIds).toBeUndefined();
  });

  test('upsertRelation supports low-confidence inferred edges without parent mutation', () => {
    const a = store.createTask('A', '/cwd');
    const b = store.createTask('B', '/cwd');
    store.upsertRelation({
      sourceTaskId: a.id,
      targetTaskId: b.id,
      type: 'same_chain',
      confidence: 0.2,
      source: 'llm-inference',
      evidence: [{ snippet: 'maybe same chain', observedAt: new Date().toISOString() }],
    });
    const stored = store.listRelations();
    expect(stored).toHaveLength(1);
    expect(stored[0].confidence).toBe(0.2);
    expect(store.getTask(a.id)!.parentTaskId).toBeUndefined();
  });

  test('upsertRelation rejects out-of-range confidence', () => {
    const a = store.createTask('A', '/cwd');
    const b = store.createTask('B', '/cwd');
    expect(() => store.upsertRelation({
      sourceTaskId: a.id, targetTaskId: b.id, type: 'related_to',
      confidence: 1.5, source: 'manual',
    })).toThrow('confidence');
    expect(() => store.upsertRelation({
      sourceTaskId: a.id, targetTaskId: b.id, type: 'related_to',
      confidence: -0.1, source: 'manual',
    })).toThrow('confidence');
    expect(() => store.upsertRelation({
      sourceTaskId: a.id, targetTaskId: b.id, type: 'related_to',
      confidence: Number.NaN, source: 'manual',
    })).toThrow('confidence');
  });

  test('listRelations supports source/target/taskId/type filters', () => {
    const a = store.createTask('A', '/cwd');
    const b = store.createTask('B', '/cwd');
    const c = store.createTask('C', '/cwd');
    store.upsertRelation({ sourceTaskId: a.id, targetTaskId: b.id, type: 'related_to', confidence: 0.5, source: 'manual' });
    store.upsertRelation({ sourceTaskId: a.id, targetTaskId: c.id, type: 'related_to', confidence: 0.5, source: 'manual' });
    store.upsertRelation({ sourceTaskId: b.id, targetTaskId: c.id, type: 'depends_on', confidence: 0.5, source: 'manual' });

    expect(store.listRelations({ sourceTaskId: a.id })).toHaveLength(2);
    expect(store.listRelations({ targetTaskId: c.id })).toHaveLength(2);
    expect(store.listRelations({ type: 'depends_on' })).toHaveLength(1);
    expect(store.listRelations({ taskId: c.id })).toHaveLength(2);
  });

  test('loadRelations replaces the relation set and dedups by key', () => {
    const a = store.createTask('A', '/cwd');
    const b = store.createTask('B', '/cwd');
    store.upsertRelation({ sourceTaskId: a.id, targetTaskId: b.id, type: 'related_to', confidence: 0.5, source: 'manual' });

    const nowIso = new Date().toISOString();
    store.loadRelations([
      {
        id: 'rel-1', sourceTaskId: a.id, targetTaskId: b.id, type: 'depends_on',
        confidence: 0.9, source: 'kookr-spawn', evidence: [],
        createdAt: nowIso, updatedAt: nowIso, lifecycle: 'active',
      },
      {
        id: 'rel-2', sourceTaskId: a.id, targetTaskId: b.id, type: 'depends_on',
        confidence: 0.4, source: 'transcript', evidence: [],
        createdAt: nowIso, updatedAt: nowIso, lifecycle: 'active',
      },
    ]);
    const stored = store.listRelations();
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe('rel-2');
    expect(stored[0].source).toBe('transcript');
  });

  test('deleteTask drops every relation that references the deleted task', () => {
    const a = store.createTask('A', '/cwd');
    const b = store.createTask('B', '/cwd');
    const c = store.createTask('C', '/cwd');
    store.upsertRelation({ sourceTaskId: a.id, targetTaskId: b.id, type: 'related_to', confidence: 0.5, source: 'manual' });
    store.upsertRelation({ sourceTaskId: c.id, targetTaskId: a.id, type: 'depends_on', confidence: 0.5, source: 'manual' });
    store.upsertRelation({ sourceTaskId: b.id, targetTaskId: c.id, type: 'blocks', confidence: 0.5, source: 'manual' });

    store.deleteTask(a.id);
    const remaining = store.listRelations();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].sourceTaskId).toBe(b.id);
    expect(remaining[0].targetTaskId).toBe(c.id);
  });

  test('listRelations returns snapshots — external mutation does not leak back', () => {
    const a = store.createTask('A', '/cwd');
    const b = store.createTask('B', '/cwd');
    store.upsertRelation({
      sourceTaskId: a.id, targetTaskId: b.id, type: 'related_to',
      confidence: 0.5, source: 'manual',
      evidence: [{ snippet: 'orig', observedAt: new Date().toISOString() }],
    });
    const snap = store.listRelations()[0];
    snap.confidence = 0.99;
    snap.evidence.push({ snippet: 'mutated', observedAt: new Date().toISOString() });
    const reread = store.listRelations()[0];
    expect(reread.confidence).toBe(0.5);
    expect(reread.evidence).toHaveLength(1);
  });
});

describe('Task-relation persistence (issue #599)', () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  test('relations round-trip through the persistence envelope', async () => {
    const { saveTasks, loadTasks } = await import('./task-persistence.js');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = await mkdtemp(join(tmpdir(), 'kookr-relations-'));
    try {
      const parent = store.createTask('Parent', '/cwd');
      const child = store.createTask('Child', '/cwd', undefined, parent.id);
      store.upsertRelation({
        sourceTaskId: child.id, targetTaskId: parent.id, type: 'same_chain',
        confidence: 0.6, source: 'transcript',
        evidence: [{ path: '/var/log/x.log', observedAt: new Date().toISOString() }],
      });

      const file = join(dir, 'tasks.json');
      await saveTasks(store.getAllTasks(), file, 0, undefined, undefined, store.listRelations());

      const loaded = await loadTasks(file);
      expect(loaded.relations ?? []).toHaveLength(2);
      const keys = (loaded.relations ?? []).map((r) => `${r.sourceTaskId}|${r.targetTaskId}|${r.type}`).sort();
      expect(keys).toContain(`${child.id}|${parent.id}|spawned_by`);
      expect(keys).toContain(`${child.id}|${parent.id}|same_chain`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('legacy task files (no relations key) deserialize with relations === undefined', async () => {
    const { loadTasks } = await import('./task-persistence.js');
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = await mkdtemp(join(tmpdir(), 'kookr-relations-'));
    try {
      const file = join(dir, 'tasks.json');
      const legacy = { version: 2, lifetimeSpendUsd: 0, tasks: [] };
      await writeFile(file, JSON.stringify(legacy), 'utf-8');
      const loaded = await loadTasks(file);
      expect(loaded.relations).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('malformed relation entries are dropped silently on load', async () => {
    const { loadTasks } = await import('./task-persistence.js');
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = await mkdtemp(join(tmpdir(), 'kookr-relations-'));
    try {
      const file = join(dir, 'tasks.json');
      const envelope = {
        version: 2,
        lifetimeSpendUsd: 0,
        tasks: [],
        relations: [
          { id: 'good', sourceTaskId: 's', targetTaskId: 't', type: 'related_to', confidence: 0.5, source: 'manual', evidence: [], createdAt: 'x', updatedAt: 'x', lifecycle: 'active' },
          { id: 'bad-type', sourceTaskId: 's', targetTaskId: 't', type: 'not_a_type', confidence: 0.5, source: 'manual', evidence: [], createdAt: 'x', updatedAt: 'x', lifecycle: 'active' },
          { id: 'bad-conf', sourceTaskId: 's', targetTaskId: 't', type: 'related_to', confidence: 5, source: 'manual', evidence: [], createdAt: 'x', updatedAt: 'x', lifecycle: 'active' },
          'not-an-object',
        ],
      };
      await writeFile(file, JSON.stringify(envelope), 'utf-8');
      const loaded = await loadTasks(file);
      expect(loaded.relations ?? []).toHaveLength(1);
      expect((loaded.relations ?? [])[0].id).toBe('good');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('status classification helpers', () => {
  // Exhaustive coverage — if TaskStatus grows, these tables force a decision.
  const terminal: TaskStatus[] = ['completed', 'terminated', 'cancelled'];
  const active: TaskStatus[] = ['open', 'pending', 'inProgress'];

  test.each(terminal)('isTerminalStatus(%s) is true', (s) => {
    expect(isTerminalStatus(s)).toBe(true);
    expect(isActiveStatus(s)).toBe(false);
  });

  test.each(active)('isActiveStatus(%s) is true', (s) => {
    expect(isActiveStatus(s)).toBe(true);
    expect(isTerminalStatus(s)).toBe(false);
  });

  // issue #1664 — recoverable-vs-terminal termination classification.
  const recoverable: TerminationReason[] = ['server-restart', 'oom', 'timeout', 'unknown'];
  const nonRecoverable: TerminationReason[] = ['manual', 'supervisor'];

  test.each(recoverable)('isRecoverableTermination(%s) is true', (r) => {
    expect(isRecoverableTermination(r)).toBe(true);
  });

  test.each(nonRecoverable)('isRecoverableTermination(%s) is false', (r) => {
    expect(isRecoverableTermination(r)).toBe(false);
  });

  test('isRecoverableTermination(undefined) is true (legacy pre-#1664 terminations)', () => {
    expect(isRecoverableTermination(undefined)).toBe(true);
  });
});

describe('TaskStore unattended + operator-needed (issue #1562)', () => {
  test('createTask stamps unattended when requested', () => {
    const store = new TaskStore();
    const task = store.createTask({ prompt: 'Autonomous work', cwd: '/repo', unattended: true });
    expect(store.getTask(task.id)!.unattended).toBe(true);
  });

  test('createTask leaves unattended undefined by default', () => {
    const store = new TaskStore();
    const task = store.createTask({ prompt: 'Interactive work', cwd: '/repo' });
    expect(store.getTask(task.id)!.unattended).toBeUndefined();
  });

  test('unattended is inherited by a child task from an unattended parent', () => {
    const store = new TaskStore();
    const parent = store.createTask({ prompt: 'Autonomous parent', cwd: '/repo', unattended: true });
    const child = store.createTask({ prompt: 'Autonomous child', cwd: '/repo', parentTaskId: parent.id });
    expect(store.getTask(child.id)!.unattended).toBe(true);
  });

  test('a child can opt out of an inherited unattended policy with explicit false', () => {
    const store = new TaskStore();
    const parent = store.createTask({ prompt: 'Autonomous parent', cwd: '/repo', unattended: true });
    const child = store.createTask({
      prompt: 'Attended child',
      cwd: '/repo',
      parentTaskId: parent.id,
      unattended: false,
    });
    expect(store.getTask(child.id)!.unattended).toBeUndefined();
  });

  test('setOperatorNeeded records the marker and is first-write-wins', () => {
    const store = new TaskStore();
    const task = store.createTask({ prompt: 'Autonomous work', cwd: '/repo', unattended: true });
    const first = {
      reason: 'interactive_tool_denied' as const,
      toolName: 'AskUserQuestion',
      detectedAt: new Date('2026-07-28T00:00:00.000Z'),
      message: 'blocked',
    };

    expect(store.setOperatorNeeded(task.id, first)).toBe(true);
    expect(store.getTask(task.id)!.operatorNeeded).toEqual(first);

    // A second denied call does not overwrite or churn the marker.
    const second = { ...first, detectedAt: new Date('2026-07-28T01:00:00.000Z') };
    expect(store.setOperatorNeeded(task.id, second)).toBe(false);
    expect(store.getTask(task.id)!.operatorNeeded).toEqual(first);
  });

  test('setOperatorNeeded returns false for an unknown task', () => {
    const store = new TaskStore();
    expect(
      store.setOperatorNeeded('missing', {
        reason: 'interactive_tool_denied',
        toolName: 'AskUserQuestion',
        detectedAt: new Date(),
        message: 'blocked',
      }),
    ).toBe(false);
  });
});

describe('TaskStore pending agent signal', () => {
  test('set/get/clear round-trips a pending signal', () => {
    const store = new TaskStore();
    const task = store.createTask('Ship it', '/repo');
    expect(store.getPendingSignal(task.id)).toBeUndefined();

    const ok = store.setPendingSignal(task.id, {
      kind: 'completion_ready',
      raisedAt: '2026-06-05T12:00:00.000Z',
      note: 'tests green',
    });
    expect(ok).toBe(true);
    expect(store.getPendingSignal(task.id)).toEqual({
      kind: 'completion_ready',
      raisedAt: '2026-06-05T12:00:00.000Z',
      note: 'tests green',
    });

    expect(store.clearPendingSignal(task.id)).toBe(true);
    expect(store.getPendingSignal(task.id)).toBeUndefined();
    // Second clear is a no-op.
    expect(store.clearPendingSignal(task.id)).toBe(false);
  });

  test('setPendingSignal is idempotent per kind: preserves raisedAt, merges a new note', () => {
    const store = new TaskStore();
    const task = store.createTask('Ship it', '/repo');
    store.setPendingSignal(task.id, { kind: 'completion_ready', raisedAt: '2026-06-05T12:00:00.000Z' });
    // A repeat completion-ready signal keeps the original raisedAt (no review-window
    // churn) but adopts a freshly supplied note.
    store.setPendingSignal(task.id, { kind: 'completion_ready', raisedAt: '2026-06-05T13:00:00.000Z', note: 'now with PR' });
    expect(store.getPendingSignal(task.id)).toEqual({
      kind: 'completion_ready',
      raisedAt: '2026-06-05T12:00:00.000Z',
      note: 'now with PR',
    });
  });

  test('setPendingSignal records signalId for pure outbox replays (issue #1541)', () => {
    const store = new TaskStore();
    const task = store.createTask('Ship it', '/repo');
    store.setPendingSignal(task.id, {
      kind: 'completion_ready',
      raisedAt: '2026-06-05T12:00:00.000Z',
      signalId: 'sig-1',
    });
    expect(store.getProcessedSignal('sig-1')).toEqual({
      taskId: task.id,
      kind: 'completion_ready',
    });
    // Same-kind re-raise without signalId keeps the original signalId on the row.
    store.setPendingSignal(task.id, {
      kind: 'completion_ready',
      raisedAt: '2026-06-05T13:00:00.000Z',
      note: 'again',
    });
    expect(store.getPendingSignal(task.id)).toMatchObject({
      raisedAt: '2026-06-05T12:00:00.000Z',
      note: 'again',
      signalId: 'sig-1',
    });
  });

  test('setPendingSignal re-raise without a note preserves the existing note', () => {
    const store = new TaskStore();
    const task = store.createTask('Ship it', '/repo');
    store.setPendingSignal(task.id, { kind: 'completion_ready', raisedAt: '2026-06-05T12:00:00.000Z', note: 'PR #1' });
    // A note-less re-raise keeps both the original raisedAt and the prior note.
    store.setPendingSignal(task.id, { kind: 'completion_ready', raisedAt: '2026-06-05T13:00:00.000Z' });
    expect(store.getPendingSignal(task.id)).toEqual({
      kind: 'completion_ready',
      raisedAt: '2026-06-05T12:00:00.000Z',
      note: 'PR #1',
    });
  });

  test('recordCompletionRemediation round-trips a fingerprint and clears on delete', () => {
    const store = new TaskStore();
    const task = store.createTask('Ship it', '/repo');
    expect(store.getCompletionRemediationFingerprint(task.id)).toBeUndefined();
    store.recordCompletionRemediation(task.id, 'fp-1');
    expect(store.getCompletionRemediationFingerprint(task.id)).toBe('fp-1');
    store.deleteTask(task.id);
    expect(store.getCompletionRemediationFingerprint(task.id)).toBeUndefined();
  });

  test('set/clear are no-ops for unknown tasks', () => {
    const store = new TaskStore();
    expect(store.setPendingSignal('missing', { kind: 'completion_ready', raisedAt: 'x' })).toBe(false);
    expect(store.clearPendingSignal('missing')).toBe(false);
    expect(store.getPendingSignal('missing')).toBeUndefined();
  });
});

describe('TaskStore.evaluateCompletionSignal', () => {
  const completedTurn: AgentEvent[] = [
    { type: 'user_prompt', sessionId: 's1', prompt: 'continue', eventSeq: 1 },
    { type: 'stop', sessionId: 's1', lastMessage: 'Implemented and pushed.', eventSeq: 2 },
  ];

  function inProgressTask(store: TaskStore, opts: Parameters<TaskStore['createTask']>[0] = { prompt: 'Ship it', cwd: '/repo' }) {
    const task = store.createTask(opts);
    store.addSession(task.id, { tmuxSession: 'kookr-x', agentType: 'claude-code', cwd: '/repo', createdAt: new Date() });
    return task;
  }

  test('remediates once, then suppresses the identical follow-up (once per state)', () => {
    const store = new TaskStore();
    const task = inProgressTask(store);

    const first = store.evaluateCompletionSignal(task.id, completedTurn);
    expect(first.action).toBe('remediate');
    expect(store.getCompletionRemediationFingerprint(task.id)).toBe(first.stateFingerprint);

    const repeat = store.evaluateCompletionSignal(task.id, completedTurn);
    expect(repeat.action).toBe('skip');
    expect(repeat.reason).toBe('remediation_already_delivered');
  });

  test('auto-signals a pre-authorized task and is idempotent once signaled', () => {
    const store = new TaskStore();
    const task = inProgressTask(store, { prompt: 'Ship it', cwd: '/repo', deliveryAuthorization: 'pre-authorized' });

    expect(store.evaluateCompletionSignal(task.id, completedTurn).action).toBe('auto_signal');

    store.setPendingSignal(task.id, { kind: 'completion_ready', raisedAt: '2026-07-11T00:00:00.000Z' });
    const afterSignal = store.evaluateCompletionSignal(task.id, completedTurn);
    expect(afterSignal.action).toBe('skip');
    expect(afterSignal.reason).toBe('already_signaled');
  });

  test('never auto-signals a delivery-gated (ask-first) task with unsatisfied delivery', () => {
    const store = new TaskStore();
    const task = inProgressTask(store, { prompt: 'Ship it', cwd: '/repo', deliveryAuthorization: 'ask-first' });

    const decision = store.evaluateCompletionSignal(task.id, completedTurn);
    expect(decision.action).toBe('skip');
    expect(decision.reason).toBe('delivery_blocked');

    // Once delivery is satisfied it becomes eligible to auto-signal.
    expect(store.evaluateCompletionSignal(task.id, completedTurn, { deliverySatisfied: true }).action).toBe('auto_signal');
  });

  test('skips an unknown task without throwing', () => {
    const store = new TaskStore();
    expect(store.evaluateCompletionSignal('missing', completedTurn)).toMatchObject({
      action: 'skip',
      reason: 'unknown_task',
    });
  });
});

// ---------------------------------------------------------------------------
// Launch reservations (#700 fix — issue-700-multi-session-attach-audit)
// ---------------------------------------------------------------------------

describe('launch reservations (#700)', () => {
  test('beginLaunch is a CAS: second reserve on the same task fails', () => {
    const store = new TaskStore();
    const task = store.createTask('t', '/repo');
    store.pendTask(task.id);
    expect(store.beginLaunch(task.id)).toBe(true);
    expect(store.beginLaunch(task.id)).toBe(false);
  });

  test('endLaunch frees the reservation', () => {
    const store = new TaskStore();
    const task = store.createTask('t', '/repo');
    store.pendTask(task.id);
    expect(store.beginLaunch(task.id)).toBe(true);
    store.endLaunch(task.id);
    expect(store.beginLaunch(task.id)).toBe(true);
  });

  test('refuses to reserve inProgress, terminal, or missing tasks', () => {
    const store = new TaskStore();
    const running = store.createTask('r', '/repo');
    store.startTask(running.id);
    expect(store.beginLaunch(running.id)).toBe(false);
    const done = store.createTask('d', '/repo');
    store.startTask(done.id);
    store.completeTask(done.id);
    expect(store.beginLaunch(done.id)).toBe(false);
    expect(store.beginLaunch('nope')).toBe(false);
  });

  test('a stale reservation expires and can be taken over (self-healing)', () => {
    vi.useFakeTimers();
    try {
      const store = new TaskStore();
      const task = store.createTask('t', '/repo');
      store.pendTask(task.id);
      expect(store.beginLaunch(task.id)).toBe(true);
      vi.advanceTimersByTime(10 * 60 * 1000 + 1); // past LAUNCH_RESERVATION_TTL_MS
      expect(store.beginLaunch(task.id)).toBe(true); // wedged launch lost its hold
    } finally {
      vi.useRealTimers();
    }
  });

  test('a stale token cannot release a replacement reservation', () => {
    vi.useFakeTimers();
    try {
      const store = new TaskStore();
      const task = store.createTask('t', '/repo');
      store.pendTask(task.id);
      const stale = store.beginLaunchWithToken(task.id)!;
      vi.advanceTimersByTime(10 * 60 * 1000 + 1);
      const replacement = store.beginLaunchWithToken(task.id)!;

      expect(store.ownsLaunchReservation(task.id, stale)).toBe(false);
      expect(store.ownsLaunchReservation(task.id, replacement)).toBe(true);
      store.endLaunch(task.id, stale);
      expect(store.ownsLaunchReservation(task.id, replacement)).toBe(true);
      expect(store.hasForeignFreshLaunchReservation(task.id, stale)).toBe(true);
      expect(store.hasForeignFreshLaunchReservation(task.id, replacement)).toBe(false);
      store.endLaunch(task.id, replacement);
      expect(store.hasFreshLaunchReservation(task.id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('getNextPending skips reserved tasks; getActiveCount counts them', () => {
    const store = new TaskStore();
    const first = store.createTask('first', '/repo');
    const second = store.createTask('second', '/repo');
    store.pendTask(first.id);
    store.pendTask(second.id);

    expect(store.getActiveCount()).toBe(0);
    expect(store.getNextPending()?.id).toBe(first.id);

    expect(store.beginLaunch(first.id)).toBe(true);
    expect(store.getNextPending()?.id).toBe(second.id); // skips the reserved one
    expect(store.getActiveCount()).toBe(1); // the in-flight launch holds a slot

    store.endLaunch(first.id);
    expect(store.getNextPending()?.id).toBe(first.id);
    expect(store.getActiveCount()).toBe(0);
  });

  test('persistence reservations exclude promotion without consuming capacity', () => {
    const store = new TaskStore();
    const first = store.createTask('first', '/repo');
    const second = store.createTask('second', '/repo');
    store.pendTask(first.id);
    store.pendTask(second.id);

    const token = store.beginLaunchPersistenceWithToken(first.id);
    expect(token).toBeDefined();
    expect(store.getNextPending()?.id).toBe(second.id);
    expect(store.getActiveCount()).toBe(0);
    expect(store.hasFreshLaunchReservation(first.id)).toBe(true);
    expect(store.hasFreshActiveLaunchReservation(first.id)).toBe(false);

    store.endLaunch(first.id, token);
    expect(store.getNextPending()?.id).toBe(first.id);
  });

  test('terminal transition retains only an unproven probe cleanup fence', () => {
    const store = new TaskStore();
    const probing = {
      status: 'probing' as const,
      reason: 'half_open_probe_in_flight' as const,
      dependencies: [{ dependency: 'kb', state: 'half_open' as const }],
      startedAt: new Date().toISOString(),
      sessionId: 'kookr-probe-cleanup',
    };
    const task = store.createTask({ prompt: 'probe', cwd: '/repo', launchAdmission: probing });
    store.addSession(task.id, {
      tmuxSession: 'kookr-probe-cleanup',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date(),
    });

    store.cancelTask(task.id);
    expect(store.getTask(task.id)?.launchAdmission).toEqual(probing);

    store.updateSession(task.id, 'kookr-probe-cleanup', { lastStatus: 'aborted' });
    store.setLaunchAdmission(task.id, undefined);
    expect(store.getTask(task.id)?.launchAdmission).toBeUndefined();
  });

  test('addSession consumes the reservation (no double slot for launched tasks)', () => {
    const store = new TaskStore();
    const task = store.createTask('t', '/repo');
    store.pendTask(task.id);
    store.beginLaunch(task.id);
    store.addSession(task.id, {
      tmuxSession: 'kookr-x',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date(),
    });
    expect(store.getTask(task.id)!.status).toBe('inProgress');
    expect(store.getActiveCount()).toBe(1); // counted once, as inProgress
    // Pin the consumption itself: once inProgress, a lingering reservation is
    // invisible to getActiveCount/getNextPending, so assert the private map
    // directly (mutation guard for the addSession delete).
    const reservations = (store as unknown as { launchReservations: Map<string, unknown> }).launchReservations;
    expect(reservations.has(task.id)).toBe(false);
  });

  test('addSession loudly logs a duplicate not-known-dead session (detection funnel)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const store = new TaskStore();
      const task = store.createTask('t', '/repo');
      const mkSession = (name: string) => ({
        tmuxSession: name,
        agentType: 'claude-code' as const,
        cwd: '/repo',
        createdAt: new Date(),
      });
      store.addSession(task.id, mkSession('kookr-a'));
      expect(errorSpy).not.toHaveBeenCalled(); // first attach is clean

      store.addSession(task.id, mkSession('kookr-b'));
      expect(errorSpy).toHaveBeenCalledTimes(1); // second live attach is loud
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('duplicate-session attach');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('addSession on a Ralph task stays quiet (iteration relaunch is by design)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const store = new TaskStore();
      const task = store.createTask('ralph', '/repo');
      // Mark the task as a Ralph loop the way runtime state does.
      const raw = (store as unknown as { tasks: Map<string, { ralphLoop?: object }> }).tasks.get(task.id)!;
      raw.ralphLoop = { status: 'running' };
      const mk = (name: string) => ({
        tmuxSession: name, agentType: 'claude-code' as const, cwd: '/repo', createdAt: new Date(),
      });
      store.addSession(task.id, mk('kookr-iter-1'));
      store.addSession(task.id, mk('kookr-iter-2')); // iteration relaunch
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('addSession ignores crash-recovered siblings in the duplicate check', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const store = new TaskStore();
      const task = store.createTask('t', '/repo');
      store.addSession(task.id, {
        tmuxSession: 'kookr-recovered-prior',
        agentType: 'claude-code',
        cwd: '/repo',
        createdAt: new Date(),
        crashRecovered: true,
      });
      errorSpy.mockClear();
      store.addSession(task.id, {
        tmuxSession: 'kookr-next',
        agentType: 'claude-code',
        cwd: '/repo',
        createdAt: new Date(),
      });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('addSession over dead sessions stays quiet (crash-recovery re-attach)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const store = new TaskStore();
      const task = store.createTask('t', '/repo');
      store.addSession(task.id, {
        tmuxSession: 'kookr-dead',
        agentType: 'claude-code',
        cwd: '/repo',
        createdAt: new Date(),
      });
      store.updateSession(task.id, 'kookr-dead', { lastStatus: 'completed' });
      errorSpy.mockClear();

      store.addSession(task.id, {
        tmuxSession: 'kookr-recovered',
        agentType: 'claude-code',
        cwd: '/repo',
        createdAt: new Date(),
      });
      expect(errorSpy).not.toHaveBeenCalled(); // dead siblings are legitimate to attach over
    } finally {
      errorSpy.mockRestore();
    }
  });
});
