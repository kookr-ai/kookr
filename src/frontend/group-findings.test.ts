import { describe, test, expect } from 'vitest';
import { groupFindings, groupLabel } from './group-findings.js';
import type { AgentState } from '../shared/protocol.js';

function makeAgent(id: string, anomalyType: string): AgentState {
  return {
    agentId: id,
    events: [],
    anomaly: {
      agentId: id,
      type: anomalyType as any,
      severity: 'warning',
      explanation: `test ${anomalyType}`,
      detectedAt: new Date(),
    },
  };
}

describe('groupFindings', () => {
  test('returns all ungrouped when fewer than 3 share any type', () => {
    const findings = [
      makeAgent('a1', 'permission_blocked'),
      makeAgent('a2', 'permission_blocked'),
      makeAgent('a3', 'needs_input'),
    ];
    const { ungrouped, groups } = groupFindings(findings);
    expect(ungrouped).toHaveLength(3);
    expect(groups.size).toBe(0);
  });

  test('groups findings when ≥3 share the same anomaly type', () => {
    const findings = [
      makeAgent('a1', 'permission_blocked'),
      makeAgent('a2', 'permission_blocked'),
      makeAgent('a3', 'permission_blocked'),
      makeAgent('a4', 'needs_input'),
    ];
    const { ungrouped, groups } = groupFindings(findings);
    expect(groups.size).toBe(1);
    expect(groups.get('permission_blocked')).toHaveLength(3);
    expect(ungrouped).toHaveLength(1);
    expect(ungrouped[0].agentId).toBe('a4');
  });

  test('groups multiple types independently', () => {
    const findings = [
      makeAgent('a1', 'permission_blocked'),
      makeAgent('a2', 'permission_blocked'),
      makeAgent('a3', 'permission_blocked'),
      makeAgent('a4', 'needs_input'),
      makeAgent('a5', 'needs_input'),
      makeAgent('a6', 'needs_input'),
      makeAgent('a7', 'repeated_error'),
    ];
    const { ungrouped, groups } = groupFindings(findings);
    expect(groups.size).toBe(2);
    expect(groups.get('permission_blocked')).toHaveLength(3);
    expect(groups.get('needs_input')).toHaveLength(3);
    expect(ungrouped).toHaveLength(1);
    expect(ungrouped[0].agentId).toBe('a7');
  });

  test('returns all ungrouped when no findings', () => {
    const { ungrouped, groups } = groupFindings([]);
    expect(ungrouped).toHaveLength(0);
    expect(groups.size).toBe(0);
  });

  test('threshold is exactly 3', () => {
    const findings = [
      makeAgent('a1', 'permission_blocked'),
      makeAgent('a2', 'permission_blocked'),
    ];
    const { ungrouped, groups } = groupFindings(findings);
    expect(groups.size).toBe(0);
    expect(ungrouped).toHaveLength(2);

    findings.push(makeAgent('a3', 'permission_blocked'));
    const result2 = groupFindings(findings);
    expect(result2.groups.size).toBe(1);
    expect(result2.ungrouped).toHaveLength(0);
  });
});

describe('groupLabel', () => {
  test('maps known types to human-readable labels', () => {
    expect(groupLabel('permission_blocked')).toBe('blocked on permission');
    expect(groupLabel('repeated_error')).toBe('hitting repeated errors');
    expect(groupLabel('needs_input')).toBe('waiting for input');
  });

  test('returns type string for unknown types', () => {
    expect(groupLabel('unknown_type')).toBe('unknown_type');
  });
});
