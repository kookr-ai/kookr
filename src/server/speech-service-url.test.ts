import { describe, expect, it } from 'vitest';

import {
  isValidSpeechServiceUrl,
  MAX_SPEECH_SERVICE_URL_LENGTH,
  validateSpeechServiceUrl,
} from './speech-service-url.js';

describe('validateSpeechServiceUrl', () => {
  it.each([
    'http://127.0.0.1:8004',
    'http://127.0.0.1:8004/',
    'http://localhost:8004',
    'ws://127.0.0.1:8003',
    'wss://stt.example.com/stream',
    'https://tts.example.com/v1',
    'http://192.168.1.50:8004',
    'http://10.0.0.5:8004',
    'http://172.16.0.1:8004',
    'http://100.64.1.2:8004',
    'http://[::1]:8004',
    'ws://[fd12:3456:789a::1]:8003',
  ])('allows legitimate speech service URL %s', (url) => {
    expect(validateSpeechServiceUrl(url)).toEqual({ ok: true });
    expect(isValidSpeechServiceUrl(url)).toBe(true);
  });

  it('trims surrounding whitespace before validating', () => {
    expect(validateSpeechServiceUrl('  http://127.0.0.1:8004  ')).toEqual({ ok: true });
  });

  it.each([
    ['', 'speech service URL is required'],
    ['   ', 'speech service URL is required'],
    ['not-a-url', 'speech service URL must be a valid URL'],
    ['ftp://127.0.0.1:8004', 'speech service URL must use http, https, ws, or wss'],
    ['file:///etc/passwd', 'speech service URL must use http, https, ws, or wss'],
    ['http://user:pass@127.0.0.1:8004', 'speech service URL must not include credentials'],
    ['https://token@tts.example.com', 'speech service URL must not include credentials'],
    ['http://metadata/', 'speech service URL host is not allowed'],
    ['http://metadata.google.internal/computeMetadata/v1/', 'speech service URL host is not allowed'],
    ['http://metadata.goog/', 'speech service URL host is not allowed'],
    ['http://instance-data/', 'speech service URL host is not allowed'],
    ['http://169.254.169.254/latest/meta-data/', 'speech service URL address is not allowed'],
    ['http://169.254.0.1/', 'speech service URL address is not allowed'],
    ['http://0.0.0.0:8004', 'speech service URL address is not allowed'],
    ['http://224.0.0.1/', 'speech service URL address is not allowed'],
    ['http://[fe80::1]/', 'speech service URL address is not allowed'],
    ['http://[ff02::1]/', 'speech service URL address is not allowed'],
    ['http://[::]/', 'speech service URL address is not allowed'],
    ['http://[::ffff:169.254.169.254]/', 'speech service URL address is not allowed'],
  ])('rejects %s', (url, reason) => {
    expect(validateSpeechServiceUrl(url)).toEqual({ ok: false, reason });
    expect(isValidSpeechServiceUrl(url)).toBe(false);
  });

  it('rejects oversized URLs', () => {
    const url = `http://example.com/${'a'.repeat(MAX_SPEECH_SERVICE_URL_LENGTH)}`;
    expect(validateSpeechServiceUrl(url)).toEqual({
      ok: false,
      reason: 'speech service URL is too long',
    });
  });
});
