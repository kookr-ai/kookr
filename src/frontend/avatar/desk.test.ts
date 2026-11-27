// The desk's words and small decisions (`desk.ts`): what a finding is called, the "Next:" line, the header's
// summary, and which closed questions and finished tasks count as today.

import { describe, expect, test } from 'vitest';
import type { AgentState } from '../../shared/protocol.js';
import type { OperatorAskView } from '../../shared/contracts/asks.js';
import type { NeedsYouItem } from '../store/needs-you.js';
import {
  DESK_DECIDED_LIMIT,
  DESK_FINISHED_LIMIT,
  decidedToday,
  deskSummaryText,
  findingExplanationLine,
  findingWords,
  finishedToday,
  nextDecisionText,
  startOfLocalDay,
} from './desk.js';

const MIN = 60_000;
const NOW = new Date(2026, 10, 16, 12, 0, 0).getTime();

function finding(type: string, over: Partial<AgentState> = {}, explanation = 'It says so.'): AgentState {
  return {
    agentId: 'a1', taskId: 't1', taskName: 'Package release', events: [],
    anomaly: { agentId: 'a1', type, severity: 'warning', explanation, detectedAt: new Date(NOW) },
    ...over,
  } as unknown as AgentState;
}

describe('findingWords', () => {
  test('a task that signalled complete says it is finished', () => {
    expect(findingWords(finding('needs_input', { turnState: 'completed_turn' }))).toMatchObject({ kind: 'Says it is finished', verb: 'review' });
  });

  test('the other kinds are named in words', () => {
    expect(findingWords(finding('budget_exceeded')).kind).toBe('Over budget');
    expect(findingWords(finding('stale_agent')).kind).toBe('Gone quiet');
    expect(findingWords(finding('needs_input')).kind).toBe('Asks for input');
  });

  test('a kind with no sentence falls back to the dashboard label', () => {
    expect(findingWords(finding('brand_new_kind')).kind).toBe('brand new kind');
  });
});

describe('findingExplanationLine', () => {
  test('is the first non-empty line, and empty when the data has none', () => {
    expect(findingExplanationLine(finding('stale_agent', {}, '\n  First line.\nSecond line.'))).toBe('First line.');
    expect(findingExplanationLine(finding('stale_agent', {}, ''))).toBe('');
    expect(findingExplanationLine({ agentId: 'x', events: [], anomaly: null } as unknown as AgentState)).toBe('');
  });
});

describe('nextDecisionText', () => {
  const none = (): undefined => undefined;

  test('a question: answer the task, with the time left', () => {
    const item: NeedsYouItem = { id: 'question:q', kind: 'question', taskName: 'Earnings Watch UX review', expiresAt: NOW + 117 * MIN };
    expect(nextDecisionText(item, NOW, none)).toBe('Next: answer Earnings Watch UX review, 117 min left');
  });

  test('a permission prompt: the task wants permission to use the tool', () => {
    const item: NeedsYouItem = { id: 'permission:p', kind: 'permission', taskName: 'Billing migration', toolName: 'Bash' };
    expect(nextDecisionText(item, NOW, none)).toBe('Next: Billing migration wants your permission to use Bash');
  });

  test('a finding: review a finished task, look at the others, each with its reason', () => {
    const done = finding('needs_input', { turnState: 'completed_turn' });
    const item: NeedsYouItem = { id: 'finding:a1:t1', kind: 'finding', taskId: 't1', taskName: 'Package release' };
    expect(nextDecisionText(item, NOW, () => done)).toBe('Next: review Package release, it says it is finished');
    expect(nextDecisionText(item, NOW, () => finding('budget_exceeded'))).toBe('Next: look at Package release, it is over budget');
  });
});

describe('deskSummaryText', () => {
  test('names what runs and what needs the operator, and leaves the second out when nothing does', () => {
    expect(deskSummaryText(7, 2)).toBe('7 running · 2 need you');
    expect(deskSummaryText(7, 1)).toBe('7 running · 1 needs you');
    expect(deskSummaryText(0, 0)).toBe('0 running');
  });
});

describe('what counts as today', () => {
  const closed = (id: string, closedAt: number, state: OperatorAskView['state'] = 'answered'): OperatorAskView => ({
    id, taskId: `t-${id}`, question: 'Q?', options: ['Yes'], allowText: false, state, createdAt: closedAt - MIN, expiresAt: closedAt + MIN, resolvedAt: closedAt,
  });

  test('startOfLocalDay is midnight of the same day', () => {
    expect(startOfLocalDay(NOW)).toBe(new Date(2026, 10, 16).getTime());
  });

  test('questions closed today, newest first, at most five; yesterday and pending ones are left out', () => {
    const asks = [
      closed('old', startOfLocalDay(NOW) - MIN),
      { ...closed('open', NOW), state: 'pending' as const },
      ...Array.from({ length: 7 }, (_, i) => closed(`c${i}`, NOW - (i + 1) * MIN)),
    ];
    const decided = decidedToday(asks, NOW);
    expect(decided).toHaveLength(DESK_DECIDED_LIMIT);
    expect(decided.map((ask) => ask.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
  });

  test('tasks finished today keep the dashboard order and stop at eight', () => {
    const done = (id: string, finishedAt: number | null): AgentState => ({ agentId: id, events: [], anomaly: null, ...(finishedAt === null ? {} : { finishedAt: new Date(finishedAt).toISOString() }) }) as unknown as AgentState;
    const list = [
      ...Array.from({ length: 10 }, (_, i) => done(`d${i}`, NOW - i * MIN)),
      done('yesterday', startOfLocalDay(NOW) - MIN),
      done('never', null),
    ];
    const today = finishedToday(list, NOW);
    expect(today).toHaveLength(DESK_FINISHED_LIMIT);
    expect(today.map((agent) => agent.agentId)).toEqual(['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']);
    expect(finishedToday(list.slice(10), NOW)).toEqual([]);
  });
});
