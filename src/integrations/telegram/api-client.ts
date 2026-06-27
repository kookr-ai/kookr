/**
 * Minimal Telegram Bot API client.
 *
 * Just the four methods we need:
 *   - getUpdates (long poll, 30s timeout)
 *   - sendMessage (with optional inline_keyboard)
 *   - editMessageText (mark confirmation as done)
 *   - answerCallbackQuery (close the spinner on the user's button click)
 *
 * Honors HTTP 429 retry_after per round-2 N18 fix.
 *
 * The base URL is overridable via `KOOKR_TELEGRAM_API_URL` so tests can
 * point at an in-process fake HTTP server. Default: api.telegram.org.
 */

const DEFAULT_BASE_URL = 'https://api.telegram.org';

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  edited_message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  from?: { id: number; username?: string };
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel' };
  text?: string;
  voice?: TelegramVoice;
  audio?: TelegramAudio;
  video_note?: TelegramVideoNote;
  document?: TelegramDocument;
  forward_origin?: unknown;
  forward_from?: unknown;
  forward_from_chat?: unknown;
}

/**
 * In-app Telegram voice recording. See https://core.telegram.org/bots/api#voice .
 */
export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

/** Uploaded audio file. See https://core.telegram.org/bots/api#audio . */
export interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  performer?: string;
  title?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** Circular video message. See https://core.telegram.org/bots/api#videonote . */
export interface TelegramVideoNote {
  file_id: string;
  file_unique_id: string;
  duration: number;
  length?: number;
  file_size?: number;
}

/** Generic uploaded file. See https://core.telegram.org/bots/api#document . */
export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** Result of `getFile` — the file_path is what we feed to `downloadFile`. */
export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_path?: string;
  file_size?: number;
}

export interface TelegramCallbackQuery {
  id: string;
  from: { id: number };
  data?: string;
  message?: TelegramMessage;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export class TelegramApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfter: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

export class TelegramDownloadTooLargeError extends Error {
  constructor(
    public readonly limitBytes: number,
    public readonly bytesRead: number,
  ) {
    super(`Telegram download exceeded ${limitBytes} bytes (read ${bytesRead} bytes)`);
    this.name = 'TelegramDownloadTooLargeError';
  }
}

export class TelegramApiClient {
  private readonly baseUrl: string;
  constructor(private readonly token: string, baseUrl?: string) {
    this.baseUrl = baseUrl ?? process.env.KOOKR_TELEGRAM_API_URL ?? DEFAULT_BASE_URL;
  }

  private endpoint(method: string): string {
    return `${this.baseUrl}/bot${this.token}/${method}`;
  }

  private async call<T>(method: string, body: unknown, timeoutMs = 35_000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(this.endpoint(method), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after')) || null;
        throw new TelegramApiError(429, retryAfter, `Telegram rate-limited: retry_after=${retryAfter}`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new TelegramApiError(res.status, null, `Telegram ${method} ${res.status}: ${text.slice(0, 200)}`);
      }
      let json: { ok: boolean; result?: T; description?: string };
      try {
        json = await res.json() as { ok: boolean; result?: T; description?: string };
      } catch {
        throw new TelegramApiError(res.status, null, `Telegram ${method} returned non-JSON body`);
      }
      if (!json.ok || json.result === undefined) {
        throw new TelegramApiError(res.status, null, `Telegram ${method} not-ok: ${json.description ?? 'unknown'}`);
      }
      return json.result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Long-poll for updates. `offset` is `last_update_id + 1`. */
  async getUpdates(offset: number, timeoutSec = 30): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] }, (timeoutSec + 5) * 1000);
  }

  async sendMessage(chatId: number, text: string, replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] }): Promise<TelegramMessage> {
    return this.call<TelegramMessage>('sendMessage', {
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  async editMessageText(chatId: number, messageId: number, text: string): Promise<unknown> {
    return this.call('editMessageText', { chat_id: chatId, message_id: messageId, text });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<unknown> {
    return this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text, show_alert: false } : {}),
    });
  }

  /**
   * Resolve a Telegram file_id to a file_path for download.
   * See https://core.telegram.org/bots/api#getfile — the returned `file_path`
   * is valid for at least one hour.
   */
  async getFile(fileId: string): Promise<TelegramFile> {
    return this.call<TelegramFile>('getFile', { file_id: fileId });
  }

  /**
   * Download a file from Telegram's CDN by `file_path` (returned from `getFile`).
   *
   * IMPORTANT: the file CDN host is a *different* URL shape than the bot API
   * host — `https://api.telegram.org/file/bot<TOKEN>/<file_path>` rather than
   * `https://api.telegram.org/bot<TOKEN>/<method>`. The base URL override
   * (`KOOKR_TELEGRAM_API_URL`) is honored so tests can intercept this
   * download with the same in-process fake server they use for the JSON API.
   *
   * When `maxBytes` is set, the response body is streamed with a running byte
   * counter and aborts with `TelegramDownloadTooLargeError` as soon as the cap
   * is crossed, before materializing the rest of the payload in memory.
   */
  async downloadFile(filePath: string, timeoutMs = 30_000, maxBytes?: number): Promise<Buffer> {
    const url = `${this.baseUrl}/file/bot${this.token}/${filePath}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new TelegramApiError(res.status, null, `Telegram downloadFile ${res.status}: ${text.slice(0, 200)}`);
      }
      if (!res.body) return Buffer.alloc(0);
      const reader = res.body.getReader();
      const chunks: Buffer[] = [];
      let bytesRead = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytesRead += value.byteLength;
          if (maxBytes !== undefined && bytesRead > maxBytes) {
            controller.abort();
            throw new TelegramDownloadTooLargeError(maxBytes, bytesRead);
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
      return Buffer.concat(chunks, bytesRead);
    } finally {
      clearTimeout(timer);
    }
  }
}
