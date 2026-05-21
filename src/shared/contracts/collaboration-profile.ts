export const PRIVATE_NETWORK_PROFILE_SCHEMA_VERSION = 'private-network-profile.v1' as const;
export const COLLABORATION_HEALTH_SCHEMA_VERSION = 'collaboration-health.v1' as const;

export type PrivateNetworkHint = 'tailscale' | 'wireguard' | 'ssh-tunnel' | 'lan' | 'corp-vpn' | 'other';

export type PrivateNetworkTransportSecurity =
  | 'https-required'
  | 'loopback-tunnel-only'
  | 'authenticated-secure-tunnel';

export type CollaborationProfileHealth =
  | { state: 'notConfigured' }
  | { state: 'disabled'; reason: string }
  | { state: 'unreachable'; checkedAt: string; detail?: string }
  | { state: 'identityMismatch'; checkedAt: string }
  | { state: 'unverifiedDevice'; checkedAt: string }
  | { state: 'auditUnavailable'; checkedAt: string }
  | { state: 'ok'; checkedAt: string; peerNodeLabel?: string };

export interface PrivateNetworkConnectionProfile {
  schemaVersion: typeof PRIVATE_NETWORK_PROFILE_SCHEMA_VERSION;
  profileId: string;
  label: string;
  peerBaseUrl: string;
  networkHint: PrivateNetworkHint;
  transportSecurity: PrivateNetworkTransportSecurity;
  expectedPeerFingerprint?: string;
  lastHealth?: CollaborationProfileHealth;
  createdAt: string;
  updatedAt: string;
}

export interface CollaborationFeatureFlags {
  profiles: boolean;
  listener: boolean;
  privateNetwork: boolean;
  contactShareViewOnly: boolean;
}

export interface CollaborationListenerStatus {
  enabled: boolean;
  host: string;
  port: number;
  url: string;
}

export interface CollaborationHealthResponse {
  schemaVersion: typeof COLLABORATION_HEALTH_SCHEMA_VERSION;
  profileKind: 'privateNetwork';
  featureFlags: CollaborationFeatureFlags;
  listener: CollaborationListenerStatus;
  profile: PrivateNetworkConnectionProfile | null;
  health: CollaborationProfileHealth;
  rollback: {
    disableFlags: Array<keyof CollaborationFeatureFlags>;
    behavior: 'reject-new-collaboration-requests-preserve-state';
  };
}
