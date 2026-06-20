/**
 * Reconnecting WebSocket controller — single owner of the connect → close →
 * retry lifecycle for the dashboard and terminal sockets.
 *
 * Exists because hand-rolled `onclose → setTimeout(connect)` loops have two
 * failure modes that show up as UI flicker whenever the server restarts or
 * the host drops offline (kookr flickering report, 2026-06):
 *
 *  1. Stale-socket clobbering. Every socket ever created kept live handlers,
 *     so a deliberately replaced socket (effect re-run, HMR, StrictMode
 *     double-mount) would fire `onclose`, flip the shared `connected` flag to
 *     false and schedule a *second* reconnect chain alongside the live one.
 *     Duplicate sockets then double-process every snapshot. Here, events from
 *     any socket that is no longer `current` are ignored entirely.
 *
 *  2. Connected-flag flapping. Marking `connected=true` on `onopen` flashes
 *     the UI when an upgrade is accepted and immediately dropped — exactly
 *     what a dev-proxy or restarting server produces every retry. The
 *     `establishOn: 'first-message'` mode only reports a connection once the
 *     server actually delivers data (the dashboard server sends a snapshot
 *     immediately on connect, so this costs nothing in the healthy path).
 *
 * Retries use capped exponential backoff with jitter instead of a fixed
 * hammer interval. The attempt counter resets only once the server delivers a
 * message on a connection — a bare socket open is NOT proof of health (a
 * proxy or restarting server can accept the upgrade and instantly drop it),
 * and resetting on open would pin the backoff at its minimum during exactly
 * the outage loops it exists to dampen.
 */

export interface CloseEventLike {
  code?: number;
}

export interface MessageEventLike {
  data: unknown;
}

/** Which handler fired an event from a socket that is no longer current. */
export type StaleSocketEventKind = 'open' | 'message' | 'close' | 'error';

/** The subset of the browser WebSocket surface the controller manages. */
export interface SocketLike {
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: MessageEventLike) => void) | null;
  onclose: ((event?: CloseEventLike) => void) | null;
  onerror: (() => void) | null;
}

const SOCKET_OPEN = 1; // WebSocket.OPEN — constant inlined so tests can stub minimal fakes.

export interface BackoffOptions {
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  /** Fraction of the base delay used as symmetric jitter (0.2 → ±20%). */
  jitterRatio: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  initialDelayMs: 1_000,
  maxDelayMs: 15_000,
  multiplier: 2,
  jitterRatio: 0.2,
};

/**
 * Delay before reconnect attempt `attempt` (0-based count of consecutive
 * failures). Grows exponentially to the cap, with symmetric jitter so a fleet
 * of clients doesn't stampede a restarting server in lockstep.
 */
export function computeReconnectDelayMs(
  attempt: number,
  backoff: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt);
  const base = Math.min(
    backoff.maxDelayMs,
    backoff.initialDelayMs * Math.pow(backoff.multiplier, exponent),
  );
  const jitter = base * backoff.jitterRatio * (random() * 2 - 1);
  // Clamp after jitter too, so maxDelayMs is a true ceiling.
  return Math.max(0, Math.round(Math.min(backoff.maxDelayMs, base + jitter)));
}

export interface ReconnectingSocketOptions<T extends SocketLike> {
  createSocket: () => T;
  /**
   * When the connection counts as established:
   *  - 'open' (default): on socket open.
   *  - 'first-message': only once the server delivers a message. Shields the
   *    established flag from upgrades that are accepted then instantly
   *    dropped (proxy with a dead backend, server mid-restart).
   */
  establishOn?: 'open' | 'first-message';
  /** Fired on socket open, before any establish bookkeeping. */
  onOpen?: (socket: T) => void;
  onMessage?: (event: MessageEventLike, socket: T) => void;
  /** Fired when the connection (re-)establishes per `establishOn`. */
  onEstablished?: (socket: T) => void;
  /** Fired when an established connection is lost. Not fired for failed attempts. */
  onLost?: (event: CloseEventLike) => void;
  /** Fired for every close of the current socket, established or not. */
  onClose?: (event: CloseEventLike, info: { wasEstablished: boolean }) => void;
  /** Return false to end the retry loop for this close (e.g. clean PTY exit). */
  shouldReconnect?: (event: CloseEventLike) => boolean;
  /**
   * Fired whenever an event from a socket that is no longer `current`
   * (replaced or stopped) is ignored. The controller owns no telemetry policy;
   * consumers use this to surface bounded, rate-limited diagnostics for
   * stale-socket churn without re-implementing the staleness check.
   */
  onStaleEvent?: (kind: StaleSocketEventKind) => void;
  backoff?: Partial<BackoffOptions>;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  random?: () => number;
}

