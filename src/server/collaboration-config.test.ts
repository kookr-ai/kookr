import { describe, expect, it } from 'vitest';

import {
  DEFAULT_COLLABORATION_LISTENER_PORT,
  readPrivateNetworkCollaborationConfig,
  validateCollaborationPeerBaseUrl,
} from './collaboration-config.js';

const PRIVATE_NETWORK_FLAGS = {
  KOOKR_COLLABORATION_PROFILES: '1',
  KOOKR_COLLABORATION_LISTENER: '1',
  KOOKR_COLLABORATION_PRIVATE_NETWORK: '1',
} as const;

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

  it('rejects a cloud-metadata peer base URL so the update poller never fetches it', () => {
    const config = readPrivateNetworkCollaborationConfig({
      env: {
        ...PRIVATE_NETWORK_FLAGS,
        KOOKR_COLLABORATION_PEER_BASE_URL: 'http://metadata.google.internal/',
      },
      dashboardHost: '127.0.0.1',
      dashboardPort: 4801,
      now: () => new Date('2026-05-21T00:00:00.000Z'),
    });

    expect(config.profile).toBeNull();
    expect(config.health).toEqual({
      state: 'disabled',
      reason: 'collaboration-peer-url-rejected:peer-url-cloud-metadata-host',
    });
    // The listener is independent of the peer URL and keeps running.
    expect(config.shouldStartListener).toBe(true);
  });

  it('rejects the 169.254.169.254 link-local metadata address', () => {
    const config = readPrivateNetworkCollaborationConfig({
      env: {
        ...PRIVATE_NETWORK_FLAGS,
        KOOKR_COLLABORATION_PEER_BASE_URL: 'http://169.254.169.254/',
      },
      dashboardHost: '127.0.0.1',
      dashboardPort: 4801,
      now: () => new Date('2026-05-21T00:00:00.000Z'),
    });

    expect(config.profile).toBeNull();
    expect(config.health).toEqual({
      state: 'disabled',
      reason: 'collaboration-peer-url-rejected:peer-url-link-local-host',
    });
    // The listener is independent of the peer URL and keeps running.
    expect(config.shouldStartListener).toBe(true);
  });

  it('still builds a profile for a private-LAN peer', () => {
    const config = readPrivateNetworkCollaborationConfig({
      env: {
        ...PRIVATE_NETWORK_FLAGS,
        KOOKR_COLLABORATION_PEER_BASE_URL: 'https://192.168.1.42:4902',
      },
      dashboardHost: '127.0.0.1',
      dashboardPort: 4801,
      now: () => new Date('2026-05-21T00:00:00.000Z'),
    });

    expect(config.shouldStartListener).toBe(true);
    expect(config.profile).toMatchObject({ peerBaseUrl: 'https://192.168.1.42:4902' });
    expect(config.health).toEqual({ state: 'ok', checkedAt: '2026-05-21T00:00:00.000Z' });
  });
});

describe('validateCollaborationPeerBaseUrl', () => {
  it('rejects cloud instance-metadata hostnames', () => {
    expect(validateCollaborationPeerBaseUrl('http://metadata.google.internal/')).toEqual({
      ok: false,
      reason: 'peer-url-cloud-metadata-host',
    });
    expect(validateCollaborationPeerBaseUrl('http://metadata/')).toEqual({
      ok: false,
      reason: 'peer-url-cloud-metadata-host',
    });
    // Same host class the sibling webhook / speech / relay egress guards reject.
    expect(validateCollaborationPeerBaseUrl('http://metadata.goog/')).toEqual({
      ok: false,
      reason: 'peer-url-cloud-metadata-host',
    });
    expect(validateCollaborationPeerBaseUrl('http://instance-data/')).toEqual({
      ok: false,
      reason: 'peer-url-cloud-metadata-host',
    });
    // Trailing-dot FQDN must not slip past the hostname normalization.
    expect(validateCollaborationPeerBaseUrl('http://metadata.google.internal./')).toEqual({
      ok: false,
      reason: 'peer-url-cloud-metadata-host',
    });
  });

  it('rejects IPv4 and IPv6 link-local addresses', () => {
    expect(validateCollaborationPeerBaseUrl('http://169.254.169.254/')).toEqual({
      ok: false,
      reason: 'peer-url-link-local-host',
    });
    expect(validateCollaborationPeerBaseUrl('http://[fe80::1]/')).toEqual({
      ok: false,
      reason: 'peer-url-link-local-host',
    });
    expect(validateCollaborationPeerBaseUrl('http://[::ffff:169.254.169.254]/')).toEqual({
      ok: false,
      reason: 'peer-url-link-local-host',
    });
  });

  it('rejects non-http(s) protocols and unparseable URLs', () => {
    expect(validateCollaborationPeerBaseUrl('file:///etc/passwd')).toEqual({
      ok: false,
      reason: 'peer-url-protocol-not-http',
    });
    expect(validateCollaborationPeerBaseUrl('not a url')).toEqual({
      ok: false,
      reason: 'peer-url-invalid',
    });
  });

  it('rejects peer URLs that embed credentials', () => {
    expect(validateCollaborationPeerBaseUrl('https://user:pass@peer.example.test/')).toEqual({
      ok: false,
      reason: 'peer-url-has-credentials',
    });
  });

  it('allows loopback, private-LAN, and public peers', () => {
    expect(validateCollaborationPeerBaseUrl('http://127.0.0.1:4902')).toEqual({ ok: true });
    expect(validateCollaborationPeerBaseUrl('https://10.0.0.5:4902')).toEqual({ ok: true });
    expect(validateCollaborationPeerBaseUrl('https://192.168.1.42:4902')).toEqual({ ok: true });
    expect(validateCollaborationPeerBaseUrl('https://172.16.9.9:4902')).toEqual({ ok: true });
    expect(validateCollaborationPeerBaseUrl('https://peer.example.test:4902')).toEqual({ ok: true });
  });
});
