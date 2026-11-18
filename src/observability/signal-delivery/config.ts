/**
 * Env-driven configuration for the operator-signal delivery bridge (issue #1716).
 *
 * The bridge is off by default: it only runs when at least one channel is
 * configured. Discord needs just a webhook URL; Telegram reuses the existing
 * `KOOKR_TELEGRAM_BOT_TOKEN` plus a dedicated alert chat id so operator alerts
 * do not depend on the inbound remote-chat allowlist.
 *
 * Owner-chat fallback (issue #3924): when no alert channel is set at all but
 * the Telegram bot is set up with exactly one allowed user, alerts go to that
 * user's private chat with the bot (in Telegram a private chat's id is the
 * user's id). An explicit `KOOKR_SIGNAL_TELEGRAM_CHAT_ID` always wins, and with
 * several allowed users nothing is guessed.
 *
 * Telegram alerts go to the same Bot API host as the bot itself: the
 * `KOOKR_TELEGRAM_API_URL` override (fake servers, private bot-API proxies) is
 * honoured and checked with the bot client's host policy. An override that
 * fails the check switches Telegram alerts off instead of falling back to the
 * public API (issue #3952).
 *
 * Telegram gets only the alerts an agent is waiting on the operator for
 * (`KOOKR_SIGNAL_TELEGRAM_LEVEL`, default `decisions`; see decision-signals.ts).
 * Discord still gets every signal.
 *
 * `KOOKR_SIGNAL_DELIVERY=0` switches alert delivery off entirely (no outbox
 * writes, no delivery service). Test servers start with it off, so a test that
 * sets a Telegram token never spools into the operator's HOME outbox or posts
 * alerts (issue #3952).
 *
 * Discord webhook URLs use the same host policy as findings webhooks (#2063):
 * public http(s) only by default; cloud metadata and link-local are always
 * rejected. Lab LAN receivers can opt in with KOOKR_WEBHOOK_ALLOW_PRIVATE.
 */

import { validateWebhookUrl } from '../../integrations/webhook/index.js';
import { parseAllowedUserIds } from '../../integrations/telegram/allowed-users.js';
import { validateTelegramApiUrl } from '../../integrations/telegram/telegram-api-url.js';
import type { DiscordChannelConfig, TelegramChannelConfig } from './channels.js';
import { DEFAULT_TELEGRAM_SIGNAL_LEVEL, type TelegramSignalLevel } from './decision-signals.js';

/** Default poll cadence: signals are time-sensitive but batched to ≤1 msg/min. */
export const DEFAULT_DELIVERY_POLL_INTERVAL_MS = 15_000;
/** Minimum spacing between outbound messages (batching floor). */
export const DEFAULT_DELIVERY_MIN_SEND_INTERVAL_MS = 60_000;
/** Initial delivery shortly after boot so a pre-existing spool does not wait a full interval. */
export const DEFAULT_DELIVERY_BOOT_DELAY_MS = 5_000;
/**
 * First back-off window after an all-channel delivery failure (issue #3046).
 * A revoked webhook / bad token / 429 / network fault would otherwise re-POST
 * the same batch every poll interval forever; the window doubles per consecutive
 * failure from this base and is capped at {@link DEFAULT_DELIVERY_BACKOFF_MAX_MS}.
 */
export const DEFAULT_DELIVERY_BACKOFF_BASE_MS = 30_000;
/** Ceiling for the exponential failure back-off (and for an honored `Retry-After`). */
export const DEFAULT_DELIVERY_BACKOFF_MAX_MS = 900_000;

export interface SignalDeliveryConfig {
  discord?: DiscordChannelConfig;
  telegram?: TelegramChannelConfig;
  /** Which signals Telegram gets: only decisions (default) or all of them. Discord always gets all. */
  telegramSignals: TelegramSignalLevel;
  /** When true, format and log but never POST. */
  dryRun: boolean;
  pollIntervalMs: number;
  minSendIntervalMs: number;
  bootDelayMs: number;
  /** Base back-off window after an all-channel failure (issue #3046). */
  backoffBaseMs: number;
  /** Cap for the back-off window and any honored `Retry-After` (issue #3046). */
  backoffMaxMs: number;
}

/** One place an alert can leave the machine through (issue #3924). */
export type AlertChannelKind = 'telegram_configured_chat' | 'telegram_owner_chat' | 'discord';

/**
 * Where operator alerts go, as published on `/api/health`, `/api/settings` and
 * `kookr status` (issue #3924). `channels` is empty when alerts reach open
 * dashboards only; `reason` then says why, in words the operator can act on.
 */
export interface AlertDestination {
  channels: AlertChannelKind[];
  /** e.g. "Telegram (owner chat)", "Discord", or "nowhere outside the dashboard". */
  label: string;
  reason?: string;
}

const CHANNEL_LABELS: Record<AlertChannelKind, string> = {
  telegram_configured_chat: 'Telegram (configured chat)',
  telegram_owner_chat: 'Telegram (owner chat)',
  discord: 'Discord',
};

