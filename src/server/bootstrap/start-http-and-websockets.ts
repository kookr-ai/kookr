import { createServer, type IncomingMessage, type Server } from 'node:http';

import { getRequestListener } from '@hono/node-server';
import type { Hono } from 'hono';
import { WebSocket, WebSocketServer } from 'ws';

import type { TerminalBackend } from '../../adapters/terminal-backend.js';
import {
  asTerminalInputWriterPort,
  type TerminalInputWriterPort,
} from '../../core/ports/terminal-input-writer-port.js';
import { HOOK_EVENTS, LOAD_BEARING_HOOKS } from '../../core/hook-spec.js';
import { handleTerminalInput, handleTerminalKeystroke, type TerminalInputDeps } from '../agent-lifecycle.js';
import { FakeTerminalBridge } from '../fake-terminal-bridge.js';
import { SessionBridge } from '../session-bridge.js';
import {
  isLoopbackUpgradeOriginAllowed,
  resolveUpgradeIdentity,
  type ApiAuthConfig,
  type Actor,
} from '../auth.js';
import type { SocketRegistrar } from '../viewer-connection-registry.js';
import type { IsActorAllowedTerminalSession } from '../terminal-scope.js';

export interface HttpAndWebSocketsDeps {
  app: Hono;
  port: number;
  host: string;
  tasksFile: string;
  hooksDir: string;
  terminalBackend: TerminalBackend;
  terminalInputWriter?: TerminalInputWriterPort;
  terminalDeps: TerminalInputDeps;
  useFakeTerminalBridge?: boolean;
  /**
   * Resolved API-token auth posture (issue #708). When `required` is true (a
   * non-loopback bind), every WebSocket upgrade must present a valid credential
   * — a bearer token (CLI) or the session cookie (browser); #802 removed the
   * `?token=` query branch — or the socket is rejected with a 401 handshake.
   * Absent/`required: false` accepts all upgrades (loopback).
   */
  apiAuth?: ApiAuthConfig;
  onLocalTerminalActivity?: (sessionId: string) => void;
  onDashboardConnection: (ws: WebSocket) => void;
  /**
   * Registry that owns the terminal socket pool (#805). When present, every
   * terminal socket is registered here on open (`actor` + `sessionName`) and
   * unregistered on close, so the revocation sweep can drop or re-check viewer
   * sockets by `grantId` (#807, R5/F1). Optional — when absent (most tests) the
   * bridge still works, it just isn't swept.
   */
  terminalRegistrar?: SocketRegistrar;
  /**
   * Resolve the actor for a terminal upgrade (#807 seam). Read-only viewer
   * bridges are constructed when this returns `{ kind: 'viewer' }`.
   *
   * SECURITY: the live viewer-cookie resolution stays deferred to the
   * `resolveViewer` security gate (#808/#809) — admitting a viewer cookie onto a
   * terminal stream ahead of the scope check (#810) and scoped fan-out (#809)
   * would be a fail-open. Until that lands this is left unset, so every terminal
   * socket resolves to the owner and the read-only path is exercised only by
   * synthetic viewer actors in tests. The seam exists so #810 can plug the
   * cookie→actor resolution in one place.
   */
  resolveTerminalActor?: (req: IncomingMessage) => Actor;
  /**
   * Terminal scope gate (#810). Owns the WHOLE check — session→task lookup AND
   * scope comparison — so this handler holds zero scope logic. Called at the
   * terminal upgrade with the resolved actor + session name; a `false` verdict
   * is a 403 handshake (logged `{ grantId, sessionName, reason: 'out-of-scope' }`)
   * before any socket is created. Owners always pass. Optional — when absent
   * (most tests) every upgrade is admitted, matching pre-#810 behaviour.
   */
  isActorAllowedTerminalSession?: IsActorAllowedTerminalSession;
}

export interface HttpAndWebSocketsCloseOptions {
  gracefulShutdownMs?: number;
}

export interface HttpAndWebSockets {
  httpServer: Server;
  wss: WebSocketServer;
  terminalWss: WebSocketServer;
  activeBridges: Map<WebSocket, FakeTerminalBridge | SessionBridge>;
  close(options?: HttpAndWebSocketsCloseOptions): Promise<void>;
}

const DEFAULT_GRACEFUL_WEBSOCKET_SHUTDOWN_MS = 1_000;
const SHUTDOWN_CLOSE_CODE = 1001;
const SHUTDOWN_CLOSE_REASON = 'Server shutting down';

function terminateOpenWebSockets(wss: WebSocketServer): void {
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.CLOSED) {
      ws.terminate();
    }
  }
}

