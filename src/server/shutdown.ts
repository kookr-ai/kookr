import type { STTManager } from './stt-manager.js';
import type { TTSManager } from './tts-manager.js';
import { inFlightRequestRegistry, startInFlightRequestShutdownLogger } from './in-flight-request-registry.js';

/**
 * Issue #1320: dependencies the graceful-shutdown handler needs. Injected
 * (rather than closed over) so the handler is unit-testable without booting a
 * real server — `exit`/`logger` default to `process.exit`/`console`.
 *
 * Fast-prod-restart P1 (docs/rfc/rfc-fast-prod-restart.md): STT/TTS managers
 * remain on the deps object for callers that still hold them, but routine
 * SIGTERM/SIGINT **detaches** — it does not call `stop()`. Sidecar teardown is
 * operator-driven via `pnpm prod:stop --with-sidecars` or the failed-start
 * cleanup path inside the managers.
 */
export interface ShutdownHandlerDeps {
  lifecycleAc: Pick<AbortController, 'abort'>;
  sttManager: STTManager | null;
  ttsManager: TTSManager | null;
  server: { close: () => Promise<void> };
  exit?: (code: number) => void;
  logger?: Pick<Console, 'log' | 'warn'>;
}

/**
 * Issue #1320: build a re-entrancy-guarded SIGINT/SIGTERM handler.
 *
 * The first signal runs the full graceful path: abort the lifecycle, close the
 * HTTP server, then `exit(0)`. Bundled STT/TTS containers are left running
 * (detach). If a step is slow (e.g. a hung `server.close()`), a second signal
 * must NOT re-enter the graceful path — instead it escalates to an immediate
 * `exit(1)`. The `shuttingDown` guard is per-handler closure state so each
 * handler is independent and testable in isolation.
 *
 * This lives in its own module (not inline in start.ts) so the unit test can
 * import it without triggering start.ts's `main()` server-boot side effect.
 */
export function createShutdownHandler(deps: ShutdownHandlerDeps): (signal: string) => Promise<void> {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const logger = deps.logger ?? console;
  let shuttingDown = false;
  return async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      // A repeated stop signal while the graceful path is still running means
      // the operator wants out NOW. Escalate to an immediate force-exit rather
      // than re-running the graceful path concurrently. Warn first so the
      // reason is on the record.
      logger.warn(`\n${signal} received again during shutdown — forcing immediate exit.`);
      exit(1);
      return;
    }
    shuttingDown = true;
    logger.log(`\n${signal} received. Shutting down...`);
    // Signal lifecycle abort so in-flight startup-warmup work (Telegram whisper)
    // cancels cleanly. See issue #188.
    deps.lifecycleAc.abort();
    // Detach bundled speech sidecars: do NOT call sttManager.stop()/ttsManager.stop().
    // Freeing GPU / containers is `pnpm prod:stop --with-sidecars` (or failed-start
    // cleanup inside the managers). Detach removes the historical restart race
    // where the old process tore down containers the new process was starting.
    void deps.sttManager;
    void deps.ttsManager;
    const stopInFlightRequestLogging = startInFlightRequestShutdownLogger(inFlightRequestRegistry);
    try {
      await deps.server.close();
    } finally {
      stopInFlightRequestLogging();
    }
    logger.log('Server closed (speech sidecars left running; use pnpm prod:stop --with-sidecars to free GPU).');
    exit(0);
  };
}
