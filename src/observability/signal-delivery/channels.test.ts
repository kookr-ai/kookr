import { describe, expect, test, vi } from 'vitest';
import {
  DISCORD_MAX_CONTENT,
  TELEGRAM_MAX_CONTENT,
  deliverToDiscord,
  deliverToTelegram,
} from './channels.js';

function okFetch() {
  return vi.fn(async () => new Response(null, { status: 204 }));
}

describe('deliverToDiscord', () => {
  test('POSTs { content } to the webhook URL', async () => {
    const fetchImpl = okFetch();
    const res = await deliverToDiscord({ webhookUrl: 'https://discord/webhook' }, 'hello', { fetchImpl });
    expect(res.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://discord/webhook');
    expect(JSON.parse(init!.body as string)).toEqual({ content: 'hello' });
  });

  test('truncates over-long content', async () => {
    const fetchImpl = okFetch();
    await deliverToDiscord({ webhookUrl: 'u' }, 'x'.repeat(5000), { fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string) as { content: string };
    expect(body.content.length).toBeLessThanOrEqual(DISCORD_MAX_CONTENT);
    expect(body.content.endsWith('…')).toBe(true);
  });

  test('reports non-2xx as failure without throwing', async () => {
    const fetchImpl = vi.fn(async () => new Response('no', { status: 500 }));
    const res = await deliverToDiscord({ webhookUrl: 'u' }, 'x', { fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
  });

  test('reports network error without throwing', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const res = await deliverToDiscord({ webhookUrl: 'u' }, 'x', { fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('ECONNREFUSED');
  });
});

describe('deliverToTelegram', () => {
  test('POSTs sendMessage with chat_id and text', async () => {
    const fetchImpl = okFetch();
    const res = await deliverToTelegram(
      { botToken: 'TOK', chatId: '123', baseUrl: 'https://tg.test' },
      'hello',
      { fetchImpl },
    );
    expect(res.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://tg.test/botTOK/sendMessage');
    const body = JSON.parse(init!.body as string) as { chat_id: string; text: string };
    expect(body.chat_id).toBe('123');
    expect(body.text).toBe('hello');
  });

  test('truncates to the Telegram limit', async () => {
    const fetchImpl = okFetch();
    await deliverToTelegram({ botToken: 't', chatId: 'c' }, 'y'.repeat(9000), { fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string) as { text: string };
    expect(body.text.length).toBeLessThanOrEqual(TELEGRAM_MAX_CONTENT);
  });
});
