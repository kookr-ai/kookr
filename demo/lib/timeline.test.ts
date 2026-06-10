import { describe, it, expect } from 'vitest';
import { buildSrt, segmentsFromTracker, estimateSpeechMs } from './timeline.js';

describe('estimateSpeechMs', () => {
  it('clamps very short text to the 1800ms floor', () => {
    expect(estimateSpeechMs('Hi.')).toBe(1800);
  });

  it('clamps very long text to the 9000ms ceiling', () => {
    expect(estimateSpeechMs('word '.repeat(60).trim())).toBe(9000);
  });

  it('uses ~2.6 words/second on the nominal path', () => {
    // 13 words / 2.6 wps = 5000ms
    const text = Array.from({ length: 13 }, (_, i) => `w${i}`).join(' ');
    expect(estimateSpeechMs(text)).toBe(5000);
  });
});

describe('buildSrt', () => {
  const narrations = { a: 'First line.', b: 'Second line.' };

  it('builds cues from clip durations with sequential indices', () => {
    const srt = buildSrt(
      [{ key: 'a', offsetMs: 0 }, { key: 'b', offsetMs: 10_000 }],
      narrations,
      new Map([['a', { durationMs: 2000 }], ['b', { durationMs: 1500 }]]),
    );
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:02,000\nFirst line.');
    expect(srt).toContain('2\n00:00:10,000 --> 00:00:11,500\nSecond line.');
  });

  it('skips marks with no narration text without breaking cue numbering', () => {
    const srt = buildSrt(
      [
        { key: 'a', offsetMs: 0 },
        { key: 'structural', offsetMs: 5000 },
        { key: 'b', offsetMs: 10_000 },
      ],
      narrations,
      new Map(),
    );
    expect(srt).not.toContain('structural');
    expect(srt).toContain('2\n00:00:10,000');
  });

  it('does not let a non-narrated structural mark truncate the preceding cue', () => {
    // video_end fires 700ms after the final narration mark; the cue must
    // still run for its full clip duration.
    const srt = buildSrt(
      [{ key: 'a', offsetMs: 0 }, { key: 'video_end', offsetMs: 700 }],
      narrations,
      new Map([['a', { durationMs: 6000 }]]),
    );
    expect(srt).toContain('00:00:00,000 --> 00:00:06,000');
  });

  it('clamps a cue that would overlap the next narrated mark', () => {
    const srt = buildSrt(
      [{ key: 'a', offsetMs: 0 }, { key: 'b', offsetMs: 3000 }],
      narrations,
      new Map([['a', { durationMs: 10_000 }]]),
    );
    expect(srt).toContain('00:00:00,000 --> 00:00:02,900');
  });

  it('drops a cue whose window collapses to zero', () => {
    const srt = buildSrt(
      [{ key: 'a', offsetMs: 1000 }, { key: 'b', offsetMs: 1050 }],
      narrations,
      new Map([['a', { durationMs: 5000 }]]),
    );
    expect(srt).not.toContain('First line.');
    expect(srt).toContain('Second line.');
  });
});

describe('segmentsFromTracker', () => {
  const entries = [
    { key: 'start', offsetMs: 1000 },
    { key: 'mid', offsetMs: 5000 },
    { key: 'late', offsetMs: 9000 },
  ];

  it('resolves from/to pairs against mark offsets', () => {
    expect(segmentsFromTracker(entries, 20_000, [['start', 'mid']])).toEqual([
      { startMs: 1000, endMs: 5000 },
    ]);
  });

  it('extends a null toKey to the video duration', () => {
    expect(segmentsFromTracker(entries, 12_000, [['late', null]])).toEqual([
      { startMs: 9000, endMs: 12_000 },
    ]);
  });

  it('skips pairs whose keys are missing (typo protection)', () => {
    expect(segmentsFromTracker(entries, 20_000, [['nope', 'mid'], ['start', 'gone']])).toEqual([]);
  });

  it('skips inverted pairs and clamps ends past the video duration', () => {
    expect(segmentsFromTracker(entries, 7000, [['mid', 'start'], ['mid', 'late']])).toEqual([
      { startMs: 5000, endMs: 7000 },
    ]);
  });
});
