/**
 * End-to-end wiring of the Lucy interaction log (issue #3605) through the real
 * server: a spoken summary (server side) and a browser `lucy_*` telemetry event
 * (websocket) must land in the same log, join on `clipId`, show up in the
 * summary endpoint, and stop being written when the `lucyInteractionLog`
 * setting is switched off. Only the TTS service is faked.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { createKookrServerInternal } from './index.js';
import type { KookrServerInternal } from './server-test-helpers.js';

function portOf(server: { address(): unknown }): number {
  const addr = server.address();
  if (addr && typeof addr === 'object' && 'port' in addr) return (addr as { port: number }).port;
  throw new Error('Server not listening');
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('Lucy interaction log wiring (real server, fake TTS)', () => {
  let tempDir: string;
  let tts: Server;
  let server: KookrServerInternal;
  let baseUrl: string;
  let logPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-lucy-wiring-'));
    logPath = join(tempDir, 'lucy-interactions.jsonl');
    tts = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ audioBase64: 'UklGRg==', durationMs: 1500, generationTimeMs: 5 }));
      });
    });
    await new Promise<void>((resolve) => tts.listen(0, '127.0.0.1', resolve));
    server = await createKookrServerInternal({
      port: 0,
      host: '127.0.0.1',
      kookrDir: tempDir,
      tasksFile: join(tempDir, 'tasks.json'),
      hooksDir: join(tempDir, 'hooks'),
      settingsDir: join(tempDir, 'settings'),
      serverCwd: '/test/cwd',
      frontendDir: join(tempDir, 'frontend'),
      saveIntervalMs: 600_000,
      livenessIntervalMs: 600_000,
      terminalBackend: new FakeTerminalBackend(),
      ttsUrl: `http://127.0.0.1:${portOf(tts)}`,
    });
    baseUrl = `http://127.0.0.1:${portOf(server.httpServer)}`;
  });

  afterEach(async () => {
    await server.close();
    await new Promise<void>((resolve) => tts.close(() => resolve()));
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function speak(taskId: string): Promise<{ clipId: string }> {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/speak-summary`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.clipId).toEqual(expect.any(String));
    return body;
  }

  async function summary(): Promise<any> {
    return (await fetch(`${baseUrl}/api/diagnostics/lucy-interactions/summary?days=1`)).json();
  }

  async function sendTelemetry(events: Array<Record<string, unknown>>): Promise<void> {
    const ws = new WebSocket(`ws://127.0.0.1:${portOf(server.httpServer)}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once('error', reject);
      ws.once('open', () => ws.once('message', () => resolve()));
    });
    ws.send(JSON.stringify({ type: 'telemetry', events }));
    // The summary poll below waits for the effect; give the socket a moment to flush before closing.
    await new Promise((r) => setTimeout(r, 50));
    ws.close();
    await new Promise<void>((r) => ws.once('close', () => r()));
  }

  test('speak -> ws lucy_clip_ended with that clipId -> summary shows both; switching the setting off stops writes', async () => {
    const task = server.taskStore.createTask('Fix login flow', '/project');

    const { clipId } = await speak(task.id);

    await sendTelemetry([{
      type: 'lucy_clip_ended',
      timestamp: new Date().toISOString(),
      sessionId: 'wiring-session',
      platform: 'linux',
      clipId,
      endedBy: 'user_stop',
      playedMs: 100,
      totalMs: 1000,
      smuggled: 'x'.repeat(5000),
    }]);

    const afterUi = await until(summary, (s) => s.ui.clipsEnded === 1);
    expect(afterUi.said.count).toBe(1);
    expect(afterUi.ui.clipsEnded).toBe(1);
    expect(afterUi.ui.earlyStops.count).toBe(1);
    // The early stop joined back to the spoken text through the shared clipId.
    expect(afterUi.earlyStopsWithoutText).toBe(0);
    expect(afterUi.topEarlyStopped).toHaveLength(1);

    // On disk: one said line, one ui line, only allowlisted fields, owner-only file.
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.kind).sort()).toEqual(['said', 'ui']);
    expect(lines.find((l) => l.kind === 'said').clipId).toBe(clipId);
    const uiLine = lines.find((l) => l.kind === 'ui');
    expect(uiLine.event.clipId).toBe(clipId);
    expect('smuggled' in uiLine.event).toBe(false);
    if (process.platform !== 'win32') expect(statSync(logPath).mode & 0o777).toBe(0o600);

    // Switch the setting off: a further clip is delivered but not recorded.
    const put = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lucyInteractionLog: false }),
    });
    expect(put.status).toBe(200);
    const second = await speak(task.id);
    expect(second.clipId).not.toBe(clipId);
    await sendTelemetry([{
      type: 'lucy_panel_action', timestamp: new Date().toISOString(), sessionId: 'wiring-session', platform: 'linux', action: 'move',
    }]);
    await new Promise((r) => setTimeout(r, 150));

    const after = await summary();
    expect(after.said.count).toBe(1);
    expect(after.ui.panelActions).toEqual({});
    expect(readFileSync(logPath, 'utf8').trim().split('\n')).toHaveLength(2);
  });
});
