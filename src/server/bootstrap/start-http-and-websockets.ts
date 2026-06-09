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
import { resolveUpgradeIdentity, type ApiAuthConfig, type Actor } from '../auth.js';
import type { SocketRegistrar } from '../viewer-connection-registry.js';

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

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = req.url ?? '';
    // Dispatch on the pathname only — strip any query string before matching so
    // a trailing `?…` can never misroute `/ws`. (#802 removed credential-bearing
    // query params from the WS upgrade; auth now rides on header or cookie.)
    const path = url.split('?', 1)[0];

    // Issue #708: on a non-loopback bind, reject unauthenticated upgrades before
    // any handshake. The dashboard WS carries the full live snapshot stream and
    // terminal I/O, so it must be gated alongside state-changing HTTP routes.
    if (deps.apiAuth) {
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
      terminalWss.handleUpgrade(req, socket, head, (ws) => {
        terminalWss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  const activeBridges = new Map<WebSocket, FakeTerminalBridge | SessionBridge>();

  terminalWss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = req.url ?? '';
    const sessionName = decodeURIComponent(url.replace('/ws/terminal/', ''));

    if (!sessionName) {
      ws.close(1008, 'Missing session name');
      return;
    }

    // Resolve the actor for this terminal upgrade. Defaults to owner — viewer
    // cookie resolution is deferred to the resolveViewer security gate (see the
    // SECURITY note on `resolveTerminalActor`). Viewer sockets are output-only.
    const actor: Actor = deps.resolveTerminalActor?.(req) ?? { kind: 'owner' };
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
