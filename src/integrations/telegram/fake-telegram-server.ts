/**
 * Tiny in-process Telegram Bot API stand-in for tests.
 *
 * Returns canned getUpdates batches and captures outbound sendMessage /
 * editMessageText / answerCallbackQuery calls so the test can assert on them.
 *
 * Usage:
 *   const fake = await startFakeTelegram();
 *   process.env.KOOKR_TELEGRAM_API_URL = fake.baseUrl;
 *   fake.queueUpdates([{ update_id: 1, message: {...} }]);
 *   ...
 *   expect(fake.outbound.sendMessage).toHaveBeenCalled();
 *   await fake.stop();
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { TelegramUpdate } from './api-client.js';

export interface FakeTelegramServer {
  baseUrl: string;
  queueUpdates(updates: TelegramUpdate[]): void;
  /**
   * Stash a fake Telegram file. The integration test should call this BEFORE
   * queueing the update that references `fileId`. `bytes` is what
   * `downloadFile` returns; `filePath` is what `getFile` reports back.
   */
  registerFile(fileId: string, filePath: string, bytes: Buffer, reportedFileSize?: number | null): void;
  outbound: {
    getUpdates: number;
    sendMessage: Array<{ chat_id: number; text: string; reply_markup?: unknown }>;
    editMessageText: Array<{ chat_id: number; message_id: number; text: string }>;
    answerCallbackQuery: Array<{ callback_query_id: string; text?: string }>;
    getFile: Array<{ file_id: string }>;
    downloadFile: Array<{ filePath: string }>;
  };
  stop(): Promise<void>;
}

interface PendingBatch {
  updates: TelegramUpdate[];
}

export async function startFakeTelegram(): Promise<FakeTelegramServer> {
  const queue: PendingBatch[] = [];
  const pendingEmptyPolls = new Map<NodeJS.Timeout, () => void>();
  let nextMessageId = 100;
  const files = new Map<string, { filePath: string; bytes: Buffer; reportedFileSize?: number | null }>();
  const outbound = {
    getUpdates: 0,
    sendMessage: [] as Array<{ chat_id: number; text: string; reply_markup?: unknown }>,
    editMessageText: [] as Array<{ chat_id: number; message_id: number; text: string }>,
    answerCallbackQuery: [] as Array<{ callback_query_id: string; text?: string }>,
    getFile: [] as Array<{ file_id: string }>,
    downloadFile: [] as Array<{ filePath: string }>,
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => { chunks.push(typeof c === 'string' ? Buffer.from(c) : c); });
    req.on('end', () => {
      const respond = (result: unknown) => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, result }));
      };
      const url = req.url ?? '';
      // File CDN download — `/file/bot<TOKEN>/<file_path>`. Path is opaque to us.
      const fileMatch = url.match(/\/file\/bot[^/]+\/(.+)$/);
      if (fileMatch) {
        const filePath = fileMatch[1];
        outbound.downloadFile.push({ filePath });
        const entry = Array.from(files.values()).find((f) => f.filePath === filePath);
        if (!entry) {
          res.statusCode = 404;
          res.setHeader('content-type', 'text/plain');
          res.end('not found');
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/octet-stream');
        res.end(entry.bytes);
        return;
      }
      const body = Buffer.concat(chunks).toString();
      let payload: Record<string, unknown> = {};
      try { payload = body ? JSON.parse(body) : {}; } catch { /* noop */ }
      if (url.includes('/getUpdates')) {
        outbound.getUpdates += 1;
        const batch = queue.shift();
        if (batch) {
          respond(batch.updates);
        } else {
          // Telegram getUpdates is a long poll. A small bounded delay models
          // that behavior without monopolizing a loopback connection, and
          // prevents the integration from busy-spinning under suite load.
          const timer = setTimeout(() => {
            pendingEmptyPolls.delete(timer);
            respond([]);
          }, 25);
          pendingEmptyPolls.set(timer, () => respond([]));
        }
        return;
      }
      if (url.includes('/getFile')) {
        const fileId = String(payload['file_id'] ?? '');
        outbound.getFile.push({ file_id: fileId });
        const entry = files.get(fileId);
        if (!entry) {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: false, description: 'file not found' }));
          return;
        }
        respond({
          file_id: fileId,
          file_unique_id: fileId,
          file_path: entry.filePath,
          ...(entry.reportedFileSize !== null ? { file_size: entry.reportedFileSize ?? entry.bytes.length } : {}),
        });
        return;
      }
      if (url.includes('/sendMessage')) {
        outbound.sendMessage.push(payload as { chat_id: number; text: string });
        const message_id = nextMessageId++;
        respond({ message_id, chat: { id: payload['chat_id'] }, text: payload['text'] });
        return;
      }
      if (url.includes('/editMessageText')) {
        outbound.editMessageText.push(payload as { chat_id: number; message_id: number; text: string });
        respond(true);
        return;
      }
      if (url.includes('/answerCallbackQuery')) {
        outbound.answerCallbackQuery.push(payload as { callback_query_id: string; text?: string });
        respond(true);
        return;
      }
      // Unknown method — succeed silently so tests don't fail on incidental calls.
      respond({});
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    queueUpdates(updates) {
      queue.push({ updates });
    },
    registerFile(fileId, filePath, bytes, reportedFileSize) {
      files.set(fileId, { filePath, bytes, reportedFileSize });
    },
    outbound,
    stop: () => {
      for (const [timer, respondEmpty] of pendingEmptyPolls) {
        clearTimeout(timer);
        respondEmpty();
      }
      pendingEmptyPolls.clear();
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
