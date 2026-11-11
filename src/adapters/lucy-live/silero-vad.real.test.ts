import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadSileroVad, type SileroVad } from './silero-vad.js';

/** Deterministic pseudo-random numbers (mulberry32) so the noise is the same on every run. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pcm(samples: number[]): Buffer {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s))), i * 2));
  return b;
}
const MS = 16; // samples per millisecond
const silence = (ms: number): Buffer => pcm(new Array(ms * MS).fill(0));
const noise = (ms: number, amp: number, seed = 1): Buffer => {
  const r = rng(seed);
  return pcm(Array.from({ length: ms * MS }, () => (r() * 2 - 1) * amp));
};
/** A click: a short decaying burst at the start, silence after. */
const click = (ms: number, total: number): Buffer => {
  const r = rng(7);
  const samples = new Array(total * MS).fill(0);
  for (let i = 0; i < ms * MS; i++) samples[i] = (r() * 2 - 1) * 28000 * (1 - i / (ms * MS));
  return pcm(samples);
};

// Opt-in: point LUCY_LIVE_SPEECH_WAV at a 16 kHz mono PCM16 WAV of someone speaking to also check
// that real speech scores high. No speech recording is committed, so this case skips by default.
const SPEECH_WAV = process.env.LUCY_LIVE_SPEECH_WAV ?? '';

function wavPcm(path: string): Buffer {
  const b = readFileSync(path);
  const at = b.indexOf('data');
  return b.subarray(at + 8, at + 8 + b.readUInt32LE(at + 4));
}

describe('Silero VAD with the real model', () => {
  let vad: SileroVad | null;
  beforeAll(async () => { vad = await loadSileroVad(); });

  async function probs(audio: Buffer): Promise<number[]> {
    return vad!.openTurn().push(audio);
  }
  const max = (p: number[]): number => Math.max(...p);

  it('loads the model that ships in the repo', () => {
    expect(vad).not.toBeNull();
  });

  it('gives low probabilities for silence, a click and bursts of white noise', async () => {
    const results = {
      silence: await probs(silence(500)),
      click: await probs(click(20, 500)),
      noise150: await probs(Buffer.concat([silence(200), noise(150, 20000), silence(200)])),
      noiseLoud: await probs(noise(500, 32000, 3)),
    };
    for (const [name, p] of Object.entries(results)) {
      
      expect(p.length).toBeGreaterThan(0);
      expect(p.filter((x) => x >= 0.5).length).toBeLessThan(3);
    }
  });

  it.skipIf(!SPEECH_WAV || !existsSync(SPEECH_WAV))('gives high probabilities for real speech', async () => {
    const p = await probs(wavPcm(SPEECH_WAV));
    const speechFrames = p.filter((x) => x >= 0.5).length;
    
    expect(speechFrames).toBeGreaterThan(10);
  });
});
