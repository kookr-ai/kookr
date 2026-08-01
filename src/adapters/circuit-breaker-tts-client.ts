/**
 * TTS client wrapper that routes synthesize calls through a circuit breaker.
 * When the breaker is open, synthesis is skipped immediately (graceful degrade:
 * cached speak results still serve; fresh speech fails fast without hammering
 * the TTS container).
 */
import type { CircuitBreaker } from '../core/circuit-breaker.js';
import { CircuitBreakerOpenError } from '../core/circuit-breaker.js';
import {
  synthesize,
  TTSClientError,
  type SynthesizeOptions,
  type TTSSynthesisResult,
} from './tts-client.js';

/**
 * Run Pocket TTS synthesize under an optional circuit breaker.
 * When `breaker` is omitted, delegates to {@link synthesize} unchanged.
 */
export async function synthesizeWithCircuitBreaker(
  breaker: CircuitBreaker | undefined,
  opts: SynthesizeOptions,
): Promise<TTSSynthesisResult> {
  if (!breaker) {
    return synthesize(opts);
  }

  try {
    return await breaker.call(() => synthesize(opts));
  } catch (err) {
    if (err instanceof CircuitBreakerOpenError) {
      console.warn('[tts] Circuit breaker open — skipping synthesis');
      throw new TTSClientError('network', 'circuit breaker open — TTS degraded');
    }
    throw err;
  }
}
