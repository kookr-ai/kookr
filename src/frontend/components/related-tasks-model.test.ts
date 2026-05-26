import { describe, expect, it } from 'vitest';
import type { TaskRelation } from '../../shared/protocol.js';
import {
  buildRelatedTaskGroups,
  computeChainMembership,
  computeDescendants,
  isInferredRelation,
} from './related-tasks-model.js';

function relation(input: Partial<TaskRelation> & { sourceTaskId: string; targetTaskId: string }): TaskRelation {
  return {
    id: input.id ?? `rel-${input.sourceTaskId}-${input.targetTaskId}-${input.type ?? 'spawned_by'}`,
    sourceTaskId: input.sourceTaskId,
    targetTaskId: input.targetTaskId,
    type: input.type ?? 'spawned_by',
    confidence: input.confidence ?? 1,
    source: input.source ?? 'api',
    evidence: input.evidence ?? [],
    createdAt: '2026-05-26T00:00:00.000Z',
    updatedAt: '2026-05-26T00:00:00.000Z',
    lifecycle: input.lifecycle ?? 'active',
  };
}

describe('isInferredRelation', () => {
  it('marks llm-inference as inferred regardless of confidence', () => {
    expect(isInferredRelation(relation({ sourceTaskId: 'a', targetTaskId: 'b', source: 'llm-inference', confidence: 1 })))
      .toBe(true);
  });

  it('marks low-confidence non-LLM edges as inferred', () => {
    expect(isInferredRelation(relation({ sourceTaskId: 'a', targetTaskId: 'b', source: 'hook-log', confidence: 0.5 })))
      .toBe(true);
  });

  it('keeps deterministic high-confidence edges solid', () => {
    expect(isInferredRelation(relation({ sourceTaskId: 'a', targetTaskId: 'b', source: 'api', confidence: 1 })))
      .toBe(false);
    expect(isInferredRelation(relation({ sourceTaskId: 'a', targetTaskId: 'b', source: 'kookr-spawn', confidence: 0.95 })))
      .toBe(false);
  });
});

describe('buildRelatedTaskGroups', () => {
  it('groups children, parent, dependencies separately', () => {
    const relations: TaskRelation[] = [
      relation({ sourceTaskId: 'me', targetTaskId: 'parent-1', type: 'spawned_by' }),
      relation({ sourceTaskId: 'child-1', targetTaskId: 'me', type: 'spawned_by' }),
      relation({ sourceTaskId: 'me', targetTaskId: 'dep-1', type: 'depends_on' }),
    ];
    const groups = buildRelatedTaskGroups({ taskId: 'me', relations });
    const byKey = new Map(groups.map((g) => [g.key, g]));
    expect(byKey.get('parent')?.entries[0]?.otherTaskId).toBe('parent-1');
    expect(byKey.get('children')?.entries[0]?.otherTaskId).toBe('child-1');
    expect(byKey.get('dependencies')?.entries[0]?.otherTaskId).toBe('dep-1');
  });

  it('drops superseded and rejected relations', () => {
    const relations: TaskRelation[] = [
      relation({ sourceTaskId: 'me', targetTaskId: 'p1', type: 'spawned_by', lifecycle: 'superseded' }),
      relation({ sourceTaskId: 'me', targetTaskId: 'p2', type: 'spawned_by', lifecycle: 'rejected' }),
      relation({ sourceTaskId: 'me', targetTaskId: 'p3', type: 'spawned_by', lifecycle: 'active' }),
    ];
    const groups = buildRelatedTaskGroups({ taskId: 'me', relations });
    const parent = groups.find((g) => g.key === 'parent');
    expect(parent?.entries).toHaveLength(1);
    expect(parent?.entries[0].otherTaskId).toBe('p3');
  });

  it('flags inferred entries with the inferred bit', () => {
    const relations: TaskRelation[] = [
      relation({ sourceTaskId: 'me', targetTaskId: 'p1', type: 'spawned_by', source: 'api', confidence: 1 }),
      relation({
        sourceTaskId: 'me',
        targetTaskId: 'p2',
        type: 'related_to',
        source: 'llm-inference',
        confidence: 0.4,
      }),
    ];
    const groups = buildRelatedTaskGroups({ taskId: 'me', relations });
    const parent = groups.find((g) => g.key === 'parent');
    expect(parent?.entries[0].inferred).toBe(false);
    const other = groups.find((g) => g.key === 'other');
    expect(other?.entries[0].inferred).toBe(true);
  });

  it('hides completed descendants when the filter is on', () => {
    const relations: TaskRelation[] = [
      relation({ sourceTaskId: 'child-running', targetTaskId: 'me', type: 'spawned_by' }),
      relation({ sourceTaskId: 'child-done', targetTaskId: 'me', type: 'spawned_by' }),
    ];
    const taskStatusByTaskId = new Map<string, 'completed' | 'inProgress'>([
      ['child-running', 'inProgress'],
      ['child-done', 'completed'],
    ]);
    const groups = buildRelatedTaskGroups({
      taskId: 'me',
      relations,
      hideCompletedDescendants: true,
      taskStatusByTaskId: taskStatusByTaskId as any,
    });
    const children = groups.find((g) => g.key === 'children');
    expect(children?.entries.map((e) => e.otherTaskId)).toEqual(['child-running']);
  });

  it('returns groups in stable display order (parent → children → ...)', () => {
    const relations: TaskRelation[] = [
      relation({ sourceTaskId: 'me', targetTaskId: 'dep', type: 'depends_on' }),
      relation({ sourceTaskId: 'child', targetTaskId: 'me', type: 'spawned_by' }),
      relation({ sourceTaskId: 'me', targetTaskId: 'parent', type: 'spawned_by' }),
    ];
    const groups = buildRelatedTaskGroups({ taskId: 'me', relations });
    expect(groups.map((g) => g.key)).toEqual(['parent', 'children', 'dependencies']);
  });
});

describe('computeChainMembership', () => {
  it('walks same_chain and spawned_by edges in both directions', () => {
    const relations: TaskRelation[] = [
      relation({ sourceTaskId: 'b', targetTaskId: 'a', type: 'spawned_by' }),
      relation({ sourceTaskId: 'c', targetTaskId: 'b', type: 'spawned_by' }),
      relation({ sourceTaskId: 'd', targetTaskId: 'a', type: 'same_chain', confidence: 0.6, source: 'llm-inference' }),
    ];
    const chain = computeChainMembership('a', relations);
    expect(chain).toEqual(new Set(['a', 'b', 'c', 'd']));
  });

  it('ignores rejected and superseded edges', () => {
    const relations: TaskRelation[] = [
      relation({ sourceTaskId: 'b', targetTaskId: 'a', type: 'spawned_by', lifecycle: 'superseded' }),
    ];
    expect(computeChainMembership('a', relations)).toEqual(new Set(['a']));
  });
});

describe('computeDescendants', () => {
  it('returns transitive descendants but not the root', () => {
    const relations: TaskRelation[] = [
      relation({ sourceTaskId: 'b', targetTaskId: 'a', type: 'spawned_by' }),
      relation({ sourceTaskId: 'c', targetTaskId: 'b', type: 'spawned_by' }),
      relation({ sourceTaskId: 'd', targetTaskId: 'c', type: 'successor_of' }),
    ];
    const descendants = computeDescendants('a', relations);
    expect(descendants).toEqual(new Set(['b', 'c', 'd']));
  });
});
