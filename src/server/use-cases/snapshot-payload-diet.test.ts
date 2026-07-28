import { describe, expect, it } from 'vitest';
import { TaskStore, type Task } from '../../core/tasks.js';
import {
  createSnapshotMessage,
  getSnapshotAgentsForClient,
  getSnapshotAgentsRaw,
} from './get-snapshot.js';
import {
  buildSnapshotProjection,
  isAgedTerminalTask,
  SNAPSHOT_TERMINAL_TASK_MAX_AGE_MS,
  taskSnapshotRecencyMs,
} from './snapshot-projection.js';
import { buildRelationProjection } from './build-relation-projection.js';
import {
  TERMINAL_DESCRIPTION_MAX_BYTES,
  projectTerminalAgentFieldsForClient,
  projectTerminalCompletionDigestForClient,
} from '../event-projection.js';
import type { CompletionDigest } from '../../core/completion-digest.js';

const NOW = new Date('2026-07-25T12:00:00Z');
const RECENT = new Date('2026-07-24T12:00:00Z'); // 1 day old
const AGED = new Date('2026-07-10T12:00:00Z'); // 15 days old

function fullDigest(): CompletionDigest {
  return {
    bullets: ['did the thing'],
    filesChanged: ['src/a.ts', 'src/b.ts'],
    testSummary: 'all green',
    branch: 'feature/x',
    commits: ['abc123', 'def456'],
    prUrls: ['https://github.com/acme/repo/pull/1'],
    verificationCommands: ['npx vitest run', 'npx tsc --noEmit'],
    criteriaVerdict: {
      verdict: 'met',
      summary: 'criteria satisfied',
    } as CompletionDigest['criteriaVerdict'],
  };
}

/**
 * Seed a store with one completed task, controlling its age. Returns the
 * mutable internal record so tests can adjust timestamps/fields directly.
 */
function seedCompletedTask(
  store: TaskStore,
  opts: { name: string; session: string; finishedAt: Date; description?: string; digest?: CompletionDigest },
): Task {
  const created = store.createTask(opts.description ?? `prompt for ${opts.name}`, '/repo');
  store.addSession(created.id, {
    tmuxSession: opts.session,
    agentType: 'claude-code',
    cwd: '/repo',
    createdAt: new Date(opts.finishedAt.getTime() - 60_000),
  });
  store.completeTask(created.id);
  const task = store.getTaskForMutation(created.id);
  if (!task) throw new Error('missing task');
  task.updatedAt = opts.finishedAt;
  task.finishedAt = opts.finishedAt;
  if (opts.digest) task.completionDigest = opts.digest;
  return task;
}

function monitorFor(store: TaskStore) {
  return {
    getSnapshot: () => [],
    getTaskSnapshot: () => store.getAllTasks(),
  };
}

