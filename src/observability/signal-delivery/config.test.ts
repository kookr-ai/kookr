import { describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_DELIVERY_MIN_SEND_INTERVAL_MS,
  DEFAULT_DELIVERY_POLL_INTERVAL_MS,
  readSignalDeliveryConfigFromEnv,
  resolveSignalDeliveryFromEnv,
} from './config.js';

const silent = { warn: () => {} };

/** Representative public Discord incoming-webhook shape (host policy allows any public https host). */
const VALID_DISCORD_URL = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz';

describe('readSignalDeliveryConfigFromEnv', () => {
  test('returns null when no channel is configured', () => {
    expect(readSignalDeliveryConfigFromEnv({} as NodeJS.ProcessEnv, silent)).toBeNull();
  });

  test('enables Discord from a valid public webhook URL', () => {
    const cfg = readSignalDeliveryConfigFromEnv(
      { KOOKR_DISCORD_WEBHOOK_URL: VALID_DISCORD_URL } as NodeJS.ProcessEnv,
      silent,
    );
    expect(cfg?.discord).toEqual({ webhookUrl: VALID_DISCORD_URL });
    expect(cfg?.telegram).toBeUndefined();
    expect(cfg?.dryRun).toBe(false);
    expect(cfg?.pollIntervalMs).toBe(DEFAULT_DELIVERY_POLL_INTERVAL_MS);
    expect(cfg?.minSendIntervalMs).toBe(DEFAULT_DELIVERY_MIN_SEND_INTERVAL_MS);
  });

  test('enables Telegram when both chat id and bot token are present', () => {
    const cfg = readSignalDeliveryConfigFromEnv(
      { KOOKR_SIGNAL_TELEGRAM_CHAT_ID: '123', KOOKR_TELEGRAM_BOT_TOKEN: 'TOK' } as NodeJS.ProcessEnv,
      silent,
    );
    expect(cfg?.telegram).toEqual({ botToken: 'TOK', chatId: '123' });
  });

  test('warns and disables Telegram when chat id is set but token is missing', () => {
    const warn = vi.fn();
    const cfg = readSignalDeliveryConfigFromEnv(
      { KOOKR_SIGNAL_TELEGRAM_CHAT_ID: '123' } as NodeJS.ProcessEnv,
      { warn },
    );
    expect(cfg).toBeNull(); // no other channel → whole config null
    expect(warn).toHaveBeenCalledOnce();
  });

  test('honors the dry-run flag only for the exact value "1"', () => {
    const base = { KOOKR_DISCORD_WEBHOOK_URL: VALID_DISCORD_URL };
    expect(readSignalDeliveryConfigFromEnv({ ...base, KOOKR_SIGNAL_DELIVERY_DRY_RUN: '1' } as NodeJS.ProcessEnv, silent)?.dryRun).toBe(true);
    expect(readSignalDeliveryConfigFromEnv({ ...base, KOOKR_SIGNAL_DELIVERY_DRY_RUN: 'true' } as NodeJS.ProcessEnv, silent)?.dryRun).toBe(false);
    expect(readSignalDeliveryConfigFromEnv(base as NodeJS.ProcessEnv, silent)?.dryRun).toBe(false);
  });

  test('parses interval overrides and falls back on invalid input', () => {
    const cfg = readSignalDeliveryConfigFromEnv(
      {
        KOOKR_DISCORD_WEBHOOK_URL: VALID_DISCORD_URL,
        KOOKR_SIGNAL_DELIVERY_POLL_MS: '5000',
        KOOKR_SIGNAL_DELIVERY_MIN_SEND_MS: '0',
      } as NodeJS.ProcessEnv,
      silent,
    );
    expect(cfg?.pollIntervalMs).toBe(5000);
    // 0 is not > 0 → falls back to the default (never a zero-spacing hot loop).
    expect(cfg?.minSendIntervalMs).toBe(DEFAULT_DELIVERY_MIN_SEND_INTERVAL_MS);
  });

  describe('Discord webhook host policy (#2207)', () => {
    test.each([
      'http://169.254.169.254/',
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://metadata/latest',
      'http://127.0.0.1:8080/hook',
      'http://10.0.0.5/hook',
      'http://192.168.0.1/hook',
      'ftp://discord.com/api/webhooks/x/y',
      'https://user:pass@discord.com/api/webhooks/x/y',
      'not-a-url',
    ])('rejects %s: disables Discord and returns null when no other channel', (url) => {
      const warn = vi.fn();
      const cfg = readSignalDeliveryConfigFromEnv(
        { KOOKR_DISCORD_WEBHOOK_URL: url } as NodeJS.ProcessEnv,
        { warn },
      );
      expect(cfg).toBeNull();
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]?.[0])).toMatch(
        /ignoring invalid KOOKR_DISCORD_WEBHOOK_URL.*Discord delivery disabled/,
      );
    });

    test('invalid Discord URL leaves Telegram channel enabled', () => {
      const warn = vi.fn();
      const cfg = readSignalDeliveryConfigFromEnv(
        {
          KOOKR_DISCORD_WEBHOOK_URL: 'http://169.254.169.254/',
          KOOKR_SIGNAL_TELEGRAM_CHAT_ID: '123',
          KOOKR_TELEGRAM_BOT_TOKEN: 'TOK',
        } as NodeJS.ProcessEnv,
        { warn },
      );
      expect(cfg?.discord).toBeUndefined();
      expect(cfg?.telegram).toEqual({ botToken: 'TOK', chatId: '123' });
      expect(warn).toHaveBeenCalledOnce();
    });

    test('accepts normal Discord webhook URL', () => {
      const warn = vi.fn();
      const cfg = readSignalDeliveryConfigFromEnv(
        { KOOKR_DISCORD_WEBHOOK_URL: VALID_DISCORD_URL } as NodeJS.ProcessEnv,
        { warn },
      );
      expect(cfg?.discord).toEqual({ webhookUrl: VALID_DISCORD_URL });
      expect(warn).not.toHaveBeenCalled();
    });

    test('trims whitespace on accepted Discord URLs', () => {
      const cfg = readSignalDeliveryConfigFromEnv(
        { KOOKR_DISCORD_WEBHOOK_URL: `  ${VALID_DISCORD_URL}  ` } as NodeJS.ProcessEnv,
        silent,
      );
      expect(cfg?.discord).toEqual({ webhookUrl: VALID_DISCORD_URL });
    });

    test('KOOKR_WEBHOOK_ALLOW_PRIVATE allows LAN Discord mock but still blocks metadata', () => {
      const lan = 'http://192.168.1.10/discord-mock';
      const cfg = readSignalDeliveryConfigFromEnv(
        {
          KOOKR_DISCORD_WEBHOOK_URL: lan,
          KOOKR_WEBHOOK_ALLOW_PRIVATE: '1',
        } as NodeJS.ProcessEnv,
        silent,
      );
      expect(cfg?.discord).toEqual({ webhookUrl: lan });

      const warn = vi.fn();
      const blocked = readSignalDeliveryConfigFromEnv(
        {
          KOOKR_DISCORD_WEBHOOK_URL: 'http://169.254.169.254/',
          KOOKR_WEBHOOK_ALLOW_PRIVATE: '1',
        } as NodeJS.ProcessEnv,
        { warn },
      );
      expect(blocked).toBeNull();
      expect(warn).toHaveBeenCalledOnce();
    });

    test('dry-run still works with a valid Discord URL', () => {
      const cfg = readSignalDeliveryConfigFromEnv(
        {
          KOOKR_DISCORD_WEBHOOK_URL: VALID_DISCORD_URL,
          KOOKR_SIGNAL_DELIVERY_DRY_RUN: '1',
        } as NodeJS.ProcessEnv,
        silent,
      );
      expect(cfg?.dryRun).toBe(true);
      expect(cfg?.discord).toEqual({ webhookUrl: VALID_DISCORD_URL });
    });
  });
});

