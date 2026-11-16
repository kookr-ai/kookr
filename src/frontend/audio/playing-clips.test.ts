import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  __resetPlayingClipsForTests,
  clipStarted,
  playingClips,
  setAnswerYield,
  subscribePlayingClips,
} from './playing-clips.js';

const clip = () => ({ setVolume: vi.fn(), stop: vi.fn() });

describe('playing clips', () => {
  afterEach(() => {
    __resetPlayingClipsForTests();
    vi.restoreAllMocks();
  });

  test('a clip is listed from its start until it is released; releasing twice changes nothing', () => {
    const changes = vi.fn();
    subscribePlayingClips(changes);
    const a = clip();
    const release = clipStarted(a);
    expect(playingClips()).toEqual([a]);
    release();
    release();
    expect(playingClips()).toEqual([]);
    expect(changes).toHaveBeenCalledTimes(2);
  });

  test('the hands-free answer is told to yield before the clip is listed', () => {
    const seen: number[] = [];
    setAnswerYield(() => { seen.push(playingClips().length); });
    clipStarted(clip());
    expect(seen).toEqual([0]);
  });

  test('removing the answer yield only removes the one that is still registered', () => {
    const first = vi.fn();
    const second = vi.fn();
    const removeFirst = setAnswerYield(first);
    setAnswerYield(second);
    removeFirst();
    clipStarted(clip());
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  test('a failing answer yield or listener does not stop the clip from being listed', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setAnswerYield(() => { throw new Error('boom'); });
    subscribePlayingClips(() => { throw new Error('boom'); });
    const later = vi.fn();
    subscribePlayingClips(later);
    clipStarted(clip());
    expect(playingClips()).toHaveLength(1);
    expect(later).toHaveBeenCalledTimes(1);
  });
});
