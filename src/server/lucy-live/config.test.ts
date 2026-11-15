import { describe, expect, it } from 'vitest';
import { earsUrlWarning, lucyLiveStatusOf, resolveLucyLiveConfig } from './config.js';

describe('resolveLucyLiveConfig', () => {
  it('is available when ears, key and tts are all set', () => {
    const r = resolveLucyLiveConfig({ KOOKR_LUCY_EARS_URL: 'ws://x:1', BASETEN_API_KEY: 'k' }, 'http://tts');
    expect(r.ok).toBe(true);
    expect(lucyLiveStatusOf(r)).toEqual({ available: true });
  });

  it('names every missing piece', () => {
    const r = resolveLucyLiveConfig({}, undefined);
    expect(r.ok).toBe(false);
    const reason = lucyLiveStatusOf(r).reason ?? '';
    expect(reason).toContain('KOOKR_LUCY_EARS_URL');
    expect(reason).toContain('KOOKR_BASETEN_API_KEY');
    expect(reason).toContain('KOOKR_TTS');
  });

  it('names only what is missing', () => {
    const reason = lucyLiveStatusOf(resolveLucyLiveConfig({ KOOKR_LUCY_EARS_URL: 'ws://x', BASETEN_API_KEY: 'k' }, undefined)).reason ?? '';
    expect(reason).toContain('speech service');
    expect(reason).not.toContain('recogniser');
  });
});

describe('lucyLiveStatusOf barge-in confirmation', () => {
  it('reports how interruptions are decided, and stays available either way', () => {
    const ok = { ok: true, config: {} } as Parameters<typeof lucyLiveStatusOf>[0];
    expect(lucyLiveStatusOf(ok, 'silero')).toEqual({ available: true, bargeInConfirmation: 'silero' });
    expect(lucyLiveStatusOf(ok, 'off')).toEqual({ available: true, bargeInConfirmation: 'off' });
    expect(lucyLiveStatusOf(ok)).toEqual({ available: true });
    expect(lucyLiveStatusOf({ ok: false, reason: 'no' }, 'silero')).toEqual({ available: false, reason: 'no' });
  });
});

describe('earsUrlWarning (#3666)', () => {
  it('is silent for a recogniser on this machine', () => {
    for (const url of ['ws://127.0.0.1:8095', 'ws://localhost:8095', 'WS://LOCALHOST:8095', 'wss://127.10.0.3', 'ws://[::1]:8095']) {
      expect(earsUrlWarning(url), url).toBeUndefined();
    }
  });

  it('warns, naming the host, when the audio would leave this machine', () => {
    for (const [url, host] of [['ws://192.168.1.20:8095', '192.168.1.20'], ['ws://gpu-box:8095', 'gpu-box'], ['wss://[fd00::1]:8095', '[fd00::1]'], ['ws://localhost.example.com', 'localhost.example.com']]) {
      const warning = earsUrlWarning(url);
      expect(warning, url).toContain(host);
      expect(warning).toContain('KOOKR_LUCY_EARS_URL');
    }
  });

  it('warns without throwing when the URL cannot be read', () => {
    expect(earsUrlWarning('not a url')).toContain('KOOKR_LUCY_EARS_URL');
  });

  it('does not change whether Lucy live is available', () => {
    expect(resolveLucyLiveConfig({ KOOKR_LUCY_EARS_URL: 'ws://gpu-box:8095', BASETEN_API_KEY: 'k' }, 'http://tts').ok).toBe(true);
  });
});
