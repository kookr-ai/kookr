import { describe, expect, it } from 'vitest';

import { redactRelaySecret } from './relay-secret-redaction.js';

describe('redactRelaySecret', () => {
  it('redacts bearer tokens from relay command and log lines', () => {
    expect(
      redactRelaySecret(
        'curl -H "Authorization: Bearer kookr_tok_v1_a9B-cD_eF0123456789" http://127.0.0.1:4800/relay/node/status',
      ),
    ).toBe(
      'curl -H "Authorization: Bearer [redacted]" http://127.0.0.1:4800/relay/node/status',
    );

    expect(
      redactRelaySecret(
        '[relay] fetch /relay/admin/nodes authorization=Bearer admin-secret-0123456789',
      ),
    ).toBe('[relay] fetch /relay/admin/nodes authorization=Bearer [redacted]');

    expect(redactRelaySecret('authorization: Bearer secret')).toBe(
      'authorization: Bearer [redacted]',
    );

    expect(redactRelaySecret(`headers: { authorization: 'Bearer admin' }`)).toBe(
      `headers: { authorization: 'Bearer [redacted]' }`,
    );
  });

  it('redacts relay secrets in environment assignments', () => {
    const input = [
      'KOOKR_RELAY_ADMIN_TOKEN=admin-secret-0123456789',
      'KOOKR_RELAY_ACCOUNT_TOKEN=account-secret-0123456789',
      'KOOKR_RELAY_CLIENT_KEY=client-key-0123456789',
      'KOOKR_RELAY_PASSWORD=password-secret-0123456789',
    ].join(' ');

    expect(redactRelaySecret(input)).toBe([
      'KOOKR_RELAY_ADMIN_TOKEN=[redacted]',
      'KOOKR_RELAY_ACCOUNT_TOKEN=[redacted]',
      'KOOKR_RELAY_CLIENT_KEY=[redacted]',
      'KOOKR_RELAY_PASSWORD=[redacted]',
    ].join(' '));
  });

  it('redacts relay token prefixes and serialized credential fields', () => {
    const input = [
      'node token kookr_tok_v1_AbCdEf0123456789-_',
      '{"relayToken":"kookr_tok_v1_relaySecret","nodeToken":"node-secret-0123456789"}',
      '"adminToken": "admin-secret-0123456789"',
      'accountToken: "account-secret-0123456789"',
    ].join('\n');

    expect(redactRelaySecret(input)).toBe([
      'node token kookr_tok_v1_[redacted]',
      '{"relayToken":"[redacted]","nodeToken":"[redacted]"}',
      '"adminToken": "[redacted]"',
      'accountToken: "[redacted]"',
    ].join('\n'));
  });

  it('is idempotent after secrets have been redacted', () => {
    const input = [
      'Authorization: Bearer kookr_tok_v1_a9B-cD_eF0123456789',
      'KOOKR_RELAY_ADMIN_TOKEN=admin-secret-0123456789',
      '{"relayToken":"kookr_tok_v1_relaySecret"}',
    ].join('\n');

    const once = redactRelaySecret(input);

    expect(redactRelaySecret(once)).toBe(once);
  });

  it('redacts secrets independently across multiline input', () => {
    expect(
      redactRelaySecret([
        '[relay] starting',
        'Authorization: Bearer kookr_tok_v1_firstSecret0123456789',
        'details unchanged',
        'KOOKR_RELAY_TOKEN=kookr_tok_v1_secondSecret0123456789',
      ].join('\n')),
    ).toBe([
      '[relay] starting',
      'Authorization: Bearer [redacted]',
      'details unchanged',
      'KOOKR_RELAY_TOKEN=[redacted]',
    ].join('\n'));
  });

  it('does not treat later lines as bearer tokens', () => {
    const input = [
      'Authorization: Bearer',
      'relayTokenCount=2',
      'KOOKR_RELAY_PORT=4800',
    ].join('\n');

    expect(redactRelaySecret(input)).toBe(input);
  });

  it('leaves non-secret prose and adjacent relay status text untouched', () => {
    const input = [
      'Relay is running as pid 1234.',
      'The log bearer level is informational.',
      'Bearer of good news should stay readable prose.',
      'Bearer credential guidance should stay readable prose.',
      'relayTokenCount=2',
      'KOOKR_RELAY_PORT=4800',
    ].join('\n');

    expect(redactRelaySecret(input)).toBe(input);
  });
});
