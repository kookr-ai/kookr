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
    void fetch(GROK_AUTH_STATUS_PATH, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<unknown>;
      })
      .then((body) => {
        if (controller.signal.aborted) return;
        const parsed = parseGrokAuthStatusResponse(body);
        if (parsed) setStatus(parsed);
      })
      .catch(() => {
        // Network, abort, or non-JSON: leave status unknown.
      });
    return () => controller.abort();
  }, []);

  return status;
}
