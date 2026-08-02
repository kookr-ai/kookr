import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  decryptContactTerminalPayload,
  encryptContactTerminalPayload,
  type ContactTerminalStreamEncryption,
} from '../terminal-frame-crypto.js';
import type { TerminalBytesPayload } from '../stream-events.js';

function ephemeralRsaPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function bytesPayload(plain: string | Buffer): TerminalBytesPayload {
  const buf = typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain;
  return {
    encoding: 'base64',
    data: buf.toString('base64'),
    byteLength: buf.byteLength,
  };
}

describe('terminal-frame-crypto contact-e2ee wrap/unwrap', () => {
  it('round-trips plaintext with ephemeral recipient keys', () => {
    const recipient = ephemeralRsaPair();
    const plain = 'terminal frame secret payload\nwith newlines and unicode café 🔐';
    const aad = 'node-1:session-1:epoch-1:42';

    const encrypted = encryptContactTerminalPayload(bytesPayload(plain), {
      recipientDeviceId: 'device-a',
      recipientPublicKey: recipient.publicKey,
      streamKeyId: 'stream-key-test',
      aad,
    });

    expect(Buffer.from(encrypted.payload.data, 'base64').toString('utf8')).not.toContain('secret');
    expect(encrypted.payload.byteLength).toBe(Buffer.byteLength(plain, 'utf8'));
    expect(encrypted.streamEncryption).toEqual(expect.objectContaining({
      kind: 'contact-e2ee',
      recipientDeviceId: 'device-a',
      streamKeyId: 'stream-key-test',
      alg: 'RSA-OAEP-SHA256+A256GCM',
    }));

    const recovered = decryptContactTerminalPayload(encrypted.payload, {
      recipientPrivateKey: recipient.privateKey,
      streamEncryption: encrypted.streamEncryption,
      aad,
    });
    expect(recovered.toString('utf8')).toBe(plain);
  });

  it('round-trips an empty payload', () => {
    const recipient = ephemeralRsaPair();
    const encrypted = encryptContactTerminalPayload(bytesPayload(Buffer.alloc(0)), {
      recipientDeviceId: 'device-empty',
      recipientPublicKey: recipient.publicKey,
      streamKeyId: 'stream-empty',
    });

    expect(encrypted.payload.byteLength).toBe(0);
    const recovered = decryptContactTerminalPayload(encrypted.payload, {
      recipientPrivateKey: recipient.privateKey,
      streamEncryption: encrypted.streamEncryption,
    });
    expect(recovered.byteLength).toBe(0);
  });

  it('rejects decryption with the wrong recipient private key', () => {
    const recipient = ephemeralRsaPair();
    const wrong = ephemeralRsaPair();
    const encrypted = encryptContactTerminalPayload(bytesPayload('only-for-device-a'), {
      recipientDeviceId: 'device-a',
      recipientPublicKey: recipient.publicKey,
      streamKeyId: 'stream-key-1',
    });

    expect(() => decryptContactTerminalPayload(encrypted.payload, {
      recipientPrivateKey: wrong.privateKey,
      streamEncryption: encrypted.streamEncryption,
    })).toThrow();
  });

  it('rejects tampered ciphertext and auth tag', () => {
    const recipient = ephemeralRsaPair();
    const encrypted = encryptContactTerminalPayload(bytesPayload('integrity-check'), {
      recipientDeviceId: 'device-a',
      recipientPublicKey: recipient.publicKey,
      streamKeyId: 'stream-key-1',
      aad: 'session-aad',
    });

    const ciphertext = Buffer.from(encrypted.payload.data, 'base64');
    ciphertext[0] = ciphertext[0]! ^ 0xff;
    const tamperedPayload: TerminalBytesPayload = {
      ...encrypted.payload,
      data: ciphertext.toString('base64'),
    };

    expect(() => decryptContactTerminalPayload(tamperedPayload, {
      recipientPrivateKey: recipient.privateKey,
      streamEncryption: encrypted.streamEncryption,
      aad: 'session-aad',
    })).toThrow();

    const tag = Buffer.from(encrypted.streamEncryption.tag, 'base64');
    tag[0] = tag[0]! ^ 0xff;
    const tamperedMeta: ContactTerminalStreamEncryption = {
      ...encrypted.streamEncryption,
      tag: tag.toString('base64'),
    };

    expect(() => decryptContactTerminalPayload(encrypted.payload, {
      recipientPrivateKey: recipient.privateKey,
      streamEncryption: tamperedMeta,
      aad: 'session-aad',
    })).toThrow();
  });

  it('rejects AAD mismatch and does not embed plaintext secrets in metadata', () => {
    const recipient = ephemeralRsaPair();
    const secret = 'CONTACT_SECRET_OUTPUT';
    const encrypted = encryptContactTerminalPayload(bytesPayload(secret), {
      recipientDeviceId: 'device-a',
      recipientPublicKey: recipient.publicKey,
      streamKeyId: 'stream-key-1',
      aad: 'correct-aad',
    });

    const metaJson = JSON.stringify(encrypted.streamEncryption);
    expect(metaJson).not.toContain(secret);
    // AES key material is only present as RSA-wrapped ciphertext, not as raw key bytes.
    expect(encrypted.streamEncryption.wrappedKey.length).toBeGreaterThan(0);
    expect(encrypted.streamEncryption).not.toHaveProperty('key');

    expect(() => decryptContactTerminalPayload(encrypted.payload, {
      recipientPrivateKey: recipient.privateKey,
      streamEncryption: encrypted.streamEncryption,
      aad: 'wrong-aad',
    })).toThrow();
  });
});
