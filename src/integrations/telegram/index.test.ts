/**
 * End-to-end smoke test for the Telegram remote-chat integration.
 *
 * Uses an in-process fake Telegram HTTP server (see fake-telegram-server.ts)
 * so CI never hits the real api.telegram.org. Drives the full happy path:
 *
 *   message → rephrase → confirmation sent → callback "y" → launchTask called
 *
 * Plus several rejection paths (group chat, forwarded message, non-allowlisted
 * sender, /task bypass with no LLM).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmClient } from '../../core/llm-client.js';
import type { LaunchOpts, LaunchResult } from '../../server/launch-service.js';
import { startTelegramTrigger, type StartTelegramTriggerDeps, type TelegramHandle } from './index.js';
import { startFakeTelegram, type FakeTelegramServer } from './fake-telegram-server.js';
import type { TelegramUpdate } from './api-client.js';
import { TranscriptionError, type TranscribeOpts } from './transcribe.js';

function readAuditEvents(dataDir: string): Array<Record<string, unknown>> {
  try {
    const raw = readFileSync(join(dataDir, 'telegram', 'audit.jsonl'), 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function makeVoiceMessage(opts: {
  update_id: number;
  userId: number;
  voice: { file_id: string; duration: number; file_size?: number };
  chatType?: 'private' | 'group';
}): TelegramUpdate {
  return {
    update_id: opts.update_id,
    message: {
      message_id: opts.update_id,
      from: { id: opts.userId },
      chat: { id: opts.userId, type: opts.chatType ?? 'private' },
      voice: { file_unique_id: opts.voice.file_id, ...opts.voice },
    },
  };
}

function makeAudioMessage(opts: {
  update_id: number;
  userId: number;
  audio: { file_id: string; duration: number; file_size?: number; file_name?: string; mime_type?: string };
}): TelegramUpdate {
  return {
    update_id: opts.update_id,
    message: {
      message_id: opts.update_id,
      from: { id: opts.userId },
      chat: { id: opts.userId, type: 'private' },
      audio: { file_unique_id: opts.audio.file_id, ...opts.audio },
    },
  };
}

function makeVideoNoteMessage(opts: {
  update_id: number;
  userId: number;
  videoNote: { file_id: string; duration: number; file_size?: number };
}): TelegramUpdate {
  return {
    update_id: opts.update_id,
    message: {
      message_id: opts.update_id,
      from: { id: opts.userId },
      chat: { id: opts.userId, type: 'private' },
      video_note: { file_unique_id: opts.videoNote.file_id, ...opts.videoNote },
    },
  };
}

function makeDocumentMessage(opts: {
  update_id: number;
  userId: number;
  document: { file_id: string; file_size?: number; file_name?: string; mime_type?: string };
}): TelegramUpdate {
  return {
    update_id: opts.update_id,
    message: {
      message_id: opts.update_id,
      from: { id: opts.userId },
      chat: { id: opts.userId, type: 'private' },
      document: { file_unique_id: opts.document.file_id, ...opts.document },
    },
  };
}

function fakeLlm(response: string): LlmClient {
  return {
    provider: 'fake',
    model: 'fake-1',
    complete: vi.fn().mockResolvedValue(response),
  };
}

function makeMessage(opts: { update_id: number; userId: number; text: string; chatType?: 'private' | 'group'; forward?: boolean }): any {
  return {
    update_id: opts.update_id,
    message: {
      message_id: opts.update_id,
      from: { id: opts.userId },
      chat: { id: opts.userId, type: opts.chatType ?? 'private' },
      text: opts.text,
      ...(opts.forward ? { forward_origin: { type: 'user' } } : {}),
    },
  };
}

function makeCallback(opts: { update_id: number; userId: number; data: string; messageId: number }): any {
  return {
    update_id: opts.update_id,
    callback_query: {
      id: `cb-${opts.update_id}`,
      from: { id: opts.userId },
      data: opts.data,
      message: { message_id: opts.messageId, chat: { id: opts.userId, type: 'private' } },
    },
  };
}

const ALLOWED_USER_ID = 12345;
const PROJECT = { name: 'kookr', cwd: '/tmp/kookr-test' };

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

interface FakeWhisper {
  baseUrl: string;
  captured: Array<{ method: string; url: string; body: Buffer }>;
  stop(): Promise<void>;
}

async function startFakeWhisper(): Promise<FakeWhisper> {
  const captured: FakeWhisper['captured'] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      captured.push({
        method: req.method ?? '',
        url: req.url ?? '',
        body: Buffer.concat(chunks),
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ text: '' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    captured,
    stop: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function waitFor(assertion: () => void, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await sleep(25);
    }
  }
  throw lastError;
}

async function waitForAudit(
  dataDir: string,
  assertion: (events: Array<Record<string, unknown>>) => void,
  timeoutMs = 1000,
): Promise<void> {
  await waitFor(() => assertion(readAuditEvents(dataDir)), timeoutMs);
}

describe('startTelegramTrigger — end-to-end with fake Telegram', () => {
  let tmp: string;
  let fake: FakeTelegramServer;
  let handle: TelegramHandle | null = null;
  let launchTaskMock: ReturnType<typeof vi.fn>;
  const originalUrl = process.env.KOOKR_TELEGRAM_API_URL;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'kookr-tg-test-'));
    fake = await startFakeTelegram();
    process.env.KOOKR_TELEGRAM_API_URL = fake.baseUrl;
    launchTaskMock = vi.fn(async (_opts: LaunchOpts) => ({
      task: { id: 't-test-123' },
      queued: false,
    } as unknown as LaunchResult));
  });

  afterEach(async () => {
    if (handle) { await handle.stop(); handle = null; }
    await fake.stop();
    if (originalUrl === undefined) delete process.env.KOOKR_TELEGRAM_API_URL;
    else process.env.KOOKR_TELEGRAM_API_URL = originalUrl;
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeDeps(overrides: Partial<StartTelegramTriggerDeps> = {}): StartTelegramTriggerDeps {
    return {
      token: 'test-token',
      allowedUserIds: new Set([ALLOWED_USER_ID]),
      allowedProjects: [PROJECT],
      dataDir: tmp,
      dryRun: false,
      dashboardBaseUrl: 'http://localhost:4800',
      launchTask: launchTaskMock,
      llmClient: fakeLlm(JSON.stringify({
        prompt: 'Investigate sweep button placement.',
        cwd: PROJECT.cwd,
        suggestedBranch: 'fix/sweep',
      })),
      ...overrides,
    };
  }

  it('sends a confirmation in response to a free-form message', async () => {
    fake.queueUpdates([makeMessage({ update_id: 1, userId: ALLOWED_USER_ID, text: 'fix sweep button' })]);
    handle = await startTelegramTrigger(makeDeps());
    await waitFor(() => expect(fake.outbound.sendMessage.length).toBeGreaterThan(0));
    const sent = fake.outbound.sendMessage[fake.outbound.sendMessage.length - 1];
    expect(sent.chat_id).toBe(ALLOWED_USER_ID);
    expect(sent.text).toMatch(/Spawn this task/);
    expect((sent as any).reply_markup).toBeDefined();
  });

  // Regression for issue #572: Telegram caps callback_data at 64 bytes and
  // rejects the entire sendMessage with BUTTON_DATA_INVALID when exceeded.
  // The original 64-hex-char SHA-256 plus the ":y" / ":n" suffix was 66 bytes,
  // so the confirmation prompt never reached the user. This test asserts the
  // actual emitted callback_data byte length, not just regex shape, so any
  // future regression that re-lengthens the hash trips immediately.
  it('regression #572: callback_data stays within Telegram 64-byte limit (both :y and :n variants)', async () => {
    fake.queueUpdates([makeMessage({ update_id: 1, userId: ALLOWED_USER_ID, text: 'Implement kookr issue 565' })]);
    handle = await startTelegramTrigger(makeDeps({
      // Use a realistic rephraser output — a prompt long enough to flush out
      // the original off-by-2 (the bug isn't input-size dependent, but a
      // realistic spec keeps the test honest about what production emits).
      llmClient: fakeLlm(JSON.stringify({
        prompt: 'Implement the sub-task described in kookr issue 565: investigate the sweep button placement on the dashboard, propose a fix, and submit a PR with regression tests.',
        cwd: PROJECT.cwd,
        suggestedBranch: 'feat/issue-565-sweep-button-placement',
      })),
    }));
    await waitFor(() => expect(fake.outbound.sendMessage.length).toBeGreaterThan(0));
    const sent = fake.outbound.sendMessage[fake.outbound.sendMessage.length - 1] as any;
    const buttons = sent.reply_markup?.inline_keyboard?.[0] as Array<{ text: string; callback_data: string }>;
    expect(buttons).toBeDefined();
    expect(buttons).toHaveLength(2);
    for (const btn of buttons) {
      expect(Buffer.byteLength(btn.callback_data, 'utf8')).toBeLessThanOrEqual(64);
      expect(Buffer.byteLength(btn.callback_data, 'utf8')).toBeGreaterThanOrEqual(1);
    }
    // Spot-check the suffixes are still routable through handleCallback.
    expect(buttons[0].callback_data).toMatch(/:y$/);
    expect(buttons[1].callback_data).toMatch(/:n$/);
  });

  it('drops messages from non-allowlisted senders silently', async () => {
    fake.queueUpdates([makeMessage({ update_id: 1, userId: 999, text: 'fix it' })]);
    handle = await startTelegramTrigger(makeDeps());
    await sleep(150);
    expect(fake.outbound.sendMessage).toHaveLength(0);
  });

  it('drops group-chat messages', async () => {
    fake.queueUpdates([makeMessage({ update_id: 1, userId: ALLOWED_USER_ID, text: 'fix it', chatType: 'group' })]);
    handle = await startTelegramTrigger(makeDeps());
    await sleep(150);
    expect(fake.outbound.sendMessage).toHaveLength(0);
  });

  it('drops forwarded messages', async () => {
    fake.queueUpdates([makeMessage({ update_id: 1, userId: ALLOWED_USER_ID, text: 'fix it', forward: true })]);
    handle = await startTelegramTrigger(makeDeps());
    await sleep(150);
    expect(fake.outbound.sendMessage).toHaveLength(0);
  });

  it('full flow: message → confirmation → callback "y" → launchTask called', async () => {
    fake.queueUpdates([makeMessage({ update_id: 1, userId: ALLOWED_USER_ID, text: 'fix it' })]);
    handle = await startTelegramTrigger(makeDeps());
    await waitFor(() => expect(fake.outbound.sendMessage.length).toBeGreaterThan(0));

    // Capture the inline-keyboard callback_data emitted in the confirmation message.
    const sent = fake.outbound.sendMessage[fake.outbound.sendMessage.length - 1] as any;
    const cbData = sent.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data as string;
    expect(cbData).toMatch(/^[0-9a-f]{32}:y$/);

    // Inject the callback as the next update.
    fake.queueUpdates([makeCallback({
      update_id: 2,
      userId: ALLOWED_USER_ID,
      data: cbData,
      messageId: sent.chat_id ?? 1, // anything; not asserted
    })]);
    await sleep(200);

    expect(launchTaskMock).toHaveBeenCalledTimes(1);
    const launchOpts = launchTaskMock.mock.calls[0][0] as LaunchOpts;
    expect(launchOpts.launchSource).toBe('remote-chat-telegram');
    expect(launchOpts.agentType).toBe('claude-code');
    expect(launchOpts.cwd).toBe(PROJECT.cwd);
    // The rephrased prompt — not the raw "fix it" — should reach launchTask.
    expect(launchOpts.prompt).toBe('Investigate sweep button placement.');
  });

  it('callback "n" cancels without spawning', async () => {
    fake.queueUpdates([makeMessage({ update_id: 1, userId: ALLOWED_USER_ID, text: 'fix it' })]);
    handle = await startTelegramTrigger(makeDeps());
    await waitFor(() => expect(fake.outbound.sendMessage.length).toBeGreaterThan(0));
    const sent = fake.outbound.sendMessage[fake.outbound.sendMessage.length - 1] as any;
    const cbData = sent.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data as string;
    const noData = cbData.replace(/:y$/, ':n');
    fake.queueUpdates([makeCallback({ update_id: 2, userId: ALLOWED_USER_ID, data: noData, messageId: 1 })]);
    await sleep(200);
    expect(launchTaskMock).not.toHaveBeenCalled();
    expect(fake.outbound.editMessageText.some((e) => /Cancelled/.test(e.text))).toBe(true);
  });

  it('expired callback gets explicit UX', async () => {
    handle = await startTelegramTrigger(makeDeps());
    // Inject a callback with no preceding spec write — pending file won't exist.
    fake.queueUpdates([makeCallback({
      update_id: 1,
      userId: ALLOWED_USER_ID,
      data: 'a'.repeat(32) + ':y',
      messageId: 1,
    })]);
    await sleep(150);
    expect(launchTaskMock).not.toHaveBeenCalled();
    const answers = fake.outbound.answerCallbackQuery;
    expect(answers.some((a) => /expired/.test(a.text ?? ''))).toBe(true);
  });

  it('/task bypass works with no LLM client configured', async () => {
    fake.queueUpdates([makeMessage({ update_id: 1, userId: ALLOWED_USER_ID, text: '/task fix the sweep button' })]);
    handle = await startTelegramTrigger(makeDeps({ llmClient: null }));
    await sleep(150);
    const sent = fake.outbound.sendMessage[fake.outbound.sendMessage.length - 1] as any;
    expect(sent?.text).toMatch(/Spawn this task/);
    expect(sent?.text).toMatch(/agent: Claude Code/);
  });

  it('/task bypass accepts explicit --agent codex when remote Codex is enabled', async () => {
    fake.queueUpdates([makeMessage({ update_id: 1, userId: ALLOWED_USER_ID, text: '/task --agent codex fix the sweep button' })]);
    handle = await startTelegramTrigger(makeDeps({
      llmClient: null,
      allowCodexRemoteSpawn: true,
    }));
    await waitFor(() => expect(fake.outbound.sendMessage.some((m) => /Spawn this task/.test(m.text))).toBe(true));
    const sent = fake.outbound.sendMessage[fake.outbound.sendMessage.length - 1] as any;
    expect(sent.text).toMatch(/agent: Codex CLI/);

    const cbData = sent.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data as string;
    fake.queueUpdates([makeCallback({ update_id: 2, userId: ALLOWED_USER_ID, data: cbData, messageId: 1 })]);
    await sleep(200);

    expect(launchTaskMock).toHaveBeenCalledTimes(1);
    expect((launchTaskMock.mock.calls[0][0] as LaunchOpts).agentType).toBe('codex-cli');
  });

  it('rejects explicit Codex selection when remote Codex is disabled', async () => {
    fake.queueUpdates([makeMessage({ update_id: 1, userId: ALLOWED_USER_ID, text: '/task --agent codex fix the sweep button' })]);
    handle = await startTelegramTrigger(makeDeps({ llmClient: null }));
    await sleep(150);

    expect(launchTaskMock).not.toHaveBeenCalled();
    expect(fake.outbound.sendMessage.some((m) => /Codex remote launch is disabled/.test(m.text))).toBe(true);
  });

  it('/agent status reports the current default agent', async () => {
    fake.queueUpdates([makeMessage({ update_id: 1, userId: ALLOWED_USER_ID, text: '/agent status' })]);
    handle = await startTelegramTrigger(makeDeps());
    await sleep(150);

    expect(fake.outbound.sendMessage).toHaveLength(1);
    expect(fake.outbound.sendMessage[0].text).toMatch(/Default agent: Claude Code/);
  });

  it('/agent codex persists the default and future tasks use Codex when enabled', async () => {
    fake.queueUpdates([
      makeMessage({ update_id: 1, userId: ALLOWED_USER_ID, text: '/agent codex' }),
      makeMessage({ update_id: 2, userId: ALLOWED_USER_ID, text: 'fix sweep button' }),
    ]);
    handle = await startTelegramTrigger(makeDeps({
      allowCodexRemoteSpawn: true,
      llmClient: fakeLlm(JSON.stringify({
        prompt: 'Investigate sweep button placement.',
        cwd: PROJECT.cwd,
      })),
    }));
    await waitFor(() => expect(fake.outbound.sendMessage.some((m) => /Spawn this task/.test(m.text))).toBe(true));

    expect(fake.outbound.sendMessage.some((m) => /Default agent set to Codex CLI/.test(m.text))).toBe(true);
    const sent = fake.outbound.sendMessage[fake.outbound.sendMessage.length - 1] as any;
    expect(sent.text).toMatch(/agent: Codex CLI/);

    const cbData = sent.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data as string;
    fake.queueUpdates([makeCallback({ update_id: 3, userId: ALLOWED_USER_ID, data: cbData, messageId: 1 })]);
    await sleep(200);

    expect(launchTaskMock).toHaveBeenCalledTimes(1);
    expect((launchTaskMock.mock.calls[0][0] as LaunchOpts).agentType).toBe('codex-cli');

    await waitForAudit(tmp, (events) => {
      expect(events.some((e) => e.kind === 'agent_default_changed' && e.agentType === 'codex-cli')).toBe(true);
      expect(events.some((e) => e.kind === 'agent_resolved' && e.agentType === 'codex-cli' && e.source === 'default')).toBe(true);
    });
  });

  it('/agent claude switches the default back to Claude Code', async () => {
    fake.queueUpdates([
      makeMessage({ update_id: 1, userId: ALLOWED_USER_ID, text: '/agent codex' }),
      makeMessage({ update_id: 2, userId: ALLOWED_USER_ID, text: '/agent claude' }),
      makeMessage({ update_id: 3, userId: ALLOWED_USER_ID, text: '/agent status' }),
    ]);
    handle = await startTelegramTrigger(makeDeps({ allowCodexRemoteSpawn: true }));
    await waitFor(() => expect(fake.outbound.sendMessage.length).toBeGreaterThanOrEqual(3));

    expect(fake.outbound.sendMessage.some((m) => /Default agent set to Claude Code/.test(m.text))).toBe(true);
    expect(fake.outbound.sendMessage[fake.outbound.sendMessage.length - 1].text).toMatch(/Default agent: Claude Code/);
  });

  it('/agent codex is blocked when remote Codex is disabled', async () => {
    fake.queueUpdates([makeMessage({ update_id: 1, userId: ALLOWED_USER_ID, text: '/agent codex' })]);
    handle = await startTelegramTrigger(makeDeps());
    await sleep(150);

    expect(fake.outbound.sendMessage).toHaveLength(1);
    expect(fake.outbound.sendMessage[0].text).toMatch(/Codex remote launch is disabled/);
  });

  it('voice transcription can select Codex through structured rephrase metadata', async () => {
    const oggBytes = Buffer.from('OggS-FAKE-VOICE-CODEX');
    fake.registerFile('voice-codex-fid', 'voice/codex.oga', oggBytes);
    fake.queueUpdates([makeVoiceMessage({
      update_id: 1,
      userId: ALLOWED_USER_ID,
      voice: { file_id: 'voice-codex-fid', duration: 4, file_size: oggBytes.length },
    })]);

    handle = await startTelegramTrigger(makeDeps({
      allowCodexRemoteSpawn: true,
      whisperUrl: 'http://127.0.0.1:65535',
      transcribeVoice: vi.fn(async () => 'use codex to fix the sweep button'),
      llmClient: fakeLlm(JSON.stringify({
        prompt: 'Fix the sweep button.',
        cwd: PROJECT.cwd,
        agentType: 'codex-cli',
      })),
    }));
    await waitFor(() => expect(fake.outbound.sendMessage.some((m) => /Spawn this task/.test(m.text))).toBe(true));

    const sent = fake.outbound.sendMessage[fake.outbound.sendMessage.length - 1] as any;
    expect(sent.text).toMatch(/agent: Codex CLI/);
  });

  it('dry-run mode: callback "y" does NOT call launchTask', async () => {
    fake.queueUpdates([makeMessage({ update_id: 1, userId: ALLOWED_USER_ID, text: 'fix it' })]);
    handle = await startTelegramTrigger(makeDeps({ dryRun: true }));
    await waitFor(() => expect(fake.outbound.sendMessage.length).toBeGreaterThan(0));
    const sent = fake.outbound.sendMessage[fake.outbound.sendMessage.length - 1] as any;
    const cbData = sent.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data as string;
    fake.queueUpdates([makeCallback({ update_id: 2, userId: ALLOWED_USER_ID, data: cbData, messageId: 1 })]);
    await sleep(200);
    expect(launchTaskMock).not.toHaveBeenCalled();
    // The dry-run reply should appear (either as edit or callback answer).
    const allText = [
      ...fake.outbound.editMessageText.map((e) => e.text),
      ...fake.outbound.answerCallbackQuery.map((a) => a.text ?? ''),
    ].join(' ');
    expect(allText).toMatch(/DRY-RUN/);
  });

  it('block-alert (R16) sends a Telegram message for a remote-spawned task', async () => {
    fake.queueUpdates([makeMessage({ update_id: 1, userId: ALLOWED_USER_ID, text: 'fix it' })]);
    handle = await startTelegramTrigger(makeDeps());
    await waitFor(() => expect(fake.outbound.sendMessage.length).toBeGreaterThan(0));
    const sent = fake.outbound.sendMessage[fake.outbound.sendMessage.length - 1] as any;
    const cbData = sent.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data as string;
    fake.queueUpdates([makeCallback({ update_id: 2, userId: ALLOWED_USER_ID, data: cbData, messageId: 1 })]);
    await sleep(200);
    // The launch was real (not dry-run); the integration should have recorded
    // the (taskId → chatId) mapping. Now fire a permission-blocked event.
    handle!.onPermissionBlocked('t-test-123', 'Bash(git push origin feat-x)');
    await sleep(50);
    const alertMessages = fake.outbound.sendMessage.filter((m) => /blocked/.test(m.text));
    expect(alertMessages.length).toBeGreaterThan(0);
    expect(alertMessages[0].text).toMatch(/Bash/);
    // Round-3 reviewer follow-up: explicitly assert routing went to the originating
    // chat. A mis-keyed origin map would otherwise pass this test silently.
    expect(alertMessages[0].chat_id).toBe(ALLOWED_USER_ID);
  });

  it('block-alert (R16) redacts credential-shaped prompts before sending', async () => {
    fake.queueUpdates([makeMessage({ update_id: 1, userId: ALLOWED_USER_ID, text: 'fix it' })]);
    handle = await startTelegramTrigger(makeDeps());
    await waitFor(() => expect(fake.outbound.sendMessage.length).toBeGreaterThan(0));
    const sent = fake.outbound.sendMessage[fake.outbound.sendMessage.length - 1] as any;
    const cbData = sent.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data as string;
    fake.queueUpdates([makeCallback({ update_id: 2, userId: ALLOWED_USER_ID, data: cbData, messageId: 1 })]);
    await sleep(200);
    // Credential-shaped prompt — the integration must replace the body with the redaction sentinel.
    handle!.onPermissionBlocked('t-test-123', 'Bash(curl -H "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789")');
    await sleep(50);
    const alertMessages = fake.outbound.sendMessage.filter((m) => /blocked/.test(m.text));
    expect(alertMessages.length).toBeGreaterThan(0);
    expect(alertMessages[0].text).toMatch(/redacted/);
    expect(alertMessages[0].text).not.toMatch(/ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
  });

  it('block-alert (R16) silently skips for non-remote tasks', async () => {
    handle = await startTelegramTrigger(makeDeps());
    // Fire a permission-blocked event for a task we never spawned.
    handle.onPermissionBlocked('t-not-remote', 'something');
    await sleep(50);
    expect(fake.outbound.sendMessage).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Telegram audio-message handling — issues #574 and #585.
  // -------------------------------------------------------------------------

  it('warms up whisper at startup when audio transcription is enabled', async () => {
    const whisper = await startFakeWhisper();
    try {
      handle = await startTelegramTrigger(makeDeps({ whisperUrl: whisper.baseUrl }));
      await waitFor(() => {
        expect(readAuditEvents(tmp).some((e) => e.kind === 'voice_warmup' && typeof e.okMs === 'number')).toBe(true);
      });

      expect(whisper.captured).toHaveLength(1);
      expect(whisper.captured[0].method).toBe('POST');
      expect(whisper.captured[0].url).toBe('/v1/audio/transcriptions');
    } finally {
      await whisper.stop();
    }
  });

  it('voice happy path: getFile → downloadFile → transcribe → confirmation_pending', async () => {
    const oggBytes = Buffer.from('OggS-FAKE-VOICE-PAYLOAD');
    fake.registerFile('voice-fid-1', 'voice/AQADxYxk.oga', oggBytes);
    fake.queueUpdates([makeVoiceMessage({
      update_id: 1,
      userId: ALLOWED_USER_ID,
      voice: { file_id: 'voice-fid-1', duration: 4, file_size: oggBytes.length },
    })]);

    const transcribeSpy = vi.fn(async (buf: Buffer) => {
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.equals(oggBytes)).toBe(true);
      return 'fix the sweep button';
    });

    handle = await startTelegramTrigger(makeDeps({
      whisperUrl: 'http://127.0.0.1:65535', // never hit — transcribe is stubbed
      transcribeVoice: transcribeSpy,
    }));
    await waitFor(() => expect(fake.outbound.sendMessage.some((m) => /Spawn this task/.test(m.text))).toBe(true));

    expect(transcribeSpy).toHaveBeenCalledTimes(1);
    expect(fake.outbound.getFile).toContainEqual({ file_id: 'voice-fid-1' });
    expect(fake.outbound.downloadFile).toContainEqual({ filePath: 'voice/AQADxYxk.oga' });

    await waitForAudit(tmp, (events) => {
      const orderedSubset = events.filter((e) => e.kind === 'audio_received' || e.kind === 'transcribed' || e.kind === 'confirmation_pending');
      expect(orderedSubset.slice(0, 3).map((e) => e.kind)).toEqual(['audio_received', 'transcribed', 'confirmation_pending']);
      expect(orderedSubset[0]).toMatchObject({ kind: 'audio_received', source: 'voice', durationSec: 4 });
    });

    const sent = fake.outbound.sendMessage[fake.outbound.sendMessage.length - 1] as any;
    expect(sent.text).toMatch(/Spawn this task/);
  });

  it('audio upload happy path: m.audio transcribes through the confirmation flow', async () => {
    const mp3Bytes = Buffer.from('ID3-FAKE-MP3-PAYLOAD');
    fake.registerFile('audio-fid-1', 'audio/uploaded-track.mp3', mp3Bytes);
    fake.queueUpdates([makeAudioMessage({
      update_id: 1,
      userId: ALLOWED_USER_ID,
      audio: {
        file_id: 'audio-fid-1',
        duration: 8,
        file_size: mp3Bytes.length,
        file_name: 'uploaded-track.mp3',
        mime_type: 'audio/mpeg',
      },
    })]);

    const transcribeSpy = vi.fn(async (buf: Buffer, opts: TranscribeOpts) => {
      expect(buf.equals(mp3Bytes)).toBe(true);
      expect(opts.filename).toBe('uploaded-track.mp3');
      expect(opts.mimeType).toBe('audio/mpeg');
      return 'fix the sweep button';
    });

    handle = await startTelegramTrigger(makeDeps({
      whisperUrl: 'http://127.0.0.1:65535',
      transcribeVoice: transcribeSpy,
    }));
    await waitFor(() => expect(fake.outbound.sendMessage.some((m) => /Spawn this task/.test(m.text))).toBe(true));

    expect(transcribeSpy).toHaveBeenCalledTimes(1);
    expect(fake.outbound.getFile).toContainEqual({ file_id: 'audio-fid-1' });
    expect(fake.outbound.downloadFile).toContainEqual({ filePath: 'audio/uploaded-track.mp3' });
    await waitForAudit(tmp, (events) => {
      expect(events.some((e) => e.kind === 'audio_received' && e.source === 'audio' && e.durationSec === 8)).toBe(true);
      expect(events.some((e) => e.kind === 'transcribed' && e.source === 'audio')).toBe(true);
    });
  });

  it('video note happy path: m.video_note transcribes the mp4 audio track', async () => {
    const mp4Bytes = Buffer.from('FAKE-MP4-VIDEO-NOTE-WITH-AUDIO');
    fake.registerFile('video-note-fid-1', 'video_notes/circle.mp4', mp4Bytes);
    fake.queueUpdates([makeVideoNoteMessage({
      update_id: 1,
      userId: ALLOWED_USER_ID,
      videoNote: { file_id: 'video-note-fid-1', duration: 5, file_size: mp4Bytes.length },
    })]);

    const transcribeSpy = vi.fn(async (buf: Buffer, opts: TranscribeOpts) => {
      expect(buf.equals(mp4Bytes)).toBe(true);
      expect(opts.filename).toBe('circle.mp4');
      expect(opts.mimeType).toBe('video/mp4');
      return 'fix the sweep button';
    });

    handle = await startTelegramTrigger(makeDeps({
      whisperUrl: 'http://127.0.0.1:65535',
      transcribeVoice: transcribeSpy,
    }));
    await waitFor(() => expect(fake.outbound.sendMessage.some((m) => /Spawn this task/.test(m.text))).toBe(true));

    expect(transcribeSpy).toHaveBeenCalledTimes(1);
    await waitForAudit(tmp, (events) => {
      expect(events.some((e) => e.kind === 'audio_received' && e.source === 'video_note' && e.durationSec === 5)).toBe(true);
      expect(events.some((e) => e.kind === 'transcribed' && e.source === 'video_note')).toBe(true);
    });
  });

  it('audio document happy path: m.document with audio mime transcribes', async () => {
    const flacBytes = Buffer.from('fLaC-FAKE-PAYLOAD');
    fake.registerFile('doc-audio-fid-1', 'documents/sample.flac', flacBytes);
    fake.queueUpdates([makeDocumentMessage({
      update_id: 1,
      userId: ALLOWED_USER_ID,
      document: {
        file_id: 'doc-audio-fid-1',
        file_size: flacBytes.length,
        file_name: 'sample.flac',
        mime_type: 'audio/flac',
      },
    })]);

    const transcribeSpy = vi.fn(async (buf: Buffer, opts: TranscribeOpts) => {
      expect(buf.equals(flacBytes)).toBe(true);
      expect(opts.filename).toBe('sample.flac');
      expect(opts.mimeType).toBe('audio/flac');
      return 'fix the sweep button';
    });

    handle = await startTelegramTrigger(makeDeps({
      whisperUrl: 'http://127.0.0.1:65535',
      transcribeVoice: transcribeSpy,
    }));
    await waitFor(() => expect(fake.outbound.sendMessage.some((m) => /Spawn this task/.test(m.text))).toBe(true));

    expect(transcribeSpy).toHaveBeenCalledTimes(1);
    await waitForAudit(tmp, (events) => {
      expect(events.some((e) => e.kind === 'audio_received' && e.source === 'document' && e.durationSec === undefined)).toBe(true);
      expect(events.some((e) => e.kind === 'transcribed' && e.source === 'document')).toBe(true);
    });
  });

  it('non-audio document still drops as non-text without fetching or transcribing', async () => {
    fake.queueUpdates([makeDocumentMessage({
      update_id: 1,
      userId: ALLOWED_USER_ID,
      document: {
        file_id: 'doc-pdf-fid-1',
        file_size: 1024,
        file_name: 'notes.pdf',
        mime_type: 'application/pdf',
      },
    })]);

    const transcribeSpy = vi.fn(async () => 'should not be called');
    handle = await startTelegramTrigger(makeDeps({
      whisperUrl: 'http://127.0.0.1:65535',
      transcribeVoice: transcribeSpy,
    }));
    await sleep(150);

    expect(transcribeSpy).not.toHaveBeenCalled();
    expect(fake.outbound.getFile).toHaveLength(0);
    await waitForAudit(tmp, (events) => {
      expect(events.some((e) => e.kind === 'dropped_non_text')).toBe(true);
    });
  });

  it('voice too long: emits dropped_audio_too_long and a polite reply, no transcription', async () => {
    fake.registerFile('voice-fid-long', 'voice/x.oga', Buffer.from('x'));
    fake.queueUpdates([makeVoiceMessage({
      update_id: 1,
      userId: ALLOWED_USER_ID,
      voice: { file_id: 'voice-fid-long', duration: 999 },
    })]);

    const transcribeSpy = vi.fn(async () => 'should not be called');
    handle = await startTelegramTrigger(makeDeps({
      whisperUrl: 'http://127.0.0.1:65535',
      transcribeVoice: transcribeSpy,
    }));
    await sleep(150);

    expect(transcribeSpy).not.toHaveBeenCalled();
    await waitForAudit(tmp, (events) => {
      expect(events.some((e) => e.kind === 'dropped_audio_too_long' && e.source === 'voice')).toBe(true);
    });
    expect(fake.outbound.sendMessage.some((m) => /too long/i.test(m.text))).toBe(true);
  });

  it('audio upload too long: emits dropped_audio_too_long before getFile', async () => {
    fake.queueUpdates([makeAudioMessage({
      update_id: 1,
      userId: ALLOWED_USER_ID,
      audio: { file_id: 'audio-fid-long', duration: 999, file_size: 1234 },
    })]);

    const transcribeSpy = vi.fn(async () => 'should not be called');
    handle = await startTelegramTrigger(makeDeps({
      whisperUrl: 'http://127.0.0.1:65535',
      transcribeVoice: transcribeSpy,
    }));
    await sleep(150);

    expect(transcribeSpy).not.toHaveBeenCalled();
    expect(fake.outbound.getFile).toHaveLength(0);
    await waitForAudit(tmp, (events) => {
      expect(events.some((e) => e.kind === 'dropped_audio_too_long' && e.source === 'audio' && e.durationSec === 999)).toBe(true);
    });
  });

  it('audio document too large: emits dropped_audio_too_large before getFile', async () => {
    fake.queueUpdates([makeDocumentMessage({
      update_id: 1,
      userId: ALLOWED_USER_ID,
      document: {
        file_id: 'doc-audio-huge',
        file_size: 26 * 1024 * 1024,
        file_name: 'huge.m4a',
        mime_type: 'audio/mp4',
      },
    })]);

    const transcribeSpy = vi.fn(async () => 'should not be called');
    handle = await startTelegramTrigger(makeDeps({
      whisperUrl: 'http://127.0.0.1:65535',
      transcribeVoice: transcribeSpy,
    }));
    await sleep(150);

    expect(transcribeSpy).not.toHaveBeenCalled();
    expect(fake.outbound.getFile).toHaveLength(0);
    await waitForAudit(tmp, (events) => {
      expect(events.some((e) => e.kind === 'dropped_audio_too_large' && e.source === 'document')).toBe(true);
    });
  });

  it('audio document with no duration uses a size heuristic for likely-too-long files before getFile', async () => {
    fake.queueUpdates([makeDocumentMessage({
      update_id: 1,
      userId: ALLOWED_USER_ID,
      document: {
        file_id: 'doc-audio-likely-long',
        file_size: 13 * 1024 * 1024,
        file_name: 'likely-long.m4a',
        mime_type: 'audio/mp4',
      },
    })]);

    const transcribeSpy = vi.fn(async () => 'should not be called');
    handle = await startTelegramTrigger(makeDeps({
      whisperUrl: 'http://127.0.0.1:65535',
      transcribeVoice: transcribeSpy,
    }));
    await sleep(150);

    expect(transcribeSpy).not.toHaveBeenCalled();
    expect(fake.outbound.getFile).toHaveLength(0);
    await waitForAudit(tmp, (events) => {
      expect(events.some((e) =>
        e.kind === 'dropped_audio_too_long' &&
        e.source === 'document' &&
        e.estimatedFromBytes === true,
      )).toBe(true);
    });
  });

  it('getFile file_size is checked before download when message metadata omits size', async () => {
    fake.registerFile('audio-fid-getfile-large', 'audio/large.mp3', Buffer.from('not-downloaded'), 26 * 1024 * 1024);
    fake.queueUpdates([makeAudioMessage({
      update_id: 1,
      userId: ALLOWED_USER_ID,
      audio: { file_id: 'audio-fid-getfile-large', duration: 5, mime_type: 'audio/mpeg' },
    })]);

    const transcribeSpy = vi.fn(async () => 'should not be called');
    handle = await startTelegramTrigger(makeDeps({
      whisperUrl: 'http://127.0.0.1:65535',
      transcribeVoice: transcribeSpy,
    }));
    await sleep(150);

    expect(transcribeSpy).not.toHaveBeenCalled();
    expect(fake.outbound.getFile).toContainEqual({ file_id: 'audio-fid-getfile-large' });
    expect(fake.outbound.downloadFile).toHaveLength(0);
    await waitForAudit(tmp, (events) => {
      expect(events.some((e) => e.kind === 'dropped_audio_too_large' && e.source === 'audio')).toBe(true);
    });
  });

  it('downloaded payload size guard drops before transcribe when size metadata is absent', async () => {
    const tooLarge = Buffer.alloc(26 * 1024 * 1024, 1);
    fake.registerFile('audio-fid-downloaded-large', 'audio/downloaded-large.mp3', tooLarge, null);
    fake.queueUpdates([makeAudioMessage({
      update_id: 1,
      userId: ALLOWED_USER_ID,
      audio: { file_id: 'audio-fid-downloaded-large', duration: 5, mime_type: 'audio/mpeg' },
    })]);

    const transcribeSpy = vi.fn(async () => 'should not be called');
    handle = await startTelegramTrigger(makeDeps({
      whisperUrl: 'http://127.0.0.1:65535',
      transcribeVoice: transcribeSpy,
    }));
    await waitForAudit(tmp, (events) => {
      expect(events.some((e) => e.kind === 'dropped_audio_too_large' && e.source === 'audio')).toBe(true);
    }, 2000);

    expect(transcribeSpy).not.toHaveBeenCalled();
    expect(fake.outbound.downloadFile).toContainEqual({ filePath: 'audio/downloaded-large.mp3' });
  });

  it('getFile failure path: emits transcription_failed without audio_received', async () => {
    // file_id is NOT registered, so the fake server returns `ok: false`
    // → api.getFile rejects → catch path runs BEFORE audio_received fires.
    fake.queueUpdates([makeVoiceMessage({
      update_id: 1,
      userId: ALLOWED_USER_ID,
      voice: { file_id: 'unknown-fid', duration: 3 },
    })]);

    const transcribeSpy = vi.fn(async () => 'should not be called');
    handle = await startTelegramTrigger(makeDeps({
      whisperUrl: 'http://127.0.0.1:65535',
      transcribeVoice: transcribeSpy,
    }));
    await sleep(200);

    expect(transcribeSpy).not.toHaveBeenCalled();
    await waitForAudit(tmp, (events) => {
      // Critical: audio_received must NOT appear because the download never happened.
      expect(events.some((e) => e.kind === 'audio_received')).toBe(false);
      expect(events.some((e) => e.kind === 'transcription_failed')).toBe(true);
    });
    expect(fake.outbound.sendMessage.some((m) => /Transcription failed/i.test(m.text))).toBe(true);
  });

  it('whisper rejection: emits transcription_failed and a polite reply', async () => {
    const oggBytes = Buffer.from('xx');
    fake.registerFile('voice-fid-fail', 'voice/y.oga', oggBytes);
    fake.queueUpdates([makeVoiceMessage({
      update_id: 1,
      userId: ALLOWED_USER_ID,
      voice: { file_id: 'voice-fid-fail', duration: 3 },
    })]);

    const transcribeSpy = vi.fn(async () => { throw new Error('whisper exploded'); });
    handle = await startTelegramTrigger(makeDeps({
      whisperUrl: 'http://127.0.0.1:65535',
      transcribeVoice: transcribeSpy,
    }));
    await sleep(200);

    expect(transcribeSpy).toHaveBeenCalledTimes(1);
    await waitForAudit(tmp, (events) => {
      expect(events.some((e) => e.kind === 'transcription_failed')).toBe(true);
    });
    expect(fake.outbound.sendMessage.some((m) => /Transcription failed/i.test(m.text))).toBe(true);
  });

  // Issue #577: classify the underlying error so the user knows whether to
  // retry, re-record, or give up. Audit kind stays `transcription_failed` for
  // every branch — only the user-facing reply differs.
  describe('voice error classification (#577)', () => {
    type Branch = {
      name: string;
      err: unknown;
      replyMatches: RegExp;
    };

    const branches: Branch[] = [
      {
        name: 'unreachable: TranscriptionError(null) wrapping ECONNREFUSED',
        err: new TranscriptionError(null, 'whisper request failed: TypeError: fetch failed: connect ECONNREFUSED 127.0.0.1:8010'),
        replyMatches: /server unreachable/i,
      },
      {
        name: 'unreachable: TranscriptionError(null) from abort timeout',
        err: new TranscriptionError(null, 'whisper request aborted after 30000ms'),
        replyMatches: /server unreachable/i,
      },
      {
        name: 'payload-rejected: TranscriptionError(415) — whisper refused the OGG',
        err: new TranscriptionError(415, 'whisper 415: Unsupported Media Type'),
        replyMatches: /re-record or type/i,
      },
      {
        name: 'server-error: TranscriptionError(503) — whisper down behind a load balancer',
        err: new TranscriptionError(503, 'whisper 503: Service Unavailable'),
        replyMatches: /server error/i,
      },
      {
        name: 'server-error: 200 OK with non-JSON body',
        err: new TranscriptionError(200, 'whisper returned non-JSON body: SyntaxError: Unexpected token < in JSON'),
        replyMatches: /server error/i,
      },
      {
        name: 'fallback: unrelated Error from the catch path',
        err: new Error('some unforeseen voice-pipeline failure'),
        replyMatches: /^Transcription failed\. Please type\.$/,
      },
      {
        name: 'no-false-positive: HTTP 500 body containing "ECONNREFUSED" still classified as server-error',
        err: new TranscriptionError(500, 'whisper 500: backend trace mentioned ECONNREFUSED 10.0.0.5:9000 but this is a 5xx, not a transport failure'),
        replyMatches: /server error/i,
      },
    ];

    for (const b of branches) {
      it(b.name, async () => {
        fake.registerFile('voice-fid-cls', 'voice/cls.oga', Buffer.from('xx'));
        fake.queueUpdates([makeVoiceMessage({
          update_id: 1,
          userId: ALLOWED_USER_ID,
          voice: { file_id: 'voice-fid-cls', duration: 3 },
        })]);
        const transcribeSpy = vi.fn(async () => { throw b.err; });
        handle = await startTelegramTrigger(makeDeps({
          whisperUrl: 'http://127.0.0.1:65535',
          transcribeVoice: transcribeSpy,
        }));
        await sleep(200);

        expect(transcribeSpy).toHaveBeenCalledTimes(1);
        await waitForAudit(tmp, (events) => {
          // Audit taxonomy stays unchanged regardless of branch (#577 acceptance criterion).
          const failures = events.filter((e) => e.kind === 'transcription_failed');
          expect(failures).toHaveLength(1);
          // The audit still carries the raw error string so postmortems work.
          expect(typeof failures[0].err).toBe('string');
          expect((failures[0].err as string).length).toBeGreaterThan(0);
        });
        // User-facing reply matches the branch under test.
        expect(fake.outbound.sendMessage.some((m) => b.replyMatches.test(m.text))).toBe(true);
      });
    }
  });

  it('whisper URL unset: emits dropped_audio_disabled and a polite reply', async () => {
    fake.registerFile('voice-fid-off', 'voice/z.oga', Buffer.from('xx'));
    fake.queueUpdates([makeVoiceMessage({
      update_id: 1,
      userId: ALLOWED_USER_ID,
      voice: { file_id: 'voice-fid-off', duration: 3 },
    })]);

    const transcribeSpy = vi.fn(async () => 'should not be called');
    handle = await startTelegramTrigger(makeDeps({
      // no whisperUrl
      transcribeVoice: transcribeSpy,
    }));
    await sleep(150);

    expect(transcribeSpy).not.toHaveBeenCalled();
    expect(fake.outbound.getFile).toHaveLength(0);
    await waitForAudit(tmp, (events) => {
      expect(events.some((e) => e.kind === 'dropped_audio_disabled' && e.source === 'voice')).toBe(true);
      expect(events.some((e) => e.kind === 'dropped_non_text')).toBe(false);
    });
    expect(fake.outbound.sendMessage.some((m) => /not supported/i.test(m.text))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // /start and /help — issue #583. Without this branch these fall through to
  // the rephrase path and produce a cryptic schema-validation error.
  // -------------------------------------------------------------------------
  describe('/start and /help (#583)', () => {
    for (const variant of ['/start', '/help', '/start@kookr_core_bot', '/help@kookr_core_bot']) {
      it(`${variant} replies with help text and audits help_replied`, async () => {
        fake.queueUpdates([makeMessage({ update_id: 1, userId: ALLOWED_USER_ID, text: variant })]);
        // Provide an LLM client that would fail validation if the branch leaked
        // into the rephrase path — so a regression here surfaces as a wrong reply.
        handle = await startTelegramTrigger(makeDeps({
          llmClient: fakeLlm('not-json-at-all'),
        }));
        await sleep(150);

        expect(launchTaskMock).not.toHaveBeenCalled();
        const sent = fake.outbound.sendMessage;
        expect(sent).toHaveLength(1);
        expect(sent[0].chat_id).toBe(ALLOWED_USER_ID);
        expect(sent[0].text).toMatch(/Kookr remote-chat trigger/);
        expect(sent[0].text).toMatch(/Available projects/);
        expect(sent[0].text).toMatch(new RegExp(PROJECT.name));
        // No inline keyboard — this is a plain text reply, not a confirmation.
        expect((sent[0] as any).reply_markup).toBeUndefined();

        await waitForAudit(tmp, (events) => {
          const kinds = events.map((e) => e.kind);
          const idxRecv = kinds.indexOf('message_received');
          const idxHelp = kinds.indexOf('help_replied');
          expect(idxRecv).toBeGreaterThanOrEqual(0);
          expect(idxHelp).toBeGreaterThan(idxRecv);
          expect(kinds).not.toContain('rephrase_failed');
          expect(kinds).not.toContain('rephrased');
        });
      });
    }

    it('unauthorized sender sending /start is dropped — no help leak', async () => {
      fake.queueUpdates([makeMessage({ update_id: 1, userId: 999, text: '/start' })]);
      handle = await startTelegramTrigger(makeDeps());
      await sleep(150);

      expect(fake.outbound.sendMessage).toHaveLength(0);
      await waitForAudit(tmp, (events) => {
        const kinds = events.map((e) => e.kind);
        expect(kinds).toContain('dropped_unauthorized');
        expect(kinds).not.toContain('help_replied');
      });
    });

    for (const variant of ['/helpme please', '/startup']) {
      it(`prefix-collision ${variant} does not match — message routes to rephrase path`, async () => {
        fake.queueUpdates([makeMessage({ update_id: 1, userId: ALLOWED_USER_ID, text: variant })]);
        // Bad LLM output forces rephrase_failed — proves the message reached
        // the rephrase branch (i.e. the help branch did NOT swallow it) rather
        // than being dropped for some unrelated reason.
        handle = await startTelegramTrigger(makeDeps({
          llmClient: fakeLlm('not-json-at-all'),
        }));
        await sleep(150);

        await waitForAudit(tmp, (events) => {
          const kinds = events.map((e) => e.kind);
          expect(kinds).not.toContain('help_replied');
          expect(kinds).toContain('rephrase_failed');
        });
      });
    }
  });
});
