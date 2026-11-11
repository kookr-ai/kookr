import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  __resetSpeechBusForTests,
  emitSpeechGenerating,
  emitSpeechIdle,
  emitSpeechPlaying,
  hasSpeechBusListeners,
  subscribeSpeechBus,
  type SpeechBusEvent,
} from './speech-bus.js';

function fakeAudio() {
  const analyser = { fftSize: 0, smoothingTimeConstant: 0 } as unknown as AnalyserNode;
  const ctx = { createAnalyser: vi.fn(() => analyser) };
  const source = { connect: vi.fn() };
  return { analyser, ctx, source };
}

describe('speech-bus', () => {
  beforeEach(() => {
    __resetSpeechBusForTests();
  });

  test('with nobody listening, a playing clip creates no audio node at all', () => {
    const { ctx, source } = fakeAudio();
    expect(hasSpeechBusListeners()).toBe(false);
    emitSpeechPlaying(ctx, source as unknown as AudioNode, { text: 'hello' });
    expect(ctx.createAnalyser).not.toHaveBeenCalled();
    expect(source.connect).not.toHaveBeenCalled();
  });

  test('a listener gets a tap on the clip, its text and its length', () => {
    const { analyser, ctx, source } = fakeAudio();
    const events: SpeechBusEvent[] = [];
    subscribeSpeechBus((e) => events.push(e));
    emitSpeechGenerating();
    emitSpeechPlaying(ctx, source as unknown as AudioNode, { text: 'Two tasks need you.', durationMs: 2400 });
    emitSpeechIdle();
    expect(events.map((e) => e.type)).toEqual(['idle', 'generating', 'playing', 'idle']);
    expect(events[2]).toEqual({ type: 'playing', analyser, text: 'Two tasks need you.', durationMs: 2400 });
    // The tap is attached to the source but never to the speakers.
    expect(source.connect).toHaveBeenCalledTimes(1);
    expect(source.connect).toHaveBeenCalledWith(analyser);
  });

  test('a new subscriber is told the current state straight away', () => {
    emitSpeechGenerating();
    const seen: string[] = [];
    subscribeSpeechBus((e) => seen.push(e.type));
    expect(seen).toEqual(['generating']);
  });

  test('repeated generating or idle announcements are not re-sent', () => {
    const seen: string[] = [];
    subscribeSpeechBus((e) => seen.push(e.type));
    emitSpeechIdle();
    emitSpeechGenerating();
    emitSpeechGenerating();
    emitSpeechIdle();
    emitSpeechIdle();
    expect(seen).toEqual(['idle', 'generating', 'idle']);
  });

  test('unsubscribing stops delivery', () => {
    const seen: string[] = [];
    const off = subscribeSpeechBus((e) => seen.push(e.type));
    off();
    emitSpeechGenerating();
    expect(seen).toEqual(['idle']);
    expect(hasSpeechBusListeners()).toBe(false);
  });

  test('a listener that throws does not stop the others or the caller', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: string[] = [];
    let armed = false;
    subscribeSpeechBus(() => { if (armed) throw new Error('boom'); });
    subscribeSpeechBus((e) => seen.push(e.type));
    armed = true;
    expect(() => emitSpeechGenerating()).not.toThrow();
    expect(seen).toEqual(['idle', 'generating']);
    warn.mockRestore();
  });

  test('if the tap cannot be created the clip is still announced, without one', () => {
    const ctx = { createAnalyser: vi.fn(() => { throw new Error('closed'); }) };
    const source = { connect: vi.fn() };
    const events: SpeechBusEvent[] = [];
    subscribeSpeechBus((e) => events.push(e));
    emitSpeechPlaying(ctx, source as unknown as AudioNode);
    expect(events[1]).toEqual({ type: 'playing', analyser: null, text: null, durationMs: null });
  });
});
