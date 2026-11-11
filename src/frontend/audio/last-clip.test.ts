import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  __resetLastClipForTests,
  captureLastClip,
  discardLastClip,
  getLastClip,
  getLastClipSnapshot,
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
    expect(getLastClipSnapshot()).toEqual({ hasClip: false, unheard: false });
  });

  test('captures a clip as unheard, keeping its bytes, text and server clip id', () => {
    const clip = captureLastClip({ clipId: 'srv-1', text: 'Two tasks need you.', audio: bytes(1, 2, 3), durationMs: 2400 });
    expect(clip).toMatchObject({ clipId: 'srv-1', text: 'Two tasks need you.', durationMs: 2400, heard: false });
    expect(new Uint8Array(clip.audio)).toEqual(new Uint8Array([1, 2, 3]));
    expect(getLastClipSnapshot()).toEqual({ hasClip: true, unheard: true });
  });

  test('falls back to a locally generated id when the server sent none', () => {
    const a = captureLastClip({ text: 'a', audio: bytes(1) });
    const b = captureLastClip({ clipId: '', text: 'b', audio: bytes(1) });
    expect(a.clipId).toMatch(/^local-/);
    expect(b.clipId).toMatch(/^local-/);
    expect(a.clipId).not.toBe(b.clipId);
  });

  test('only the latest clip is kept; a new one starts unheard even after the old one was heard', () => {
    captureLastClip({ clipId: 'one', text: 'first', audio: bytes(1) });
    markClipHeard('one');
    expect(getLastClipSnapshot()).toEqual({ hasClip: true, unheard: false });

    captureLastClip({ clipId: 'two', text: 'second', audio: bytes(2) });
    expect(getLastClip()?.clipId).toBe('two');
    expect(getLastClipSnapshot()).toEqual({ hasClip: true, unheard: true });
  });

  test('marking an older clip heard does not touch the latest one', () => {
    captureLastClip({ clipId: 'one', text: 'first', audio: bytes(1) });
    captureLastClip({ clipId: 'two', text: 'second', audio: bytes(2) });
    markClipHeard('one');
    expect(getLastClip()?.heard).toBe(false);
  });

  test('discarding removes the clip, but only when the id matches', () => {
    captureLastClip({ clipId: 'one', text: 'first', audio: bytes(1) });
    discardLastClip('other');
    expect(getLastClip()?.clipId).toBe('one');
    discardLastClip('one');
    expect(getLastClip()).toBeNull();
    expect(getLastClipSnapshot().hasClip).toBe(false);
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