describe('owner-chat fallback and alert destination (issue #3924)', () => {
  const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;

  test('token + one allowed user + no chat id sends to that user\'s private chat', () => {
    const { config, destination } = resolveSignalDeliveryFromEnv(
      env({ KOOKR_TELEGRAM_BOT_TOKEN: 'TOK', KOOKR_TELEGRAM_ALLOWED_USERS: ' 4242 ' }),
      silent,
    );
    expect(config?.telegram).toEqual({ botToken: 'TOK', chatId: '4242' });
    expect(destination).toEqual({ channels: ['telegram_owner_chat'], label: 'Telegram (owner chat)' });
    // The legacy reader sees the same channel.
    expect(readSignalDeliveryConfigFromEnv(
      env({ KOOKR_TELEGRAM_BOT_TOKEN: 'TOK', KOOKR_TELEGRAM_ALLOWED_USERS: '4242' }),
      silent,
    )?.telegram?.chatId).toBe('4242');
  });

  test('a repeated id still counts as one allowed user, as the bot sees it', () => {
    const { config } = resolveSignalDeliveryFromEnv(
      env({ KOOKR_TELEGRAM_BOT_TOKEN: 'TOK', KOOKR_TELEGRAM_ALLOWED_USERS: '4242,4242' }),
      silent,
    );
    expect(config?.telegram?.chatId).toBe('4242');
  });

  test('two allowed users and no chat id gives no channel, with a reason', () => {
    const { config, destination } = resolveSignalDeliveryFromEnv(
      env({ KOOKR_TELEGRAM_BOT_TOKEN: 'TOK', KOOKR_TELEGRAM_ALLOWED_USERS: '1,2' }),
      silent,
    );
    expect(config).toBeNull();
    expect(destination.channels).toEqual([]);
    expect(destination.label).toBe('nowhere outside the dashboard');
    expect(destination.reason).toMatch(/several allowed users.*KOOKR_SIGNAL_TELEGRAM_CHAT_ID/);
  });

  test('an explicit chat id is used as is, even with one allowed user', () => {
    const { config, destination } = resolveSignalDeliveryFromEnv(
      env({
        KOOKR_TELEGRAM_BOT_TOKEN: 'TOK',
        KOOKR_TELEGRAM_ALLOWED_USERS: '4242',
        KOOKR_SIGNAL_TELEGRAM_CHAT_ID: '-100777',
      }),
      silent,
    );
    expect(config?.telegram).toEqual({ botToken: 'TOK', chatId: '-100777' });
    expect(destination).toEqual({
      channels: ['telegram_configured_chat'],
      label: 'Telegram (configured chat)',
    });
  });

  test('the Telegram panic switch turns the fallback off', () => {
    const { config, destination } = resolveSignalDeliveryFromEnv(
      env({
        KOOKR_TELEGRAM_BOT_TOKEN: 'TOK',
        KOOKR_TELEGRAM_ALLOWED_USERS: '4242',
        KOOKR_REMOTE_CHAT_DISABLED: '1',
      }),
      silent,
    );
    expect(config).toBeNull();
    expect(destination.reason).toMatch(/KOOKR_REMOTE_CHAT_DISABLED=1/);
  });

  test('an allowed user without a bot token gives no channel', () => {
    const { config, destination } = resolveSignalDeliveryFromEnv(
      env({ KOOKR_TELEGRAM_ALLOWED_USERS: '4242' }),
      silent,
    );
    expect(config).toBeNull();
    expect(destination.reason).toMatch(/Telegram bot is not set up/);
  });

  test('a token with an empty allowlist gives no channel', () => {
    const { config, destination } = resolveSignalDeliveryFromEnv(
      env({ KOOKR_TELEGRAM_BOT_TOKEN: 'TOK', KOOKR_TELEGRAM_ALLOWED_USERS: 'abc' }),
      silent,
    );
    expect(config).toBeNull();
    expect(destination.reason).toMatch(/KOOKR_TELEGRAM_ALLOWED_USERS is empty/);
  });

  test('an install already sending to Discord is not also sent to the owner chat', () => {
    const { config, destination } = resolveSignalDeliveryFromEnv(
      env({
        KOOKR_DISCORD_WEBHOOK_URL: VALID_DISCORD_URL,
        KOOKR_TELEGRAM_BOT_TOKEN: 'TOK',
        KOOKR_TELEGRAM_ALLOWED_USERS: '4242',
      }),
      silent,
    );
    expect(config?.telegram).toBeUndefined();
    expect(destination).toEqual({ channels: ['discord'], label: 'Discord' });
  });

  test('a configured chat and Discord are both named', () => {
    const { destination } = resolveSignalDeliveryFromEnv(
      env({
        KOOKR_DISCORD_WEBHOOK_URL: VALID_DISCORD_URL,
        KOOKR_TELEGRAM_BOT_TOKEN: 'TOK',
        KOOKR_SIGNAL_TELEGRAM_CHAT_ID: '123',
      }),
      silent,
    );
    expect(destination).toEqual({
      channels: ['telegram_configured_chat', 'discord'],
      label: 'Telegram (configured chat) + Discord',
    });
  });

  test('nothing configured says why', () => {
    const { config, destination } = resolveSignalDeliveryFromEnv(env({}), silent);
    expect(config).toBeNull();
    expect(destination).toEqual({
      channels: [],
      label: 'nowhere outside the dashboard',
      reason: 'no alert channel is configured and the Telegram bot is not set up',
    });
  });
});