/** Telegram labels when it gets decisions only, so settings and `kookr status` say what reaches the phone. */
const DECISIONS_ONLY_LABELS: Record<Exclude<AlertChannelKind, 'discord'>, string> = {
  telegram_configured_chat: 'Telegram (configured chat, decisions only)',
  telegram_owner_chat: 'Telegram (owner chat, decisions only)',
};

export const NO_ALERT_DESTINATION_LABEL = 'nowhere outside the dashboard';

export interface ResolvedSignalDelivery {
  /** Null when no channel resolves: detectors then skip the outbox and the service never starts. */
  config: SignalDeliveryConfig | null;
  destination: AlertDestination;
}

/**
 * Config-only form of {@link resolveSignalDeliveryFromEnv}, kept for callers
 * that do not need the destination. Read delivery config from the environment. Returns null when no channel is
 * configured (the service then never starts). Logs a warning when a channel is
 * partially configured (e.g. Telegram chat id without a bot token) or when the
 * Discord webhook URL fails the findings-webhook host safety policy (#2207).
 */
export function readSignalDeliveryConfigFromEnv(
  env: NodeJS.ProcessEnv,
  logger: Pick<Console, 'warn'> = console,
): SignalDeliveryConfig | null {
  return resolveSignalDeliveryFromEnv(env, logger).config;
}

/**
 * Same reading as {@link readSignalDeliveryConfigFromEnv}, plus a description
 * of where alerts will go (issue #3924). It does not warn when the answer is
 * "nowhere"; the server start-up does that once, using `destination.reason`.
 */
export function resolveSignalDeliveryFromEnv(
  env: NodeJS.ProcessEnv,
  logger: Pick<Console, 'warn'> = console,
): ResolvedSignalDelivery {
  if (isFalsyEnvFlag(env.KOOKR_SIGNAL_DELIVERY)) {
    return {
      config: null,
      destination: {
        channels: [],
        label: NO_ALERT_DESTINATION_LABEL,
        reason: 'alert delivery is switched off (KOOKR_SIGNAL_DELIVERY=0)',
      },
    };
  }
  const rawDiscordUrl = env.KOOKR_DISCORD_WEBHOOK_URL?.trim();
  const telegramToken = env.KOOKR_TELEGRAM_BOT_TOKEN?.trim();
  const telegramChatId = env.KOOKR_SIGNAL_TELEGRAM_CHAT_ID?.trim();

  let discord: DiscordChannelConfig | undefined;
  if (rawDiscordUrl) {
    // Same allow-private opt-in as findings webhook (KOOKR_WEBHOOK_ALLOW_PRIVATE).
    // Metadata / link-local stay blocked even when private-LAN is allowed.
    const allowPrivate = isTruthyEnvFlag(env.KOOKR_WEBHOOK_ALLOW_PRIVATE);
    const validation = validateWebhookUrl(rawDiscordUrl, { allowPrivate });
    if (validation.ok) {
      discord = { webhookUrl: validation.url };
    } else {
      logger.warn(
        `[signal-delivery] ignoring invalid KOOKR_DISCORD_WEBHOOK_URL (${validation.reason}); Discord delivery disabled`,
      );
    }
  }

  // Same Bot API host as the bot client (issue #3952). Unset or blank means
  // the public API (channels.ts default); a rejected override disables
  // Telegram alerts rather than sending them to a host the operator did not pick.
  const rawTelegramApiUrl = env.KOOKR_TELEGRAM_API_URL?.trim();
  let telegramBaseUrl: string | undefined;
  let telegramApiUrlError: string | undefined;
  if (rawTelegramApiUrl) {
    const validation = validateTelegramApiUrl(rawTelegramApiUrl);
    if (validation.ok) telegramBaseUrl = validation.url;
    else telegramApiUrlError = validation.reason;
  }

  let telegram: TelegramChannelConfig | undefined;
  let telegramKind: AlertChannelKind | undefined;
  let noDestinationReason: string | undefined;
  if (telegramChatId) {
    if (telegramToken) {
      telegram = {
        botToken: telegramToken,
        chatId: telegramChatId,
        ...(telegramBaseUrl ? { baseUrl: telegramBaseUrl } : {}),
      };
      telegramKind = 'telegram_configured_chat';
    } else {
      logger.warn(
        '[signal-delivery] KOOKR_SIGNAL_TELEGRAM_CHAT_ID set but KOOKR_TELEGRAM_BOT_TOKEN empty — Telegram delivery disabled',
      );
      noDestinationReason = 'KOOKR_SIGNAL_TELEGRAM_CHAT_ID is set but KOOKR_TELEGRAM_BOT_TOKEN is empty';
    }
  } else if (!discord) {
    // Owner-chat fallback (issue #3924): only when no other channel resolves,
    // so an install that already sends alerts to Discord is left alone.
    const fallback = resolveOwnerChatFallback(
      telegramToken,
      env.KOOKR_TELEGRAM_ALLOWED_USERS,
      env.KOOKR_REMOTE_CHAT_DISABLED === '1',
    );
    if ('chatId' in fallback) {
      telegram = {
        botToken: telegramToken as string,
        chatId: fallback.chatId,
        ...(telegramBaseUrl ? { baseUrl: telegramBaseUrl } : {}),
      };
      telegramKind = 'telegram_owner_chat';
    } else {
      noDestinationReason = fallback.reason;
    }
  }

  if (telegram && telegramApiUrlError) {
    logger.warn(
      `[signal-delivery] ignoring invalid KOOKR_TELEGRAM_API_URL (${telegramApiUrlError}); Telegram delivery disabled`,
    );
    telegram = undefined;
    telegramKind = undefined;
    noDestinationReason = `KOOKR_TELEGRAM_API_URL is invalid (${telegramApiUrlError})`;
  }

  const telegramSignals = readTelegramSignalLevel(env.KOOKR_SIGNAL_TELEGRAM_LEVEL, logger);
  const channels: AlertChannelKind[] = [
    ...(telegramKind ? [telegramKind] : []),
    ...(discord ? (['discord'] as const) : []),
  ];
  const channelLabel = (c: AlertChannelKind): string =>
    (telegramSignals === 'decisions' && c !== 'discord' ? DECISIONS_ONLY_LABELS[c] : CHANNEL_LABELS[c]);
  const destination: AlertDestination = channels.length > 0
    ? { channels, label: channels.map(channelLabel).join(' + ') }
    : {
        channels,
        label: NO_ALERT_DESTINATION_LABEL,
        reason: noDestinationReason ?? 'no alert channel is configured',
      };

  if (!discord && !telegram) return { config: null, destination };

  const config: SignalDeliveryConfig = {
    ...(discord ? { discord } : {}),
    ...(telegram ? { telegram } : {}),
    telegramSignals,
    dryRun: env.KOOKR_SIGNAL_DELIVERY_DRY_RUN === '1',
    pollIntervalMs: parsePositiveInt(env.KOOKR_SIGNAL_DELIVERY_POLL_MS, DEFAULT_DELIVERY_POLL_INTERVAL_MS),
    minSendIntervalMs: parsePositiveInt(
      env.KOOKR_SIGNAL_DELIVERY_MIN_SEND_MS,
      DEFAULT_DELIVERY_MIN_SEND_INTERVAL_MS,
    ),
    bootDelayMs: DEFAULT_DELIVERY_BOOT_DELAY_MS,
    backoffBaseMs: parsePositiveInt(
      env.KOOKR_SIGNAL_DELIVERY_BACKOFF_BASE_MS,
      DEFAULT_DELIVERY_BACKOFF_BASE_MS,
    ),
    backoffMaxMs: parsePositiveInt(
      env.KOOKR_SIGNAL_DELIVERY_BACKOFF_MAX_MS,
      DEFAULT_DELIVERY_BACKOFF_MAX_MS,
    ),
  };
  return { config, destination };
}

