import { describe, expect, it } from 'vitest';
import { TelegramApiError } from './api-client.js';
import { isUrlButtonRefusal } from './index.js';

/** The error message the API client builds from a 400 answer (`Telegram <method> 400: <body>`, cut at 200 chars). */
function badRequest(description: string): TelegramApiError {
  const body = JSON.stringify({ ok: false, error_code: 400, description });
  return new TelegramApiError(400, null, `Telegram sendMessage 400: ${body.slice(0, 200)}`);
}

describe('isUrlButtonRefusal', () => {
  it.each([
    'Bad Request: BUTTON_URL_INVALID',
    "Bad Request: inline keyboard button URL 'http://localhost:4800/?task=t1' is invalid: Wrong HTTP URL",
    `Bad Request: inline keyboard button URL 'https://example.com/${'a'.repeat(300)}' is invalid: Unsupported URL protocol`,
  ])('is true for Telegram refusing a URL button: %s', (description) => {
    expect(isUrlButtonRefusal(badRequest(description))).toBe(true);
  });

  it.each([
    'Bad Request: chat not found',
    'Bad Request: message is too long',
    "Bad Request: can't parse entities: Unsupported start tag",
  ])('is false for another 400: %s', (description) => {
    expect(isUrlButtonRefusal(badRequest(description))).toBe(false);
  });

  it('is false for a non-400 error and for a plain error', () => {
    expect(isUrlButtonRefusal(new TelegramApiError(403, null, 'Telegram sendMessage 403: BUTTON_URL_INVALID'))).toBe(false);
    expect(isUrlButtonRefusal(new Error('BUTTON_URL_INVALID'))).toBe(false);
  });
});
