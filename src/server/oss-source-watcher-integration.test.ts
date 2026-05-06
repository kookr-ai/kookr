import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { createKookrServerInternal } from './index.js';
import type { KookrServerInternal } from './server-test-helpers.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import type { OssSourceWatcherFs } from './oss-source-watcher.js';

type WatchListener = (eventType: string, filename: string | Buffer | null) => void;

class FakeWatchSurface {
  private listeners = new Map<string, Set<WatchListener>>();

  readonly runFs: Partial<OssSourceWatcherFs> = {
    watch: (path, _options, listener) => {
      const listeners = this.listeners.get(path) ?? new Set<WatchListener>();
      listeners.add(listener);
      this.listeners.set(path, listeners);
      return {
        close: () => listeners.delete(listener),
      } as ReturnType<OssSourceWatcherFs['watch']>;
    },
    stat,
    readdir,
  };

  emit(path: string, filename: string): void {
    for (const listener of this.listeners.get(path) ?? []) {
      listener('rename', filename);
    }
  }
}

function getActualPort(server: KookrServerInternal): number {
  const addr = server.httpServer.address();
  if (addr && typeof addr === 'object') return addr.port;
  throw new Error('Server not listening');
}

async function waitForMessage(
  messages: ServerMessage[],
  predicate: (msg: ServerMessage) => boolean,
  timeoutMs = 2000,
): Promise<ServerMessage> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for WebSocket message');
}

describe('OSS source watcher server integration', () => {
  let tempDir: string;
  let claudeDir: string;
  let server: KookrServerInternal;
  let watchSurface: FakeWatchSurface;
  let ws: WebSocket | null;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-oss-source-server-'));
    claudeDir = join(tempDir, 'claude');
    mkdirSync(claudeDir, { recursive: true });
    watchSurface = new FakeWatchSurface();
    ws = null;

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
      claudeDir,
      ossSourceWatcherFs: watchSurface.runFs,
      ossSourceWatcherDebounceMs: 10,
    });
  });

  afterEach(async () => {
    ws?.close();
    await server.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('file events reload registry and recon reports without manual routes', async () => {
    const messages: ServerMessage[] = [];
    ws = new WebSocket(`ws://127.0.0.1:${getActualPort(server)}/ws`);
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()) as ServerMessage);
    });
    await new Promise<void>((resolve) => ws!.once('open', () => resolve()));

    const registryPath = join(tempDir, 'oss-repos.json');
    writeFileSync(
      registryPath,
      JSON.stringify({ version: 1, repos: { 'grafana/grafana': { status: 'active' } } }),
    );
    watchSurface.emit(tempDir, 'oss-repos.json');

    const ossMessage = await waitForMessage(
      messages,
      (msg) => msg.type === 'ossAttempts' && msg.store.registryActiveRepos.includes('grafana/grafana'),
    );
    expect(ossMessage.type).toBe('ossAttempts');

    const reconDir = join(claudeDir, 'BerriAI-litellm-recon');
    mkdirSync(reconDir, { recursive: true });
    writeFileSync(
      join(reconDir, 'recon-report.md'),
      [
        '---',
        'repo: BerriAI/litellm',
        '---',
        '',
        '# Recon Report: BerriAI/litellm',
      ].join('\n'),
    );
    watchSurface.emit(claudeDir, 'BerriAI-litellm-recon');

    const projectMessage = await waitForMessage(
      messages,
      (msg) => msg.type === 'projectSummaries'
        && msg.projects.some((project) => project.project === 'github.com/berriai/litellm'),
    );
    expect(projectMessage.type).toBe('projectSummaries');
  });
});