/**
 * The bot owner's private chat, when the bot has a token and exactly one
 * allowed user; otherwise why there is none (issue #3924).
 */
function resolveOwnerChatFallback(
  token: string | undefined,
  rawAllowedUsers: string | undefined,
  remoteChatDisabled: boolean,
): { chatId: string } | { reason: string } {
  const allowed = parseAllowedUserIds(rawAllowedUsers);
  // The Telegram panic switch silences the bot entirely, and demo / harness
  // servers set it so they never reach the operator's bot: never guess a chat
  // then. An explicit KOOKR_SIGNAL_TELEGRAM_CHAT_ID still opts in.
  if (remoteChatDisabled) {
    return { reason: 'no alert chat is configured and the Telegram bot is off (KOOKR_REMOTE_CHAT_DISABLED=1)' };
  }
  if (!token) {
    return { reason: 'no alert channel is configured and the Telegram bot is not set up' };
  }
  if (allowed.size === 0) {
    return { reason: 'no alert chat is configured and KOOKR_TELEGRAM_ALLOWED_USERS is empty' };
  }
  if (allowed.size > 1) {
    return {
      reason: 'no alert chat is configured and the Telegram bot has several allowed users; set KOOKR_SIGNAL_TELEGRAM_CHAT_ID',
    };
  }
  const [owner] = allowed;
  return { chatId: String(owner) };
}

/** `decisions` unless the operator asked for `all`; an unknown value warns and keeps the default. */
function readTelegramSignalLevel(
  raw: string | undefined,
  logger: Pick<Console, 'warn'>,
): TelegramSignalLevel {
  const v = raw?.trim().toLowerCase();
  if (!v) return DEFAULT_TELEGRAM_SIGNAL_LEVEL;
  if (v === 'all' || v === 'decisions') return v;
  logger.warn(
    `[signal-delivery] ignoring unknown KOOKR_SIGNAL_TELEGRAM_LEVEL=${JSON.stringify(raw)} (use decisions or all); `
      + `Telegram gets ${DEFAULT_TELEGRAM_SIGNAL_LEVEL} only`,
  );
  return DEFAULT_TELEGRAM_SIGNAL_LEVEL;
}

function isTruthyEnvFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function isFalsyEnvFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'no' || v === 'off';
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
