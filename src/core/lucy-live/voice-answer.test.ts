import { describe, expect, it } from 'vitest';
import { buildAnswerMatchPrompt, buildAnswerReadBack, parseAnswerMatch, type VoiceAskChoice } from './voice-answer.js';

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
