/**
 * STT health-probe wrapper that routes outbound health checks through a
 * circuit breaker. Browser clients talk to the STT WebSocket directly; the
 * only server-side STT "provider call" today is the HTTP health probe used by
 * `/api/health/stt` and similar soft-degrade paths.
 *
 * When the breaker is open, probes return `{ status: 'unavailable' }` without
 * contacting the STT service (graceful degrade: skip speech / keep UI soft-fail).
 */
import type { CircuitBreaker } from '../core/circuit-breaker.js';
import { CircuitBreakerOpenError } from '../core/circuit-breaker.js';

export interface SttHealthProbeResult {
  status: string;
  [key: string]: unknown;
}

export interface ProbeSttHealthOptions {
  sttUrl: string;
  /** Optional breaker; when omitted the probe runs unprotected. */
  breaker?: CircuitBreaker;
  /** Fetch timeout in ms. Default 3000. */
  timeoutMs?: number;
  /** Test seam. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

function toHttpHealthUrl(sttUrl: string): string {
  const base = sttUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:').replace(/\/$/, '');
  return `${base}/health`;
}

async function probeOnce(
  sttUrl: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<SttHealthProbeResult> {
  const res = await fetchImpl(toHttpHealthUrl(sttUrl), {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`STT health returned HTTP ${res.status}`);
  }
  const body: unknown = await res.json();
  if (!body || typeof body !== 'object') {
    throw new Error('STT health body not an object');
  }
  return body as SttHealthProbeResult;
}

/**
 * Probe STT service health, optionally through a circuit breaker.
 * Never throws: failures and open-breaker degrade to `{ status: 'unavailable' }`.
 */
export async function probeSttHealth(opts: ProbeSttHealthOptions): Promise<SttHealthProbeResult> {
  const {
    sttUrl,
    breaker,
    timeoutMs = 3_000,
    fetchImpl = fetch,
  } = opts;

  const run = () => probeOnce(sttUrl, timeoutMs, fetchImpl);

  if (!breaker) {
    try {
      return await run();
    } catch {
      return { status: 'unavailable' };
    }
  }

  try {
    return await breaker.call(run);
  } catch (err) {
    if (err instanceof CircuitBreakerOpenError) {
      console.warn('[stt] Circuit breaker open — skipping STT health probe');
      return { status: 'unavailable', reason: 'circuit_open' };
    }
    return { status: 'unavailable' };
  }
}
