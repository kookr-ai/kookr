import { afterEach, describe, expect, test, vi } from 'vitest';
import { CircuitBreaker } from '../core/circuit-breaker.js';
import { probeSttHealth } from './circuit-breaker-stt-client.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function makeBreaker(threshold = 1): CircuitBreaker {
  return new CircuitBreaker({
    name: 'stt',
    failureThreshold: threshold,
    failureWindowMs: 60_000,
    resetTimeoutMs: 60_000,
  });
}

describe('probeSttHealth', () => {
  test('returns parsed health body on success without a breaker', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ status: 'ok', backend: 'whisper' }), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(
      probeSttHealth({ sttUrl: 'ws://localhost:8003', fetchImpl }),
    ).resolves.toEqual({ status: 'ok', backend: 'whisper' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:8003/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  test('degrades to unavailable on network failure without a breaker', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    await expect(
      probeSttHealth({ sttUrl: 'ws://localhost:8003', fetchImpl }),
    ).resolves.toEqual({ status: 'unavailable' });
  });

  test('provider failures trip the breaker then open degrades without calling fetch', async () => {
    const breaker = makeBreaker(1);
    const failFetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    await expect(
      probeSttHealth({ sttUrl: 'ws://localhost:8003', breaker, fetchImpl: failFetch }),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(breaker.getState()).toBe('open');

    const laterFetch = vi.fn(async () =>
      new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(
      probeSttHealth({ sttUrl: 'ws://localhost:8003', breaker, fetchImpl: laterFetch }),
    ).resolves.toEqual({ status: 'unavailable', reason: 'circuit_open' });
    expect(laterFetch).not.toHaveBeenCalled();
    expect(breaker.getSnapshot().rejectedCalls).toBeGreaterThanOrEqual(1);
  });

  test('closed breaker records success and returns health body', async () => {
    const breaker = makeBreaker(5);
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(
      probeSttHealth({ sttUrl: 'wss://stt.example/ws', breaker, fetchImpl }),
    ).resolves.toEqual({ status: 'ok' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://stt.example/ws/health',
      expect.anything(),
    );
    expect(breaker.getState()).toBe('closed');
  });
});
