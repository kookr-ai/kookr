import { describe, test, expect, beforeEach } from 'vitest';
import { TaskStore, InvalidTransitionError, isTerminalStatus, isActiveStatus, type Task } from './tasks.js';
import type { TaskStatus } from './types.js';

describe('TaskStore', () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
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
      const task = store.createTask('Fix auth bug in login flow', '/cwd');
      expect(task.name).toBeUndefined();

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

    test('survives task deletion (monotonically increasing)', () => {
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

    test('ignores negative deltas (cost decrease)', () => {
      const task = store.createTask('Task', '/cwd');
      store.updateTokenUsage(task.id, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1.00 });
      // Cost goes down (should not happen, but guard against it)
      store.updateTokenUsage(task.id, { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.50 });
      expect(store.getLifetimeSpendUsd()).toBeCloseTo(1.00);
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
});
