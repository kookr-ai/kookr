import { test, expect } from './fixtures.js';
import { injectSessionStart, injectStopEvent, resetServer } from './battle-helpers.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';

test('a slow WebSocket upgrade still streams output and accepts input', async ({ page, request, serverURL }) => {
  await resetServer(request);
  const proxy = createServer();
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const upstreams = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });
  let upgrades = 0;
  proxy.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  proxy.on('upgrade', (req, socket, head) => {
    upgrades++;
    // Delay the real HTTP upgrade, before the browser's WebSocket open event.
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (socket.destroyed) return;
      wss.handleUpgrade(req, socket, head, (browser) => {
        const upstream = new WebSocket(new URL(req.url!, serverURL.replace(/^http/, 'ws')), browser.protocol);
        upstreams.add(upstream);
        upstream.on('message', (data, isBinary) => {
          if (browser.readyState === WebSocket.OPEN) browser.send(data, { binary: isBinary });
        });
        browser.on('message', (data, isBinary) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        });
        browser.on('close', () => upstream.close());
        browser.on('error', () => upstream.close());
        upstream.on('close', () => { upstreams.delete(upstream); browser.close(); });
        upstream.on('error', () => browser.close());
      });
    }, 3000);
    timers.add(timer);
    socket.on('close', () => { clearTimeout(timer); timers.delete(timer); });
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('Missing proxy port');
  try {
    await page.addInitScript((port) => {
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          const target = new URL(url);
          if (target.pathname.startsWith('/ws/terminal/')) target.port = String(port);
          super(target, protocols);
        }
      };
    }, address.port);
    const settings = await (await request.get('/api/settings')).json();
    await request.put('/api/settings', { data: { ...settings, quotaHeadroomThreshold: 0 } });
    const response = await request.post('/api/tasks', {
      headers: { 'X-Kookr-Launch-Source': 'ui' },
      data: { prompt: 'Slow terminal connection check', cwd: '/test/terminal-recovery' },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const task = await response.json() as { sessions: Array<{ tmuxSession: string }> };
    const tmuxName = task.sessions.at(-1)!.tmuxSession;
    await request.post('/api/test/set-terminal-content', {
      data: { tmuxName, content: { text: 'Output after delayed connection', mode: 'streaming', lineDelayMs: 20 } },
    });
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName, 'Waiting for input.');
    await page.goto('/');
    await page.locator('.finding-card').first().click();
    await expect(page.locator('.xterm-rows')).toContainText('Output after delayed connection');
    await expect(page.getByTestId('terminal-attach-pending')).toHaveCount(0);
    await page.locator('.xterm-helper-textarea').press('x');
    await expect.poll(async () => {
      const result = await request.get(`/api/test/written-chunks/${tmuxName}`);
      const body = await result.json() as { chunks: Array<{ text: string }> };
      return body.chunks.filter((chunk) => chunk.text === 'x').length;
    }).toBe(1);
    expect(upgrades).toBe(1);
  } finally {
    await page.close();
    for (const timer of timers) clearTimeout(timer);
    for (const socket of wss.clients) socket.terminate();
    for (const upstream of upstreams) upstream.terminate();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});

test('a truncated terminal keeps streaming and accepting input after repeated tab switches', async ({ page, request }) => {
  await resetServer(request);
  let connections = 0;
  await page.routeWebSocket('**/ws/terminal/**', (browser) => {
    connections++;
    const server = browser.connectToServer();
    server.onMessage((message) => {
      if (typeof message === 'string') {
        const control = JSON.parse(message);
        if (control.type === 'seed-end') {
          // Captured from a live Codex viewport-ring seed: older history exists,
          // but the truncated prefix cannot certify an exact parser cursor.
          browser.send(JSON.stringify({ ...control, cursor: null, historyAvailable: true, approximate: true }));
          return;
        }
      }
      browser.send(message);
    });
  });
  const settings = await (await request.get('/api/settings')).json();
  await request.put('/api/settings', { data: { ...settings, quotaHeadroomThreshold: 0 } });
  const response = await request.post('/api/tasks', {
    headers: { 'X-Kookr-Launch-Source': 'ui' },
    data: { prompt: 'Terminal recovery check', cwd: '/test/terminal-recovery' },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const task = await response.json() as { sessions: Array<{ tmuxSession: string }> };
  const tmuxName = task.sessions.at(-1)!.tmuxSession;
  await request.post('/api/test/set-terminal-content', {
    data: { tmuxName, content: { text: 'Recovered live output', mode: 'streaming', lineDelayMs: 20 } },
  });
  await injectSessionStart(request, tmuxName);
  await injectStopEvent(request, tmuxName, 'Waiting for input.');
  await page.goto('/');
  await page.locator('.finding-card').first().click();

  for (let i = 0; i < 5; i++) {
    await expect.poll(() => connections).toBe(i + 1);
    await expect(page.getByTestId('terminal-attach-pending')).toHaveCount(0);
    await expect(page.getByText('Some earlier terminal output is unavailable.', { exact: true })).toBeVisible();
    await expect(page.locator('.xterm-rows')).toContainText('Recovered live output');
    await page.locator('.xterm-helper-textarea').press('x');
    await expect.poll(async () => {
      const result = await request.get(`/api/test/written-chunks/${tmuxName}`);
      const body = await result.json() as { chunks: Array<{ text: string }> };
      return body.chunks.filter((chunk) => chunk.text === 'x').length;
    }).toBe(i + 1);
    if (i === 4) break;
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.getByTestId('terminal-attach-pending')).toContainText('paused');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }
});
