import type { STTManager } from './stt-manager.js';
import type { TTSManager } from './tts-manager.js';
import { inFlightRequestRegistry, startInFlightRequestShutdownLogger } from './in-flight-request-registry.js';

/**
 * Issue #1320: dependencies the graceful-shutdown handler needs. Injected
 * (rather than closed over) so the handler is unit-testable without booting a
 * real server — `exit`/`logger` default to `process.exit`/`console`.
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
 * The first signal runs the full graceful path: abort the lifecycle, stop the
 * STT/TTS containers, close the HTTP server, then `exit(0)`. If a step is slow
 * (e.g. a hung `docker compose stop`), a second signal must NOT re-enter the
 * graceful path and call `sttManager.stop()`/`ttsManager.stop()` a second time
 * concurrently — instead it escalates to an immediate `exit(1)`. The
 * `shuttingDown` guard is per-handler closure state so each handler is
 * independent and testable in isolation.
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
      // than re-running the graceful path (which would re-invoke the container
      // stops concurrently). Warn first so the reason is on the record.
      logger.warn(`\n${signal} received again during shutdown — forcing immediate exit.`);
      exit(1);
      return;
    }
    shuttingDown = true;
    logger.log(`\n${signal} received. Shutting down...`);
    // Signal lifecycle abort BEFORE stopping STT/TTS containers so any
    // in-flight startup-warmup work (Telegram whisper) cancels cleanly. The
    // catch path inside warmupWhisper turns this into a distinct info-level
    // log instead of a "warmup FAILED — first user message will pay the
    // cold-start cost" warning that misleads operators during a clean shutdown.
    // See issue #188.
    deps.lifecycleAc.abort();
    // Stop Docker containers BEFORE closing the HTTP server so that the port
    // stays occupied until cleanup is complete. The restart scripts poll the
    // port to decide when to launch the new server — releasing it early caused
    // a race where the old process tore down containers the new process started.
    if (deps.sttManager) {
      await deps.sttManager.stop();
    }
    if (deps.ttsManager) {
      await deps.ttsManager.stop();
    }
    const stopInFlightRequestLogging = startInFlightRequestShutdownLogger(inFlightRequestRegistry);
    try {
      await deps.server.close();
    } finally {
      stopInFlightRequestLogging();
    }
    logger.log('Server closed.');
    exit(0);
  };
}
