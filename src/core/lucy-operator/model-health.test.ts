import { describe, expect, test } from 'vitest';
import { LUCY_BREAKER_OPEN_MS, createLucyModelHealth } from './model-health.js';
import { LucyModelError, type LucyModelEvent, type LucyModelPort, type LucyModelRequest } from './model-port.js';

const REQUEST: LucyModelRequest = { messages: [{ role: 'user', content: 'hi' }], tools: [], maxOutputTokens: 100 };
const FINISH: LucyModelEvent = { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, costUsd: null } };
const RATE_LIMITED = () => new LucyModelError('provider', 'log', 429, { providerName: 'Sail Research', status: 429 });

async function call(port: LucyModelPort): Promise<'ok' | LucyModelError> {
  try {
    for await (const event of port(REQUEST)) void event;
    return 'ok';
  } catch (err) {
    return err as LucyModelError;
  }
}

function setup() {
  let clock = 1_000_000;
  const health = createLucyModelHealth(() => clock);
  const calls = { n: 0 };
  let next: 'ok' | LucyModelError = 'ok';
  const port = health.guard(async function* () {
    calls.n += 1;
    if (next !== 'ok') throw next;
    yield FINISH;
  });
  return { health, port, calls, set: (v: 'ok' | LucyModelError) => { next = v; }, advance: (ms: number) => { clock += ms; } };
}

describe('the Lucy model circuit breaker', () => {
  test('opens after two failures in a row, refuses calls without reaching the provider, and says why', async () => {
    const s = setup();
    s.set(RATE_LIMITED());
    expect(await call(s.port)).toMatchObject({ kind: 'provider' });
    expect(s.health.snapshot().breakerOpen).toBe(false);
    expect(await call(s.port)).toMatchObject({ kind: 'provider' });
    expect(s.health.snapshot().breakerOpen).toBe(true);
    expect(s.calls.n).toBe(2);

    const refused = await call(s.port);
    expect(refused).toMatchObject({ kind: 'unavailable', detail: { providerName: 'Sail Research', status: 429 } });
    expect(s.calls.n).toBe(2); // not called
  });

  test('stays open for a minute, then lets one call through; a success closes it, a failure reopens it', async () => {
    const s = setup();
    s.set(RATE_LIMITED());
    await call(s.port);
    await call(s.port);
    s.advance(LUCY_BREAKER_OPEN_MS - 1);
    expect(await call(s.port)).toMatchObject({ kind: 'unavailable' });

    s.advance(1);
    expect(s.health.snapshot().breakerOpen).toBe(false);
    expect(await call(s.port)).toMatchObject({ kind: 'provider' }); // the trial call fails: open again
    expect(s.health.snapshot().breakerOpen).toBe(true);

    s.advance(LUCY_BREAKER_OPEN_MS);
    s.set('ok');
    expect(await call(s.port)).toBe('ok');
    expect(s.health.snapshot().breakerOpen).toBe(false);
    expect(await call(s.port)).toBe('ok');
  });

  test('a success between two failures keeps it closed; a cancelled call counts for nothing', async () => {
    const s = setup();
    s.set(RATE_LIMITED());
    await call(s.port);
    s.set('ok');
    await call(s.port);
    s.set(RATE_LIMITED());
    await call(s.port);
    expect(s.health.snapshot().breakerOpen).toBe(false);

    s.set(new LucyModelError('aborted', 'caller left'));
    await call(s.port);
    await call(s.port);
    expect(s.health.snapshot().breakerOpen).toBe(false);
  });

  test('a failure the turn recorded itself (first token deadline) counts toward opening it', () => {
    const s = setup();
    const deadline = new LucyModelError('timeout', 'x', undefined, { firstTokenAfterMs: 8000 });
    s.health.recordFailure(deadline);
    s.health.recordFailure(deadline);
    expect(s.health.snapshot().breakerOpen).toBe(true);
  });

  test('the snapshot gives times and the safe sentence of the last failure', async () => {
    const s = setup();
    expect(s.health.snapshot()).toEqual({ lastSuccessAt: null, lastFailureAt: null, lastFailure: null, breakerOpen: false });
    await call(s.port);
    s.set(RATE_LIMITED());
    s.advance(1000);
    await call(s.port);
    expect(s.health.snapshot()).toEqual({
      lastSuccessAt: new Date(1_000_000).toISOString(),
      lastFailureAt: new Date(1_001_000).toISOString(),
      lastFailure: "My language model is not answering: OpenRouter's provider Sail Research is rate-limited (429).",
      breakerOpen: false,
    });
  });
});