describe('Telegram Bot API host and the delivery kill switch (issue #3952)', () => {
  const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;
  const OWNER = { KOOKR_TELEGRAM_BOT_TOKEN: 'TOK', KOOKR_TELEGRAM_ALLOWED_USERS: '4242' };
  const EXPLICIT = { KOOKR_TELEGRAM_BOT_TOKEN: 'TOK', KOOKR_SIGNAL_TELEGRAM_CHAT_ID: '123' };

  test('owner-chat alerts go to the KOOKR_TELEGRAM_API_URL host the bot uses', () => {
    const { config } = resolveSignalDeliveryFromEnv(
      env({ ...OWNER, KOOKR_TELEGRAM_API_URL: ' http://127.0.0.1:18080 ' }),
      silent,
    );
    expect(config?.telegram).toEqual({ botToken: 'TOK', chatId: '4242', baseUrl: 'http://127.0.0.1:18080' });
  });

  test('configured-chat alerts go to the KOOKR_TELEGRAM_API_URL host too', () => {
    const { config } = resolveSignalDeliveryFromEnv(
      env({ ...EXPLICIT, KOOKR_TELEGRAM_API_URL: 'http://10.0.0.5:8081' }),
      silent,
    );
    expect(config?.telegram).toEqual({ botToken: 'TOK', chatId: '123', baseUrl: 'http://10.0.0.5:8081' });
  });

  test('an unset or blank override keeps the public Bot API default', () => {
    for (const extra of [{}, { KOOKR_TELEGRAM_API_URL: '   ' }]) {
      const { config } = resolveSignalDeliveryFromEnv(env({ ...OWNER, ...extra }), silent);
      expect(config?.telegram).toEqual({ botToken: 'TOK', chatId: '4242' });
    }
  });

  test('a blocked override disables Telegram alerts instead of using the public API', () => {
    const warn = vi.fn();
    const { config, destination } = resolveSignalDeliveryFromEnv(
      env({ ...OWNER, KOOKR_TELEGRAM_API_URL: 'http://169.254.169.254/' }),
      { warn },
    );
    expect(config).toBeNull();
    expect(destination.channels).toEqual([]);
    expect(destination.reason).toMatch(/KOOKR_TELEGRAM_API_URL is invalid/);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignoring invalid KOOKR_TELEGRAM_API_URL'));
  });

  test('a blocked override drops Telegram but keeps Discord', () => {
    const { config, destination } = resolveSignalDeliveryFromEnv(
      env({
        ...EXPLICIT,
        KOOKR_DISCORD_WEBHOOK_URL: VALID_DISCORD_URL,
        KOOKR_TELEGRAM_API_URL: 'http://user:pw@127.0.0.1:18080',
      }),
      silent,
    );
    expect(config?.telegram).toBeUndefined();
    expect(config?.discord).toEqual({ webhookUrl: VALID_DISCORD_URL });
    expect(destination).toEqual({ channels: ['discord'], label: 'Discord' });
  });

  test('a blocked override with no Telegram channel changes nothing', () => {
    const warn = vi.fn();
    const { config } = resolveSignalDeliveryFromEnv(
      env({ KOOKR_DISCORD_WEBHOOK_URL: VALID_DISCORD_URL, KOOKR_TELEGRAM_API_URL: 'http://169.254.169.254/' }),
      { warn },
    );
    expect(config?.discord).toEqual({ webhookUrl: VALID_DISCORD_URL });
    expect(warn).not.toHaveBeenCalled();
  });

  test.each(['0', 'false', 'off', 'NO'])('KOOKR_SIGNAL_DELIVERY=%s switches every channel off', (value) => {
    const { config, destination } = resolveSignalDeliveryFromEnv(
      env({ ...EXPLICIT, KOOKR_DISCORD_WEBHOOK_URL: VALID_DISCORD_URL, KOOKR_SIGNAL_DELIVERY: value }),
      silent,
    );
    expect(config).toBeNull();
    expect(destination).toEqual({
      channels: [],
      label: 'nowhere outside the dashboard',
      reason: 'alert delivery is switched off (KOOKR_SIGNAL_DELIVERY=0)',
    });
  });

  test.each(['1', 'on', ''])('KOOKR_SIGNAL_DELIVERY=%j leaves delivery on', (value) => {
    const { config } = resolveSignalDeliveryFromEnv(env({ ...OWNER, KOOKR_SIGNAL_DELIVERY: value }), silent);
    expect(config?.telegram?.chatId).toBe('4242');
  });
});
