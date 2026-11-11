import { describe, expect, it } from 'vitest';
import { lucyLiveStatusOf, resolveLucyLiveConfig } from './config.js';

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
