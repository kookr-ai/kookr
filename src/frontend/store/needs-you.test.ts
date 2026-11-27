import { describe, expect, test } from 'vitest';
import type { OperatorAskView } from '../../shared/contracts/asks.js';
import type { LucyPermissionCardView } from '../../shared/contracts/lucy-permission.js';
import type { AgentState } from '../../shared/protocol.js';
import { buildNeedsYou, needsYouActionText, needsYouHint, needsYouTimeLeftText } from './needs-you.js';

const NOW = 1_800_000_000_000;

function ask(over: Partial<OperatorAskView> = {}): OperatorAskView {
  return {
    id: 'a1', taskId: 't1', taskName: 'Fix login', question: 'Ship?', options: ['Yes', 'No'], allowText: false,
    state: 'pending', createdAt: NOW - 1000, expiresAt: NOW + 29 * 60_000, ...over,
  };
}
function card(over: Partial<LucyPermissionCardView> = {}): LucyPermissionCardView {
  return { promptId: 'p1', taskId: 't2', agentId: 'ag2', taskName: 'Build docs', toolName: 'Bash', command: 'ls', since: NOW - 5000, ...over };
}
function finding(id: string, over: Partial<AgentState> = {}): AgentState {
  return { agentId: id, taskId: `task-${id}`, taskName: `Finding ${id}`, events: [], anomaly: { agentId: id, type: 'needs_input', severity: 'warning', explanation: 'x', detectedAt: new Date() }, ...over } as AgentState;
}
const none = { findings: [], asks: [], permissionCards: [], nowMs: NOW };

describe('buildNeedsYou', () => {
  test('nothing waiting is an empty list with zero counts', () => {
    expect(buildNeedsYou(none)).toEqual({ items: [], counts: { question: 0, permission: 0, finding: 0 }, total: 0 });
  });

  test('lists questions, permission prompts and findings, in that order, with stable ids', () => {
    const needs = buildNeedsYou({ ...none, findings: [finding('f1')], asks: [ask()], permissionCards: [card()] });
    expect(needs.items.map((i) => [i.id, i.kind])).toEqual([
      ['question:a1', 'question'], ['permission:p1', 'permission'], ['finding:f1:task-f1', 'finding'],
    ]);
    expect(needs.items[0]).toMatchObject({ taskId: 't1', taskName: 'Fix login', expiresAt: NOW + 29 * 60_000 });
    expect(needs.items[1]).toMatchObject({ taskId: 't2', taskName: 'Build docs', toolName: 'Bash' });
    expect(needs.counts).toEqual({ question: 1, permission: 1, finding: 1 });
    expect(needs.total).toBe(3);
  });

  test('a question that is not pending, has expired, or whose task ended is not waiting', () => {
    const needs = buildNeedsYou({
      ...none,
      asks: [
        ask({ id: 'answered', state: 'answered' }),
        ask({ id: 'expired-state', state: 'expired' }),
        ask({ id: 'past', expiresAt: NOW - 1 }),
        ask({ id: 'opinion', taskEnded: true }),
        ask({ id: 'live' }),
      ],
    });
    expect(needs.items.map((i) => i.id)).toEqual(['question:live']);
  });

  test('the question closing soonest comes first', () => {
    const needs = buildNeedsYou({ ...none, asks: [ask({ id: 'late', expiresAt: NOW + 60_000 * 20 }), ask({ id: 'soon', expiresAt: NOW + 60_000 * 2 })] });
    expect(needs.items.map((i) => i.id)).toEqual(['question:soon', 'question:late']);
  });

  test('a question of the system itself is named Kookr', () => {
    const needs = buildNeedsYou({ ...none, asks: [ask({ taskId: 'system:janitor', taskName: undefined }), ask({ id: 'a2', taskId: 'x', system: 'setup' })] });
    expect(needs.items.map((i) => i.taskName)).toEqual(['Kookr', 'Kookr']);
  });

  test('a task with a question and a finding is two entries', () => {
    const needs = buildNeedsYou({ ...none, findings: [finding('f1', { taskId: 't1' })], asks: [ask()] });
    expect(needs.total).toBe(2);
    expect(needsYouHint(needs.counts)).toBe('1 question, 1 finding');
  });

  test('a permission prompt of a task that already has a permission finding is not counted twice', () => {
    const blocked = finding('f1', { taskId: 't2', anomaly: { agentId: 'f1', type: 'permission_blocked', severity: 'warning', explanation: 'x', detectedAt: new Date() } as AgentState['anomaly'] });
    const needs = buildNeedsYou({ ...none, findings: [blocked], permissionCards: [card()] });
    expect(needs.counts).toEqual({ question: 0, permission: 0, finding: 1 });
  });

  test('a permission prompt still counts when its task has a finding of another type', () => {
    const other = finding('f1', { taskId: 't2' });
    const needs = buildNeedsYou({ ...none, findings: [other], permissionCards: [card()] });
    expect(needs.counts).toEqual({ question: 0, permission: 1, finding: 1 });
  });
});

describe('wording', () => {
  test('hint names the kinds, and is empty when only findings wait', () => {
    expect(needsYouHint({ question: 0, permission: 0, finding: 3 })).toBe('');
    expect(needsYouHint({ question: 2, permission: 1, finding: 0 })).toBe('2 questions, 1 permission prompt');
    expect(needsYouHint({ question: 1, permission: 0, finding: 1 })).toBe('1 question, 1 finding');
  });

  test('action text and time left', () => {
    expect(needsYouActionText({ id: 'q', kind: 'question' })).toBe('asks you a question');
    expect(needsYouActionText({ id: 'p', kind: 'permission', toolName: 'Bash' })).toBe('wants your permission to use Bash');
    expect(needsYouTimeLeftText(NOW + 29 * 60_000 + 5000, NOW)).toBe('29 min left');
    expect(needsYouTimeLeftText(NOW + 30_000, NOW)).toBe('under a minute left');
    expect(needsYouTimeLeftText(NOW + 3 * 3_600_000, NOW)).toBe('3 h left');
  });
});
