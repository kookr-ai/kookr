/**
 * Keeps Lucy live's status and connection handler in step with the speech recogniser.
 *
 * With an explicit `KOOKR_LUCY_EARS_URL` the answer is fixed at startup, as before. With the
 * managed recogniser (`KOOKR_LUCY_EARS=true`) it changes while the sidecar comes up: the status
 * says "starting", then Lucy live switches on by itself when the recogniser is healthy, with no
 * Kookr restart.
 */

import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import type { LucyLiveStatus } from '../../shared/contracts/lucy-live.js';
import type { LucyEarsHandle } from '../lucy-ears-manager.js';
import { lucyLiveStatusOf, resolveLucyLiveConfig, type LucyLiveConfig } from './config.js';
import type { LucyLiveService } from './create-lucy-live.js';

export interface LucyLiveRuntimeDeps {
  env: Record<string, string | undefined>;
  ttsUrl: string | undefined;
  /** Present only when Kookr manages the recogniser. */
  ears?: LucyEarsHandle;
  /** Builds the service for a resolved config; returns the barge-in mode too. Async because Silero loads from disk. */
  build(config: LucyLiveConfig): Promise<{ service: LucyLiveService; bargeIn: 'silero' | 'off' }>;
  warn?: (message: string) => void;
}

export interface LucyLiveRuntime {
  status(): LucyLiveStatus;
  /** Undefined only when Lucy live can never switch on in this run (nothing managed, config incomplete). */
  service: LucyLiveService | undefined;
  /** Resolves once the first evaluation is done; for tests and startup logging. */
  ready: Promise<void>;
}

export function createLucyLiveRuntime(deps: LucyLiveRuntimeDeps): LucyLiveRuntime {
  const warn = deps.warn ?? ((m: string) => console.warn(`[lucy-live] ${m}`));
  let status: LucyLiveStatus = { available: false, reason: 'Lucy live is starting.' };
  let current: LucyLiveService | undefined;
  // Serialises evaluations: the recogniser can change state while Silero is still loading.
  let evaluating: Promise<void> = Promise.resolve();

  const evaluate = async (): Promise<void> => {
    const ears = deps.ears?.getState();
    if (ears?.phase === 'starting') {
      current = undefined;
      status = {
        available: false,
        starting: true,
        reason: 'Lucy\'s ears (the speech recogniser) are starting. The first start downloads about 2.4 GB, so this can take several minutes.',
      };
      return;
    }
    if (ears?.phase === 'unavailable') {
      current = undefined;
      status = { available: false, reason: ears.reason };
      return;
    }
    const env = ears?.phase === 'ready' ? { ...deps.env, KOOKR_LUCY_EARS_URL: ears.url } : deps.env;
    const resolved = resolveLucyLiveConfig(env, deps.ttsUrl);
    if (!resolved.ok) {
      current = undefined;
      status = lucyLiveStatusOf(resolved);
      return;
    }
    try {
      const built = await deps.build(resolved.config);
      current = built.service;
      status = lucyLiveStatusOf(resolved, built.bargeIn);
    } catch (err) {
      current = undefined;
      status = { available: false, reason: `Lucy live failed to start: ${err instanceof Error ? err.message : String(err)}` };
      warn(status.reason ?? '');
    }
  };
  const schedule = (): Promise<void> => (evaluating = evaluating.then(evaluate));

  const ready = schedule();
  deps.ears?.onChange(() => { void schedule(); });

  // Without management and without a complete config there is nothing to switch on later,
  // so the upgrade path stays closed exactly as before.
  const everPossible = deps.ears !== undefined || resolveLucyLiveConfig(deps.env, deps.ttsUrl).ok;
  const service: LucyLiveService | undefined = everPossible
    ? {
        handleConnection(ws: WebSocket, req: IncomingMessage) {
          if (current) return current.handleConnection(ws, req);
          ws.close(1013, 'Lucy live is not ready');
        },
      }
    : undefined;

  return { status: () => status, service, ready };
}
