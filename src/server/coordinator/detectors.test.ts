import { performance } from 'node:perf_hooks';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'vitest';
import { hashPrompt } from '../hash-prompt.js';
import type { CoordinatorDetectorOutput } from '../../shared/contracts/coordinator.js';
import {
  buildCoordinatorSnapshotState,
  runDetectors,
  type CoordinatorAuditTailRow,
  type CoordinatorTask,
} from './detectors.js';

const NOW = new Date('2026-05-21T12:00:00.000Z');

function task(overrides: Partial<CoordinatorTask> & Pick<CoordinatorTask, 'id'>): CoordinatorTask {
  return pruneUndefined({
    id: overrides.id,
    prompt: overrides.prompt ?? `prompt for ${overrides.id}`,
    status: overrides.status ?? 'inProgress',
    createdAt: overrides.createdAt ?? '2026-05-21T11:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-05-21T11:00:00.000Z',
    agentType: overrides.agentType ?? 'codex-cli',
    sessions: overrides.sessions,
    cwd: overrides.cwd ?? '/tmp/kookr-coordinator-default',
    completionDigest: overrides.completionDigest,
    completionFeedback: overrides.completionFeedback,
    anomaly: overrides.anomaly,
    followUp: overrides.followUp,
    followUpRequired: overrides.followUpRequired,
    nextAction: overrides.nextAction,
    metadata: overrides.metadata,
    parentTaskId: overrides.parentTaskId,
    childTaskIds: overrides.childTaskIds,
    blocks: overrides.blocks,
    blocked_by: overrides.blocked_by,
  }) as CoordinatorTask;
}

function outputsByDetector(
  outputs: CoordinatorDetectorOutput[],
  detector: CoordinatorDetectorOutput['detectorId'],
): CoordinatorDetectorOutput[] {
  return outputs.filter((output) => output.detectorId === detector);
}

function pruneUndefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}

