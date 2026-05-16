import type { HostedRelayPairRequest, HostedRelayStatus } from './hosted-relay.js';

export type RelayConnectionSource = 'none' | 'env' | 'stored' | 'hosted';

export type RelayConnectionState =
  | 'localOnly'
  | 'configured'
  | 'connecting'
  | 'connected'
  | 'backingOff'
  | 'stopped'
  | 'authFailed'
  | 'error';

export interface RelayConnectionErrorView {
  code: string;
  message: string;
  at: string;
}

export interface RelayConnectionStatus {
  configured: boolean;
  source: RelayConnectionSource;
  relayUrl?: string;
  displayName?: string;
  connectionState: RelayConnectionState;
  relayConnected: boolean;
  nodeId?: string;
  nodeMode?: 'active' | 'degraded';
  lastConnectedAt?: string;
  lastError?: RelayConnectionErrorView;
  hostedRelay: HostedRelayStatus;
}

export interface RelayConnectionConnectRequest {
  relayUrl: string;
  nodeId: string;
  relayToken: string;
  displayName?: string;
  publicBaseUrl?: string;
}

export interface RelayConnectionPairRequest {
  relayUrl: string;
  relayAdminToken: string;
  displayName?: string;
  publicBaseUrl?: string;
}

export type RelayConnectionHostedPairRequest = HostedRelayPairRequest;

export interface RelayConnectionRotateRequest {
  relayAdminToken: string;
}

export interface RelayConnectionStatusResponse {
  status: RelayConnectionStatus;
}

export interface RelayNodeCredentialStatusResponse {
  nodeId: string;
  displayName: string;
}
