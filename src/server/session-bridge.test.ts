/**
 * Unit tests for SessionBridge.
 *
 * V8 (rfc-v8-tmux-removal.md) rewrote the bridge as a fan-out view over the
 * backend's byte stream. These tests drive a FakeTerminalBackend and assert
 * the bridge:
 *   - replays `backend.captureBytes` output to new WS clients
 *   - subscribes via `backend.onData` and forwards live bytes
 *   - forwards binary WS frames to `backend.write` byte-for-byte
 *   - routes resize JSON text frames to `backend.resize`
 *   - fires onInput on CR / LF bytes
 *   - closes the WS when the session is gone
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionBridge } from './session-bridge.js';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import {
  SessionAttachFailedError,
  SessionGoneError,
  WriteTimeoutError,
} from '../adapters/terminal-backend.js';

class FakeWs {
  public readyState = 1;
  public OPEN = 1;
  public sent: Array<Buffer | string> = [];
  private listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  send(payload: Buffer | string): void { this.sent.push(payload); }
  close(_code?: number, _reason?: string): void { this.readyState = 3; this.emit('close'); }
  on(event: string, cb: (...a: unknown[]) => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(cb);
    this.listeners.set(event, arr);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }
}

async function makeReadySession(id: string): Promise<FakeTerminalBackend> {
  const backend = new FakeTerminalBackend();
  await backend.createSession({ id, command: 'claude', args: [] });
  return backend;
}

describe('SessionBridge', () => {
  it('sends backend-emitted bytes as binary frames', async () => {
    const backend = await makeReadySession('s1');
    const ws = new FakeWs();
    const bridge = new SessionBridge('s1', ws as unknown as never, backend);

    await bridge.start();
    backend.emit('s1', new Uint8Array([0x48, 0x69])); // "Hi"

    // Multiple bin frames land — the replay snapshot (may be empty or the
    // fake's synthetic banner) and the live "Hi" emit. Assert on the
    // full concatenated stream so the ordering of those frames does not
    // matter.
    const merged = ws.sent
      .filter((s): s is Buffer => Buffer.isBuffer(s))
      .map((b) => b.toString('utf-8'))
      .join('');
    expect(merged).toContain('Hi');
  });

  it('replays the backend ring buffer to a new attach', async () => {
    const backend = await makeReadySession('s1');
    // Seed content before the WS attaches.
    backend.setCaptureContent('s1', 'banner-text-ABC');

    const ws = new FakeWs();
    const bridge = new SessionBridge('s1', ws as unknown as never, backend);
    await bridge.start();

    const replayed = ws.sent.find(
      (s) => Buffer.isBuffer(s) && (s as Buffer).toString('utf-8').includes('banner-text-ABC'),
    );
    expect(replayed).toBeDefined();
  });

  it('forwards binary WS input to the session verbatim (no string coercion)', async () => {
    const backend = await makeReadySession('s1');
    const ws = new FakeWs();
    const bridge = new SessionBridge('s1', ws as unknown as never, backend);
    await bridge.start();

    // High-bit bytes that string coercion would corrupt.
    const bytes = Buffer.from([0xc3, 0xa9, 0xf0, 0x9f, 0x8d, 0x95]); // 'é🍕' in UTF-8
    ws.emit('message', bytes, true);

    // Allow the async write chain to drain.
    await new Promise((r) => setTimeout(r, 10));

    const written = backend.getWrittenBytes('s1');
    expect(written.length).toBeGreaterThan(0);
    expect(Array.from(written[0])).toEqual(Array.from(bytes));
  });

  it('routes resize JSON text frames to backend.resize', async () => {
    const backend = await makeReadySession('s1');
    const resizeSpy = vi.spyOn(backend, 'resize');
    const ws = new FakeWs();
    const bridge = new SessionBridge('s1', ws as unknown as never, backend);
    await bridge.start();

    ws.emit('message', Buffer.from('{"type":"resize","cols":120,"rows":30}'), false);

    expect(resizeSpy).toHaveBeenCalledWith('s1', 120, 30);
    // No keystroke bytes should reach the session from a resize JSON frame.
    await new Promise((r) => setTimeout(r, 10));
    expect(backend.getWrittenBytes('s1').length).toBe(0);
  });

  it.each([
    ['null dims', '{"type":"resize","cols":null,"rows":null}'],
    ['zero cols', '{"type":"resize","cols":0,"rows":30}'],
    ['negative cols', '{"type":"resize","cols":-5,"rows":30}'],
    ['fractional cols', '{"type":"resize","cols":1.5,"rows":30}'],
    ['string cols', '{"type":"resize","cols":"120","rows":30}'],
    ['zero rows', '{"type":"resize","cols":120,"rows":0}'],
  ])('drops invalid resize JSON text frames (%s) without forwarding as stdin', async (_label, payload) => {
    const backend = await makeReadySession('s1');
    const resizeSpy = vi.spyOn(backend, 'resize');
    const ws = new FakeWs();
    const bridge = new SessionBridge('s1', ws as unknown as never, backend);
    await bridge.start();

    ws.emit('message', Buffer.from(payload), false);

    expect(resizeSpy).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 10));
    expect(backend.getWrittenBytes('s1').length).toBe(0);
  });

  it('fires onInput on CR / LF bytes', async () => {
    const backend = await makeReadySession('s1');
    const ws = new FakeWs();
    const onInput = vi.fn();
    const onAny = vi.fn();
    const bridge = new SessionBridge('s1', ws as unknown as never, backend, onInput, onAny);
    await bridge.start();

    ws.emit('message', Buffer.from([0x61, 0x62]), true); // "ab" — keystroke, no submit
    ws.emit('message', Buffer.from([0x61, 0x0d]), true); // "a\r" — submit

    expect(onAny).toHaveBeenCalledTimes(2);
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it('matches the byte-equality golden stream for replay, live output, and input echo', async () => {
    const backend = await makeReadySession('golden');
    backend.setCaptureContent('golden', 'replay:\x1b[31mred\x1b[0m\n');
    const ws = new FakeWs();
    const bridge = new SessionBridge('golden', ws as unknown as never, backend);
    await bridge.start();

    backend.emit('golden', new Uint8Array([0x00, 0x41, 0xff, 0x0a]));
    ws.emit('message', Buffer.from([0xc3, 0xa9, 0x0d]), true);
    await new Promise((r) => setTimeout(r, 10));

    const actual = Buffer.concat(ws.sent.filter(Buffer.isBuffer));
    const expected = readFileSync(join(process.cwd(), 'src/server/__fixtures__/session-bridge-golden.bin'));
    expect(actual).toEqual(expected);
  });

  it('closes the WS when captureBytes reports the session is gone', async () => {
    const backend = new FakeTerminalBackend();
    // No session created for 's1' → captureBytes throws SessionGoneError.
    const ws = new FakeWs();
    const bridge = new SessionBridge('s1', ws as unknown as never, backend);

    await bridge.start();

    expect(ws.readyState).toBe(3); // closed
  });

  it('unsubscribes from backend.onData on dispose', async () => {
    const backend = await makeReadySession('s1');
    const ws = new FakeWs();
    const bridge = new SessionBridge('s1', ws as unknown as never, backend);
    await bridge.start();

    const subscribersBefore = (backend.sessions.get('s1') as unknown as { dataSubscribers: Set<unknown> }).dataSubscribers.size;
    bridge.dispose();
    const subscribersAfter = (backend.sessions.get('s1') as unknown as { dataSubscribers: Set<unknown> }).dataSubscribers.size;

    expect(subscribersAfter).toBeLessThan(subscribersBefore);
  });

  // Resilience regression tests — keep the backend alive when the underlying
  // dtach session goes away mid-stream. In V8 the write/resize path is async
  // and the bridge currently fire-and-forgets (`void this.backend.write(...)`):
  // a rejected promise becomes an unhandledRejection on the process, which in
  // Node 15+ terminates the server by default. The ws.send / ws.close surfaces
  // in onData and onExit can also throw synchronously when the socket is
  // broken. These tests pin the contract that SessionBridge is the last line
  // of defense and never lets an error escape to the process level.
  describe('resilience — backend and ws faults must not crash the process', () => {
    /** Capture unhandledRejection events during a scoped block. */
    async function collectUnhandledRejections(fn: () => Promise<void>): Promise<unknown[]> {
      const captured: unknown[] = [];
      const handler = (reason: unknown): void => { captured.push(reason); };
      process.on('unhandledRejection', handler);
      try {
        await fn();
        // Allow microtasks + a macrotask to settle so any uncaught rejection
        // materializes before we unsubscribe the listener.
        await new Promise((r) => setTimeout(r, 20));
      } finally {
        process.off('unhandledRejection', handler);
      }
      return captured;
    }

    /** Minimal backend whose write/resize/captureBytes/onData are programmable. */
    function makeFaultyBackend(opts: {
      writeError?: Error | null;
      resizeError?: Error | null;
      captureError?: Error | null;
      onDataError?: Error | null;
    }) {
      return {
        async createSession(): Promise<void> {},
        async listSessions(): Promise<string[]> { return ['s1']; },
        async isAlive(): Promise<boolean> { return true; },
        async killSession(): Promise<void> {},
        async write(): Promise<void> {
          if (opts.writeError) throw opts.writeError;
        },
        async writeSequence(): Promise<void> {},
        async resize(): Promise<void> {
          if (opts.resizeError) throw opts.resizeError;
        },
        async captureBytes(): Promise<Uint8Array> {
          if (opts.captureError) throw opts.captureError;
          return new Uint8Array(0);
        },
        onData() {
          if (opts.onDataError) throw opts.onDataError;
          return (): void => {};
        },
        onBackendError() { return (): void => {}; },
        getStats() {
          return {
            attachedSessions: 0,
            reattachCounts: {},
            pendingWriters: 0,
            lastError: null,
            errorCount: 0,
          };
        },
      };
    }

    it('contains backend.write rejections (no unhandled promise rejection)', async () => {
      const backend = makeFaultyBackend({ writeError: new SessionGoneError('s1') });
      const ws = new FakeWs();
      const bridge = new SessionBridge('s1', ws as unknown as never, backend);
      await bridge.start();

      const leaked = await collectUnhandledRejections(async () => {
        ws.emit('message', Buffer.from([0x61]), true); // binary keystroke
      });

      expect(leaked).toEqual([]);
      // The bridge should have retired the dying WS rather than keep forwarding.
      expect(ws.readyState).toBe(3);
    });

    it('contains backend.write rejections for text keystroke path', async () => {
      const backend = makeFaultyBackend({ writeError: new WriteTimeoutError('s1', 2000) });
      const ws = new FakeWs();
      const bridge = new SessionBridge('s1', ws as unknown as never, backend);
      await bridge.start();

      const leaked = await collectUnhandledRejections(async () => {
        ws.emit('message', Buffer.from('hello\r'), false);
      });

      expect(leaked).toEqual([]);
    });

    it('contains backend.resize rejections', async () => {
      const backend = makeFaultyBackend({ resizeError: new SessionGoneError('s1') });
      const ws = new FakeWs();
      const bridge = new SessionBridge('s1', ws as unknown as never, backend);
      await bridge.start();

      const leaked = await collectUnhandledRejections(async () => {
        ws.emit('message', Buffer.from('{"type":"resize","cols":120,"rows":30}'), false);
      });

      expect(leaked).toEqual([]);
      expect(ws.readyState).toBe(3);
    });

    it('contains SessionAttachFailedError from backend.write', async () => {
      const backend = makeFaultyBackend({ writeError: new SessionAttachFailedError('s1', 3) });
      const ws = new FakeWs();
      const bridge = new SessionBridge('s1', ws as unknown as never, backend);
      await bridge.start();

      const leaked = await collectUnhandledRejections(async () => {
        ws.emit('message', Buffer.from([0x61]), true);
      });

      expect(leaked).toEqual([]);
    });

    it('does not rethrow when ws.send throws from the initial captureBytes replay', async () => {
      const backend = await makeReadySession('s1');
      backend.setCaptureContent('s1', 'banner-ABC');

      const ws = new FakeWs();
      ws.send = (): void => { throw new Error('ws.send: invalid state'); };
      const bridge = new SessionBridge('s1', ws as unknown as never, backend);

      await expect(bridge.start()).resolves.toBeUndefined();
    });

    it('does not rethrow when ws.send throws from the onData subscription', async () => {
      const backend = await makeReadySession('s1');
      const ws = new FakeWs();
      // Let the replay succeed (empty), then make every subsequent send throw.
      let sentOnce = false;
      ws.send = (_: Buffer | string): void => {
        if (sentOnce) throw new Error('ws.send: invalid state');
        sentOnce = true;
      };
      const bridge = new SessionBridge('s1', ws as unknown as never, backend);
      await bridge.start();

      expect(() => {
        backend.emit('s1', new Uint8Array([0x48, 0x69]));
      }).not.toThrow();
    });

    it('closes the WS when captureBytes rejects with SessionAttachFailedError', async () => {
      // Pre-fix: only SessionGoneError was caught — SessionAttachFailedError
      // (reattach cap exhausted) escaped to the start() caller, left the WS
      // open and leaked a bridge. Treat both as permanent-session failures.
      const backend = makeFaultyBackend({
        captureError: new SessionAttachFailedError('s1', 3),
      });
      const ws = new FakeWs();
      const bridge = new SessionBridge('s1', ws as unknown as never, backend);

      await bridge.start();

      expect(ws.readyState).toBe(3);
    });

    it('closes the WS when onData throws SessionAttachFailedError', async () => {
      const backend = makeFaultyBackend({
        onDataError: new SessionAttachFailedError('s1', 3),
      });
      const ws = new FakeWs();
      const bridge = new SessionBridge('s1', ws as unknown as never, backend);

      await bridge.start();

      expect(ws.readyState).toBe(3);
    });

    it('ws error during the initial replay window does not escape', async () => {
      // The 'error' listener must be installed BEFORE any awaits/safeSend
      // calls — otherwise EventEmitter re-raises during the replay.
      const backend = await makeReadySession('s1');
      const ws = new FakeWs();
      const bridge = new SessionBridge('s1', ws as unknown as never, backend);
      // Fire the ws error between captureBytes and onData wiring.
      const originalCapture = backend.captureBytes.bind(backend);
      backend.captureBytes = async (id: string): Promise<Uint8Array> => {
        // Simulate a socket fault right as the replay lands.
        queueMicrotask(() => {
          expect(() => ws.emit('error', new Error('hangup mid-replay'))).not.toThrow();
        });
        return originalCapture(id);
      };

      await expect(bridge.start()).resolves.toBeUndefined();
    });

    it('dispose is idempotent across concurrent close paths', async () => {
      // closeBridgeForFailure calls ws.close(), which synchronously fires
      // ws 'close', which re-enters dispose(). The second call must be a
      // no-op — unsubscribeData must only run once — so that a buggy backend
      // can't see a double-unsubscribe race.
      const backend = await makeReadySession('s1');
      let unsubCalls = 0;
      const originalOnData = backend.onData.bind(backend);
      backend.onData = (id: string, cb: (bytes: Uint8Array) => void): (() => void) => {
        const inner = originalOnData(id, cb);
        return () => { unsubCalls += 1; inner(); };
      };
      const ws = new FakeWs();
      const bridge = new SessionBridge('s1', ws as unknown as never, backend);
      await bridge.start();

      // Force the failure path — it closes the ws, which fires 'close',
      // which re-enters dispose(). If idempotency broke, unsubCalls would
      // climb past 1.
      ws.emit('error', new Error('socket hang up'));
      // And direct dispose on top of that — still must not double-unsub.
      bridge.dispose();

      expect(unsubCalls).toBe(1);
    });

    it('suppresses duplicate rejections after the bridge has been closed', async () => {
      // A keystroke storm can queue several backend.write promises before
      // the first rejection lands; after the first rejection closes the
      // bridge, the tail of rejections must not spam logs or re-enter the
      // close path.
      const deferred: Array<() => void> = [];
      const backend = {
        async createSession(): Promise<void> {},
        async listSessions(): Promise<string[]> { return ['s1']; },
        async isAlive(): Promise<boolean> { return true; },
        async killSession(): Promise<void> {},
        write(): Promise<void> {
          return new Promise((_res, rej) => {
            deferred.push(() => rej(new SessionGoneError('s1')));
          });
        },
        async writeSequence(): Promise<void> {},
        async resize(): Promise<void> {},
        async captureBytes(): Promise<Uint8Array> { return new Uint8Array(0); },
        onData() { return (): void => {}; },
        onBackendError() { return (): void => {}; },
        getStats() {
          return {
            attachedSessions: 0,
            reattachCounts: {},
            pendingWriters: 0,
            lastError: null,
            errorCount: 0,
          };
        },
      };
      const ws = new FakeWs();
      const bridge = new SessionBridge('s1', ws as unknown as never, backend);
      await bridge.start();

      // Three queued keystrokes, each with its own pending write promise.
      ws.emit('message', Buffer.from([0x61]), true);
      ws.emit('message', Buffer.from([0x62]), true);
      ws.emit('message', Buffer.from([0x63]), true);

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        // Reject all three — only the first should trigger logs + close.
        for (const r of deferred) r();
        await new Promise((r) => setTimeout(r, 10));

        // One rejection closes the bridge + logs a single warn. The
        // remaining two are suppressed.
        expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
        expect(err.mock.calls.length).toBe(0);
        expect(ws.readyState).toBe(3);
      } finally {
        warn.mockRestore();
        err.mockRestore();
      }
    });
  });
});
