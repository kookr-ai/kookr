import { describe, expect, test } from 'vitest';

import type { AgentState } from '../shared/contracts/agent-state.js';
import type { SnapshotMessage } from '../shared/contracts/messages.js';
import {
  agentStreamKey,
  buildDeltaFromSnapshots,
  diffAggregates,
  diffProjectedAgents,
  readWsDeltaEnabledFromEnv,
  scopeDeltaForProjects,
} from './snapshot-delta.js';

function agent(partial: Partial<AgentState> & { agentId: string }): AgentState {
  return {
    events: [],
    anomaly: null,
    ...partial,
  } as AgentState;
}

function snap(overrides: Partial<SnapshotMessage> = {}): SnapshotMessage {
  return {
    type: 'snapshot',
    agents: [],
    serverCwd: '/repo',
    epoch: 'E1',
    seq: 1,
    ...overrides,
  };
}

describe('snapshot-delta (#1754 Stage 2)', () => {
  describe('readWsDeltaEnabledFromEnv', () => {
    test('defaults on when unset', () => {
      expect(readWsDeltaEnabledFromEnv({})).toBe(true);
    });
    test.each(['0', 'false', 'off', 'no', 'FALSE'])('disables on %s', (raw) => {
      expect(readWsDeltaEnabledFromEnv({ KOOKR_WS_DELTA: raw })).toBe(false);
    });
    test.each(['1', 'true', 'on', 'yes'])('enables on %s', (raw) => {
      expect(readWsDeltaEnabledFromEnv({ KOOKR_WS_DELTA: raw })).toBe(true);
    });
  });

  describe('diffProjectedAgents', () => {
    test('unchanged fleet yields empty delta', () => {
      const a = agent({ agentId: 's1', taskId: 't1', taskName: 'A' });
      expect(diffProjectedAgents([a], [a])).toEqual({ upserts: [], removed: [] });
    });

    test('changed agent becomes an upsert; removed key is listed', () => {
      const prev = [
        agent({ agentId: 's1', taskId: 't1', taskName: 'A' }),
        agent({ agentId: 's2', taskId: 't2', taskName: 'B' }),
      ];
      const next = [
        agent({ agentId: 's1', taskId: 't1', taskName: 'A-changed' }),
        agent({ agentId: 's3', taskId: 't3', taskName: 'C' }),
      ];
      const d = diffProjectedAgents(prev, next);
      expect(d.upserts.map((u) => agentStreamKey(u)).sort()).toEqual(['s1:t1', 's3:t3']);
      expect(d.removed).toEqual(['s2:t2']);
    });
  });

  describe('buildDeltaFromSnapshots', () => {
    test('produces a dense-seq keep-alive when nothing changed', () => {
      const prev = snap({ seq: 4, agents: [agent({ agentId: 's1', taskId: 't1' })] });
      const cur = snap({ seq: 5, agents: [agent({ agentId: 's1', taskId: 't1' })] });
      const { delta, empty } = buildDeltaFromSnapshots(prev, cur);
      expect(empty).toBe(true);
      expect(delta).toEqual({ type: 'delta', epoch: 'E1', seq: 5 });
    });

    test('includes agent upserts, removed, relations, and aggregates', () => {
      const prev = snap({
        seq: 1,
        agents: [agent({ agentId: 's1', taskId: 't1' })],
        totalSpendUsd: 1,
        taskRelations: [],
      });
      const cur = snap({
        seq: 2,
        agents: [agent({ agentId: 's1', taskId: 't1', taskName: 'x' })],
        totalSpendUsd: 2,
        taskRelations: [{
          id: 'r1',
          sourceTaskId: 't1',
          targetTaskId: 't2',
          type: 'spawned_by',
          confidence: 1,
          source: 'kookr-spawn',
          evidence: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          lifecycle: 'active',
        }],
      });
      const { delta, empty } = buildDeltaFromSnapshots(prev, cur);
      expect(empty).toBe(false);
      expect(delta.seq).toBe(2);
      expect(delta.agents?.upserts).toHaveLength(1);
      expect(delta.aggregates?.totalSpendUsd).toBe(2);
      expect(delta.taskRelations).toHaveLength(1);
    });
  });

  describe('diffAggregates', () => {
    test('omits unchanged aggregate keys', () => {
      const prev = snap({ totalSpendUsd: 5, maxActiveTasks: 3 });
      const cur = snap({ totalSpendUsd: 5, maxActiveTasks: 4 });
      expect(diffAggregates(prev, cur)).toEqual({ maxActiveTasks: 4 });
    });
  });

  describe('scopeDeltaForProjects', () => {
    test('filters upserts/removals to in-scope projectIds and drops aggregates', () => {
      const previous = [
        agent({ agentId: 's1', taskId: 't1', projectId: 'p1' }),
        agent({ agentId: 's2', taskId: 't2', projectId: 'p2' }),
      ];
      const delta = {
        type: 'delta' as const,
        epoch: 'E1',
        seq: 3,
        agents: {
          upserts: [
            agent({ agentId: 's1', taskId: 't1', projectId: 'p1', taskName: 'upd' }),
            agent({ agentId: 's2', taskId: 't2', projectId: 'p2', taskName: 'other' }),
          ],
          removed: ['s1:t1', 's2:t2'],
        },
        aggregates: { totalSpendUsd: 99 },
      };
      const scoped = scopeDeltaForProjects(delta, previous, ['p1']);
      expect(scoped.agents?.upserts.map((a) => a.agentId)).toEqual(['s1']);
      expect(scoped.agents?.removed).toEqual(['s1:t1']);
      expect(scoped.aggregates).toBeUndefined();
    });
  });
});
