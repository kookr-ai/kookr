import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  __resetSpeechBusForTests,
  emitSpeechGenerating,
  emitSpeechIdle,
  emitSpeechPlaying,
  subscribeSpeechBus,
  type SpeechBusEvent,
} from './speech-bus.js';

function fakeAudio() {
  const analyser = { fftSize: 0, smoothingTimeConstant: 0 } as unknown as AnalyserNode;
  const ctx = { createAnalyser: vi.fn(() => analyser) };
  const source = { connect: vi.fn() };
  return { analyser, ctx, source: source as unknown as AudioNode & { connect: ReturnType<typeof vi.fn> } };
}

describe('speech-bus', () => {
  // Stand-ins for two speaker buttons.
  const a = { name: 'button A' };
  const b = { name: 'button B' };

  beforeEach(() => {
    __resetSpeechBusForTests();
  });

  test('with nobody listening, a playing clip creates no audio node at all', () => {
    const { ctx, source } = fakeAudio();
    emitSpeechPlaying(a, ctx, source);
    expect(ctx.createAnalyser).not.toHaveBeenCalled();
    expect(source.connect).not.toHaveBeenCalled();
  });

  test('a listener gets a tap on the clip', () => {
    const { analyser, ctx, source } = fakeAudio();
    const events: SpeechBusEvent[] = [];
    subscribeSpeechBus((e) => events.push(e));
    emitSpeechGenerating(a);
    emitSpeechPlaying(a, ctx, source);
    emitSpeechIdle(a);
    expect(events.map((e) => e.type)).toEqual(['idle', 'generating', 'playing', 'idle']);
    expect(events[2]).toEqual({ type: 'playing', analyser });
    // The tap is attached to the source but never to the speakers.
    expect(source.connect).toHaveBeenCalledTimes(1);
    expect(source.connect).toHaveBeenCalledWith(analyser);
  });

  test('a new subscriber is told the current state straight away', () => {
    emitSpeechGenerating(a);
    const seen: string[] = [];
    subscribeSpeechBus((e) => seen.push(e.type));
    expect(seen).toEqual(['generating']);
  });

  test('repeated generating or idle announcements are not re-sent', () => {
    const seen: string[] = [];
    subscribeSpeechBus((e) => seen.push(e.type));
    emitSpeechIdle(a);
    emitSpeechGenerating(a);
    emitSpeechGenerating(a);
    emitSpeechIdle(a);
    emitSpeechIdle(a);
    expect(seen).toEqual(['idle', 'generating', 'idle']);
  });

  test('only the button that is speaking can announce the end', () => {
    const { ctx, source } = fakeAudio();
    const seen: string[] = [];
    subscribeSpeechBus((e) => seen.push(e.type));

    emitSpeechPlaying(b, ctx, source);
    // A was never speaking; it being stopped or removed must not silence B's clip on the avatar.
    emitSpeechIdle(a);
    expect(seen).toEqual(['idle', 'playing']);

    emitSpeechIdle(b);
    expect(seen).toEqual(['idle', 'playing', 'idle']);
  });

  test('when a second button takes over, the first one ending later is ignored', () => {
    const { ctx, source } = fakeAudio();
    const seen: string[] = [];
    subscribeSpeechBus((e) => seen.push(e.type));

    emitSpeechPlaying(a, ctx, source);
    emitSpeechGenerating(b);
    emitSpeechIdle(a);
    expect(seen).toEqual(['idle', 'playing', 'generating']);

    emitSpeechPlaying(b, ctx, source);
    emitSpeechIdle(b);
    expect(seen).toEqual(['idle', 'playing', 'generating', 'playing', 'idle']);
  });

  test('unsubscribing stops delivery, and the next clip creates no audio node', () => {
    const { ctx, source } = fakeAudio();
    const seen: string[] = [];
    const off = subscribeSpeechBus((e) => seen.push(e.type));
    off();
    emitSpeechGenerating(a);
    emitSpeechPlaying(a, ctx, source);
    expect(seen).toEqual(['idle']);
    expect(ctx.createAnalyser).not.toHaveBeenCalled();
  });

  test('a listener that throws does not stop the others or the caller', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: string[] = [];
    let armed = false;
    subscribeSpeechBus(() => { if (armed) throw new Error('boom'); });
    subscribeSpeechBus((e) => seen.push(e.type));
    armed = true;
    expect(() => emitSpeechGenerating(a)).not.toThrow();
    expect(seen).toEqual(['idle', 'generating']);
    warn.mockRestore();
  });

  test('if the tap cannot be created the clip is still announced, without one', () => {
    const ctx = { createAnalyser: vi.fn(() => { throw new Error('closed'); }) };
    const { source } = fakeAudio();
    const events: SpeechBusEvent[] = [];
    subscribeSpeechBus((e) => events.push(e));
    emitSpeechPlaying(a, ctx, source);
    expect(events[1]).toEqual({ type: 'playing', analyser: null });
  });
});
