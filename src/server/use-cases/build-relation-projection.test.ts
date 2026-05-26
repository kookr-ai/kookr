import { describe, expect, it } from 'vitest';
import type { AgentState } from '../../core/monitor.js';
import type { Anomaly } from '../../core/types.js';
import type { TaskRelation } from '../../shared/contracts/task-relations.js';
import {
  buildRelationProjection,
  deriveEffectiveAttentionSeverity,
} from './build-relation-projection.js';

function relation(input: Partial<TaskRelation> & { sourceTaskId: string; targetTaskId: string }): TaskRelation {
  return {
    id: input.id ?? `rel-${input.sourceTaskId}-${input.targetTaskId}-${input.type ?? 'spawned_by'}`,
    sourceTaskId: input.sourceTaskId,
    targetTaskId: input.targetTaskId,
    type: input.type ?? 'spawned_by',
    confidence: input.confidence ?? 1,
    source: input.source ?? 'api',
    evidence: input.evidence ?? [],
    createdAt: input.createdAt ?? '2026-05-26T10:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-05-26T10:00:00.000Z',
    lifecycle: input.lifecycle ?? 'active',
  };
}

function agent(partial: Partial<AgentState> & { agentId: string }): AgentState {
  return {
    agentId: partial.agentId,
    events: partial.events ?? [],
    anomaly: partial.anomaly ?? null,
    ...partial,
  } as AgentState;
}

function anomaly(partial: Partial<Anomaly> & { type: Anomaly['type']; severity: Anomaly['severity'] }): Anomaly {
  return {
    agentId: partial.agentId ?? 'a',
    type: partial.type,
    severity: partial.severity,
    explanation: partial.explanation ?? 'needs review',
    detectedAt: partial.detectedAt ?? new Date('2026-05-26T10:00:00.000Z'),
  };
}

describe('buildRelationProjection', () => {
  it('filters out non-active relations from the projected list', () => {
    const relations: TaskRelation[] = [
      relation({ sourceTaskId: 'c1', targetTaskId: 'p1', lifecycle: 'active' }),
      relation({ sourceTaskId: 'c2', targetTaskId: 'p1', lifecycle: 'superseded' }),
      relation({ sourceTaskId: 'c3', targetTaskId: 'p1', lifecycle: 'rejected' }),
    ];

    const result = buildRelationProjection({ listRelations: () => relations }, []);
    expect(result.taskRelations).toHaveLength(1);
    expect(result.taskRelations[0].sourceTaskId).toBe('c1');
  });

  it('rolls up children by parent and counts mutually exclusive buckets', () => {
    const relations: TaskRelation[] = [
      relation({ sourceTaskId: 'child-running', targetTaskId: 'parent' }),
      relation({ sourceTaskId: 'child-completed', targetTaskId: 'parent' }),
      relation({ sourceTaskId: 'child-blocked-by-anomaly', targetTaskId: 'parent' }),
      relation({ sourceTaskId: 'child-blocked-by-turn', targetTaskId: 'parent' }),
    ];
    const agents: AgentState[] = [
      agent({ agentId: 'a1', taskId: 'child-running', taskStatus: 'inProgress', anomaly: null }),
      agent({ agentId: 'a2', taskId: 'child-completed', taskStatus: 'completed', anomaly: null }),
      agent({
        agentId: 'a3',
        taskId: 'child-blocked-by-anomaly',
        taskStatus: 'inProgress',
        anomaly: anomaly({ type: 'needs_input', severity: 'warning', explanation: 'wants reply' }),
      }),
      agent({ agentId: 'a4', taskId: 'child-blocked-by-turn', taskStatus: 'inProgress', turnState: 'blocked', anomaly: null }),
    ];

    const { rollupsByParentTaskId } = buildRelationProjection({ listRelations: () => relations }, agents);
    const rollup = rollupsByParentTaskId.get('parent');
    expect(rollup).toBeDefined();
    expect(rollup!.childCount).toBe(4);
    expect(rollup!.running).toBe(1);
    expect(rollup!.completed).toBe(1);
    expect(rollup!.blocked).toBe(2);
  });

  it('surfaces the most-severe child finding (critical beats warning)', () => {
    const relations: TaskRelation[] = [
      relation({ sourceTaskId: 'c1', targetTaskId: 'parent' }),
      relation({ sourceTaskId: 'c2', targetTaskId: 'parent' }),
    ];
    const agents: AgentState[] = [
      agent({
        agentId: 'a-warn',
        taskId: 'c1',
        taskStatus: 'inProgress',
        anomaly: anomaly({ type: 'needs_input', severity: 'warning', explanation: 'soft block' }),
      }),
      agent({
        agentId: 'a-crit',
        taskId: 'c2',
        taskStatus: 'inProgress',
        anomaly: anomaly({ type: 'permission_blocked', severity: 'critical', explanation: 'hard block' }),
      }),
    ];

    const { rollupsByParentTaskId } = buildRelationProjection({ listRelations: () => relations }, agents);
    const rollup = rollupsByParentTaskId.get('parent');
    expect(rollup?.mostUrgentChildFinding).toMatchObject({
      childTaskId: 'c2',
      childAgentId: 'a-crit',
      severity: 'critical',
      anomalyType: 'permission_blocked',
    });
  });

  it('omits mostUrgentChildFinding when no child has an active anomaly', () => {
    const relations: TaskRelation[] = [
      relation({ sourceTaskId: 'c1', targetTaskId: 'parent' }),
    ];
    const agents: AgentState[] = [
      agent({ agentId: 'a1', taskId: 'c1', taskStatus: 'inProgress', anomaly: null }),
    ];
    const { rollupsByParentTaskId } = buildRelationProjection({ listRelations: () => relations }, agents);
    const rollup = rollupsByParentTaskId.get('parent');
    expect(rollup).toBeDefined();
    expect(rollup?.mostUrgentChildFinding).toBeUndefined();
  });

  it('preserves deterministic-vs-inferred confidence in the projected array', () => {
    const relations: TaskRelation[] = [
      relation({ sourceTaskId: 'c1', targetTaskId: 'p1', confidence: 1, source: 'api' }),
      relation({
        sourceTaskId: 'c2',
        targetTaskId: 'p1',
        type: 'related_to',
        confidence: 0.4,
        source: 'llm-inference',
      }),
    ];
    const { taskRelations } = buildRelationProjection({ listRelations: () => relations }, []);
    expect(taskRelations).toHaveLength(2);
    const deterministic = taskRelations.find((r) => r.source === 'api');
    const inferred = taskRelations.find((r) => r.source === 'llm-inference');
    expect(deterministic?.confidence).toBe(1);
    expect(inferred?.confidence).toBe(0.4);
  });

  it('does not project a rollup for parents that have no `spawned_by` children', () => {
    const relations: TaskRelation[] = [
      relation({ sourceTaskId: 'a', targetTaskId: 'b', type: 'related_to', confidence: 0.5, source: 'llm-inference' }),
    ];
    const { rollupsByParentTaskId } = buildRelationProjection({ listRelations: () => relations }, []);
    expect(rollupsByParentTaskId.size).toBe(0);
  });

  it('treats a child task with no live agent as running (synthetic pending)', () => {
    const relations: TaskRelation[] = [
      relation({ sourceTaskId: 'c-no-agent', targetTaskId: 'parent' }),
    ];
    const { rollupsByParentTaskId } = buildRelationProjection({ listRelations: () => relations }, []);
    const rollup = rollupsByParentTaskId.get('parent');
    expect(rollup).toMatchObject({ childCount: 1, running: 1, completed: 0, blocked: 0 });
  });
});