function closeWebSocketServer(
  wss: WebSocketServer,
  gracefulShutdownMs: number,
): Promise<void> {
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(SHUTDOWN_CLOSE_CODE, SHUTDOWN_CLOSE_REASON);
    } else if (ws.readyState !== WebSocket.CLOSED) {
      ws.terminate();
    }
  }

  return new Promise<void>((resolve) => {
    let resolved = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (forceTimer) clearTimeout(forceTimer);
      resolve();
    };
    if (wss.clients.size === 0) {
      wss.close(() => finish());
      finish();
      return;
    }
    forceTimer = setTimeout(() => {
      terminateOpenWebSockets(wss);
      finish();
    }, gracefulShutdownMs);
    forceTimer.unref?.();
    wss.close(() => finish());
  });
}

function closeHttpServer(httpServer: Server, gracefulShutdownMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let resolved = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (forceTimer) clearTimeout(forceTimer);
      resolve();
    };
    forceTimer = setTimeout(() => {
      httpServer.closeAllConnections?.();
      finish();
    }, gracefulShutdownMs);
    forceTimer.unref?.();
    httpServer.close(() => finish());
  });
}

async function closeHttpAndWebSockets(
  runtime: Pick<HttpAndWebSockets, 'httpServer' | 'wss' | 'terminalWss'>,
  options: HttpAndWebSocketsCloseOptions = {},
): Promise<void> {
  const gracefulShutdownMs = options.gracefulShutdownMs ?? DEFAULT_GRACEFUL_WEBSOCKET_SHUTDOWN_MS;
  await Promise.all([
    closeWebSocketServer(runtime.terminalWss, gracefulShutdownMs),
    closeWebSocketServer(runtime.wss, gracefulShutdownMs),
  ]);
  await closeHttpServer(runtime.httpServer, gracefulShutdownMs);
}

