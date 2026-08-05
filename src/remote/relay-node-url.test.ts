import { describe, expect, it } from 'vitest';

import {
  isValidRelayNodeUrl,
  MAX_RELAY_NODE_URL_LENGTH,
  validateRelayNodeUrl,
} from './relay-node-url.js';

describe('validateRelayNodeUrl', () => {
  it.each([
    'http://127.0.0.1:4800',
    'http://127.0.0.1:4800/',
    'http://localhost:4800',
    'ws://127.0.0.1:4800',
    'wss://relay.example.com',
    'https://relay.example.com/v1',
    'http://192.168.1.50:4800',
    'http://10.0.0.5:4800',
    'http://172.16.0.1:4800',
    'http://100.64.1.2:4800',
    'http://[::1]:4800',
    'ws://[fd12:3456:789a::1]:4800',
  ])('allows legitimate relay URL %s', (url) => {
    expect(validateRelayNodeUrl(url)).toEqual({ ok: true });
    expect(isValidRelayNodeUrl(url)).toBe(true);
  });

  it('trims surrounding whitespace before validating', () => {
    expect(validateRelayNodeUrl('  http://127.0.0.1:4800  ')).toEqual({ ok: true });
  });

  it.each([
    ['', 'relay URL is required'],
    ['   ', 'relay URL is required'],
    ['not-a-url', 'relay URL must be a valid URL'],
    ['ftp://127.0.0.1:4800', 'relay URL must use http, https, ws, or wss'],
    ['file:///etc/passwd', 'relay URL must use http, https, ws, or wss'],
    ['http://user:pass@127.0.0.1:4800', 'relay URL must not include credentials'],
    ['https://token@relay.example.com', 'relay URL must not include credentials'],
    ['http://metadata/', 'relay URL host is not allowed'],
    ['http://metadata.google.internal/computeMetadata/v1/', 'relay URL host is not allowed'],
    ['http://metadata.goog/', 'relay URL host is not allowed'],
    ['http://instance-data/', 'relay URL host is not allowed'],
    ['http://169.254.169.254/latest/meta-data/', 'relay URL address is not allowed'],
    ['http://169.254.0.1/', 'relay URL address is not allowed'],
    ['http://0.0.0.0:4800', 'relay URL address is not allowed'],
    ['http://224.0.0.1/', 'relay URL address is not allowed'],
    ['http://[fe80::1]/', 'relay URL address is not allowed'],
    ['http://[ff02::1]/', 'relay URL address is not allowed'],
    ['http://[::]', 'relay URL address is not allowed'],
    ['http://[::ffff:169.254.169.254]/', 'relay URL address is not allowed'],
  ])('rejects %s', (url, reason) => {
    expect(validateRelayNodeUrl(url)).toEqual({ ok: false, reason });
    expect(isValidRelayNodeUrl(url)).toBe(false);
  });

  it('rejects oversized URLs', () => {
    const url = `http://example.com/${'a'.repeat(MAX_RELAY_NODE_URL_LENGTH)}`;
    expect(validateRelayNodeUrl(url)).toEqual({
      ok: false,
      reason: 'relay URL is too long',
    });
  });
});
