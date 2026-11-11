import { describe, expect, it } from 'vitest';
import { SentenceSplitter } from './sentence-splitter.js';

function run(deltas: string[]): string[] {
  const s = new SentenceSplitter();
  const out = deltas.flatMap((d) => s.push(d));
  const rest = s.flush();
  return rest ? [...out, rest] : out;
}

describe('SentenceSplitter', () => {
  it('splits streamed text into sentences as soon as the next word starts', () => {
    const s = new SentenceSplitter();
    expect(s.push('Two tasks ')).toEqual([]);
    expect(s.push('are running.')).toEqual([]); // end of buffer: not confirmed yet
    expect(s.push(' One needs')).toEqual(['Two tasks are running.']);
    expect(s.push(' you! Really?')).toEqual(['One needs you!']);
    expect(s.flush()).toBe('Really?');
  });

  it('does not split decimals or abbreviations', () => {
    expect(run(['It took 3.5 minutes, e.g. a short one. Next.'])).toEqual(['It took 3.5 minutes, e.g. a short one.', 'Next.']);
    expect(run(['Ask Dr. Smith about it. Okay.'])).toEqual(['Ask Dr. Smith about it.', 'Okay.']);
    expect(run(['Then J. Smith left. Bye.'])).toEqual(['Then J. Smith left.', 'Bye.']);
  });

  it('keeps closing quotes with their sentence and treats ellipsis and newlines as ends', () => {
    expect(run(['She said "go." Then left… Fine\nNext line'])).toEqual(['She said "go."', 'Then left…', 'Fine', 'Next line']);
  });

  it('is independent of how the text is chunked', () => {
    const text = 'Alpha is done. Beta, version 2.1, is running! Gamma?';
    const whole = run([text]);
    const chars = run(text.split(''));
    expect(chars).toEqual(whole);
    expect(whole).toEqual(['Alpha is done.', 'Beta, version 2.1, is running!', 'Gamma?']);
  });

  it('does not treat a leading list number as a sentence', () => {
    expect(run(['1. First thing. 2. Second thing.'])).toEqual(['1. First thing.', '2. Second thing.']);
  });

  it('flush returns null when empty', () => {
    const s = new SentenceSplitter();
    s.push('Done. ');
    expect(s.flush()).toBeNull();
  });
});
