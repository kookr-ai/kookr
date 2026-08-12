import { describe, expect, it } from 'vitest';
import {
  getAgentStateProjected,
  getSnapshotAgentsRaw,
  getTaskAgentsProjected,
} from './get-snapshot.js';
import { TaskStore } from '../../core/tasks.js';
import { Monitor } from '../../core/monitor.js';
import { AttentionQueue } from '../../core/attention-queue.js';

/**
 * Issue #2411: the targeted single-agent / single-task lookups must return the
 * exact same projected entry as the full fleet build (`getSnapshotAgentsRaw`),
 * but WITHOUT cloning the whole task store. These tests build a realistic
 * multi-task universe with a real Monitor + TaskStore and assert equivalence
 * against the fleet baseline for every agent-id shape the projection mints.
 *
 * The one fleet-wide step the targeted path drops is cross-agent
 * finding-causality annotation (`relatedFindingIds` / `rootCauseFindingId`);
 * the fixtures here deliberately have no parent/child anomaly chains, so that
 * annotation is a no-op in both paths and deep-equality holds.
 */
describe('getAgentStateProjected / getTaskAgentsProjected (issue #2411)', () => {
  function buildUniverse() {
    const taskStore = new TaskStore();
    const monitor = new Monitor(taskStore, new AttentionQueue());

    // Task A — live, in-progress, with a live monitor session.
    const liveTask = taskStore.createTask('Live task', '/repo/live');
    taskStore.addSession(liveTask.id, {
      tmuxSession: 'agent-live',
      agentType: 'claude-code',
      cwd: '/repo/live',
      createdAt: new Date('2026-08-01T10:00:00.000Z'),
    });
    // addSession auto-transitions the task open -> inProgress.
    monitor.processEvents('agent-live', [
      { type: 'tool_use', sessionId: 'agent-live', toolName: 'Read', toolInput: { file_path: '/repo/live/x' } },
    ]);

    // Task B — pending (no session): projected as synthetic `pending-<id>`.
    const pendingTask = taskStore.createTask('Pending task', '/repo/pending');
    taskStore.pendTask(pendingTask.id);

    // Task C — completed with a session but NO live monitor state (evicted):
    // projected as a synthetic terminal entry keyed by the last session id.
    const doneTask = taskStore.createTask('Done task', '/repo/done');
    taskStore.addSession(doneTask.id, {
      tmuxSession: 'agent-done',
      agentType: 'claude-code',
      cwd: '/repo/done',
      createdAt: new Date('2026-08-01T09:00:00.000Z'),
    });
    taskStore.completeTask(doneTask.id);

    // Task D — a still-WARM session (live monitor state) whose task was just
    // completed: the projection must DROP the live entry and surface the
    // synthetic terminal entry instead (the exclusion branch the single-record
    // resolver is most likely to regress on; cf. issue #1749/#2408).
    const warmTask = taskStore.createTask('Warm-but-completed', '/repo/warm');
    taskStore.addSession(warmTask.id, {
      tmuxSession: 'agent-warm',
      agentType: 'claude-code',
      cwd: '/repo/warm',
      createdAt: new Date('2026-08-01T08:00:00.000Z'),
    });
    monitor.processEvents('agent-warm', [
      { type: 'tool_use', sessionId: 'agent-warm', toolName: 'Read', toolInput: { file_path: '/repo/warm/y' } },
    ]);
    taskStore.completeTask(warmTask.id);

    // Task E — terminal (cancelled) with NO session ever launched: projected as
    // the synthetic `done-<taskId>` fallback id.
    const noSessionTask = taskStore.createTask('Cancelled before launch', '/repo/none');
    taskStore.cancelTask(noSessionTask.id);

    // Multi-session task — two live sessions on the same task.
    const multiTask = taskStore.createTask('Multi-session', '/repo/multi');
    for (const sid of ['ms-1', 'ms-2']) {
      taskStore.addSession(multiTask.id, {
        tmuxSession: sid,
        agentType: 'claude-code',
        cwd: '/repo/multi',
        createdAt: new Date('2026-08-01T07:00:00.000Z'),
      });
      monitor.processEvents(sid, [
        { type: 'tool_use', sessionId: sid, toolName: 'Read', toolInput: { file_path: `/repo/multi/${sid}` } },
      ]);
    }

    // Orphan live state — a monitor session with no owning task record.
    monitor.processEvents('agent-orphan', [
      { type: 'tool_use', sessionId: 'agent-orphan', toolName: 'Bash', toolInput: { command: 'ls' } },
    ]);

    return { taskStore, monitor, liveTask, pendingTask, doneTask, warmTask, noSessionTask, multiTask };
  }

  function fleetFind(monitor: Monitor, agentId: string) {
    return getSnapshotAgentsRaw({ monitor }).find((a) => a.agentId === agentId);
  }

  it('matches the fleet result for a live, enriched agent', () => {
    const { monitor, taskStore, liveTask } = buildUniverse();
    const projected = getAgentStateProjected({ monitor, taskStore }, 'agent-live');
    expect(projected).toEqual(fleetFind(monitor, 'agent-live'));
    expect(projected).toMatchObject({
      agentId: 'agent-live',
      taskId: liveTask.id,
      taskName: 'Live task',
      taskStatus: 'inProgress',
      cwd: '/repo/live',
    });
  });

  it('matches the fleet result for a synthetic pending entry', () => {
    const { monitor, taskStore, pendingTask } = buildUniverse();
    const id = `pending-${pendingTask.id}`;
    const projected = getAgentStateProjected({ monitor, taskStore }, id);
    expect(projected).toEqual(fleetFind(monitor, id));
    expect(projected).toMatchObject({ agentId: id, taskId: pendingTask.id, taskStatus: 'pending' });
  });

  it('matches the fleet result for a synthetic terminal entry (no live state)', () => {
    const { monitor, taskStore, doneTask } = buildUniverse();
    const projected = getAgentStateProjected({ monitor, taskStore }, 'agent-done');
    expect(projected).toEqual(fleetFind(monitor, 'agent-done'));
    expect(projected).toMatchObject({
      agentId: 'agent-done',
      taskId: doneTask.id,
      taskStatus: 'completed',
    });
  });

  it('drops a live entry whose task is already terminal, returning the terminal entry (matches fleet)', () => {
    const { monitor, taskStore, warmTask } = buildUniverse();
    const projected = getAgentStateProjected({ monitor, taskStore }, 'agent-warm');
    expect(projected).toEqual(fleetFind(monitor, 'agent-warm'));
    // The synthetic terminal entry, NOT the stale live one: no live event window.
    expect(projected).toMatchObject({
      agentId: 'agent-warm',
      taskId: warmTask.id,
      taskStatus: 'completed',
      events: [],
    });
  });

  it('matches the fleet result for a synthetic done-<id> entry (terminal, no session)', () => {
    const { monitor, taskStore, noSessionTask } = buildUniverse();
    const id = `done-${noSessionTask.id}`;
    const projected = getAgentStateProjected({ monitor, taskStore }, id);
    expect(projected).toEqual(fleetFind(monitor, id));
    expect(projected).toMatchObject({ agentId: id, taskId: noSessionTask.id, taskStatus: 'cancelled' });
  });

  it('matches the fleet result for an orphan live state (no owning task)', () => {
    const { monitor, taskStore } = buildUniverse();
    const projected = getAgentStateProjected({ monitor, taskStore }, 'agent-orphan');
    expect(projected).toEqual(fleetFind(monitor, 'agent-orphan'));
    expect(projected?.taskId).toBeUndefined();
  });

  it('returns undefined for an unknown agent id (like the fleet .find)', () => {
    const { monitor, taskStore } = buildUniverse();
    expect(getAgentStateProjected({ monitor, taskStore }, 'nope')).toBeUndefined();
    expect(fleetFind(monitor, 'nope')).toBeUndefined();
  });

  it('does not clone the whole store: getTask/getAllTasks are not walked for a single lookup', () => {
    const { monitor, taskStore } = buildUniverse();
    let getAllTasksCalls = 0;
    const originalGetAllTasks = taskStore.getAllTasks.bind(taskStore);
    taskStore.getAllTasks = ((...args: []) => {
      getAllTasksCalls += 1;
      return originalGetAllTasks(...args);
    }) as typeof taskStore.getAllTasks;

    getAgentStateProjected({ monitor, taskStore }, 'agent-live');
    // The targeted path resolves the owning task via findTaskBySession/getTask —
    // it must never fall through to the full-store clone.
    expect(getAllTasksCalls).toBe(0);
  });

  it('falls back to the fleet scan when no taskStore is wired', () => {
    const { monitor } = buildUniverse();
    // Mirrors an AgentRouteDeps wired without a taskStore: only getSnapshot +
    // getTaskSnapshot are available, so the lookup degrades to the fleet scan.
    const bareMonitor = {
      getSnapshot: () => monitor.getSnapshot(),
      getTaskSnapshot: (opts?: Parameters<Monitor['getTaskSnapshot']>[0]) => monitor.getTaskSnapshot(opts),
    };
    const projected = getAgentStateProjected({ monitor: bareMonitor }, 'agent-live');
    expect(projected).toEqual(fleetFind(monitor, 'agent-live'));
    expect(projected).toMatchObject({ agentId: 'agent-live', taskStatus: 'inProgress' });
  });

  describe('getTaskAgentsProjected', () => {
    it('matches the fleet-filtered agents for a live task', () => {
      const { monitor, taskStore, liveTask } = buildUniverse();
      const projected = getTaskAgentsProjected({ monitor, taskStore }, liveTask.id);
      const fleet = getSnapshotAgentsRaw({ monitor }).filter((a) => a.taskId === liveTask.id);
      expect(projected).toEqual(fleet);
      expect(projected.find((a) => a.taskId === liveTask.id)).toMatchObject({ agentId: 'agent-live' });
    });

    it('matches the fleet-filtered agents for a terminal task', () => {
      const { monitor, taskStore, doneTask } = buildUniverse();
      const projected = getTaskAgentsProjected({ monitor, taskStore }, doneTask.id);
      const fleet = getSnapshotAgentsRaw({ monitor }).filter((a) => a.taskId === doneTask.id);
      expect(projected).toEqual(fleet);
    });

    it('matches the fleet-filtered agents for a multi-session task', () => {
      const { monitor, taskStore, multiTask } = buildUniverse();
      const byId = (a: { agentId: string }, b: { agentId: string }) => a.agentId.localeCompare(b.agentId);
      const projected = getTaskAgentsProjected({ monitor, taskStore }, multiTask.id).sort(byId);
      const fleet = getSnapshotAgentsRaw({ monitor }).filter((a) => a.taskId === multiTask.id).sort(byId);
      expect(projected).toHaveLength(2);
      expect(projected).toEqual(fleet);
      expect(projected.map((a) => a.agentId)).toEqual(['ms-1', 'ms-2']);
    });

    it('returns [] for an unknown task id', () => {
      const { monitor, taskStore } = buildUniverse();
      expect(getTaskAgentsProjected({ monitor, taskStore }, 'no-such-task')).toEqual([]);
    });
  });
});
