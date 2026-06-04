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
import { isAuthorizedUpgrade, type ApiAuthConfig } from '../auth.js';

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
   * non-loopback bind), every WebSocket upgrade must present a valid bearer
   * token (header or `?token=` query param) or the socket is rejected with a
   * 401 handshake. Absent/`required: false` accepts all upgrades (loopback).
   */
  apiAuth?: ApiAuthConfig;
  onLocalTerminalActivity?: (sessionId: string) => void;
  onDashboardConnection: (ws: WebSocket) => void;
}

export interface HttpAndWebSockets {
  httpServer: Server;
  wss: WebSocketServer;
  terminalWss: WebSocketServer;
  activeBridges: Map<WebSocket, FakeTerminalBridge | SessionBridge>;
}

export async function startHttpAndWebSockets(deps: HttpAndWebSocketsDeps): Promise<HttpAndWebSockets> {
  const requestListener = getRequestListener(deps.app.fetch);
  const httpServer = createServer(requestListener);
  const wss = new WebSocketServer({ noServer: true });
  const terminalWss = new WebSocketServer({ noServer: true });
  const terminalInputWriter = deps.terminalInputWriter ?? asTerminalInputWriterPort(deps.terminalBackend);

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = req.url ?? '';
    // Dispatch on the pathname only — the auth token may ride on a `?token=`
    // query string (browsers cannot set WS handshake headers), so an exact
    // `url === '/ws'` check would misroute an authenticated `/ws?token=...`.
    const path = url.split('?', 1)[0];

    // Issue #708: on a non-loopback bind, reject unauthenticated upgrades before
    // any handshake. The dashboard WS carries the full live snapshot stream and
    // terminal I/O, so it must be gated alongside state-changing HTTP routes.
    if (deps.apiAuth && !isAuthorizedUpgrade(deps.apiAuth, req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
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

    void (async () => {
      const bridgeKind: 'fake' | 'session' = deps.useFakeTerminalBridge ? 'fake' : 'session';
      console.log(`Terminal bridge opened for ${sessionName} (kind=${bridgeKind})`);

      if (bridgeKind === 'fake') {
        const content = FakeTerminalBridge.getContent(sessionName);
        const bridge = new FakeTerminalBridge(sessionName, ws, content, terminalInputWriter);
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
      );
      activeBridges.set(ws, sb);
      sb.start().catch((err) => {
        console.error(`[session-bridge] attach failed for ${sessionName}:`, err);
      });
    })();

    ws.on('close', () => {
      console.log(`Terminal bridge closed for ${sessionName}`);
      activeBridges.delete(ws);
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

  return { httpServer, wss, terminalWss, activeBridges };
}
