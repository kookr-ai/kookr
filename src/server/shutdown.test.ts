import { describe, it, expect, vi } from 'vitest';
import { createShutdownHandler, type ShutdownHandlerDeps } from './shutdown.js';

/**
 * Issue #1320: the graceful-shutdown handler must be re-entrancy-safe. A
 * single SIGINT/SIGTERM runs the full graceful path exactly once; a second
 * signal arriving while that path is still in flight must force-exit(1) rather
 * than re-run the container stops concurrently.
 */

interface Harness {
  deps: ShutdownHandlerDeps;
  abort: ReturnType<typeof vi.fn>;
  sttStop: ReturnType<typeof vi.fn>;
  ttsStop: ReturnType<typeof vi.fn>;
  serverClose: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
  logs: string[];
  warns: string[];
  /** Resolve the STT stop() to let a gated graceful path proceed. */
  releaseStt: () => void;
}

function makeHarness(opts: { gateStt?: boolean } = {}): Harness {
  const logs: string[] = [];
  const warns: string[] = [];
  const abort = vi.fn();
  let release = () => {};
  const sttStop = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        if (opts.gateStt) {
          release = resolve;
        } else {
          resolve();
        }
      }),
  );
  const ttsStop = vi.fn(() => Promise.resolve());
  const serverClose = vi.fn(() => Promise.resolve());
  const exit = vi.fn();
  const deps: ShutdownHandlerDeps = {
    lifecycleAc: { abort },
    sttManager: { url: 'ws://stt', stop: sttStop },
    ttsManager: { url: 'http://tts', stop: ttsStop },
    server: { close: serverClose },
    exit,
    logger: { log: (m: string) => logs.push(m), warn: (m: string) => warns.push(m) },
  };
  return { deps, abort, sttStop, ttsStop, serverClose, exit, logs, warns, releaseStt: () => release() };
}

describe('createShutdownHandler', () => {
  it('runs the full graceful path once and exits 0', async () => {
    const h = makeHarness();
    const shutdown = createShutdownHandler(h.deps);

    await shutdown('SIGINT');

    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.sttStop).toHaveBeenCalledTimes(1);
    expect(h.ttsStop).toHaveBeenCalledTimes(1);
    expect(h.serverClose).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(0);
    expect(h.warns).toHaveLength(0);

    // Lock the documented ordering invariant: abort BEFORE the container stops
    // (issue #188 clean warmup-cancel) and stops BEFORE server.close() (the
    // restart-script port race). Count-only assertions would survive a reorder.
    expect(h.abort.mock.invocationCallOrder[0]).toBeLessThan(h.sttStop.mock.invocationCallOrder[0]);
    expect(h.sttStop.mock.invocationCallOrder[0]).toBeLessThan(h.ttsStop.mock.invocationCallOrder[0]);
    expect(h.ttsStop.mock.invocationCallOrder[0]).toBeLessThan(h.serverClose.mock.invocationCallOrder[0]);
  });

  it('force-exits(1) on a repeated signal without re-running the graceful path', async () => {
    const h = makeHarness({ gateStt: true });
    const shutdown = createShutdownHandler(h.deps);

    // First signal enters the graceful path and blocks in sttManager.stop().
    // The handler runs synchronously up to its first `await`, so sttStop() has
    // already been invoked (and `shuttingDown` set) by the time this returns.
    const first = shutdown('SIGTERM');
    expect(h.sttStop).toHaveBeenCalledTimes(1);

    // Second signal arrives mid-shutdown: it must escalate, not re-enter.
    await shutdown('SIGTERM');

    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(1);
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]).toMatch(/forcing immediate exit/i);
    // The container stops were NOT invoked a second time.
    expect(h.sttStop).toHaveBeenCalledTimes(1);
    expect(h.ttsStop).not.toHaveBeenCalled();

    // Release the gate so the first (graceful) path completes cleanly.
    h.releaseStt();
    await first;
    expect(h.sttStop).toHaveBeenCalledTimes(1);
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

    // No second graceful path: container stops/close still ran exactly once.
    expect(h.sttStop).toHaveBeenCalledTimes(1);
    expect(h.ttsStop).toHaveBeenCalledTimes(1);
    expect(h.serverClose).toHaveBeenCalledTimes(1);
    // The later signal escalated to a force-exit.
    expect(h.exit).toHaveBeenCalledWith(1);
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]).toMatch(/forcing immediate exit/i);
  });
});
