import { describe, expect, it, vi } from 'vitest';
import type { LucyEarsHandle, LucyEarsState } from '../lucy-ears-manager.js';
import { createLucyLiveRuntime } from './runtime.js';

const KEYED = { BASETEN_API_KEY: 'k' };

function fakeEars(initial: LucyEarsState) {
  let state = initial;
  const listeners: Array<(s: LucyEarsState) => void> = [];
  const handle: LucyEarsHandle = {
    getState: () => state,
    onChange: (l) => { listeners.push(l); return () => {}; },
    settled: Promise.resolve(),
    stop: async () => {},
  };
  return { handle, set(next: LucyEarsState) { state = next; listeners.forEach((l) => l(next)); } };
}

const build = () => vi.fn(async (config: { earsUrl: string }) => ({
  service: { handleConnection: vi.fn(), earsUrl: config.earsUrl } as never,
  bargeIn: 'silero' as const,
}));

describe('createLucyLiveRuntime', () => {
  it('external URL: available at once, unchanged behaviour, no ears handle', async () => {
    const b = build();
    const rt = createLucyLiveRuntime({ env: { ...KEYED, KOOKR_LUCY_EARS_URL: 'ws://h:1' }, ttsUrl: 'http://tts', build: b });
    await rt.ready;
    expect(rt.status()).toEqual({ available: true, bargeInConfirmation: 'silero' });
    expect(b).toHaveBeenCalledWith(expect.objectContaining({ earsUrl: 'ws://h:1' }));
    expect(rt.service).toBeDefined();
  });

  it('nothing configured and nothing managed: unavailable, upgrade path stays closed (service undefined)', async () => {
    const rt = createLucyLiveRuntime({ env: {}, ttsUrl: undefined, build: build() });
    await rt.ready;
    expect(rt.status().available).toBe(false);
    expect(rt.status().starting).toBeUndefined();
    expect(rt.service).toBeUndefined();
  });

  it('managed ears still starting: status says starting, not unavailable, and nothing is built', async () => {
    const ears = fakeEars({ phase: 'starting' });
    const b = build();
    const rt = createLucyLiveRuntime({ env: { ...KEYED, KOOKR_LUCY_EARS: 'true' }, ttsUrl: 'http://tts', ears: ears.handle, build: b });
    await rt.ready;
    expect(rt.status()).toMatchObject({ available: false, starting: true });
    expect(rt.status().reason).toContain('starting');
    expect(b).not.toHaveBeenCalled();
  });

  it('switches on by itself when the managed ears become ready, using the managed URL', async () => {
    const ears = fakeEars({ phase: 'starting' });
    const b = build();
    const rt = createLucyLiveRuntime({ env: { ...KEYED, KOOKR_LUCY_EARS: 'true' }, ttsUrl: 'http://tts', ears: ears.handle, build: b });
    await rt.ready;
    ears.set({ phase: 'ready', url: 'ws://127.0.0.1:8095' });
    await vi.waitFor(() => expect(rt.status().available).toBe(true));
    expect(rt.status()).toEqual({ available: true, bargeInConfirmation: 'silero' });
    expect(b).toHaveBeenCalledWith(expect.objectContaining({ earsUrl: 'ws://127.0.0.1:8095' }));
  });

  it('managed ears ready but another piece missing: names that piece, not the recogniser', async () => {
    const ears = fakeEars({ phase: 'ready', url: 'ws://127.0.0.1:8095' });
    const rt = createLucyLiveRuntime({ env: { KOOKR_LUCY_EARS: 'true' }, ttsUrl: 'http://tts', ears: ears.handle, build: build() });
    await rt.ready;
    expect(rt.status().available).toBe(false);
    expect(rt.status().reason).toContain('helper model');
    expect(rt.status().reason).not.toContain('recogniser');
  });

  it('no GPU: the status carries the manager\'s reason and is not "starting"', async () => {
    const ears = fakeEars({ phase: 'unavailable', reason: 'needs an NVIDIA GPU' });
    const b = build();
    const rt = createLucyLiveRuntime({ env: { ...KEYED }, ttsUrl: 'http://tts', ears: ears.handle, build: b });
    await rt.ready;
    expect(rt.status()).toEqual({ available: false, reason: 'needs an NVIDIA GPU' });
    expect(b).not.toHaveBeenCalled();
  });

  it('a managed run that fails after starting turns the status off and closes new sockets', async () => {
    const ears = fakeEars({ phase: 'ready', url: 'ws://127.0.0.1:8095' });
    const rt = createLucyLiveRuntime({ env: { ...KEYED }, ttsUrl: 'http://tts', ears: ears.handle, build: build() });
    await rt.ready;
    ears.set({ phase: 'unavailable', reason: 'gone' });
    await vi.waitFor(() => expect(rt.status().available).toBe(false));
    const ws = { close: vi.fn() };
    rt.service!.handleConnection(ws as never, {} as never);
    expect(ws.close).toHaveBeenCalledWith(1013, expect.any(String));
  });

  it('closes a socket that arrives while ears are starting, and hands it to the service once ready', async () => {
    const ears = fakeEars({ phase: 'starting' });
    const rt = createLucyLiveRuntime({ env: { ...KEYED }, ttsUrl: 'http://tts', ears: ears.handle, build: build() });
    await rt.ready;
    const early = { close: vi.fn() };
    rt.service!.handleConnection(early as never, {} as never);
    expect(early.close).toHaveBeenCalled();
    ears.set({ phase: 'ready', url: 'ws://127.0.0.1:8095' });
    await vi.waitFor(() => expect(rt.status().available).toBe(true));
    const ws = { close: vi.fn() };
    rt.service!.handleConnection(ws as never, {} as never);
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('a build failure is reported, not thrown', async () => {
    const warn = vi.fn();
    const rt = createLucyLiveRuntime({
      env: { ...KEYED, KOOKR_LUCY_EARS_URL: 'ws://h:1' }, ttsUrl: 'http://tts', warn,
      build: async () => { throw new Error('vad exploded'); },
    });
    await rt.ready;
    expect(rt.status().reason).toContain('vad exploded');
    expect(warn).toHaveBeenCalled();
  });
});