export async function startHttpAndWebSockets(deps: HttpAndWebSocketsDeps): Promise<HttpAndWebSockets> {
  const requestListener = getRequestListener(deps.app.fetch);
  const httpServer = createServer(requestListener);
  const wss = new WebSocketServer({ noServer: true });
  const terminalWss = new WebSocketServer({ noServer: true });
  const terminalInputWriter = deps.terminalInputWriter ?? asTerminalInputWriterPort(deps.terminalBackend);

  // Terminal context resolved ONCE at the HTTP upgrade (actor + canonical session
  // name) and consumed by the `connection` handler. Resolving once and reusing —
  // rather than re-resolving from `req` in both handlers — guarantees the scope
  // gate, the registry registration, and the read-only bridge all act on the SAME
  // actor + session-name pair (#810 review: no re-resolution drift, no
  // query-string skew between the gate's `path` and the handler's `req.url`).
  const terminalUpgrades = new WeakMap<IncomingMessage, { actor: Actor; sessionName: string }>();

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = req.url ?? '';
    // Dispatch on the pathname only — strip any query string before matching so
    // a trailing `?…` can never misroute `/ws`. (#802 removed credential-bearing
    // query params from the WS upgrade; auth now rides on header or cookie.)
    const path = url.split('?', 1)[0];

    // Issues #708/#846: reject unauthenticated non-loopback upgrades and
    // browser-origin-crossing loopback upgrades before any handshake. The
    // dashboard WS carries the full live snapshot stream and terminal I/O, so
    // it must be gated alongside state-changing HTTP routes.
    if (deps.apiAuth) {
      if (!isLoopbackUpgradeOriginAllowed(deps.apiAuth, req)) {
        console.warn(JSON.stringify({
          event: 'auth_rejected',
          reason: 'cross_origin',
          remoteAddr: req.socket.remoteAddress ?? null,
        }));
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const upgradeActor = resolveUpgradeIdentity(deps.apiAuth, req);
      if (!upgradeActor) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      // #809 removed the Phase-1 `projects`-scope WS-upgrade guard: the
      // scope-filtered snapshot fan-out (`buildScopedSnapshot`) now ships, so the
      // dashboard channel is serviceable for a `projects` viewer and the upgrade
      // handler holds **zero** scope logic (RFC boundary goal). Per-channel scope
      // enforcement lives where the data is produced: `buildScopedSnapshot` for
      // the dashboard snapshot and `isActorAllowedTerminalSession` for the
      // terminal stream (#810). NOTE: live viewer admission still depends on the
      // `resolveViewer`/`resolveTerminalActor` seam, which stays **deferred until
      // the #810 terminal scope check lands** — admitting a viewer cookie onto a
      // terminal socket before that check is a fail-open.
    }

    if (path === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else if (path.startsWith('/ws/terminal/')) {
      // #810 terminal scope gate. Resolve the actor + canonical (query-stripped)
      // session name ONCE here and let the injected predicate own the whole
      // decision (session→task lookup + scope comparison). An out-of-scope viewer
      // is rejected with a 403 BEFORE the handshake, so no read-only bridge is
      // ever created for a session the grant cannot reach. Owners (the default
      // when `resolveTerminalActor` is unset) always pass. Both the actor
      // resolution and the predicate run under one try/catch that fails CLOSED:
      // an uncaught throw in an `upgrade` listener would crash the process, and a
      // garbage cookie parsed by a future `resolveTerminalActor` must yield a 403,
      // not a DoS.
      const sessionName = decodeURIComponent(path.replace('/ws/terminal/', ''));
      let terminalActor: Actor = { kind: 'owner' };
      let denied = false;
      try {
        terminalActor = deps.resolveTerminalActor?.(req) ?? { kind: 'owner' };
        denied = deps.isActorAllowedTerminalSession
          ? !deps.isActorAllowedTerminalSession(terminalActor, sessionName)
          : false;
      } catch (err) {
        denied = true;
        console.warn('[terminal-scope] upgrade gate threw; denying', err);
      }
      if (denied) {
        console.warn(
          JSON.stringify({
            msg: 'terminal_upgrade_denied',
            grantId: terminalActor.kind === 'viewer' ? terminalActor.grantId : undefined,
            sessionName,
            reason: 'out-of-scope',
          }),
        );
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      // Hand the vetted actor + canonical session name to the connection handler
      // so the registry registration and the read-only bridge use exactly what the
      // gate just cleared.
      terminalUpgrades.set(req, { actor: terminalActor, sessionName });
      terminalWss.handleUpgrade(req, socket, head, (ws) => {
        terminalWss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  const activeBridges = new Map<WebSocket, FakeTerminalBridge | SessionBridge>();

  terminalWss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Reuse the actor + canonical session name vetted by the upgrade scope gate
    // (#810). The fallback (gate not run — e.g. a directly-emitted connection in a
    // test) re-derives from the query-stripped path so the two paths stay
    // byte-identical; the actor still defaults to owner there.
    const ctx = terminalUpgrades.get(req);
    terminalUpgrades.delete(req);
    const sessionName =
      ctx?.sessionName ??
      decodeURIComponent((req.url ?? '').split('?', 1)[0].replace('/ws/terminal/', ''));

    if (!sessionName) {
      ws.close(1008, 'Missing session name');
      return;
    }

    // The actor was resolved once at the upgrade (see SECURITY note on
    // `resolveTerminalActor`); viewer sockets are output-only. Defaults to owner.
    const actor: Actor = ctx?.actor ?? deps.resolveTerminalActor?.(req) ?? { kind: 'owner' };
    const readOnly = actor.kind === 'viewer';

    // Register the terminal socket with the connection registry (#805/#807) so
    // the revocation sweep can drop or re-check it by grantId. Owner sockets are
    // registered too (the registry owns the whole terminal pool); they are never
    // swept.
    deps.terminalRegistrar?.register(ws, actor, 'terminal', { sessionName });

    void (async () => {
      const bridgeKind: 'fake' | 'session' = deps.useFakeTerminalBridge ? 'fake' : 'session';
      console.log(`Terminal bridge opened for ${sessionName} (kind=${bridgeKind}, readOnly=${readOnly})`);

      if (bridgeKind === 'fake') {
        const content = FakeTerminalBridge.getContent(sessionName);
        const bridge = new FakeTerminalBridge(sessionName, ws, content, terminalInputWriter, { readOnly });
        activeBridges.set(ws, bridge);
        bridge.start();
        return;
      }

      const sb = new SessionBridge(
        sessionName,
        ws,
        deps.terminalBackend,
        terminalInputWriter,
        (id) => {
          deps.onLocalTerminalActivity?.(id);
          handleTerminalInput(deps.terminalDeps, id);
        },
        (id) => {
          deps.onLocalTerminalActivity?.(id);
          handleTerminalKeystroke(deps.terminalDeps, id);
        },
        { readOnly },
      );
      activeBridges.set(ws, sb);
      sb.start().catch((err) => {
        console.error(`[session-bridge] attach failed for ${sessionName}:`, err);
      });
    })();

    ws.on('close', () => {
      console.log(`Terminal bridge closed for ${sessionName}`);
      activeBridges.delete(ws);
      deps.terminalRegistrar?.unregister(ws);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    deps.onDashboardConnection(ws);
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(deps.port, deps.host, () => {
      console.log(`Kookr server listening on http://${deps.host}:${deps.port}`);
      console.log(`WebSocket endpoint: ws://${deps.host}:${deps.port}/ws`);
      console.log(`Task file: ${deps.tasksFile}`);
      console.log(`Hook files: ${deps.hooksDir}`);
      console.log(
        JSON.stringify({
          msg: 'hooks_inventory_loaded',
          eventCount: HOOK_EVENTS.length,
          loadBearingCount: LOAD_BEARING_HOOKS.size,
        }),
      );
      console.log('\nManaged agents run under dtach sessions prefixed with "kookr-".');
      console.log('Attach a Kookr-managed terminal through the dashboard terminal panel.\n');
      resolve();
    });
  });

  let closePromise: Promise<void> | undefined;
  const runtime = { httpServer, wss, terminalWss, activeBridges };
  return {
    ...runtime,
    close: (options) => {
      closePromise ??= closeHttpAndWebSockets(runtime, options);
      return closePromise;
    },
  };
}