describe('aged terminal task snapshot exclusion (issue #1526 Phase C / C2)', () => {
  it('taskSnapshotRecencyMs picks the latest of updatedAt/finishedAt/terminatedAt', () => {
    expect(
      taskSnapshotRecencyMs({
        updatedAt: new Date(1_000),
        finishedAt: new Date(5_000),
        terminatedAt: new Date(3_000),
      } as Task),
    ).toBe(5_000);
  });

  it('isAgedTerminalTask is false for active tasks regardless of age', () => {
    expect(
      isAgedTerminalTask(
        { status: 'inProgress', updatedAt: AGED, finishedAt: undefined, terminatedAt: undefined } as Task,
        NOW.getTime() - SNAPSHOT_TERMINAL_TASK_MAX_AGE_MS,
      ),
    ).toBe(false);
  });

  it('buildSnapshotProjection skips aged terminal tasks only when the cutoff is provided', () => {
    const store = new TaskStore();
    seedCompletedTask(store, { name: 'aged', session: 'agent-aged', finishedAt: AGED });
    seedCompletedTask(store, { name: 'recent', session: 'agent-recent', finishedAt: RECENT });

    const withCutoff = buildSnapshotProjection({
      monitorStates: [],
      tasks: store.getAllTasks(),
      excludeTerminalBeforeMs: NOW.getTime() - SNAPSHOT_TERMINAL_TASK_MAX_AGE_MS,
    });
    expect(withCutoff.map((a) => a.agentId)).toEqual(['agent-recent']);

    const withoutCutoff = buildSnapshotProjection({
      monitorStates: [],
      tasks: store.getAllTasks(),
    });
    expect(withoutCutoff.map((a) => a.agentId).sort()).toEqual(['agent-aged', 'agent-recent']);
  });

  it('getSnapshotAgentsForClient excludes aged terminal tasks; Raw keeps them', () => {
    const store = new TaskStore();
    seedCompletedTask(store, { name: 'aged', session: 'agent-aged', finishedAt: AGED });
    seedCompletedTask(store, { name: 'recent', session: 'agent-recent', finishedAt: RECENT });
    const monitor = monitorFor(store);

    const client = getSnapshotAgentsForClient({ monitor, now: () => NOW });
    expect(client.map((a) => a.agentId)).toEqual(['agent-recent']);

    const raw = getSnapshotAgentsRaw({ monitor });
    expect(raw.map((a) => a.agentId).sort()).toEqual(['agent-aged', 'agent-recent']);
  });

  it('a fresh mutation (updatedAt bump) makes an aged terminal task reappear', () => {
    const store = new TaskStore();
    const task = seedCompletedTask(store, { name: 'aged', session: 'agent-aged', finishedAt: AGED });
    task.updatedAt = RECENT; // e.g. rename / feedback

    const client = getSnapshotAgentsForClient({ monitor: monitorFor(store), now: () => NOW });
    expect(client.map((a) => a.agentId)).toEqual(['agent-aged']);
  });
});

describe('terminal snapshot row slimming (issue #1526 Phase C / C2)', () => {
  it('bounds description, drops dead-weight fields, and slims the digest on recent terminal rows', () => {
    const store = new TaskStore();
    const hugeDescription = 'x'.repeat(8 * 1024);
    const task = seedCompletedTask(store, {
      name: 'recent',
      session: 'agent-recent',
      finishedAt: RECENT,
      description: hugeDescription,
      digest: fullDigest(),
    });
    task.completionFeedback = { rating: 'up', ratedAt: RECENT.toISOString() } as Task['completionFeedback'];
    task.launchHealthSummary = { totalFindings: 1 } as Task['launchHealthSummary'];

    const [agent] = getSnapshotAgentsForClient({ monitor: monitorFor(store), now: () => NOW });

    // Bounded description (bytes, plus the elision marker suffix).
    expect(Buffer.byteLength(agent.description ?? '', 'utf-8')).toBeLessThanOrEqual(
      TERMINAL_DESCRIPTION_MAX_BYTES + 64,
    );
    expect(agent.description).toContain('bytes elided');

    // Dead weight dropped.
    expect(agent.completionFeedback).toBeUndefined();
    expect(agent.launchHealthSummary).toBeUndefined();

    // Digest keeps what the dashboard renders, sheds what nothing reads.
    expect(agent.completionDigest).toBeDefined();
    expect(agent.completionDigest?.bullets).toEqual(['did the thing']);
    expect(agent.completionDigest?.filesChanged).toEqual(['src/a.ts', 'src/b.ts']);
    expect(agent.completionDigest?.criteriaVerdict).toBeDefined();
    expect(agent.completionDigest?.testSummary).toBe('all green');
    expect(agent.completionDigest?.branch).toBe('feature/x');
    expect(agent.completionDigest?.verificationCommands).toBeUndefined();
    expect(agent.completionDigest?.commits).toBeUndefined();
    expect(agent.completionDigest?.prUrls).toBeUndefined();

    // Dashboard-required contract fields for the Completed pane stay intact.
    expect(agent.taskId).toBe(task.id);
    expect(agent.taskStatus).toBe('completed');
    expect(agent.taskName).toBeDefined();
    expect(agent.finishedAt).toBe(RECENT.toISOString());
    expect(agent.startedAt).toBeDefined();
    expect(agent.cwd).toBe('/repo');
    expect(agent.agentType).toBe('claude-code');
  });

  it('leaves active (non-terminal) tasks untouched by the terminal slimming', () => {
    const store = new TaskStore();
    const description = 'y'.repeat(2 * 1024); // over terminal cap, under active cap
    const created = store.createTask(description, '/repo');
    store.addSession(created.id, {
      tmuxSession: 'agent-live',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: RECENT,
    });

    const monitor = {
      getSnapshot: () => [{ agentId: 'agent-live', events: [], anomaly: null }],
      getTaskSnapshot: () => store.getAllTasks(),
    };
    const [agent] = getSnapshotAgentsForClient({ monitor, now: () => NOW });
    expect(agent.taskStatus).toBe('inProgress');
    expect(agent.description).toBe(description);
  });

  it('getSnapshotAgentsRaw keeps full-fidelity terminal fields', () => {
    const store = new TaskStore();
    const task = seedCompletedTask(store, {
      name: 'recent',
      session: 'agent-recent',
      finishedAt: RECENT,
      digest: fullDigest(),
    });
    task.completionFeedback = { rating: 'up', ratedAt: RECENT.toISOString() } as Task['completionFeedback'];

    const [agent] = getSnapshotAgentsRaw({ monitor: monitorFor(store) });
    expect(agent.completionDigest?.verificationCommands).toEqual(['npx vitest run', 'npx tsc --noEmit']);
    expect(agent.completionDigest?.commits).toEqual(['abc123', 'def456']);
    expect(agent.completionFeedback).toBeDefined();
  });

  it('projectTerminalAgentFieldsForClient is identity-preserving when nothing needs clipping', () => {
    const agent = { description: 'short', completionDigest: { bullets: [], filesChanged: [] } };
    expect(projectTerminalAgentFieldsForClient(agent)).toBe(agent);
  });

  it('projectTerminalCompletionDigestForClient is identity-preserving without droppable fields', () => {
    const digest: CompletionDigest = { bullets: ['a'], filesChanged: [] };
    expect(projectTerminalCompletionDigestForClient(digest)).toBe(digest);
  });
});