describe('runDetectors', () => {
  test('does not import launch orchestration for cwd canonicalization', () => {
    const source = readFileSync(new URL('./detectors.ts', import.meta.url), 'utf8');

    expect(source).not.toContain("from '../launch-service.js'");
    expect(source).toContain("from '../cwd.js'");
  });

  test('builds one chip for every detector class using coordinator precedence', () => {
    const edge = task({ id: 'edge', blocks: ['task:downstream'] });
    const downstream = task({ id: 'downstream' });
    const stale = task({ id: 'stale' });
    const duplicateA = task({ id: 'duplicate-a', prompt: 'same prompt', cwd: '/tmp/repo' });
    const duplicateB = task({ id: 'duplicate-b', prompt: 'same prompt', cwd: '/tmp/repo' });
    const done = task({
      id: 'done',
      status: 'completed',
      completionDigest: { bullets: ['done'], filesChanged: [] },
    });

    const state = buildCoordinatorSnapshotState(
      { tasks: [edge, downstream, stale, duplicateA, duplicateB, done] },
      [{ taskId: 'stale', rawHookEventName: 'PostToolUse', observedAt: '2026-05-21T11:00:00.000Z' }],
      { now: NOW },
    );

    expect(state.chips.map((chip) => [chip.taskId, chip.detectorId, chip.verb])).toEqual(expect.arrayContaining([
      ['edge', 'declared_edge', 'Nudge'],
      ['stale', 'stale', 'Nudge'],
      ['duplicate-a', 'duplicate', 'Compare'],
      ['duplicate-b', 'duplicate', 'Compare'],
      ['done', 'done_not_cleared', 'Acknowledge'],
    ]));
  });

  test('emits declared-edge outputs and chain strips for related tasks', () => {
    const source = task({ id: 'source', blocks: ['task:target'] });
    const target = task({ id: 'target', blocked_by: ['task:source'], parentTaskId: 'source' });
    const state = buildCoordinatorSnapshotState({ tasks: [source, target] }, [], { now: NOW });

    expect(outputsByDetector(state.outputs, 'declared_edge').map((output) => output.taskId).sort()).toEqual(['source', 'target']);
    expect(state.chains.source?.members.map((member) => [member.taskId, member.relation])).toEqual([
      ['target', 'blocks'],
    ]);
    expect(state.chains.target?.members.map((member) => [member.taskId, member.relation])).toEqual([
      ['source', 'parent'],
    ]);
    expect(state.chains.target?.priorTaskIds).toEqual(['source']);
  });

  test.each([
    {
      name: 'flags in-progress task whose last PostToolUse is older than the threshold',
      tasks: [task({ id: 'stale-task' })],
      auditTail: [
        {
          taskId: 'stale-task',
          rawHookEventName: 'PostToolUse',
          observedAt: '2026-05-21T11:20:00.000Z',
        },
      ],
      expectedTaskIds: ['stale-task'],
    },
    {
      name: 'uses active session start time, not metadata update time, when no PostToolUse exists in the audit tail',
      tasks: [task({
        id: 'quiet-task',
        createdAt: '2026-05-21T11:00:00.000Z',
        updatedAt: '2026-05-21T11:59:00.000Z',
        sessions: [{
          tmuxSession: 'kookr-quiet',
          createdAt: new Date('2026-05-21T11:00:00.000Z'),
        }],
      })],
      auditTail: [],
      expectedTaskIds: ['quiet-task'],
    },
    {
      name: 'does not flag a task queued long ago when the active session started recently',
      tasks: [task({
        id: 'recently-started-task',
        createdAt: '2026-05-21T10:00:00.000Z',
        updatedAt: '2026-05-21T11:59:00.000Z',
        sessions: [{
          tmuxSession: 'kookr-recent',
          createdAt: new Date('2026-05-21T11:45:00.000Z'),
        }],
      })],
      auditTail: [],
      expectedTaskIds: [],
    },
    {
      name: 'does not flag a relaunched task when the new active session is newer than predecessor activity',
      tasks: [task({
        id: 'relaunch-task',
        createdAt: '2026-05-21T10:00:00.000Z',
        sessions: [
          {
            tmuxSession: 'kookr-old',
            createdAt: new Date('2026-05-21T10:00:00.000Z'),
            lastStatus: 'completed',
          },
          {
            tmuxSession: 'kookr-new',
            createdAt: new Date('2026-05-21T11:56:00.000Z'),
          },
        ],
      })],
      auditTail: [
        {
          taskId: 'relaunch-task',
          rawHookEventName: 'PostToolUse',
          observedAt: '2026-05-21T10:20:00.000Z',
        },
      ],
      expectedTaskIds: [],
    },
    {
      name: 'does not flag a task without PostToolUse or an active session start',
      tasks: [task({
        id: 'not-launched-task',
        createdAt: '2026-05-21T10:00:00.000Z',
      })],
      auditTail: [],
      expectedTaskIds: [],
    },
    {
      name: 'does not flag a task with recent PostToolUse activity',
      tasks: [task({ id: 'active-task' })],
      auditTail: [
        {
          envelope: {
            taskId: 'active-task',
            rawHookEventName: 'PostToolUse',
            observedAt: '2026-05-21T11:45:00.000Z',
          },
        },
      ],
      expectedTaskIds: [],
    },
    {
      name: 'maps activity-ledger session rows back to the owning task',
      tasks: [
        task({
          id: 'session-mapped-task',
          sessions: [{
            tmuxSession: 'kookr-session-1',
            createdAt: new Date('2026-05-21T11:00:00.000Z'),
          }],
        }),
      ],
      auditTail: [
        {
          envelope: {
            kookrSessionId: 'kookr-session-1',
            rawHookEventName: 'PostToolUse',
            observedAt: '2026-05-21T11:45:00.000Z',
          },
        },
      ],
      expectedTaskIds: [],
    },
  ])('$name', ({ tasks, auditTail, expectedTaskIds }) => {
    const outputs = runDetectors({ tasks }, auditTail, { now: NOW });
    expect(outputsByDetector(outputs, 'stale').map((output) => output.taskId)).toEqual(expectedTaskIds);
  });

  test('groups active tasks by effective-prompt hash', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'coordinator-detectors-'));
    await writeFile(join(cwd, 'target.ts'), 'export {};\n');
    const prompt = 'Inspect target.ts';
    const outputs = outputsByDetector(
      runDetectors({ tasks: [
        task({ id: 'a', prompt, cwd }),
        task({ id: 'b', prompt: `Inspect ${join(cwd, 'target.ts')}`, cwd }),
        task({ id: 'closed', prompt, status: 'completed' }),
      ] }, [], { now: NOW }),
      'duplicate',
    );

    expect(outputs.map((output) => output.taskId).sort()).toEqual(['a', 'b']);
    expect(outputs[0].evidence).toMatchObject({
      promptHash: hashPrompt(`Inspect ${join(cwd, 'target.ts')}`),
      agentType: 'codex-cli',
      canonicalCwd: await realpath(cwd),
      clusterTaskIds: ['a', 'b'],
    });
  });

  test('does not group matching prompt hashes across cwd or agent type boundaries', () => {
    const prompt = 'Run the standard review';
    const outputs = outputsByDetector(
      runDetectors({ tasks: [
        task({ id: 'repo-a', prompt, cwd: '/tmp/repo-a', agentType: 'codex-cli' }),
        task({ id: 'repo-b', prompt, cwd: '/tmp/repo-b', agentType: 'codex-cli' }),
        task({ id: 'claude', prompt, cwd: '/tmp/repo-a', agentType: 'claude-code' }),
      ] }, [], { now: NOW }),
      'duplicate',
    );

    expect(outputs).toEqual([]);
  });

  test('excludes intentional duplicate tasks from duplicate clusters', () => {
    const prompt = 'Keep this duplicate on purpose';
    const outputs = outputsByDetector(
      runDetectors({ tasks: [
        task({ id: 'original', prompt }),
        task({ id: 'intentional-copy', prompt, metadata: { intent: 'keep_as_duplicate' } }),
      ] }, [], { now: NOW }),
      'duplicate',
    );

    expect(outputs).toEqual([]);
  });

  test.each([
    {
      name: 'flags completed task with a completion digest and no follow-up signal',
      candidate: task({
        id: 'done',
        status: 'completed',
        completionDigest: { bullets: ['done'], filesChanged: [] },
      }),
      shouldFlag: true,
    },
    {
      name: 'does not flag completed task without a completion digest',
      candidate: task({ id: 'no-digest', status: 'completed' }),
      shouldFlag: false,
    },
    {
      name: 'does not flag completed task with a follow-up signal',
      candidate: task({
        id: 'follow-up',
        status: 'completed',
        completionDigest: { bullets: ['done'], filesChanged: [] },
        followUpRequired: true,
      }),
      shouldFlag: false,
    },
    {
      name: 'does not flag completed task with an anomaly',
      candidate: task({
        id: 'anomaly',
        status: 'completed',
        completionDigest: { bullets: ['done'], filesChanged: [] },
        anomaly: { type: 'needs_input' },
      }),
      shouldFlag: false,
    },
  ])('$name', ({ candidate, shouldFlag }) => {
    const outputs = outputsByDetector(runDetectors({ tasks: [candidate] }, [], { now: NOW }), 'done_not_cleared');
    expect(outputs.map((output) => output.taskId)).toEqual(shouldFlag ? [candidate.id] : []);
  });

  test('evaluates 50 active tasks under the detector budget', () => {
    const tasks = Array.from({ length: 50 }, (_, index) => task({
      id: `task-${index}`,
      prompt: `unique prompt ${index}`,
      updatedAt: '2026-05-21T11:59:00.000Z',
    }));
    const auditTail: CoordinatorAuditTailRow[] = tasks.map((candidate) => ({
      taskId: candidate.id,
      rawHookEventName: 'PostToolUse',
      observedAt: '2026-05-21T11:59:30.000Z',
    }));

    const startedAt = performance.now();
    const outputs = runDetectors({ tasks }, auditTail, { now: NOW });
    const elapsedMs = performance.now() - startedAt;

    expect(outputs).toEqual([]);
    expect(elapsedMs).toBeLessThan(200);
  });
});
