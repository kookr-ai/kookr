import { describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_DELIVERY_MIN_SEND_INTERVAL_MS,
  DEFAULT_DELIVERY_POLL_INTERVAL_MS,
  readSignalDeliveryConfigFromEnv,
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
