import { useEffect, useState } from 'react';
import {
  GROK_AUTH_STATUS_PATH,
  parseGrokAuthStatusResponse,
  type GrokAuthStatusResponse,
} from '../../shared/protocol.js';

/**
 * Load the secret-free Grok auth preflight used by the Launch dialog.
 *
 * Failures stay silent: a missing verdict must not disable Launch. The server
 * still refuses a grok-build launch after submit if credentials are unusable.
 */
export function useGrokAuthStatus(): GrokAuthStatusResponse | null {
  const [status, setStatus] = useState<GrokAuthStatusResponse | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(GROK_AUTH_STATUS_PATH, {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response?.ok || controller.signal.aborted) return;
        const parsed = parseGrokAuthStatusResponse(await response.json());
        if (parsed && !controller.signal.aborted) setStatus(parsed);
      } catch {
        // Network, abort, stubbed fetch, or non-JSON: leave status unknown.
      }
    })();
    return () => controller.abort();
  }, []);

  return status;
}
