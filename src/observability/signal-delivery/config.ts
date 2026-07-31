/**
 * Env-driven configuration for the operator-signal delivery bridge (issue #1716).
 *
 * The bridge is off by default: it only runs when at least one channel is
 * configured. Discord needs just a webhook URL; Telegram reuses the existing
 * `KOOKR_TELEGRAM_BOT_TOKEN` plus a dedicated alert chat id so operator alerts
 * do not depend on the inbound remote-chat allowlist.
 */

import type { DiscordChannelConfig, TelegramChannelConfig } from './channels.js';

/** Default poll cadence: signals are time-sensitive but batched to ≤1 msg/min. */
export const DEFAULT_DELIVERY_POLL_INTERVAL_MS = 15_000;
/** Minimum spacing between outbound messages (batching floor). */
export const DEFAULT_DELIVERY_MIN_SEND_INTERVAL_MS = 60_000;
/** Initial delivery shortly after boot so a pre-existing spool does not wait a full interval. */
export const DEFAULT_DELIVERY_BOOT_DELAY_MS = 5_000;

export interface SignalDeliveryConfig {
  discord?: DiscordChannelConfig;
  telegram?: TelegramChannelConfig;
  /** When true, format and log but never POST. */
  dryRun: boolean;
  pollIntervalMs: number;
  minSendIntervalMs: number;
  bootDelayMs: number;
}

/**
 * Read delivery config from the environment. Returns null when no channel is
 * configured (the service then never starts). Logs a warning when a channel is
 * partially configured (e.g. Telegram token without a chat id).
 */
export function readSignalDeliveryConfigFromEnv(
  env: NodeJS.ProcessEnv,
  logger: Pick<Console, 'warn'> = console,
): SignalDeliveryConfig | null {
  const discordUrl = env.KOOKR_DISCORD_WEBHOOK_URL?.trim();
  const telegramToken = env.KOOKR_TELEGRAM_BOT_TOKEN?.trim();
  const telegramChatId = env.KOOKR_SIGNAL_TELEGRAM_CHAT_ID?.trim();

  const discord: DiscordChannelConfig | undefined = discordUrl ? { webhookUrl: discordUrl } : undefined;

  let telegram: TelegramChannelConfig | undefined;
  if (telegramChatId) {
    if (telegramToken) {
      telegram = { botToken: telegramToken, chatId: telegramChatId };
    } else {
      logger.warn(
        '[signal-delivery] KOOKR_SIGNAL_TELEGRAM_CHAT_ID set but KOOKR_TELEGRAM_BOT_TOKEN empty — Telegram delivery disabled',
      );
    }
  }

  if (!discord && !telegram) return null;

  return {
    ...(discord ? { discord } : {}),
    ...(telegram ? { telegram } : {}),
    dryRun: env.KOOKR_SIGNAL_DELIVERY_DRY_RUN === '1',
    pollIntervalMs: parsePositiveInt(env.KOOKR_SIGNAL_DELIVERY_POLL_MS, DEFAULT_DELIVERY_POLL_INTERVAL_MS),
    minSendIntervalMs: parsePositiveInt(
      env.KOOKR_SIGNAL_DELIVERY_MIN_SEND_MS,
      DEFAULT_DELIVERY_MIN_SEND_INTERVAL_MS,
    ),
    bootDelayMs: DEFAULT_DELIVERY_BOOT_DELAY_MS,
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
