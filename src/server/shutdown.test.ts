import { describe, it, expect, vi } from 'vitest';
import { createShutdownHandler, type ShutdownHandlerDeps } from './shutdown.js';

/**
 * Issue #1320 + fast-prod-restart P1: the graceful-shutdown handler must be
 * re-entrancy-safe and must **detach** bundled STT/TTS (no compose down on
 * routine SIGTERM).
 */

interface Harness {
  deps: ShutdownHandlerDeps;
  abort: ReturnType<typeof vi.fn>;
  sttStop: ReturnType<typeof vi.fn>;
  ttsStop: ReturnType<typeof vi.fn>;
  serverClose: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
  recordCleanShutdown: ReturnType<typeof vi.fn>;
  logs: string[];
  warns: string[];
  /** Resolve the server close() to let a gated graceful path proceed. */
  releaseClose: () => void;
}

function makeHarness(opts: { gateClose?: boolean } = {}): Harness {
  const logs: string[] = [];
  const warns: string[] = [];
  const abort = vi.fn();
  let release = () => {};
  const sttStop = vi.fn(() => Promise.resolve());
  const ttsStop = vi.fn(() => Promise.resolve());
  const serverClose = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        if (opts.gateClose) {
          release = resolve;
        } else {
          resolve();
        }
      }),
  );
  const exit = vi.fn();
  const recordCleanShutdown = vi.fn();
  const deps: ShutdownHandlerDeps = {
    lifecycleAc: { abort },
    sttManager: { url: 'ws://stt', stop: sttStop },
    ttsManager: { url: 'http://tts', stop: ttsStop },
    server: { close: serverClose },
    exit,
    recordCleanShutdown,
    logger: { log: (m: string) => logs.push(m), warn: (m: string) => warns.push(m) },
  };
  return { deps, abort, sttStop, ttsStop, serverClose, exit, recordCleanShutdown, logs, warns, releaseClose: () => release() };
}

describe('createShutdownHandler', () => {
  it('runs the full graceful path once, detaches sidecars, and exits 0', async () => {
    const h = makeHarness();
    const shutdown = createShutdownHandler(h.deps);

    await shutdown('SIGINT');

    expect(h.abort).toHaveBeenCalledTimes(1);
    // P1 detach: routine SIGTERM/SIGINT must not tear down speech containers.
    expect(h.sttStop).not.toHaveBeenCalled();
    expect(h.ttsStop).not.toHaveBeenCalled();
    expect(h.serverClose).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(0);
    expect(h.warns).toHaveLength(0);
    expect(h.logs.some((l) => /sidecars left running/i.test(l))).toBe(true);

    // abort BEFORE server.close() (issue #188 clean warmup-cancel).
    expect(h.abort.mock.invocationCallOrder[0]).toBeLessThan(h.serverClose.mock.invocationCallOrder[0]);
  });

  it('records the clean-shutdown marker with the signal, before server.close (issue #2790)', async () => {
    const h = makeHarness();
    const shutdown = createShutdownHandler(h.deps);

    await shutdown('SIGTERM');

    expect(h.recordCleanShutdown).toHaveBeenCalledTimes(1);
    expect(h.recordCleanShutdown).toHaveBeenCalledWith('SIGTERM');
    // Marker is stamped up front, before the (possibly slow) server close.
    expect(h.recordCleanShutdown.mock.invocationCallOrder[0]).toBeLessThan(
      h.serverClose.mock.invocationCallOrder[0],
    );
  });

  it('does not re-stamp the clean marker on a second, escalating signal (issue #2790)', async () => {
    const h = makeHarness({ gateClose: true });
    const shutdown = createShutdownHandler(h.deps);

    const first = shutdown('SIGTERM');
    await Promise.resolve();
    expect(h.recordCleanShutdown).toHaveBeenCalledTimes(1);

    // Second signal escalates to force-exit; it must not write another marker.
    await shutdown('SIGTERM');
    expect(h.recordCleanShutdown).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(1);

    h.releaseClose();
    await first;
  });

  it('still shuts down when no marker recorder is wired', async () => {
    const h = makeHarness();
    h.deps.recordCleanShutdown = undefined;
    const shutdown = createShutdownHandler(h.deps);

    await shutdown('SIGINT');

    expect(h.serverClose).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it('force-exits(1) on a repeated signal without re-running the graceful path', async () => {
    const h = makeHarness({ gateClose: true });
    const shutdown = createShutdownHandler(h.deps);

    // First signal enters the graceful path and blocks in server.close().
    const first = shutdown('SIGTERM');
    // Yield so the first handler reaches the await on server.close.
    await Promise.resolve();
    expect(h.serverClose).toHaveBeenCalledTimes(1);

    // Second signal arrives mid-shutdown: it must escalate, not re-enter.
    await shutdown('SIGTERM');

    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(1);
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]).toMatch(/forcing immediate exit/i);
    expect(h.serverClose).toHaveBeenCalledTimes(1);
    expect(h.sttStop).not.toHaveBeenCalled();
    expect(h.ttsStop).not.toHaveBeenCalled();

    h.releaseClose();
    await first;
    expect(h.serverClose).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it('does not treat a null STT/TTS manager as a step to run', async () => {
    const h = makeHarness();
    h.deps.sttManager = null;
    h.deps.ttsManager = null;
    const shutdown = createShutdownHandler(h.deps);

    await shutdown('SIGINT');

    expect(h.sttStop).not.toHaveBeenCalled();
    expect(h.ttsStop).not.toHaveBeenCalled();
    expect(h.serverClose).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it('stays guarded after the graceful path completes — a later signal force-exits', async () => {
    // In production the first path's exit(0) ends the process; with an injected
    // non-halting exit the guard must remain latched so a stray later signal
    // escalates rather than re-running the graceful path a second time.
    const h = makeHarness();
    const shutdown = createShutdownHandler(h.deps);

    await shutdown('SIGINT');
    expect(h.exit).toHaveBeenCalledWith(0);

    await shutdown('SIGTERM');

    expect(h.sttStop).not.toHaveBeenCalled();
    expect(h.ttsStop).not.toHaveBeenCalled();
    expect(h.serverClose).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(1);
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]).toMatch(/forcing immediate exit/i);
  });
});
