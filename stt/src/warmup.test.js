/**
 * Tests for warmupTranscriptionBackend — retry and timeout behavior.
 *
 * The warmup path is on the server startup critical path, so we cover:
 *   - succeeds on first attempt when backend is already hot
 *   - retries on transient errors and eventually succeeds
 *   - gives up when the deadline is reached and returns ok=false
 *   - passes a 1-second buffer of silence at the 16kHz sample rate
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { warmupTranscriptionBackend } from './warmup.js';

describe('warmupTranscriptionBackend', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('succeeds on first attempt when backend is ready', async () => {
    const transcribe = vi.fn().mockResolvedValue({ text: '' });
    const backend = { name: 'whisper', transcribe };

    const result = await warmupTranscriptionBackend(backend, {
      timeoutMs: 5_000,
      retryDelayMs: 10,
      sleep: () => Promise.resolve(),
    });

    expect(result).toEqual({ ok: true, attempts: 1 });
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  test('passes 1 second of silence at 16kHz to the backend', async () => {
    const transcribe = vi.fn().mockResolvedValue({ text: '' });
    const backend = { name: 'whisper', transcribe };

    await warmupTranscriptionBackend(backend, {
      timeoutMs: 5_000,
      retryDelayMs: 10,
      sleep: () => Promise.resolve(),
    });

    const audio = transcribe.mock.calls[0][0];
    expect(audio).toBeInstanceOf(Float32Array);
    expect(audio.length).toBe(16000);
    expect(audio.every((sample) => sample === 0)).toBe(true);
  });

  test('retries on transient errors and eventually succeeds', async () => {
    const transcribe = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValueOnce({ text: '' });
    const backend = { name: 'whisper', transcribe };
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await warmupTranscriptionBackend(backend, {
      timeoutMs: 60_000,
      retryDelayMs: 50,
      sleep,
    });

    expect(result).toEqual({ ok: true, attempts: 3 });
    expect(transcribe).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(50);
  });

  test('returns ok=false after exactly the expected attempts when the deadline is reached', async () => {
    const transcribe = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const backend = { name: 'whisper', transcribe };

    // Clock driven by sleep: each sleep(ms) advances the virtual clock by ms.
    // This binds the deadline to retry cadence rather than to the number of
    // times the implementation happens to call now() for logging, so the test
    // cannot silently change behavior if a log line is added or removed.
    let clock = 0;
    const sleep = (ms) => {
      clock += ms;
      return Promise.resolve();
    };
    const now = () => clock;

    const result = await warmupTranscriptionBackend(backend, {
      timeoutMs: 100,
      retryDelayMs: 50,
      sleep,
      now,
    });

    // deadline = 0 + 100 = 100
    // attempt 1: now=0 < 100, reject, sleep(50) -> clock=50
    // attempt 2: now=50 < 100, reject, sleep(50) -> clock=100
    // loop guard: now=100 < 100 = false -> exit
    expect(result).toEqual({ ok: false, attempts: 2 });
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  test('returns ok=false without attempting when timeoutMs is 0', async () => {
    const transcribe = vi.fn().mockResolvedValue({ text: '' });
    const backend = { name: 'whisper', transcribe };

    const result = await warmupTranscriptionBackend(backend, {
      timeoutMs: 0,
      retryDelayMs: 10,
      sleep: () => Promise.resolve(),
    });

    expect(result).toEqual({ ok: false, attempts: 0 });
    expect(transcribe).not.toHaveBeenCalled();
  });

  test('does not throw when backend.transcribe throws non-Error values', async () => {
    const transcribe = vi
      .fn()
      .mockRejectedValueOnce('string error')
      .mockResolvedValueOnce({ text: '' });
    const backend = { name: 'whisper', transcribe };

    const result = await warmupTranscriptionBackend(backend, {
      timeoutMs: 5_000,
      retryDelayMs: 10,
      sleep: () => Promise.resolve(),
    });

    expect(result).toEqual({ ok: true, attempts: 2 });
  });
});
