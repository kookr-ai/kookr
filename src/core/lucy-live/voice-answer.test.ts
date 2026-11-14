import { describe, expect, it } from 'vitest';
import type { OperatorAskView } from '../../shared/contracts/asks.js';
import { buildAnswerMatchPrompt, buildAnswerReadBack, buildWhichQuestion, classifyReply, parseAnswerMatch, pendingVoiceAsks, sayAnswerOutcome, type VoiceAskChoice } from './voice-answer.js';

const A: VoiceAskChoice = { askId: 'a1', taskName: 'Cleanup', question: 'Delete the 101 merged worktrees?', options: ['yes, delete', 'no, keep'] };
const B: VoiceAskChoice = { askId: 'a2', question: 'Which region?', options: ['eu', 'us'] };

describe('parseAnswerMatch', () => {
  it('maps 1-based numbers to ids and indices', () => {
    expect(parseAnswerMatch('{"ask":2,"choice":1,"unclear":false}', [A, B])).toEqual({ kind: 'choice', askId: 'a2', optionIndex: 0 });
  });
  it('tolerates prose around the JSON', () => {
    expect(parseAnswerMatch('Sure: {"ask":1,"choice":2} done', [A])).toEqual({ kind: 'choice', askId: 'a1', optionIndex: 1 });
  });
  it.each([
    ['not json', 'maybe the second one'],
    ['null picks', '{"ask":null,"choice":null}'],
    ['ask out of range', '{"ask":3,"choice":1}'],
    ['choice out of range', '{"ask":1,"choice":3}'],
    ['zero', '{"ask":1,"choice":0}'],
    ['strings', '{"ask":"1","choice":"1"}'],
    ['a fraction', '{"ask":1,"choice":1.5}'],
    ['empty', ''],
  ])('%s is none', (_n, raw) => {
    expect(parseAnswerMatch(raw, [A, B])).toEqual({ kind: 'none' });
  });
  it('unclear counts only with several questions', () => {
    expect(parseAnswerMatch('{"ask":null,"choice":null,"unclear":true}', [A, B])).toEqual({ kind: 'unclear' });
    expect(parseAnswerMatch('{"ask":null,"choice":null,"unclear":true}', [A])).toEqual({ kind: 'none' });
  });
});

describe('prompts and read-back', () => {
  it('numbers questions and choices from 1 and quotes the words', () => {
    const { user } = buildAnswerMatchPrompt('delete them', [A]);
    expect(user).toContain('Question 1 (task "Cleanup")');
    expect(user).toContain('1. yes, delete');
    expect(user).toContain('The operator said: "delete them"');
  });
  it('the read-back uses the option text itself and names the task only when several wait', () => {
    expect(buildAnswerReadBack(A, 1, 1)).toBe('You want: no, keep. Shall I send that?');
    expect(buildAnswerReadBack(A, 0, 2)).toBe('You want: yes, delete for Cleanup. Shall I send that?');
  });
});

const view = (over: Partial<OperatorAskView>): OperatorAskView => ({
  id: 'x', taskId: 't', question: 'q?', options: ['a', 'b'], allowText: false, state: 'pending', createdAt: 0, expiresAt: 1, ...over,
});

describe('pendingVoiceAsks', () => {
  it('offers only pending questions that list choices', () => {
    const got = pendingVoiceAsks([
      view({ id: 'open', taskName: 'T' }),
      view({ id: 'answered', state: 'answered' }),
      view({ id: 'expired', state: 'expired' }),
      view({ id: 'cancelled', state: 'cancelled' }),
      view({ id: 'freetext', options: [], allowText: true }),
    ]);
    expect(got).toEqual([{ askId: 'open', taskName: 'T', question: 'q?', options: ['a', 'b'] }]);
  });
});

describe('classifyReply as a spoken confirmation', () => {
  it.each([['Yes!', 'confirm'], ['yes please', 'confirm'], ['Send it.', 'confirm'], ['no', 'decline'], ['yes and also delete the logs', 'other'], ['send', 'other']])('%s -> %s', (t, v) => {
    expect(classifyReply(t)).toBe(v);
  });
});

describe('sentences she says', () => {
  it.each([
    ['expired', /expired/], ['task_gone', /no longer running/], ['cancelled', /not waiting/], ['not_found', /not waiting/], ['bad_option', /could not send/],
  ])('refusal %s is said in words', (reason, re) => {
    expect(sayAnswerOutcome({ ok: false, reason }, 'x')).toMatch(re);
  });
  it('names the tasks when asking which question, and copes with none', () => {
    expect(buildWhichQuestion([A, B])).toBe('2 questions are waiting. They are from Cleanup. Which one do you mean?');
    expect(buildWhichQuestion([B, B])).not.toContain('They are from');
    expect(buildAnswerReadBack(B, 0, 2)).toBe('You want: eu. Shall I send that?');
  });
});