export interface ReconnectingSocket {
  start(): void;
  /** Close the current socket and cancel any pending retry. Idempotent. */
  stop(): void;
  /** Send if the current socket is open; returns whether it was sent. */
  send(data: string | ArrayBufferLike | ArrayBufferView): boolean;
  isEstablished(): boolean;
  /** Consecutive failed attempts since the last established connection. */
  failedAttempts(): number;
}

export function createReconnectingSocket<T extends SocketLike>(
  options: ReconnectingSocketOptions<T>,
): ReconnectingSocket {
  const backoff: BackoffOptions = { ...DEFAULT_BACKOFF, ...options.backoff };
  const establishOn = options.establishOn ?? 'open';
  const setTimeoutFn = options.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimeoutFn = options.clearTimeoutFn ?? ((handle: unknown) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]));
  const random = options.random ?? Math.random;

  let current: T | null = null;
  let established = false;
  let attempts = 0;
  let stopped = true;
  let retryTimer: unknown = null;

  function clearRetryTimer(): void {
    if (retryTimer !== null) {
      clearTimeoutFn(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleReconnect(): void {
    clearRetryTimer();
    const delay = computeReconnectDelayMs(attempts, backoff, random);
    attempts += 1;
    retryTimer = setTimeoutFn(connect, delay);
  }

  function markEstablished(socket: T): void {
    established = true;
    options.onEstablished?.(socket);
  }

  function connect(): void {
    retryTimer = null;
    if (stopped) return;

    let socket: T;
    try {
      socket = options.createSocket();
    } catch {
      scheduleReconnect();
      return;
    }
    current = socket;

    socket.onopen = () => {
      if (current !== socket) { options.onStaleEvent?.('open'); return; }
      if (stopped) return;
      options.onOpen?.(socket);
      if (establishOn === 'open') markEstablished(socket);
    };

    let receivedMessage = false;
    socket.onmessage = (event) => {
      if (current !== socket) { options.onStaleEvent?.('message'); return; }
      if (stopped) return;
      if (!receivedMessage) {
        // First server data on this connection is the real health signal —
        // only now does the failure streak end. Resetting on bare open would
        // keep backoff pinned at minimum through accept-then-drop loops.
        receivedMessage = true;
        attempts = 0;
      }
      if (!established && establishOn === 'first-message') markEstablished(socket);
      options.onMessage?.(event, socket);
    };

    socket.onclose = (event) => {
      // Stale sockets (replaced or stopped) must not touch shared state: no
      // established flip, no rival reconnect chain.
      if (current !== socket) { options.onStaleEvent?.('close'); return; }
      current = null;
      const wasEstablished = established;
      established = false;
      const closeEvent = event ?? {};
      options.onClose?.(closeEvent, { wasEstablished });
      if (wasEstablished) options.onLost?.(closeEvent);
      if (stopped) return;
      if (options.shouldReconnect && !options.shouldReconnect(closeEvent)) return;
      scheduleReconnect();
    };

    socket.onerror = () => {
      if (current !== socket) { options.onStaleEvent?.('error'); return; }
      // Close handling owns reconnect scheduling; browsers fire close after error.
      try {
        socket.close();
      } catch {
        // Already closing/closed.
      }
    };
  }

  return {
    start(): void {
      if (!stopped) return;
      stopped = false;
      connect();
    },

    stop(): void {
      stopped = true;
      clearRetryTimer();
      const socket = current;
      // Detach before closing so this socket's onclose is treated as stale.
      current = null;
      established = false;
      try {
        socket?.close();
      } catch {
        // Already closing/closed.
      }
    },

    send(data): boolean {
      if (current !== null && current.readyState === SOCKET_OPEN) {
        current.send(data);
        return true;
      }
      return false;
    },

    isEstablished: () => established,
    failedAttempts: () => attempts,
  };
}
