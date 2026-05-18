import { createCipheriv, publicEncrypt, randomBytes } from 'node:crypto';

import type { TerminalBytesPayload, TerminalPublicationMetadata } from './stream-events.js';

const ALG = 'RSA-OAEP-SHA256+A256GCM' as const;
const KEY_BYTES = 32;
const IV_BYTES = 12;

export interface ContactTerminalEncryptionInput {
  recipientDeviceId: string;
  recipientPublicKey: string;
  streamKeyId: string;
  aad?: string;
}

export function encryptContactTerminalPayload(
  payload: TerminalBytesPayload,
  input: ContactTerminalEncryptionInput,
): { payload: TerminalBytesPayload; streamEncryption: Extract<NonNullable<TerminalPublicationMetadata['streamEncryption']>, { kind: 'contact-e2ee' }> } {
  const plain = Buffer.from(payload.data, 'base64');
  const key = randomBytes(KEY_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (input.aad) cipher.setAAD(Buffer.from(input.aad, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrappedKey = publicEncrypt({ key: input.recipientPublicKey, oaepHash: 'sha256' }, key);

  return {
    payload: {
      encoding: 'base64',
      data: encrypted.toString('base64'),
      byteLength: plain.byteLength,
    },
    streamEncryption: {
      kind: 'contact-e2ee',
      recipientDeviceId: input.recipientDeviceId,
      streamKeyId: input.streamKeyId,
      alg: ALG,
      wrappedKey: wrappedKey.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
    },
  };
}
