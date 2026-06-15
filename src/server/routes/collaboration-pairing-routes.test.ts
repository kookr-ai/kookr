import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContactIdentityStore } from '../contact-identity-store.js';
import { registerCollaborationPairingRoutes } from './collaboration-pairing-routes.js';
import { SHARE_CSRF_HEADER } from './share-routes.js';
import { createJsonRequestBodyLimitMiddleware, type RouteDeps } from './shared.js';

const CSRF = 'csrf-pairing-test';
const ORIGIN = 'http://127.0.0.1';

function publicKey(): string {
  return generateKeyPairSync('rsa', { modulusLength: 2048 })
    .publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString()
    .trim();
}

function mkApp(kookrDir: string, opts: { requestBodyLimitBytes?: number } = {}): Hono {
  const app = new Hono();
  if (opts.requestBodyLimitBytes !== undefined) {
    app.use('/api/*', createJsonRequestBodyLimitMiddleware(opts.requestBodyLimitBytes));
  }
  registerCollaborationPairingRoutes(app, {
    kookrDir,
    remoteShare: { csrfToken: CSRF, client: null },
  } as unknown as RouteDeps);
  return app;
}

async function post(app: Hono, body: unknown): Promise<Response> {
  return app.request(`${ORIGIN}/api/collaboration/pairing/verify`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Origin: ORIGIN,
      [SHARE_CSRF_HEADER]: CSRF,
    },
    body: JSON.stringify(body),
  });
}

async function acceptedPairingBody(kookrDir: string) {
  const store = new ContactIdentityStore({ kookrDir });
  await store.load();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const offer = await store.createPairingOffer({
    publicKey: publicKey(),
    nonce: 'offer-nonce',
    commitment: 'offer-commitment',
    expiresAt,
    label: 'Jean desktop',
  });
  const accepted = await store.acceptPairingOffer({
    pairingId: offer.pairingId,
    publicKey: publicKey(),
    nonce: 'accept-nonce',
    commitment: 'accept-commitment',
    expiresAt,
    label: 'Alice laptop',
  });
  return {
    pairingId: accepted.pairingId,
    verifiedFingerprint: accepted.verifiedFingerprint,
    verificationCode: accepted.verificationCode,
  };
}

describe('collaboration pairing routes', () => {
  let kookrDir: string;

  beforeEach(async () => {
    kookrDir = await mkdtemp(join(tmpdir(), 'kookr-collaboration-pairing-routes-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(kookrDir, { recursive: true, force: true });
  });

  it('verifies a valid accepted pairing request', async () => {
    const body = await acceptedPairingBody(kookrDir);
    const res = await post(mkApp(kookrDir), body);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(expect.objectContaining({
      pairingId: body.pairingId,
      verifiedFingerprint: body.verifiedFingerprint,
      verificationCode: body.verificationCode,
      contact: expect.objectContaining({ displayName: 'Alice laptop', trustState: 'verified' }),
      device: expect.objectContaining({ label: 'Alice laptop', trustState: 'verified' }),
    }));
  });

  it('rejects malformed JSON before pairing verification', async () => {
    const res = await mkApp(kookrDir).request(`${ORIGIN}/api/collaboration/pairing/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: ORIGIN,
        [SHARE_CSRF_HEADER]: CSRF,
      },
      body: 'not json',
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid-json-body' });
  });

  it.each([
    ['null body', null],
    ['array body', []],
    ['extra key', {
      pairingId: 'pairing-1',
      verifiedFingerprint: 'fingerprint',
      verificationCode: '123456',
      unexpected: true,
    }],
    ['empty required string', {
      pairingId: 'pairing-1',
      verifiedFingerprint: ' ',
      verificationCode: '123456',
    }],
  ])('rejects invalid body shape before pairing verification: %s', async (_name, body) => {
    const verifyAcceptedPairing = vi.spyOn(ContactIdentityStore.prototype, 'verifyAcceptedPairing');
    const res = await post(mkApp(kookrDir), body);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid-pairing-verification' });
    expect(verifyAcceptedPairing).not.toHaveBeenCalled();
  });

  it('rejects oversized JSON bodies with a clear client error', async () => {
    const res = await post(mkApp(kookrDir, { requestBodyLimitBytes: 96 }), {
      pairingId: 'pairing-1',
      verifiedFingerprint: 'x'.repeat(128),
      verificationCode: '123456',
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: 'request-body-too-large',
      message: 'JSON request body exceeds the 96 byte limit',
      limitBytes: 96,
    });
  });
});
