import { describe, expect, it } from 'vitest';

import {
  isValidTelegramApiUrl,
  MAX_TELEGRAM_API_URL_LENGTH,
  validateTelegramApiUrl,
} from './telegram-api-url.js';
import { TelegramApiClient } from './api-client.js';

describe('validateTelegramApiUrl (#2219)', () => {
  it.each([
    'https://api.telegram.org',
    'https://api.telegram.org/',
    'http://127.0.0.1:18080',
    'http://127.0.0.1:18080/',
    'http://localhost:9999',
    'http://[::1]:9999',
    'http://192.168.1.50:8080',
    'http://10.0.0.5:8080',
    'http://172.16.0.1:8080',
    'http://100.64.1.2:8080',
    'https://bot-api.example.com',
  ])('allows legitimate telegram API URL %s', (url) => {
    expect(validateTelegramApiUrl(url)).toEqual({ ok: true, url });
    expect(isValidTelegramApiUrl(url)).toBe(true);
  });

  it('trims surrounding whitespace before validating', () => {
    expect(validateTelegramApiUrl('  https://api.telegram.org  ')).toEqual({
      ok: true,
      url: 'https://api.telegram.org',
    });
  });

  it.each([
    ['', 'telegram API URL is required'],
    ['   ', 'telegram API URL is required'],
    ['not-a-url', 'telegram API URL must be a valid URL'],
    ['ftp://api.telegram.org', 'telegram API URL must use http or https'],
    ['file:///etc/passwd', 'telegram API URL must use http or https'],
    ['ws://127.0.0.1:18080', 'telegram API URL must use http or https'],
    ['http://user:pass@127.0.0.1:18080', 'telegram API URL must not include credentials'],
    ['https://token@api.telegram.org', 'telegram API URL must not include credentials'],
    ['http://metadata/', 'telegram API URL host is not allowed'],
    ['http://metadata.google.internal/', 'telegram API URL host is not allowed'],
    ['http://metadata.google.internal./', 'telegram API URL host is not allowed'],
    ['http://metadata.goog/', 'telegram API URL host is not allowed'],
    ['http://instance-data/', 'telegram API URL host is not allowed'],
    ['http://169.254.169.254/', 'telegram API URL address is not allowed'],
    ['http://169.254.169.254/latest/meta-data/', 'telegram API URL address is not allowed'],
    ['http://169.254.0.1/', 'telegram API URL address is not allowed'],
    ['http://0.0.0.0:8080', 'telegram API URL address is not allowed'],
    ['http://224.0.0.1/', 'telegram API URL address is not allowed'],
    ['http://[fe80::1]/', 'telegram API URL address is not allowed'],
    ['http://[ff02::1]/', 'telegram API URL address is not allowed'],
    ['http://[::]/', 'telegram API URL address is not allowed'],
    ['http://[::ffff:169.254.169.254]/', 'telegram API URL address is not allowed'],
  ])('rejects %s', (url, reason) => {
    expect(validateTelegramApiUrl(url)).toEqual({ ok: false, reason });
    expect(isValidTelegramApiUrl(url)).toBe(false);
  });

  it('rejects oversized URLs', () => {
    const url = `http://example.com/${'a'.repeat(MAX_TELEGRAM_API_URL_LENGTH)}`;
    expect(validateTelegramApiUrl(url)).toEqual({
      ok: false,
      reason: 'telegram API URL is too long',
    });
  });
});

describe('TelegramApiClient base URL validation (#2219)', () => {
  it('accepts the default api.telegram.org base URL', () => {
    expect(() => new TelegramApiClient('token')).not.toThrow();
  });

  it('accepts loopback fake-server base URLs used by tests', () => {
    expect(() => new TelegramApiClient('token', 'http://127.0.0.1:18080')).not.toThrow();
    expect(() => new TelegramApiClient('token', 'http://localhost:9999')).not.toThrow();
  });

  it('throws before any fetch when the constructor base URL is cloud metadata', () => {
    expect(() => new TelegramApiClient('token', 'http://169.254.169.254/')).toThrow(
      /Invalid Telegram API base URL: telegram API URL address is not allowed/,
    );
    expect(() => new TelegramApiClient('token', 'http://metadata.google.internal/')).toThrow(
      /Invalid Telegram API base URL: telegram API URL host is not allowed/,
    );
  });

  it('throws when KOOKR_TELEGRAM_API_URL points at a blocked host', () => {
    const original = process.env.KOOKR_TELEGRAM_API_URL;
    process.env.KOOKR_TELEGRAM_API_URL = 'http://metadata.google.internal/';
    try {
      expect(() => new TelegramApiClient('token')).toThrow(
        /Invalid Telegram API base URL: telegram API URL host is not allowed/,
      );
    } finally {
      if (original === undefined) delete process.env.KOOKR_TELEGRAM_API_URL;
      else process.env.KOOKR_TELEGRAM_API_URL = original;
    }
  });
});
