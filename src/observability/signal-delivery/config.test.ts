import { describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_DELIVERY_MIN_SEND_INTERVAL_MS,
  DEFAULT_DELIVERY_POLL_INTERVAL_MS,
  readSignalDeliveryConfigFromEnv,
} from './config.js';

const silent = { warn: () => {} };

describe('readSignalDeliveryConfigFromEnv', () => {
  test('returns null when no channel is configured', () => {
    expect(readSignalDeliveryConfigFromEnv({} as NodeJS.ProcessEnv, silent)).toBeNull();
  });

  test('enables Discord from just a webhook URL', () => {
    const cfg = readSignalDeliveryConfigFromEnv(
      { KOOKR_DISCORD_WEBHOOK_URL: 'https://discord/webhook' } as NodeJS.ProcessEnv,
      silent,
    );
    expect(cfg?.discord).toEqual({ webhookUrl: 'https://discord/webhook' });
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
    const base = { KOOKR_DISCORD_WEBHOOK_URL: 'u' };
    expect(readSignalDeliveryConfigFromEnv({ ...base, KOOKR_SIGNAL_DELIVERY_DRY_RUN: '1' } as NodeJS.ProcessEnv, silent)?.dryRun).toBe(true);
    expect(readSignalDeliveryConfigFromEnv({ ...base, KOOKR_SIGNAL_DELIVERY_DRY_RUN: 'true' } as NodeJS.ProcessEnv, silent)?.dryRun).toBe(false);
    expect(readSignalDeliveryConfigFromEnv(base as NodeJS.ProcessEnv, silent)?.dryRun).toBe(false);
  });

  test('parses interval overrides and falls back on invalid input', () => {
    const cfg = readSignalDeliveryConfigFromEnv(
      { KOOKR_DISCORD_WEBHOOK_URL: 'u', KOOKR_SIGNAL_DELIVERY_POLL_MS: '5000', KOOKR_SIGNAL_DELIVERY_MIN_SEND_MS: '0' } as NodeJS.ProcessEnv,
      silent,
    );
    expect(cfg?.pollIntervalMs).toBe(5000);
    // 0 is not > 0 → falls back to the default (never a zero-spacing hot loop).
    expect(cfg?.minSendIntervalMs).toBe(DEFAULT_DELIVERY_MIN_SEND_INTERVAL_MS);
  });
});
