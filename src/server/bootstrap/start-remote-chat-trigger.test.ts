import { describe, expect, test, vi } from 'vitest';

import { startRemoteChatTrigger, type TelegramTriggerModule } from './start-remote-chat-trigger.js';

describe('startRemoteChatTrigger', () => {
  test('returns no handle when Telegram is disabled', async () => {
    const logs: string[] = [];
    const loadTelegramModule = vi.fn<() => Promise<TelegramTriggerModule>>();

    const result = await startRemoteChatTrigger({
      host: '127.0.0.1',
      port: 4800,
      kookrDir: '/tmp/kookr',
      launchTask: vi.fn(),
      llmClient: null,
      env: { KOOKR_REMOTE_CHAT_DISABLED: '1', KOOKR_TELEGRAM_BOT_TOKEN: 'token' },
      loadTelegramModule,
      log: (message) => logs.push(message),
    });

    expect(result.handle).toBeNull();
    expect(loadTelegramModule).not.toHaveBeenCalled();
    expect(logs).toEqual(['[telegram] disabled via KOOKR_REMOTE_CHAT_DISABLED']);
  });

  test('refuses to start when token is set without allowed users', async () => {
    const warnings: string[] = [];
    const loadTelegramModule = vi.fn(async (): Promise<TelegramTriggerModule> => ({
      startTelegramTrigger: vi.fn(),
      probeWhisperReachability: vi.fn(),
    }));

    const result = await startRemoteChatTrigger({
      host: '127.0.0.1',
      port: 4800,
      kookrDir: '/tmp/kookr',
      launchTask: vi.fn(),
      llmClient: null,
      env: {
        KOOKR_TELEGRAM_BOT_TOKEN: 'token',
        KOOKR_REMOTE_CHAT_PROJECTS: '/repo',
      },
      loadTelegramModule,
      warn: (message) => warnings.push(message),
    });

    expect(result.handle).toBeNull();
    expect(warnings[0]).toContain('KOOKR_TELEGRAM_ALLOWED_USERS empty');
  });

  test('refuses to start when token is set without allowed projects', async () => {
    const warnings: string[] = [];
    const loadTelegramModule = vi.fn(async (): Promise<TelegramTriggerModule> => ({
      startTelegramTrigger: vi.fn(),
      probeWhisperReachability: vi.fn(),
    }));

    const result = await startRemoteChatTrigger({
      host: '127.0.0.1',
      port: 4800,
      kookrDir: '/tmp/kookr',
      launchTask: vi.fn(),
      llmClient: null,
      env: {
        KOOKR_TELEGRAM_BOT_TOKEN: 'token',
        KOOKR_TELEGRAM_ALLOWED_USERS: '101',
      },
      loadTelegramModule,
      warn: (message) => warnings.push(message),
    });

    expect(result.handle).toBeNull();
    expect(warnings[0]).toContain('KOOKR_REMOTE_CHAT_PROJECTS empty');
  });

  test('starts Telegram with parsed environment and exposes permission callback', async () => {
    const onPermissionBlocked = vi.fn();
    const onTaskOutcome = vi.fn();
    const launchTask = vi.fn();
    const startTelegramTrigger = vi.fn(async () => ({
      stop: vi.fn(),
      onPermissionBlocked,
      onTaskOutcome,
    }));
    const probeWhisperReachability = vi.fn(async () => ({ ok: true as const, modelCount: 2 }));
    const logs: string[] = [];
    const warnings: string[] = [];

    const result = await startRemoteChatTrigger({
      host: '0.0.0.0',
      port: 4800,
      kookrDir: '/tmp/kookr',
      launchTask,
      llmClient: null,
      env: {
        KOOKR_TELEGRAM_BOT_TOKEN: 'token',
        KOOKR_TELEGRAM_ALLOWED_USERS: '101, bad, 202',
        KOOKR_REMOTE_CHAT_PROJECTS: '/repo/a, /repo/b',
        KOOKR_REMOTE_CHAT_DRY_RUN: '1',
        KOOKR_REMOTE_CHAT_ALLOW_CODEX: '1',
        KOOKR_STT_WHISPER_URL: 'http://127.0.0.1:8010',
      },
      loadTelegramModule: async () => ({
        startTelegramTrigger,
        probeWhisperReachability,
      }),
      log: (message) => logs.push(message),
      warn: (message) => warnings.push(message),
    });

    expect(result.handle).not.toBeNull();
    expect(result.onPermissionBlocked).toBe(onPermissionBlocked);
    expect(result.onTaskOutcome).toBe(onTaskOutcome);
    expect(startTelegramTrigger).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token',
      allowedUserIds: new Set([101, 202]),
      allowedProjects: [
        { name: 'a', cwd: '/repo/a' },
        { name: 'b', cwd: '/repo/b' },
      ],
      dataDir: '/tmp/kookr',
      dryRun: true,
      allowCodexRemoteSpawn: true,
      dashboardBaseUrl: 'http://localhost:4800',
      llmClient: null,
      whisperUrl: 'http://127.0.0.1:8010',
      launchTask,
    }));
    expect(logs).toContain('[telegram] active — allowedUsers=2 projects=2 dryRun=true codex=enabled audio=enabled');
    expect(warnings).toEqual([
      '[telegram] KOOKR_REMOTE_CHAT_DASHBOARD_URL is unset; Telegram dashboard links will use http://localhost:4800 and may not open from a phone.',
    ]);

    await vi.waitFor(() => {
      expect(probeWhisperReachability).toHaveBeenCalledWith('http://127.0.0.1:8010');
      expect(logs).toContain('[telegram] voice probe: 200 OK (2 models)');
    });
  });

  test('warns when unset dashboard URL falls back to loopback host', async () => {
    const warnings: string[] = [];
    const startTelegramTrigger = vi.fn(async () => ({
      stop: vi.fn(),
      onPermissionBlocked: vi.fn(),
      onTaskOutcome: vi.fn(),
    }));

    await startRemoteChatTrigger({
      host: '127.0.0.1',
      port: 4801,
      kookrDir: '/tmp/kookr',
      launchTask: vi.fn(),
      llmClient: null,
      env: {
        KOOKR_TELEGRAM_BOT_TOKEN: 'token',
        KOOKR_TELEGRAM_ALLOWED_USERS: '101',
        KOOKR_REMOTE_CHAT_PROJECTS: '/repo',
      },
      loadTelegramModule: async () => ({
        startTelegramTrigger,
        probeWhisperReachability: vi.fn(),
      }),
      warn: (message) => warnings.push(message),
    });

    expect(startTelegramTrigger).toHaveBeenCalledWith(expect.objectContaining({
      dashboardBaseUrl: 'http://127.0.0.1:4801',
    }));
    expect(warnings).toEqual([
      '[telegram] KOOKR_REMOTE_CHAT_DASHBOARD_URL is unset; Telegram dashboard links will use http://127.0.0.1:4801 and may not open from a phone.',
    ]);
  });

  test('uses configured phone-reachable dashboard origin for Telegram links', async () => {
    const warn = vi.fn();
    const startTelegramTrigger = vi.fn(async () => ({
      stop: vi.fn(),
      onPermissionBlocked: vi.fn(),
      onTaskOutcome: vi.fn(),
    }));

    await startRemoteChatTrigger({
      host: '0.0.0.0',
      port: 4800,
      kookrDir: '/tmp/kookr',
      launchTask: vi.fn(),
      llmClient: null,
      env: {
        KOOKR_TELEGRAM_BOT_TOKEN: 'token',
        KOOKR_TELEGRAM_ALLOWED_USERS: '101',
        KOOKR_REMOTE_CHAT_PROJECTS: '/repo',
        KOOKR_REMOTE_CHAT_DASHBOARD_URL: 'https://kookr.example.com/',
      },
      loadTelegramModule: async () => ({
        startTelegramTrigger,
        probeWhisperReachability: vi.fn(),
      }),
      warn,
    });

    expect(startTelegramTrigger).toHaveBeenCalledWith(expect.objectContaining({
      dashboardBaseUrl: 'https://kookr.example.com',
    }));
    expect(warn).not.toHaveBeenCalled();
  });

  test('warns and falls back when configured dashboard URL is not an origin', async () => {
    const warnings: string[] = [];
    const startTelegramTrigger = vi.fn(async () => ({
      stop: vi.fn(),
      onPermissionBlocked: vi.fn(),
      onTaskOutcome: vi.fn(),
    }));

    await startRemoteChatTrigger({
      host: '127.0.0.1',
      port: 4801,
      kookrDir: '/tmp/kookr',
      launchTask: vi.fn(),
      llmClient: null,
      env: {
        KOOKR_TELEGRAM_BOT_TOKEN: 'token',
        KOOKR_TELEGRAM_ALLOWED_USERS: '101',
        KOOKR_REMOTE_CHAT_PROJECTS: '/repo',
        KOOKR_REMOTE_CHAT_DASHBOARD_URL: 'https://kookr.example.com/tasks',
      },
      loadTelegramModule: async () => ({
        startTelegramTrigger,
        probeWhisperReachability: vi.fn(),
      }),
      warn: (message) => warnings.push(message),
    });

    expect(startTelegramTrigger).toHaveBeenCalledWith(expect.objectContaining({
      dashboardBaseUrl: 'http://127.0.0.1:4801',
    }));
    expect(warnings).toEqual([
      '[telegram] KOOKR_REMOTE_CHAT_DASHBOARD_URL must be an http(s) origin like https://kookr.example.com; using local dashboard URL instead.',
    ]);
  });

  test('logs and continues when Telegram startup throws', async () => {
    const errors: Array<[string, unknown]> = [];

    const result = await startRemoteChatTrigger({
      host: '127.0.0.1',
      port: 4800,
      kookrDir: '/tmp/kookr',
      launchTask: vi.fn(),
      llmClient: null,
      env: {
        KOOKR_TELEGRAM_BOT_TOKEN: 'token',
        KOOKR_TELEGRAM_ALLOWED_USERS: '101',
        KOOKR_REMOTE_CHAT_PROJECTS: '/repo',
      },
      loadTelegramModule: async () => ({
        startTelegramTrigger: async () => { throw new Error('boom'); },
        probeWhisperReachability: vi.fn(),
      }),
      error: (message, err) => errors.push([message, err]),
    });

    expect(result.handle).toBeNull();
    expect(errors).toEqual([['[telegram] Failed to start integration:', 'boom']]);
  });
});
