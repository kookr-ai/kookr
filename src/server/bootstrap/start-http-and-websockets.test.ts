import { randomBytes } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';

import { afterEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { WebSocket } from 'ws';

import { FakeTerminalBackend } from '../../adapters/fake-terminal-backend.js';
import type { Actor } from '../auth.js';
import type { SocketRegistrar } from '../viewer-connection-registry.js';
import type { TerminalInputWriterPort } from '../../core/ports/terminal-input-writer-port.js';
import { startHttpAndWebSockets, type HttpAndWebSockets } from './start-http-and-websockets.js';

describe('startHttpAndWebSockets', () => {
  let runtime: HttpAndWebSockets | undefined;

  afterEach(async () => {
    if (!runtime) return;
    await runtime.close({ gracefulShutdownMs: 10 });
    runtime = undefined;
  });

  function portFor(rt: HttpAndWebSockets): number {
    const address = rt.httpServer.address();
    return (address as { port: number }).port;
  }

  async function connectRawWebSocket(port: number, path: string): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      let settled = false;
      const socket = createConnection({ host: '127.0.0.1', port }, () => {
        const key = randomBytes(16).toString('base64');
        socket.write([
          `GET ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n'));
      });
      let response = '';
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(err);
      };
      socket.on('error', fail);
      socket.on('data', (chunk) => {
        response += chunk.toString('latin1');
        if (!response.includes('\r\n\r\n')) return;
        if (!response.startsWith('HTTP/1.1 101')) {
          fail(new Error(`Expected 101 upgrade, got: ${response.split('\r\n', 1)[0]}`));
          return;
        }
        settled = true;
        socket.removeListener('error', fail);
        socket.on('error', () => {});
        resolve(socket);
      });
    });
  }

  test('starts HTTP routes and dispatches dashboard WebSocket connections', async () => {
    const app = new Hono();
    app.get('/ping', (c) => c.text('pong'));
    const dashboardConnections: WebSocket[] = [];

    runtime = await startHttpAndWebSockets({
      app,
      port: 0,
      host: '127.0.0.1',
      tasksFile: '/tmp/tasks.json',
      hooksDir: '/tmp/hooks',
      terminalBackend: new FakeTerminalBackend(),
      terminalDeps: {
        monitor: {} as never,
        abortPendingSuggestion: () => {},
        broadcastToAll: () => {},
        serverCwd: '/repo',
      },
      onDashboardConnection: (ws) => {
        dashboardConnections.push(ws);
        ws.close();
      },
    });

    const address = runtime.httpServer.address();
    expect(address && typeof address === 'object' ? address.port : 0).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${(address as { port: number }).port}/ping`);
    expect(await res.text()).toBe('pong');

    const ws = new WebSocket(`ws://127.0.0.1:${(address as { port: number }).port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.on('close', () => resolve());
      ws.on('error', reject);
    });
    expect(dashboardConnections).toHaveLength(1);
  });

  test.each([
    { label: 'dashboard', path: '/ws' },
    { label: 'terminal', path: '/ws/terminal/kookr-test-session' },
  ])('bounded shutdown force-terminates a half-open $label WebSocket', async ({ path }) => {
    const app = new Hono();
    runtime = await startHttpAndWebSockets({
      app,
      port: 0,
      host: '127.0.0.1',
      tasksFile: '/tmp/tasks.json',
      hooksDir: '/tmp/hooks',
      terminalBackend: new FakeTerminalBackend(),
      terminalDeps: {
        monitor: {} as never,
        abortPendingSuggestion: () => {},
        broadcastToAll: () => {},
        serverCwd: '/repo',
      },
      useFakeTerminalBridge: true,
      onDashboardConnection: () => {},
    });

    const rawSocket = await connectRawWebSocket(portFor(runtime), path);
    const rawSocketClosed = new Promise<void>((resolve) => rawSocket.on('close', () => resolve()));

    const startedAt = performance.now();
    await runtime.close({ gracefulShutdownMs: 25 });
    const elapsedMs = performance.now() - startedAt;
    await rawSocketClosed;
    runtime = undefined;

    expect(elapsedMs).toBeLessThan(500);
    expect(rawSocket.destroyed).toBe(true);
  });

  // Issue #708: the WS upgrade gate is the security-critical runtime path — it
  // protects the live snapshot stream + terminal I/O on a non-loopback bind.
  // Drive a real upgrade against a server configured with `apiAuth.required`.
  describe('WebSocket upgrade auth gate (non-loopback bind)', () => {
    async function startGated(): Promise<{ port: number; dashboardConnections: WebSocket[] }> {
      const app = new Hono();
      const dashboardConnections: WebSocket[] = [];
      runtime = await startHttpAndWebSockets({
        app,
        port: 0,
        host: '0.0.0.0',
        tasksFile: '/tmp/tasks.json',
        hooksDir: '/tmp/hooks',
        terminalBackend: new FakeTerminalBackend(),
        terminalDeps: {
          monitor: {} as never,
          abortPendingSuggestion: () => {},
          broadcastToAll: () => {},
          serverCwd: '/repo',
        },
        apiAuth: { required: true, token: 'secret' },
        onDashboardConnection: (ws) => {
          dashboardConnections.push(ws);
          ws.close();
        },
      });
      const address = runtime.httpServer.address();
      return { port: (address as { port: number }).port, dashboardConnections };
    }

    test('rejects an upgrade with no token', async () => {
      const { port, dashboardConnections } = await startGated();
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const err = await new Promise<Error | null>((resolve) => {
        ws.on('open', () => resolve(null));
        ws.on('error', (e) => resolve(e));
      });
      expect(err).toBeInstanceOf(Error);
      expect(dashboardConnections).toHaveLength(0);
    });

    // #802 (R7/F4): the legacy `?token=` WS query branch is removed so no token
    // rides in a WS URL. A query token is now ignored — the upgrade is rejected.
    test('rejects an upgrade carrying the token in ?token= (query branch removed)', async () => {
      const { port, dashboardConnections } = await startGated();
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=secret`);
      const err = await new Promise<Error | null>((resolve) => {
        ws.on('open', () => resolve(null));
        ws.on('error', (e) => resolve(e));
      });
      expect(err).toBeInstanceOf(Error);
      expect(dashboardConnections).toHaveLength(0);
    });

    test('accepts an upgrade with the token via the Authorization header (CLI)', async () => {
      const { port, dashboardConnections } = await startGated();
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { authorization: 'Bearer secret' },
      });
      await new Promise<void>((resolve, reject) => {
        ws.on('close', () => resolve());
        ws.on('error', reject);
      });
      expect(dashboardConnections).toHaveLength(1);
    });

    test('accepts an upgrade with the token via the session cookie (browser)', async () => {
      const { port, dashboardConnections } = await startGated();
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { cookie: 'kookr_session=secret' },
      });
      await new Promise<void>((resolve, reject) => {
        ws.on('close', () => resolve());
        ws.on('error', reject);
      });
      expect(dashboardConnections).toHaveLength(1);
    });

    test('rejects an upgrade with a wrong token', async () => {
      const { port, dashboardConnections } = await startGated();
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { authorization: 'Bearer nope' },
      });
      const err = await new Promise<Error | null>((resolve) => {
        ws.on('open', () => resolve(null));
        ws.on('error', (e) => resolve(e));
      });
      expect(err).toBeInstanceOf(Error);
      expect(dashboardConnections).toHaveLength(0);
    });
  });

  // Terminal socket registry + read-only viewer wiring — kookr #807. Terminal
  // sockets register with the connection registry (#805) so the revocation sweep
  // owns the terminal pool, and a viewer actor produces a read-only bridge whose
  // input never reaches the backend.
  describe('terminal socket registry + read-only viewer wiring (#807)', () => {
    const SESSION = 'kookr-test-session';
    const TERMINAL_PATH = `/ws/terminal/${SESSION}`;

    function makeRegistrar(): { registrar: SocketRegistrar; register: ReturnType<typeof vi.fn>; unregister: ReturnType<typeof vi.fn> } {
      const register = vi.fn();
      const unregister = vi.fn();
      return { registrar: { register, unregister }, register, unregister };
    }

    function makeWriter(): { writer: TerminalInputWriterPort; writeInput: ReturnType<typeof vi.fn> } {
      const writeInput = vi.fn().mockResolvedValue({ sessionId: SESSION, readinessVersion: 1 });
      const writer = {
        writeInput,
        writeInputSequence: vi.fn().mockResolvedValue({ sessionId: SESSION, readinessVersion: 1 }),
      } as TerminalInputWriterPort;
      return { writer, writeInput };
    }

    async function openTerminal(port: number): Promise<WebSocket> {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${TERMINAL_PATH}`);
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
      });
      return ws;
    }

    test('registers an owner terminal socket and forwards its input', async () => {
      const { registrar, register, unregister } = makeRegistrar();
      const { writer, writeInput } = makeWriter();
      runtime = await startHttpAndWebSockets({
        app: new Hono(),
        port: 0,
        host: '127.0.0.1',
        tasksFile: '/tmp/tasks.json',
        hooksDir: '/tmp/hooks',
        terminalBackend: new FakeTerminalBackend(),
        terminalInputWriter: writer,
        terminalDeps: {
          monitor: {} as never,
          abortPendingSuggestion: () => {},
          broadcastToAll: () => {},
          serverCwd: '/repo',
        },
        useFakeTerminalBridge: true,
        terminalRegistrar: registrar,
        onDashboardConnection: () => {},
      });
      const port = portFor(runtime);

      const ws = await openTerminal(port);
      // Let the registration + bridge.start() microtasks settle.
      await new Promise((r) => setTimeout(r, 20));

      expect(register).toHaveBeenCalledTimes(1);
      const [, actor, kind, meta] = register.mock.calls[0];
      expect(actor).toEqual({ kind: 'owner' });
      expect(kind).toBe('terminal');
      expect(meta).toEqual({ sessionName: SESSION });

      // Owner input flows through to the backend writer.
      ws.send('hi');
      await new Promise((r) => setTimeout(r, 20));
      expect(writeInput).toHaveBeenCalled();

      ws.close();
      await new Promise((r) => setTimeout(r, 20));
      expect(unregister).toHaveBeenCalledTimes(1);
    });

    test('a viewer actor yields a read-only bridge: input never reaches the backend', async () => {
      const { registrar, register, unregister } = makeRegistrar();
      const { writer, writeInput } = makeWriter();
      const viewer: Actor = { kind: 'viewer', grantId: 'g1', scope: { kind: 'all' } };
      runtime = await startHttpAndWebSockets({
        app: new Hono(),
        port: 0,
        host: '127.0.0.1',
        tasksFile: '/tmp/tasks.json',
        hooksDir: '/tmp/hooks',
        terminalBackend: new FakeTerminalBackend(),
        terminalInputWriter: writer,
        terminalDeps: {
          monitor: {} as never,
          abortPendingSuggestion: () => {},
          broadcastToAll: () => {},
          serverCwd: '/repo',
        },
        useFakeTerminalBridge: true,
        terminalRegistrar: registrar,
        // Synthetic viewer resolution — stands in for the deferred resolveViewer
        // security gate so the read-only path is exercised end-to-end.
        resolveTerminalActor: () => viewer,
        onDashboardConnection: () => {},
      });
      const port = portFor(runtime);

      const ws = await openTerminal(port);
      await new Promise((r) => setTimeout(r, 20));

      expect(register).toHaveBeenCalledTimes(1);
      expect(register.mock.calls[0][1]).toEqual(viewer);

      // Viewer input/resize/paste are dropped — the inbound handler was never wired.
      ws.send('hi');
      ws.send('{"type":"resize","cols":80,"rows":24}');
      ws.send(JSON.stringify({ type: 'paste', text: 'a\nb' }));
      await new Promise((r) => setTimeout(r, 20));
      expect(writeInput).not.toHaveBeenCalled();

      // The viewer socket must unregister on close — this is the seam the
      // revocation sweep (#805) relies on to drop terminal sockets by grantId.
      ws.close();
      await new Promise((r) => setTimeout(r, 20));
      expect(unregister).toHaveBeenCalledTimes(1);
    });
  });
});
