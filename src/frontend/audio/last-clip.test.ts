import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  __resetLastClipForTests,
  captureLastClip,
  discardLastClip,
  getLastClip,
  getClip,
  getClipHistory,
  getLastClipSnapshot,
  MAX_CLIP_HISTORY,
  markClipHeard,
  subscribeLastClip,
} from './last-clip.js';

function bytes(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

describe('last-clip store', () => {
  beforeEach(() => {
    __resetLastClipForTests();
  });

  test('starts empty', () => {
    expect(getLastClip()).toBeNull();
    expect(getLastClipSnapshot()).toEqual({ hasClip: false, unheard: false, unheardCount: 0 });
    expect(getClipHistory()).toEqual([]);
  });

  test('captures a clip as unheard, keeping its bytes, text and server clip id', () => {
    const clip = captureLastClip({ clipId: 'srv-1', text: 'Two tasks need you.', audio: bytes(1, 2, 3), durationMs: 2400 });
    expect(clip).toMatchObject({ clipId: 'srv-1', text: 'Two tasks need you.', durationMs: 2400, heard: false });
    expect(new Uint8Array(clip.audio)).toEqual(new Uint8Array([1, 2, 3]));
    expect(getLastClipSnapshot()).toEqual({ hasClip: true, unheard: true, unheardCount: 1 });
  });

  test('falls back to a locally generated id when the server sent none', () => {
    const a = captureLastClip({ text: 'a', audio: bytes(1) });
    const b = captureLastClip({ clipId: '', text: 'b', audio: bytes(1) });
    expect(a.clipId).toMatch(/^local-/);
    expect(b.clipId).toMatch(/^local-/);
    expect(a.clipId).not.toBe(b.clipId);
  });

  test('remembers when a clip arrived and what task it was about; a blank subject means none', () => {
    const before = Date.now();
    const withSubject = captureLastClip({ clipId: 'a', text: 'a', subject: '  UI refactor ', audio: bytes(1) });
    expect(withSubject.subject).toBe('UI refactor');
    expect(withSubject.at).toBeGreaterThanOrEqual(before);
    expect(withSubject.at).toBeLessThanOrEqual(Date.now());
    for (const subject of [undefined, null, '', '   ']) {
      const clip = captureLastClip({ clipId: 'b', text: 'b', subject, audio: bytes(1) });
      expect(clip.subject).toBeUndefined();
      expect('subject' in clip).toBe(false);
    }
  });

  test('keeps the newest clips first and at most MAX_CLIP_HISTORY of them; older ones are dropped with their audio', () => {
    expect(MAX_CLIP_HISTORY).toBe(3);
    for (const id of ['one', 'two', 'three', 'four']) captureLastClip({ clipId: id, text: id, audio: bytes(1) });
    expect(getClipHistory().map((c) => c.clipId)).toEqual(['four', 'three', 'two']);
    expect(getLastClip()?.clipId).toBe('four');
    expect(getClip('one')).toBeNull();
    expect(getLastClipSnapshot()).toEqual({ hasClip: true, unheard: true, unheardCount: 3 });
  });

  test('a new clip starts unheard even after earlier ones were heard', () => {
    captureLastClip({ clipId: 'one', text: 'first', audio: bytes(1) });
    markClipHeard('one');
    expect(getLastClipSnapshot()).toEqual({ hasClip: true, unheard: false, unheardCount: 0 });

    captureLastClip({ clipId: 'two', text: 'second', audio: bytes(2) });
    expect(getLastClip()?.clipId).toBe('two');
    expect(getLastClipSnapshot()).toEqual({ hasClip: true, unheard: true, unheardCount: 1 });
  });

  test('capturing an id that is already remembered replaces it instead of listing it twice', () => {
    captureLastClip({ clipId: 'one', text: 'first', audio: bytes(1) });
    captureLastClip({ clipId: 'two', text: 'second', audio: bytes(2) });
    captureLastClip({ clipId: 'one', text: 'first again', audio: bytes(3) });
    expect(getClipHistory().map((c) => [c.clipId, c.text])).toEqual([['one', 'first again'], ['two', 'second']]);
  });

  test('any remembered clip can be marked heard, and only that one', () => {
    captureLastClip({ clipId: 'one', text: 'first', audio: bytes(1) });
    captureLastClip({ clipId: 'two', text: 'second', audio: bytes(2) });
    captureLastClip({ clipId: 'three', text: 'third', audio: bytes(3) });
    markClipHeard('one');
    expect(getClip('one')?.heard).toBe(true);
    expect(getClip('two')?.heard).toBe(false);
    expect(getLastClip()?.heard).toBe(false);
    expect(getLastClipSnapshot()).toEqual({ hasClip: true, unheard: true, unheardCount: 2 });
    markClipHeard('two');
    markClipHeard('three');
    expect(getLastClipSnapshot()).toEqual({ hasClip: true, unheard: false, unheardCount: 0 });
  });

  test('marking a clip that fell off the history heard is ignored', () => {
    for (const id of ['one', 'two', 'three', 'four']) captureLastClip({ clipId: id, text: id, audio: bytes(1) });
    const listener = vi.fn();
    subscribeLastClip(listener);
    markClipHeard('one');
    expect(listener).not.toHaveBeenCalled();
    expect(getLastClipSnapshot().unheardCount).toBe(3);
  });

  test('discarding removes that clip (any position), and an unknown id changes nothing', () => {
    captureLastClip({ clipId: 'one', text: 'first', audio: bytes(1) });
    captureLastClip({ clipId: 'two', text: 'second', audio: bytes(2) });
    discardLastClip('other');
    expect(getClipHistory().map((c) => c.clipId)).toEqual(['two', 'one']);
    discardLastClip('one');
    expect(getClipHistory().map((c) => c.clipId)).toEqual(['two']);
    discardLastClip('two');
    expect(getLastClip()).toBeNull();
    expect(getLastClipSnapshot().hasClip).toBe(false);
    expect(getClipHistory()).toEqual([]);
  });

  test('discarding an unheard clip among several drops the unheard count by one and keeps the others', () => {
    captureLastClip({ clipId: 'one', text: 'first', audio: bytes(1) });
    captureLastClip({ clipId: 'two', text: 'second', audio: bytes(2) });
    captureLastClip({ clipId: 'three', text: 'third', audio: bytes(3) });
    markClipHeard('three');
    expect(getLastClipSnapshot()).toEqual({ hasClip: true, unheard: true, unheardCount: 2 });

    discardLastClip('two'); // unheard, in the middle
    expect(getClipHistory().map((c) => c.clipId)).toEqual(['three', 'one']);
    expect(getLastClipSnapshot()).toEqual({ hasClip: true, unheard: true, unheardCount: 1 });

    discardLastClip('one'); // the last unheard one
    expect(getLastClipSnapshot()).toEqual({ hasClip: true, unheard: false, unheardCount: 0 });
  });

  test('capturing an id that is already there, with the history full, replaces it and evicts no other clip', () => {
    captureLastClip({ clipId: 'one', text: 'first', audio: bytes(1) });
    captureLastClip({ clipId: 'two', text: 'second', audio: bytes(2) });
    captureLastClip({ clipId: 'three', text: 'third', audio: bytes(3) });
    expect(getClipHistory()).toHaveLength(MAX_CLIP_HISTORY);

    captureLastClip({ clipId: 'two', text: 'second, again', audio: bytes(22) });
    expect(getClipHistory().map((c) => c.clipId)).toEqual(['two', 'three', 'one']);
    expect(getClipHistory()[0].text).toBe('second, again');
    expect(new Uint8Array(getClip('two')!.audio)).toEqual(new Uint8Array([22]));
    expect(getClip('one')).not.toBeNull(); // the oldest survives: nothing was pushed off the end
  });

  test('a heard clip that is captured again becomes unheard again', () => {
    captureLastClip({ clipId: 'one', text: 'first', audio: bytes(1) });
    captureLastClip({ clipId: 'two', text: 'second', audio: bytes(2) });
    markClipHeard('one');
    markClipHeard('two');
    expect(getLastClipSnapshot()).toEqual({ hasClip: true, unheard: false, unheardCount: 0 });

    captureLastClip({ clipId: 'one', text: 'first, again', audio: bytes(1) });
    expect(getClip('one')!.heard).toBe(false);
    expect(getClipHistory().map((c) => [c.clipId, c.heard])).toEqual([['one', false], ['two', true]]);
    expect(getLastClipSnapshot()).toEqual({ hasClip: true, unheard: true, unheardCount: 1 });
  });

  test('the history view carries no audio and is a stable, immutable array between changes', () => {
    captureLastClip({ clipId: 'one', text: 'first', subject: 'UI', audio: bytes(1, 2), durationMs: 900 });
    const view = getClipHistory();
    expect(getClipHistory()).toBe(view);
    expect(Object.isFrozen(view)).toBe(true);
    expect(view[0]).toEqual({ clipId: 'one', text: 'first', subject: 'UI', at: expect.any(Number), heard: false });
    expect('audio' in view[0]).toBe(false);

    markClipHeard('one');
    expect(getClipHistory()).not.toBe(view);
    expect(view[0].heard).toBe(false); // the old view is not mutated
  });

  test('the snapshot object is kept when a change does not affect what it reports', () => {
    captureLastClip({ clipId: 'one', text: 'first', audio: bytes(1) });
    markClipHeard('one');
    captureLastClip({ clipId: 'two', text: 'second', audio: bytes(2) });
    markClipHeard('two');
    const snap = getLastClipSnapshot();
    discardLastClip('one'); // heard: the count stays 0
    expect(getLastClipSnapshot()).toBe(snap);
  });

  test('subscribers are notified on change, and the snapshot is stable between changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLastClip(listener);
    captureLastClip({ clipId: 'one', text: 'first', audio: bytes(1) });
    expect(listener).toHaveBeenCalledTimes(1);
    const snap = getLastClipSnapshot();
    expect(getLastClipSnapshot()).toBe(snap);

    markClipHeard('one');
    markClipHeard('one'); // already heard: no change, no notification
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    captureLastClip({ clipId: 'two', text: 'second', audio: bytes(2) });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test('a missing, negative or non-numeric length is stored as 0 (unknown)', () => {
    for (const durationMs of [undefined, -5, Number.NaN, 0]) {
      const clip = captureLastClip({ clipId: 'one', text: 'a', audio: bytes(1), durationMs });
      expect(clip.durationMs).toBe(0);
    }
  });

  test('discarding, or marking heard with a stale id, does not notify listeners', () => {
    captureLastClip({ clipId: 'one', text: 'first', audio: bytes(1) });
    const listener = vi.fn();
    subscribeLastClip(listener);

    markClipHeard('stale');
    discardLastClip('stale');
    expect(listener).not.toHaveBeenCalled();

    discardLastClip('one');
    expect(listener).toHaveBeenCalledTimes(1);
    // The clip is gone: marking it heard afterwards is a no-op.
    markClipHeard('one');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getLastClip()).toBeNull();
    expect(getLastClipSnapshot().hasClip).toBe(false);
  });
});
