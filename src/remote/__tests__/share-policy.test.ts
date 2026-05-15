import { describe, expect, it } from 'vitest';

import { asGrantId, asNodeId, asPolicyVersion } from '../ids.js';
import { RemotePolicyCache } from '../policy-cache.js';
import { evaluateGrant } from '../share-policy.js';

describe('evaluateGrant', () => {
  it('allows matching unexpired grants and freshness-wins revoked tombstones', () => {
    const cache = new RemotePolicyCache();
    cache.upsert({
      grantId: asGrantId('grant-view'),
      policyVersion: asPolicyVersion(1),
      subject: { kind: 'session', nodeId: asNodeId('node-1'), sessionId: 'session-1' },
      grants: ['view'],
    });
    cache.upsert({
      grantId: asGrantId('grant-1'),
      policyVersion: asPolicyVersion(1),
      subject: { kind: 'session', nodeId: asNodeId('node-1'), sessionId: 'session-1' },
      grants: ['write'],
      expiresAt: '2026-05-15T20:00:00.000Z',
    });

    expect(evaluateGrant(
      cache,
      { kind: 'session', nodeId: asNodeId('node-1'), sessionId: 'session-1' },
      'write',
      new Date('2026-05-15T19:00:00.000Z'),
    )).toMatchObject({ allowed: true, grantId: 'grant-1' });

    cache.revoke(asGrantId('grant-1'), asPolicyVersion(2));
    expect(cache.upsert({
      grantId: asGrantId('grant-1'),
      policyVersion: asPolicyVersion(1),
      subject: { kind: 'session', nodeId: asNodeId('node-1'), sessionId: 'session-1' },
      grants: ['write'],
    })).toBe(false);
    expect(evaluateGrant(
      cache,
      { kind: 'session', nodeId: asNodeId('node-1'), sessionId: 'session-1' },
      'write',
    )).toMatchObject({ allowed: false, reason: 'wrong-action' });
  });

  it('reports revoked when a stale snapshot attempts to retain a revoked grant row', () => {
    const cache = {
      snapshot: () => ({
        policyVersion: asPolicyVersion(2),
        grants: [{
          grantId: asGrantId('grant-revoked'),
          policyVersion: asPolicyVersion(1),
          subject: { kind: 'session' as const, nodeId: asNodeId('node-1'), sessionId: 'session-1' },
          grants: ['write' as const],
        }],
        revokedGrantIds: [asGrantId('grant-revoked')],
      }),
      hasTombstone: () => true,
    } as RemotePolicyCache;

    expect(evaluateGrant(
      cache,
      { kind: 'session', nodeId: asNodeId('node-1'), sessionId: 'session-1' },
      'write',
    )).toMatchObject({ allowed: false, reason: 'revoked' });
  });
});
