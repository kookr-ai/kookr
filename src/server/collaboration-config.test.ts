import { describe, expect, it } from 'vitest';

import {
  DEFAULT_COLLABORATION_LISTENER_PORT,
  readPrivateNetworkCollaborationConfig,
} from './collaboration-config.js';

describe('private-network collaboration config', () => {
  it('keeps the collaboration listener disabled until the phase flags are enabled', () => {
    const config = readPrivateNetworkCollaborationConfig({
      env: {},
      dashboardHost: '127.0.0.1',
      dashboardPort: 4801,
      now: () => new Date('2026-05-21T00:00:00.000Z'),
    });

    expect(config.shouldStartListener).toBe(false);
    expect(config.health).toEqual({
      state: 'disabled',
      reason: 'feature-disabled:collaboration.profiles',
    });
    expect(config.port).toBe(DEFAULT_COLLABORATION_LISTENER_PORT);
  });

  it('rejects using the normal dashboard port as the peer collaboration surface', () => {
    const config = readPrivateNetworkCollaborationConfig({
      env: {
        KOOKR_COLLABORATION_PROFILES: 'true',
        KOOKR_COLLABORATION_LISTENER: 'true',
        KOOKR_COLLABORATION_PRIVATE_NETWORK: 'true',
        KOOKR_COLLABORATION_PORT: '4801',
      },
      dashboardHost: '127.0.0.1',
      dashboardPort: 4801,
      now: () => new Date('2026-05-21T00:00:00.000Z'),
    });

    expect(config.shouldStartListener).toBe(false);
    expect(config.health).toEqual({
      state: 'disabled',
      reason: 'collaboration-listener-must-not-use-kookr-port',
    });
  });

  it('falls back from invalid port zero so diagnostics do not advertise an ephemeral port', () => {
    const config = readPrivateNetworkCollaborationConfig({
      env: {
        KOOKR_COLLABORATION_PROFILES: 'true',
        KOOKR_COLLABORATION_LISTENER: 'true',
        KOOKR_COLLABORATION_PRIVATE_NETWORK: 'true',
        KOOKR_COLLABORATION_PORT: '0',
      },
      dashboardHost: '127.0.0.1',
      dashboardPort: 4801,
      now: () => new Date('2026-05-21T00:00:00.000Z'),
    });

    expect(config.shouldStartListener).toBe(true);
    expect(config.port).toBe(DEFAULT_COLLABORATION_LISTENER_PORT);
    expect(config.url).toBe('http://127.0.0.1:4802');
  });

  it('fails closed for cleartext non-loopback listener configuration', () => {
    const config = readPrivateNetworkCollaborationConfig({
      env: {
        KOOKR_COLLABORATION_PROFILES: 'true',
        KOOKR_COLLABORATION_LISTENER: 'true',
        KOOKR_COLLABORATION_PRIVATE_NETWORK: 'true',
        KOOKR_COLLABORATION_HOST: '0.0.0.0',
        KOOKR_COLLABORATION_PORT: '4902',
      },
      dashboardHost: '127.0.0.1',
      dashboardPort: 4801,
      now: () => new Date('2026-05-21T00:00:00.000Z'),
    });

    expect(config.shouldStartListener).toBe(false);
    expect(config.health).toEqual({
      state: 'disabled',
      reason: 'cleartext-listener-requires-loopback-host',
    });
  });

  it('builds a private-network profile when flags and peer metadata are configured', () => {
    const config = readPrivateNetworkCollaborationConfig({
      env: {
        KOOKR_COLLABORATION_PROFILES: '1',
        KOOKR_COLLABORATION_LISTENER: '1',
        KOOKR_COLLABORATION_PRIVATE_NETWORK: '1',
        KOOKR_COLLABORATION_CONTACT_SHARE_VIEW_ONLY: '1',
        KOOKR_COLLABORATION_PORT: '4902',
        KOOKR_COLLABORATION_PEER_BASE_URL: 'https://peer.example.test:4902',
        KOOKR_COLLABORATION_PROFILE_LABEL: 'Kitchen laptop',
        KOOKR_COLLABORATION_NETWORK_HINT: 'tailscale',
        KOOKR_COLLABORATION_TRANSPORT_SECURITY: 'https-required',
        KOOKR_COLLABORATION_EXPECTED_PEER_FINGERPRINT: 'peer-fingerprint',
      },
      dashboardHost: '127.0.0.1',
      dashboardPort: 4801,
      now: () => new Date('2026-05-21T00:00:00.000Z'),
    });

    expect(config.shouldStartListener).toBe(true);
    expect(config.profile).toMatchObject({
      schemaVersion: 'private-network-profile.v1',
      label: 'Kitchen laptop',
      peerBaseUrl: 'https://peer.example.test:4902',
      networkHint: 'tailscale',
      transportSecurity: 'https-required',
      expectedPeerFingerprint: 'peer-fingerprint',
    });
    expect(config.health).toEqual({ state: 'ok', checkedAt: '2026-05-21T00:00:00.000Z' });
  });
});