describe('child rollup over excluded aged terminal children (issue #1526 Phase C / C2)', () => {
  it('buildRelationProjection buckets snapshot-absent children via the store-status fallback', () => {
    const relations = [
      {
        id: 'r1',
        sourceTaskId: 'child-1',
        targetTaskId: 'parent-1',
        type: 'spawned_by' as const,
        lifecycle: 'active' as const,
      },
    ];
    const parentAgent = { agentId: 'agent-parent', events: [], anomaly: null, taskId: 'parent-1' };

    const withFallback = buildRelationProjection(
      { listRelations: () => relations as never },
      [parentAgent],
      { getTaskStatus: (taskId) => (taskId === 'child-1' ? 'completed' : undefined) },
    );
    expect(withFallback.rollupsByParentTaskId.get('parent-1')).toMatchObject({
      childCount: 1,
      completed: 1,
      running: 0,
    });

    const withoutFallback = buildRelationProjection(
      { listRelations: () => relations as never },
      [parentAgent],
    );
    expect(withoutFallback.rollupsByParentTaskId.get('parent-1')).toMatchObject({
      childCount: 1,
      completed: 0,
      running: 1,
    });
  });

  it('createSnapshotMessage keeps a parent rollup completed when its aged child is excluded', () => {
    const store = new TaskStore();
    const parent = seedCompletedTask(store, { name: 'parent', session: 'agent-parent', finishedAt: RECENT });
    const child = seedCompletedTask(store, { name: 'child', session: 'agent-child', finishedAt: AGED });
    store.upsertRelation({
      sourceTaskId: child.id,
      targetTaskId: parent.id,
      type: 'spawned_by',
      lifecycle: 'active',
      source: 'deterministic',
      confidence: 1,
    } as never);

    const msg = createSnapshotMessage({
      monitor: monitorFor(store),
      serverCwd: '/repo',
      relationTaskStore: store,
      now: () => NOW,
    });

    expect(msg.agents.map((a) => a.agentId)).toEqual(['agent-parent']);
    const parentEntry = msg.agents.find((a) => a.taskId === parent.id);
    expect(parentEntry?.childRollup).toMatchObject({ childCount: 1, completed: 1, running: 0 });
  });
});
