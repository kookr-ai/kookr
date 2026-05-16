import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';

import { FakeTerminalBackend } from '../../adapters/fake-terminal-backend.js';
import type { SnapshotMessage } from '../../shared/contracts/messages.js';
import { firstReadyKookrSTTEndpoint } from '../../shared/contracts/speech.js';
import { createKookrServerInternal } from '../index.js';
import type { KookrServerInternal } from '../server-test-helpers.js';

function getActualPort(server: KookrServerInternal): number {
  const addr = server.httpServer.address();
  if (addr && typeof addr === 'object') return addr.port;
  throw new Error('Server not listening');
}

describe('Phase 6 bilingual STT parity contract', () => {
  it('delivers enough SpeechCapability data for local STT when legacy snapshot fields are stripped', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'kookr-bilingual-stt-parity-'));
    const previousGroqApiKey = process.env.GROQ_API_KEY;
    const previousGeminiApiKey = process.env.GEMINI_API_KEY;
    const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    let server: KookrServerInternal | null = null;
    try {
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
        sttUrl: 'ws://127.0.0.1:8003',
        claudeDir: join(tempDir, 'claude'),
      });

      const dashboard = new WebSocket(`ws://127.0.0.1:${getActualPort(server)}/ws`);
      const snapshot = await new Promise<SnapshotMessage>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('dashboard snapshot timeout')), 3_000);
        dashboard.on('message', (data) => {
          const parsed = JSON.parse(data.toString()) as SnapshotMessage;
          if (parsed.type !== 'snapshot') return;
          clearTimeout(timer);
          resolve(parsed);
        });
        dashboard.on('error', reject);
      });
      dashboard.close();

      const strippedSnapshot = {
        ...snapshot,
        sttEnabled: undefined,
        sttUrl: undefined,
      };

      expect(strippedSnapshot.sttEnabled).toBeUndefined();
      expect(strippedSnapshot.sttUrl).toBeUndefined();
      expect(firstReadyKookrSTTEndpoint(strippedSnapshot.speechCapabilities)).toBe('ws://127.0.0.1:8003');
    } finally {
      await server?.close();
      rmSync(tempDir, { recursive: true, force: true });
      if (previousGroqApiKey === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = previousGroqApiKey;
      if (previousGeminiApiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousGeminiApiKey;
      if (previousAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey;
    }
  });
});
