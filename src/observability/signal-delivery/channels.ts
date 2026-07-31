/**
 * Delivery channels for operator signals (issue #1716).
 *
 * Two outbound targets, each a single JSON POST behind an injectable `fetch`
 * so tests can assert exact call counts without touching the network:
 *  - **Discord** — an incoming-webhook URL (`KOOKR_DISCORD_WEBHOOK_URL`); body
 *    is `{ content }`.
 *  - **Telegram** — the Bot API `sendMessage` for a fixed alert chat id, reusing
 *    the existing `KOOKR_TELEGRAM_BOT_TOKEN`.
 *
 * Neither channel retries here; the caller (SignalDeliveryService) decides
 * whether an undelivered batch stays pending for the next tick.
 */

/** Default POST timeout — long enough for a slow-but-healthy receiver. */
export const DEFAULT_CHANNEL_TIMEOUT_MS = 10_000;
/** Discord content hard limit is 2000 chars; leave headroom for a truncation marker. */
export const DISCORD_MAX_CONTENT = 1900;
/** Telegram message hard limit is 4096 chars. */
export const TELEGRAM_MAX_CONTENT = 4000;

export type ChannelName = 'discord' | 'telegram';

export interface ChannelDeliveryResult {
  channel: ChannelName;
  ok: boolean;
  status?: number;
  error?: string;
}

export interface DiscordChannelConfig {
  webhookUrl: string;
}

export interface TelegramChannelConfig {
  botToken: string;
  chatId: string;
  /** Override for tests; defaults to the public Bot API host. */
  baseUrl?: string;
}

interface PostOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** POST a message to a Discord incoming webhook. */
export async function deliverToDiscord(
  config: DiscordChannelConfig,
  text: string,
  opts: PostOptions = {},
): Promise<ChannelDeliveryResult> {
  const body = JSON.stringify({ content: truncate(text, DISCORD_MAX_CONTENT) });
  return postJson('discord', config.webhookUrl, body, opts);
}

/** POST a message to a Telegram chat via the Bot API. */
export async function deliverToTelegram(
  config: TelegramChannelConfig,
  text: string,
  opts: PostOptions = {},
): Promise<ChannelDeliveryResult> {
  const base = (config.baseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '');
  const url = `${base}/bot${config.botToken}/sendMessage`;
  const body = JSON.stringify({
    chat_id: config.chatId,
    text: truncate(text, TELEGRAM_MAX_CONTENT),
    disable_web_page_preview: true,
  });
  return postJson('telegram', url, body, opts);
}

async function postJson(
  channel: ChannelName,
  url: string,
  body: string,
  opts: PostOptions,
): Promise<ChannelDeliveryResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHANNEL_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', 'user-agent': 'kookr-signal-delivery' },
      body,
      signal: controller.signal,
    });
    if (res.ok) return { channel, ok: true, status: res.status };
    return { channel, ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    const message = err instanceof Error
      ? (err.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : err.message)
      : String(err);
    return { channel, ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
