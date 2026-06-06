import { describe, expect, test } from 'vitest';
import type { AgentState, TaskRelation } from '../../shared/protocol.js';
import { buildDependencyRail } from './dependency-rail-model.js';

function rel(input: Partial<TaskRelation> & { sourceTaskId: string; targetTaskId: string; type: TaskRelation['type'] }): TaskRelation {
  return {
    id: input.id ?? `rel-${input.sourceTaskId}-${input.targetTaskId}-${input.type}`,
    sourceTaskId: input.sourceTaskId,
    targetTaskId: input.targetTaskId,
    type: input.type,
    confidence: input.confidence ?? 1,
    source: input.source ?? 'api',
    evidence: input.evidence ?? [],
    createdAt: '2026-06-06T00:00:00.000Z',
    updatedAt: '2026-06-06T00:00:00.000Z',
    lifecycle: input.lifecycle ?? 'active',
  };
}

const labels = new Map<string, string>([
  ['me', 'This task'],
  ['blocker', 'Blocker task'],
  ['dependent', 'Dependent task'],
  ['parent', 'Parent task'],
  ['child', 'Child task'],
]);
const statuses = new Map<string, AgentState['taskStatus']>([
  ['blocker', 'completed'],
  ['dependent', 'inProgress'],
]);

function build(relations: TaskRelation[]) {
  return buildDependencyRail({
    taskId: 'me',
    relations,
    taskLabelByTaskId: labels,
    taskStatusByTaskId: statuses,
  });
}

describe('buildDependencyRail', () => {
  test('places blockers/parents/priors upstream and dependents/children downstream', () => {
    const rail = build([
      rel({ sourceTaskId: 'me', targetTaskId: 'blocker', type: 'depends_on' }),
      rel({ sourceTaskId: 'me', targetTaskId: 'parent', type: 'spawned_by' }),
      rel({ sourceTaskId: 'me', targetTaskId: 'dependent', type: 'blocks' }),
      rel({ sourceTaskId: 'me', targetTaskId: 'child', type: 'supervises' }),
    ]);
    expect(rail.upstream.map((n) => n.taskId).sort()).toEqual(['blocker', 'parent']);
    expect(rail.downstream.map((n) => n.taskId).sort()).toEqual(['child', 'dependent']);
  });

  test('incoming edges flip side (other depends_on me → downstream)', () => {
    const rail = build([
      rel({ sourceTaskId: 'dependent', targetTaskId: 'me', type: 'depends_on' }),
    ]);
    expect(rail.downstream.map((n) => n.taskId)).toEqual(['dependent']);
    expect(rail.upstream).toEqual([]);
  });

  test('excludes same_chain and related_to edges from the rail', () => {
    const rail = build([
      rel({ sourceTaskId: 'me', targetTaskId: 'child', type: 'same_chain' }),
      rel({ sourceTaskId: 'me', targetTaskId: 'parent', type: 'related_to' }),
    ]);
    expect(rail.upstream).toEqual([]);
    expect(rail.downstream).toEqual([]);
  });

  test('uses labels and statuses, and flags low-confidence edges as inferred', () => {
    const rail = build([
      rel({ sourceTaskId: 'me', targetTaskId: 'blocker', type: 'depends_on', confidence: 0.5 }),
    ]);
    expect(rail.upstream[0]).toMatchObject({
      taskId: 'blocker',
      label: 'Blocker task',
      status: 'completed',
      inferred: true,
      relationLabel: 'depends on',
    });
  });

  test('a neighbour on both sides resolves to upstream (blocker framing wins)', () => {
    const rail = build([
      rel({ sourceTaskId: 'me', targetTaskId: 'blocker', type: 'depends_on' }),
      rel({ sourceTaskId: 'me', targetTaskId: 'blocker', type: 'blocks', id: 'other' }),
    ]);
    expect(rail.upstream.map((n) => n.taskId)).toEqual(['blocker']);
    expect(rail.downstream).toEqual([]);
  });

  test('ignores non-active relations', () => {
    const rail = build([
      rel({ sourceTaskId: 'me', targetTaskId: 'blocker', type: 'depends_on', lifecycle: 'superseded' }),
    ]);
    expect(rail.upstream).toEqual([]);
  });
});
