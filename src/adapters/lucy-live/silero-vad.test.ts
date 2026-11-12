import { describe, expect, it, vi } from 'vitest';
import { createSileroVad, loadSileroVad, SILERO_FRAME_SAMPLES, type OrtLike, type OrtSessionLike } from './silero-vad.js';

class FakeTensor {
  constructor(public type: string, public data: Float32Array | BigInt64Array, public dims?: readonly number[]) {}
}

/** A session whose probability for a frame is its first sample (scaled back from PCM16), so tests can tell frames apart. */
function fakeSession() {
  const calls: Array<{ first: number; len: number; state: unknown; sr: unknown }> = [];
  let counter = 0;
  const session: OrtSessionLike = {
    run: async (feeds) => {
      const input = feeds.input as FakeTensor;
      calls.push({ first: (input.data as Float32Array)[0], len: input.data.length, state: feeds.state, sr: feeds.sr });
      counter += 1;
      return { output: { data: [Math.round((input.data as Float32Array)[0] * 32768) / 1000] }, stateN: { generation: counter } };
    },
  };
  return { session, calls };
}
const ort = { Tensor: FakeTensor, InferenceSession: { create: vi.fn() } } as unknown as OrtLike;

/** `frames` frames of PCM16 where frame k holds the constant value `values[k]`. */
function pcm(values: number[], extraSamples = 0): Buffer {
  const b = Buffer.alloc((values.length * SILERO_FRAME_SAMPLES + extraSamples) * 2);
  values.forEach((v, f) => { for (let i = 0; i < SILERO_FRAME_SAMPLES; i++) b.writeInt16LE(v, (f * SILERO_FRAME_SAMPLES + i) * 2); });
  for (let i = 0; i < extraSamples; i++) b.writeInt16LE(77, (values.length * SILERO_FRAME_SAMPLES + i) * 2);
  return b;
}

describe('createSileroVad', () => {
  it('returns one probability per complete 512-sample frame and nothing for a partial one', async () => {
    const { session, calls } = fakeSession();
    const turn = createSileroVad(ort, session).openTurn();
    expect(await turn.push(pcm([], 100))).toEqual([]);
    expect(calls).toHaveLength(0);
    // 100 carried samples (value 77) + 1024 new ones = two frames, 100 samples left over.
    expect((await turn.push(pcm([1000, 2000]))).length).toBe(2);
    expect(calls.map((c) => c.len)).toEqual([512, 512]);
    expect(Math.round(calls[0].first * 32768)).toBe(77);
    expect(await turn.push(pcm([], 412))).toHaveLength(1);
  });

  it('carries the remainder across pushes, including a split sample (odd byte count)', async () => {
    const { session, calls } = fakeSession();
    const turn = createSileroVad(ort, session).openTurn();
    const whole = pcm([3000, 4000]);
    expect(await turn.push(whole.subarray(0, 1025))).toEqual([3]); // one frame + 1 byte of the next
    expect(await turn.push(whole.subarray(1025, 1500))).toEqual([]);
    expect(await turn.push(whole.subarray(1500))).toEqual([4]);
    expect(calls.map((c) => Math.round(c.first * 32768))).toEqual([3000, 4000]);
  });

  it('scales PCM16 to floats in [-1, 1) and passes the sample rate as int64 16000', async () => {
    const { session, calls } = fakeSession();
    await createSileroVad(ort, session).openTurn().push(pcm([-32768]));
    expect(calls[0].first).toBe(-1);
    const sr = calls[0].sr as FakeTensor;
    expect(sr.type).toBe('int64');
    expect(Array.from(sr.data as BigInt64Array)).toEqual([16000n]);
  });

  it('threads the recurrent state from one frame to the next, and starts each turn from zeros', async () => {
    const { session, calls } = fakeSession();
    const vad = createSileroVad(ort, session);
    const a = vad.openTurn();
    await a.push(pcm([1, 1]));
    await a.push(pcm([1]));
    expect((calls[0].state as FakeTensor).type).toBe('float32');
    expect(Array.from((calls[0].state as FakeTensor).data as Float32Array).every((x) => x === 0)).toBe(true);
    expect(calls[1].state).toEqual({ generation: 1 });
    expect(calls[2].state).toEqual({ generation: 2 });
    const b = vad.openTurn();
    await b.push(pcm([1]));
    expect(Array.from((calls[3].state as FakeTensor).data as Float32Array).every((x) => x === 0)).toBe(true);
  });

  it('processes pushes in order even when inference is slow, and survives a failed push', async () => {
    const order: number[] = [];
    let failNext = false;
    const session: OrtSessionLike = {
      run: async (feeds) => {
        const first = Math.round((feeds.input as FakeTensor).data[0] as number * 32768);
        await new Promise((r) => setTimeout(r, first === 100 ? 20 : 0));
        if (failNext) { failNext = false; throw new Error('boom'); }
        order.push(first);
        return { output: { data: [0.5] }, stateN: {} };
      },
    };
    const turn = createSileroVad(ort, session).openTurn();
    const slow = turn.push(pcm([100]));
    const fast = turn.push(pcm([200]));
    await Promise.all([slow, fast]);
    expect(order).toEqual([100, 200]);
    failNext = true;
    await expect(turn.push(pcm([300]))).rejects.toThrow('boom');
    await expect(turn.push(pcm([400]))).resolves.toEqual([0.5]);
  });
});

describe('loadSileroVad', () => {
  it('fails soft with one warning when the model file is missing', async () => {
    const warn = vi.fn();
    expect(await loadSileroVad({ modelPath: '/nonexistent/silero.onnx', loadOrt: async () => ort, warn })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('Silero');
  });

  it('fails soft when the runtime cannot be loaded', async () => {
    const warn = vi.fn();
    const result = await loadSileroVad({ loadOrt: async () => { throw new Error('no wasm'); }, warn });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('no wasm');
  });

  it('fails soft when the session cannot be created', async () => {
    const warn = vi.fn();
    const bad = { ...ort, InferenceSession: { create: async () => { throw new Error('bad model'); } } } as unknown as OrtLike;
    expect(await loadSileroVad({ loadOrt: async () => bad, warn })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