describe('deriveEffectiveAttentionSeverity', () => {
  it('returns the more severe of parent vs child finding', () => {
    const rollup = {
      childCount: 1, running: 0, completed: 0, blocked: 1,
      mostUrgentChildFinding: { childTaskId: 'c', severity: 'critical' as const, anomalyType: 'needs_input', explanation: '' },
    };
    expect(deriveEffectiveAttentionSeverity('warning', rollup)).toBe('critical');
    expect(deriveEffectiveAttentionSeverity('critical', rollup)).toBe('critical');
    expect(deriveEffectiveAttentionSeverity('info', rollup)).toBe('critical');
  });

  it('returns child severity when parent has no own anomaly', () => {
    const rollup = {
      childCount: 1, running: 0, completed: 0, blocked: 1,
      mostUrgentChildFinding: { childTaskId: 'c', severity: 'warning' as const, anomalyType: 'needs_input', explanation: '' },
    };
    expect(deriveEffectiveAttentionSeverity(undefined, rollup)).toBe('warning');
  });

  it('returns parent severity when no child rollup is present', () => {
    expect(deriveEffectiveAttentionSeverity('warning', undefined)).toBe('warning');
  });

  it('returns undefined when neither side has any severity', () => {
    expect(deriveEffectiveAttentionSeverity(undefined, undefined)).toBeUndefined();
    expect(deriveEffectiveAttentionSeverity(undefined, { childCount: 0, running: 0, completed: 0, blocked: 0 })).toBeUndefined();
  });

  it('keeps parent severity when it is already worse than the child finding', () => {
    const rollup = {
      childCount: 1, running: 0, completed: 0, blocked: 1,
      mostUrgentChildFinding: { childTaskId: 'c', severity: 'info' as const, anomalyType: 'needs_input', explanation: '' },
    };
    expect(deriveEffectiveAttentionSeverity('critical', rollup)).toBe('critical');
  });
});
