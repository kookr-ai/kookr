import { describe, expect, it, vi } from 'vitest';

import {
  createRelayShutdownHandler,
  installRelayProcessSignalHandlers,
  type RelayShutdownHandlerDeps,
} from '../shutdown.js';

/**
 * Issue #1391: the relay bootstrap must invoke close() exactly once on
 * SIGTERM/SIGINT, checkpoint/close SQLite via that path, ignore a second
 * signal re-entry, and force-exit after a hung close's grace deadline.
 */

interface Harness {
  deps: RelayShutdownHandlerDeps;
  close: ReturnType<typeof vi.fn>;
  stateStoreClose: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
  logs: string[];
  warns: string[];
  errors: string[];
  releaseClose: () => void;
}

function makeHarness(opts: { gateClose?: boolean; graceMs?: number } = {}): Harness {
  const logs: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  const stateStoreClose = vi.fn();
  let release = () => {};
  const close = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        stateStoreClose();
        if (opts.gateClose) {
          release = resolve;
        } else {
          resolve();
        }
      }),
  );
  const exit = vi.fn();
  const deps: RelayShutdownHandlerDeps = {
    close,
    exit,
    graceMs: opts.graceMs ?? 5_000,
    logger: {
      log: (m: string) => logs.push(m),
      warn: (m: string) => warns.push(m),
      error: (m: string) => errors.push(m),
    },
  };
  return {
    deps,
    close,
    stateStoreClose,
    exit,
    logs,
    warns,
    errors,
    releaseClose: () => release(),
  };
}

describe('createRelayShutdownHandler', () => {
  it('runs close() once (including state-store close) and exits 0', async () => {
    const h = makeHarness();
    const shutdown = createRelayShutdownHandler(h.deps);

    await shutdown('SIGTERM');

    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.stateStoreClose).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(0);
    expect(h.warns).toHaveLength(0);
    expect(h.errors).toHaveLength(0);
  });

  it('force-exits(1) on a repeated signal without re-invoking close()', async () => {
    const h = makeHarness({ gateClose: true });
    const shutdown = createRelayShutdownHandler(h.deps);

    const first = shutdown('SIGTERM');
    expect(h.close).toHaveBeenCalledTimes(1);

    await shutdown('SIGTERM');

    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(1);
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]).toMatch(/forcing immediate exit/i);
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.stateStoreClose).toHaveBeenCalledTimes(1);

    h.releaseClose();
    await first;
    // Graceful path completes after the force-exit was already requested.
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it('force-exits after the grace deadline when close() hangs', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({ gateClose: true, graceMs: 50 });
      const shutdown = createRelayShutdownHandler(h.deps);

      const first = shutdown('SIGINT');
      expect(h.close).toHaveBeenCalledTimes(1);
      expect(h.exit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(50);

      expect(h.exit).toHaveBeenCalledTimes(1);
      expect(h.exit).toHaveBeenCalledWith(1);
      expect(h.errors.some((line) => /timed out/i.test(line))).toBe(true);
      expect(h.close).toHaveBeenCalledTimes(1);

      h.releaseClose();
      await first;
    } finally {
      vi.useRealTimers();
    }
  });

  it('exits 1 when close() rejects', async () => {
    const h = makeHarness();
    h.deps.close = vi.fn(async () => {
      throw new Error('ws hangup failed');
    });
    const shutdown = createRelayShutdownHandler(h.deps);

    await shutdown('SIGINT');

    expect(h.exit).toHaveBeenCalledWith(1);
    expect(h.errors.some((line) => /ws hangup failed/.test(line))).toBe(true);
  });

  it('stays guarded after graceful completion — a later signal force-exits', async () => {
    const h = makeHarness();
    const shutdown = createRelayShutdownHandler(h.deps);

    await shutdown('SIGINT');
    expect(h.exit).toHaveBeenCalledWith(0);

    await shutdown('SIGTERM');

    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(1);
    expect(h.warns).toHaveLength(1);
  });
});

describe('installRelayProcessSignalHandlers', () => {
  it('wires SIGTERM/SIGINT to the shutdown handler once each', async () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const processRef = {
      on(event: string, listener: (...args: unknown[]) => void) {
        handlers.set(event, listener);
        return processRef;
      },
    };
    const shutdown = vi.fn(async () => undefined);

    installRelayProcessSignalHandlers(shutdown, processRef as Pick<NodeJS.Process, 'on'>);

    expect(handlers.has('SIGINT')).toBe(true);
    expect(handlers.has('SIGTERM')).toBe(true);

    handlers.get('SIGTERM')!();
    handlers.get('SIGINT')!();

    // Allow the voided promises to settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(shutdown).toHaveBeenCalledTimes(2);
    expect(shutdown).toHaveBeenCalledWith('SIGTERM');
    expect(shutdown).toHaveBeenCalledWith('SIGINT');
  });
});
