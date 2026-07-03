import { describe, test, expect } from 'vitest';
import { groupFindings, groupIdenticalPendingPrompts, groupLabel } from './group-findings.js';
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

function withAskUserQuestion(agent: AgentState, question: string, choices = ['Yes', 'No']): AgentState {
  return {
    ...agent,
    turnState: 'waiting_for_input',
    events: [{
      type: 'tool_use',
      sessionId: agent.agentId,
      toolName: 'AskUserQuestion',
      toolInput: { question, choices },
    }],
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

describe('groupIdenticalPendingPrompts', () => {
  test('groups agents waiting on the exact same AskUserQuestion prompt', () => {
    const first = withAskUserQuestion(makeAgent('a1', 'needs_input'), 'Open the PR when checks are green?');
    const second = withAskUserQuestion(makeAgent('a2', 'needs_input'), 'Open the PR when checks are green?');
    const third = withAskUserQuestion(makeAgent('a3', 'needs_input'), 'Merge the PR now?');

    const groups = groupIdenticalPendingPrompts([first, second, third]);

    expect(groups).toHaveLength(1);
    expect(groups[0].agents.map((agent) => agent.agentId)).toEqual(['a1', 'a2']);
    expect(groups[0].prompt).toContain('Open the PR when checks are green?');
    expect(groups[0].approvalResponse).toBe('yes');
  });

  test('does not batch completed-turn review findings', () => {
    const first = withAskUserQuestion(makeAgent('a1', 'needs_input'), 'Proceed?');
    const second = withAskUserQuestion(makeAgent('a2', 'needs_input'), 'Proceed?');

    const groups = groupIdenticalPendingPrompts([
      { ...first, turnState: 'completed_turn' },
      { ...second, turnState: 'completed_turn' },
    ]);

    expect(groups).toEqual([]);
  });

  test('keeps merge prompts out of policy-covered one-click approval', () => {
    const first = withAskUserQuestion(makeAgent('a1', 'needs_input'), 'Merge the PR now?');
    const second = withAskUserQuestion(makeAgent('a2', 'needs_input'), 'Merge the PR now?');

    const groups = groupIdenticalPendingPrompts([first, second]);

    expect(groups).toHaveLength(1);
    expect(groups[0].approvalResponse).toBeUndefined();
  });

  test('keeps scope-change prompts out of policy-covered one-click approval', () => {
    const first = withAskUserQuestion(makeAgent('a1', 'needs_input'), 'Expand scope to include cleanup?');
    const second = withAskUserQuestion(makeAgent('a2', 'needs_input'), 'Expand scope to include cleanup?');

    const groups = groupIdenticalPendingPrompts([first, second]);

    expect(groups).toHaveLength(1);
    expect(groups[0].approvalResponse).toBeUndefined();
  });

  test('keeps early or negated PR prompts out of policy-covered one-click approval', () => {
    const prompts = [
      'Should I open the PR before checks are green?',
      'Open the PR even though checks are not green?',
      'Open the PR without waiting for checks to pass?',
      'Open the PR once tests pass even if lint fails?',
    ];

    for (const [index, prompt] of prompts.entries()) {
      const first = withAskUserQuestion(makeAgent(`a${index}-1`, 'needs_input'), prompt);
      const second = withAskUserQuestion(makeAgent(`a${index}-2`, 'needs_input'), prompt);

      const groups = groupIdenticalPendingPrompts([first, second]);

      expect(groups).toHaveLength(1);
      expect(groups[0].approvalResponse).toBeUndefined();
    }
  });

  test('fingerprints object-shaped transcript context excerpts', () => {
    const first = makeAgent('a1', 'needs_input');
    const second = makeAgent('a2', 'needs_input');
    first.anomaly!.transcriptContext = { lastAssistantMessage: { excerpt: 'Waiting on the same prompt' } } as any;
    second.anomaly!.transcriptContext = { lastAssistantMessage: { excerpt: 'Waiting on the same prompt' } } as any;

    const groups = groupIdenticalPendingPrompts([first, second]);

    expect(groups).toHaveLength(1);
    expect(groups[0].prompt).toBe('Waiting on the same prompt');
  });

  test('ignores findings without string fallback text', () => {
    const first = makeAgent('a1', 'needs_input');
    const second = makeAgent('a2', 'needs_input');
    first.anomaly!.explanation = undefined as any;
    second.anomaly!.explanation = undefined as any;

    expect(groupIdenticalPendingPrompts([first, second])).toEqual([]);
  });
});
