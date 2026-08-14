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
import {
  DASHBOARD_WEBSOCKET_MAX_PAYLOAD_BYTES,
  startHttpAndWebSockets,
  TERMINAL_WEBSOCKET_MAX_PAYLOAD_BYTES,
  WEBSOCKET_PER_MESSAGE_DEFLATE,
  type HttpAndWebSockets,
} from './start-http-and-websockets.js';

describe('startHttpAndWebSockets', () => {
  let runtime: HttpAndWebSockets | undefined;

  afterEach(async () => {
    try {
      if (runtime) {
        await runtime.close({ gracefulShutdownMs: 10 });
      }
    } finally {
      runtime = undefined;
      vi.restoreAllMocks();
    }
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

  function upgradeStatus(
    port: number,
    path: string,
    headers: Record<string, string> = {},
  ): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
      ws.on('open', () => {
        if (settled) return;
        settled = true;
        ws.close();
        resolve(101);
      });
      ws.on('unexpected-response', (_req, res) => {
        if (settled) return;
        settled = true;
        resolve(res.statusCode ?? 0);
        res.resume();
      });
      ws.on('error', (err) => {
        if (settled) return;
        settled = true;
        reject(err);
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

  test('configures dashboard and terminal WebSocket resource limits explicitly', async () => {
    runtime = await startHttpAndWebSockets({
      app: new Hono(),
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
      onDashboardConnection: (ws) => ws.close(),
    });

    expect(runtime.wss.options.perMessageDeflate).toEqual(WEBSOCKET_PER_MESSAGE_DEFLATE);
    expect(runtime.terminalWss.options.perMessageDeflate).toEqual(WEBSOCKET_PER_MESSAGE_DEFLATE);
    expect(runtime.wss.options.maxPayload).toBe(DASHBOARD_WEBSOCKET_MAX_PAYLOAD_BYTES);
    expect(runtime.terminalWss.options.maxPayload).toBe(TERMINAL_WEBSOCKET_MAX_PAYLOAD_BYTES);
    expect(runtime.wss.options.perMessageDeflate).toMatchObject({
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
      concurrencyLimit: 10,
      threshold: 1024,
    });
  });

  test.each([
    {
      label: 'dashboard',
      path: '/ws',
      maxPayload: DASHBOARD_WEBSOCKET_MAX_PAYLOAD_BYTES,
    },
    {
      label: 'terminal',
      path: '/ws/terminal/kookr-test-session',
      maxPayload: TERMINAL_WEBSOCKET_MAX_PAYLOAD_BYTES,
    },
  ])('closes $label WebSockets that exceed the inbound frame limit', async ({ path, maxPayload }) => {
    runtime = await startHttpAndWebSockets({
      app: new Hono(),
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

    const ws = new WebSocket(`ws://127.0.0.1:${portFor(runtime)}${path}`);
    const closeCode = await new Promise<number>((resolve, reject) => {
      ws.on('open', () => ws.send(Buffer.alloc(maxPayload + 1)));
      ws.on('close', (code) => resolve(code));
      ws.on('error', reject);
    });

    expect(closeCode).toBe(1009);
  });

  test('logs dashboard WebSocket connect and disconnect lifecycle events', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const dashboardConnections: WebSocket[] = [];
    runtime = await startHttpAndWebSockets({
      app: new Hono(),
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
      },
    });

    const port = portFor(runtime);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    const closeCode = 4001;
    const closeReason = 'client requested close';
    const clientClosed = new Promise<void>((resolve, reject) => {
      ws.on('close', () => resolve());
      ws.on('error', reject);
    });
    ws.close(closeCode, closeReason);
    await clientClosed;

    let structuredLogs: Record<string, unknown>[] = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      structuredLogs = logSpy.mock.calls.flatMap(([line]) => {
        if (typeof line !== 'string') return [];
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
      if (structuredLogs.some((entry) => entry.msg === 'dashboard_ws_disconnected')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const connected = structuredLogs.find((entry) => entry.msg === 'dashboard_ws_connected');
    const disconnected = structuredLogs.find((entry) => entry.msg === 'dashboard_ws_disconnected');

    expect(dashboardConnections).toHaveLength(1);
    expect(connected).toBeDefined();
    expect(disconnected).toBeDefined();
    expect(connected?.clientId).toMatch(/^dashboard-ws-\d+$/);
    expect(disconnected?.clientId).toBe(connected?.clientId);
    expect(disconnected?.code).toBe(closeCode);
    expect(disconnected?.reason).toBe(closeReason);
    expect(typeof disconnected?.durationMs).toBe('number');
    expect(disconnected?.durationMs as number).toBeGreaterThanOrEqual(0);
    expect(disconnected?.durationMs as number).toBeLessThan(5_000);
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

    // #809 removed the Phase-1 `projects`-scope WS-upgrade guard: the upgrade now
    // holds zero scope logic and both `all`- and `projects`-scoped viewers are
    // admitted at the handshake; scope enforcement moved to `buildScopedSnapshot`
    // (dashboard) and the #810 terminal scope check. Drive both through a real
    // upgrade with a `resolveViewer` seam standing in for the (still-deferred)
    // live wiring.
    async function startGatedWithViewer(): Promise<{ port: number; dashboardConnections: WebSocket[] }> {
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
        apiAuth: {
          required: true,
          token: 'secret',
          resolveViewer: (token) => {
            if (token === 'viewer-all') return { kind: 'valid', grantId: 'ga', scope: { kind: 'all' } };
            if (token === 'viewer-projects') {
              return { kind: 'valid', grantId: 'gp', scope: { kind: 'projects', projectIds: ['p1'] } };
            }
            return { kind: 'not-found' };
          },
        },
        onDashboardConnection: (ws) => {
          dashboardConnections.push(ws);
          ws.close();
        },
      });
      const address = runtime.httpServer.address();
      return { port: (address as { port: number }).port, dashboardConnections };
    }

    test('admits a projects-scoped viewer upgrade (#809 removed the Phase-1 guard)', async () => {
      const { port, dashboardConnections } = await startGatedWithViewer();
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { cookie: 'kookr_session=viewer-projects' },
      });
      await new Promise<void>((resolve, reject) => {
        ws.on('close', () => resolve());
        ws.on('error', reject);
      });
      expect(dashboardConnections).toHaveLength(1);
    });

    test('admits an all-scoped viewer upgrade', async () => {
      const { port, dashboardConnections } = await startGatedWithViewer();
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { cookie: 'kookr_session=viewer-all' },
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

  describe('WebSocket loopback origin gate (#846)', () => {
    async function startLoopbackGated(): Promise<{ port: number; dashboardConnections: WebSocket[] }> {
      const app = new Hono();
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
        useFakeTerminalBridge: true,
        apiAuth: { required: false },
        onDashboardConnection: (ws) => {
          dashboardConnections.push(ws);
          ws.close();
        },
      });
      return { port: portFor(runtime), dashboardConnections };
    }

    test('rejects a cross-origin dashboard WebSocket on a token-free loopback bind', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { port, dashboardConnections } = await startLoopbackGated();
      const status = await upgradeStatus(port, '/ws', { origin: 'http://evil.example' });
      expect(status).toBe(403);
      expect(dashboardConnections).toHaveLength(0);
    });

    test('rejects a cross-origin terminal WebSocket on a token-free loopback bind', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { port } = await startLoopbackGated();
      const status = await upgradeStatus(port, '/ws/terminal/kookr-test-session', {
        origin: 'http://evil.example',
      });
      expect(status).toBe(403);
      expect(runtime?.activeBridges.size).toBe(0);
    });

    test('allows headerless and same-origin WebSocket upgrades on loopback', async () => {
      const { port, dashboardConnections } = await startLoopbackGated();
      expect(await upgradeStatus(port, '/ws')).toBe(101);
      await new Promise((r) => setTimeout(r, 20));
      expect(dashboardConnections).toHaveLength(1);

      expect(await upgradeStatus(port, '/ws/terminal/kookr-test-session', {
        origin: `http://127.0.0.1:${port}`,
      })).toBe(101);
    });

    test('rejects cross-site fetch metadata on loopback WebSocket upgrades', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { port } = await startLoopbackGated();
      const status = await upgradeStatus(port, '/ws', {
        origin: `http://127.0.0.1:${port}`,
        'sec-fetch-site': 'cross-site',
      });
      expect(status).toBe(403);
    });

    test('allows Sec-Fetch-Site:none on loopback WebSocket upgrades', async () => {
      const { port, dashboardConnections } = await startLoopbackGated();
      const status = await upgradeStatus(port, '/ws', {
        'sec-fetch-site': 'none',
      });
      expect(status).toBe(101);
      await new Promise((r) => setTimeout(r, 20));
      expect(dashboardConnections).toHaveLength(1);
    });

    test('rejects same-origin browser signals on rebound hostnames', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { port, dashboardConnections } = await startLoopbackGated();
      const status = await upgradeStatus(port, '/ws', {
        host: `evil.example:${port}`,
        origin: `http://evil.example:${port}`,
        'sec-fetch-site': 'same-origin',
      });
      expect(status).toBe(403);
      expect(dashboardConnections).toHaveLength(0);
    });

    test('escape hatch allows a mismatched browser Origin on loopback', async () => {
      const app = new Hono();
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
        apiAuth: { required: false, originGateDisabled: true },
        onDashboardConnection: (ws) => {
          dashboardConnections.push(ws);
          ws.close();
        },
      });
      const status = await upgradeStatus(portFor(runtime), '/ws', {
        origin: 'http://evil.example',
      });
      expect(status).toBe(101);
      expect(dashboardConnections).toHaveLength(1);
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

  // #810: terminal stream scope gate. A project-scoped viewer attempting to
  // attach to a terminal whose task is out of scope is rejected with a 403 at
  // the upgrade — before any bridge is created. Owners and in-scope sessions
  // pass. The injected predicate owns the whole decision; the handler only acts
  // on its verdict.
  describe('terminal scope gate (#810)', () => {
    const IN_SCOPE = 'kookr-in-scope';
    const OUT_OF_SCOPE = 'kookr-out-of-scope';
    const projectsViewer: Actor = { kind: 'viewer', grantId: 'gp', scope: { kind: 'projects', projectIds: ['p1'] } };

    async function startWithScopeGate(actor: Actor): Promise<{ port: number; register: ReturnType<typeof vi.fn> }> {
      const register = vi.fn();
      const registrar: SocketRegistrar = { register, unregister: vi.fn() };
      runtime = await startHttpAndWebSockets({
        app: new Hono(),
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
        terminalRegistrar: registrar,
        resolveTerminalActor: () => actor,
        // Stand-in scope checker: only IN_SCOPE is reachable by the viewer.
        isActorAllowedTerminalSession: (a, sessionName) =>
          a.kind === 'owner' || sessionName === IN_SCOPE,
        onDashboardConnection: () => {},
      });
      return { port: portFor(runtime), register };
    }

    test('rejects an out-of-scope viewer terminal upgrade with 403 and creates no bridge', async () => {
      const { port, register } = await startWithScopeGate(projectsViewer);
      const status = await upgradeStatus(port, `/ws/terminal/${OUT_OF_SCOPE}`);
      expect(status).toBe(403);
      // No handshake ⇒ no registration, no bridge.
      await new Promise((r) => setTimeout(r, 20));
      expect(register).not.toHaveBeenCalled();
      expect(runtime?.activeBridges.size).toBe(0);
    });

    test('admits an in-scope viewer terminal upgrade', async () => {
      const { port, register } = await startWithScopeGate(projectsViewer);
      const status = await upgradeStatus(port, `/ws/terminal/${IN_SCOPE}`);
      expect(status).toBe(101);
      await new Promise((r) => setTimeout(r, 20));
      expect(register).toHaveBeenCalledTimes(1);
    });

    test('owners always pass the scope gate', async () => {
      const { port, register } = await startWithScopeGate({ kind: 'owner' });
      const status = await upgradeStatus(port, `/ws/terminal/${OUT_OF_SCOPE}`);
      expect(status).toBe(101);
      await new Promise((r) => setTimeout(r, 20));
      expect(register).toHaveBeenCalledTimes(1);
    });

    test('the gate and the registration use the same query-stripped session name', async () => {
      const register = vi.fn();
      const seenByGate: string[] = [];
      const registrar: SocketRegistrar = { register, unregister: vi.fn() };
      runtime = await startHttpAndWebSockets({
        app: new Hono(),
        port: 0,
        host: '127.0.0.1',
        tasksFile: '/tmp/tasks.json',
        hooksDir: '/tmp/hooks',
        terminalBackend: new FakeTerminalBackend(),
        terminalDeps: { monitor: {} as never, abortPendingSuggestion: () => {}, broadcastToAll: () => {}, serverCwd: '/repo' },
        useFakeTerminalBridge: true,
        terminalRegistrar: registrar,
        resolveTerminalActor: () => projectsViewer,
        isActorAllowedTerminalSession: (_a, sessionName) => {
          seenByGate.push(sessionName);
          return sessionName === IN_SCOPE; // allow only the canonical name
        },
        onDashboardConnection: () => {},
      });
      const port = portFor(runtime);
      // A query string must not let the registered session name diverge from the
      // name the gate vetted (else the bridge attaches to a name never checked).
      const status = await upgradeStatus(port, `/ws/terminal/${IN_SCOPE}?x=1`);
      expect(status).toBe(101);
      await new Promise((r) => setTimeout(r, 20));
      expect(seenByGate).toEqual([IN_SCOPE]);
      expect(register).toHaveBeenCalledTimes(1);
      expect(register.mock.calls[0][3]).toEqual({ sessionName: IN_SCOPE });
    });

    test('fail-closed: a throwing scope predicate yields a 403, not a crash', async () => {
      const register = vi.fn();
      const registrar: SocketRegistrar = { register, unregister: vi.fn() };
      runtime = await startHttpAndWebSockets({
        app: new Hono(),
        port: 0,
        host: '127.0.0.1',
        tasksFile: '/tmp/tasks.json',
        hooksDir: '/tmp/hooks',
        terminalBackend: new FakeTerminalBackend(),
        terminalDeps: { monitor: {} as never, abortPendingSuggestion: () => {}, broadcastToAll: () => {}, serverCwd: '/repo' },
        useFakeTerminalBridge: true,
        terminalRegistrar: registrar,
        resolveTerminalActor: () => projectsViewer,
        isActorAllowedTerminalSession: () => {
          throw new Error('scope lookup blew up');
        },
        onDashboardConnection: () => {},
      });
      const port = portFor(runtime);
      const status = await upgradeStatus(port, `/ws/terminal/${IN_SCOPE}`);
      expect(status).toBe(403);
      await new Promise((r) => setTimeout(r, 20));
      expect(register).not.toHaveBeenCalled();
    });
  });

  // Issue #2132: the `/ws/terminal/:sessionName` upgrade must validate the
  // decoded session name against the shared `^[A-Za-z0-9_-]{1,128}$` allow-list
  // BEFORE any handshake, so a traversal-bearing name (`..%2f..%2ffoo` →
  // `../../foo`) never becomes a bridge or a per-instance filesystem path
  // (`${id}.sock` / `${id}.bin`). The raw-socket helper sends the path verbatim
  // (no client-side URL normalization) so the server-side decode + regex is what
  // the assertion exercises.
  describe('terminal session-name allow-list (#2132)', () => {
    // Open a raw socket, send a WS upgrade for `path` verbatim, and resolve the
    // numeric HTTP status of the (non-101) response — the pre-handshake reject.
    function rawUpgradeStatus(port: number, path: string): Promise<number> {
      return new Promise<number>((resolve, reject) => {
        let settled = false;
        const socket = createConnection({ host: '127.0.0.1', port }, () => {
          const key = randomBytes(16).toString('base64');
          socket.write(
            [
              `GET ${path} HTTP/1.1`,
              `Host: 127.0.0.1:${port}`,
              'Upgrade: websocket',
              'Connection: Upgrade',
              `Sec-WebSocket-Key: ${key}`,
              'Sec-WebSocket-Version: 13',
              '',
              '',
            ].join('\r\n'),
          );
        });
        let response = '';
        const done = (n: number) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve(n);
        };
        socket.on('error', (err) => {
          if (settled) return;
          settled = true;
          reject(err);
        });
        socket.on('data', (chunk) => {
          response += chunk.toString('latin1');
          if (!response.includes('\r\n')) return;
          const match = /^HTTP\/1\.1 (\d{3})/.exec(response);
          if (match) done(Number(match[1]));
        });
      });
    }

    async function startWithRegistrar(): Promise<{ port: number; register: ReturnType<typeof vi.fn> }> {
      const register = vi.fn();
      const registrar: SocketRegistrar = { register, unregister: vi.fn() };
      runtime = await startHttpAndWebSockets({
        app: new Hono(),
        port: 0,
        host: '127.0.0.1',
        tasksFile: '/tmp/tasks.json',
        hooksDir: '/tmp/hooks',
        terminalBackend: new FakeTerminalBackend(),
        terminalDeps: { monitor: {} as never, abortPendingSuggestion: () => {}, broadcastToAll: () => {}, serverCwd: '/repo' },
        useFakeTerminalBridge: true,
        terminalRegistrar: registrar,
        onDashboardConnection: () => {},
      });
      return { port: portFor(runtime), register };
    }

    test('rejects a `..`-bearing terminal name pre-handshake with 400 and creates no bridge', async () => {
      const { port, register } = await startWithRegistrar();
      // `..%2f..%2ffoo` decodes to `../../foo` — a path-traversal primitive.
      const status = await rawUpgradeStatus(port, '/ws/terminal/..%2f..%2ffoo');
      expect(status).toBe(400);
      await new Promise((r) => setTimeout(r, 20));
      expect(register).not.toHaveBeenCalled();
      expect(runtime?.activeBridges.size).toBe(0);
    });

    test('rejects a name with a path separator pre-handshake', async () => {
      const { port, register } = await startWithRegistrar();
      const status = await rawUpgradeStatus(port, '/ws/terminal/foo%2Fbar');
      expect(status).toBe(400);
      await new Promise((r) => setTimeout(r, 20));
      expect(register).not.toHaveBeenCalled();
    });

    test('rejects a malformed percent-escape and keeps serving later upgrades', async () => {
      const { port, register } = await startWithRegistrar();
      // A lone `%` makes `decodeURIComponent` throw a URIError; the guard must
      // treat it as a rejection, not let it escape the `upgrade` listener (which
      // would crash the process). Prove the listener survived by driving a valid
      // upgrade on the same server afterwards.
      const status = await rawUpgradeStatus(port, '/ws/terminal/%');
      expect(status).toBe(400);
      const after = await rawUpgradeStatus(port, '/ws/terminal/kookr-still-alive');
      expect(after).toBe(101);
      await new Promise((r) => setTimeout(r, 20));
      expect(register).toHaveBeenCalledTimes(1);
    });

    test('rejects an empty session name pre-handshake (was a post-handshake 1008 close)', async () => {
      // Before #2132 an empty name completed the handshake (101) and was closed
      // 1008 by the connection handler; now the allow-list's {1,128} lower bound
      // rejects it at the upgrade, before any bridge.
      const { port, register } = await startWithRegistrar();
      const status = await rawUpgradeStatus(port, '/ws/terminal/');
      expect(status).toBe(400);
      await new Promise((r) => setTimeout(r, 20));
      expect(register).not.toHaveBeenCalled();
    });

    test('enforces the 128-char length bound (128 admitted, 129 rejected)', async () => {
      const { port, register } = await startWithRegistrar();
      const ok = 'a'.repeat(128);
      const tooLong = 'a'.repeat(129);
      expect(await rawUpgradeStatus(port, `/ws/terminal/${tooLong}`)).toBe(400);
      expect(await rawUpgradeStatus(port, `/ws/terminal/${ok}`)).toBe(101);
      await new Promise((r) => setTimeout(r, 20));
      // Only the 128-char name registered.
      expect(register).toHaveBeenCalledTimes(1);
      expect(register.mock.calls[0][3]).toEqual({ sessionName: ok });
    });

    test('admits a legitimate allow-list session name (101) and registers it', async () => {
      const { port, register } = await startWithRegistrar();
      const status = await rawUpgradeStatus(port, '/ws/terminal/kookr-test-session_01');
      expect(status).toBe(101);
      await new Promise((r) => setTimeout(r, 20));
      expect(register).toHaveBeenCalledTimes(1);
      expect(register.mock.calls[0][3]).toEqual({ sessionName: 'kookr-test-session_01' });
    });
  });
});

describe('dashboard auto-open on listen', () => {
  let openedRuntime: HttpAndWebSockets | undefined;

  afterEach(async () => {
    try {
      if (openedRuntime) {
        await openedRuntime.close({ gracefulShutdownMs: 10 });
      }
    } finally {
      openedRuntime = undefined;
      vi.restoreAllMocks();
    }
  });

  test('startHttpAndWebSockets opens the bound dashboard URL once', async () => {
    const openDashboardBrowser = vi.fn();
    openedRuntime = await startHttpAndWebSockets({
      app: new Hono(),
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
      onDashboardConnection: () => {},
      openDashboardBrowser,
    });
    const address = openedRuntime.httpServer.address();
    const port = (address as { port: number }).port;
    expect(openDashboardBrowser).toHaveBeenCalledTimes(1);
    expect(openDashboardBrowser).toHaveBeenCalledWith('127.0.0.1', port);
  });

  test('an opener throw during listen does not fail startup', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    openedRuntime = await startHttpAndWebSockets({
      app: new Hono(),
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
      onDashboardConnection: () => {},
      openDashboardBrowser: () => {
        throw new Error('opener exploded');
      },
    });
    expect(openedRuntime.httpServer.listening).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });
});
