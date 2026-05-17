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
  setupDiagnosis: RelaySetupDiagnosis;
  hostedRelay: HostedRelayStatus;
}

export interface RelaySetupDiagnosis {
  envState: 'ok' | 'missing-env' | 'missing-admin-token' | 'restart-required';
  envMessage: string;
  requiresRelayRestart: boolean;
  envFilePath: string;
  localRelayCommands: {
    start: 'pnpm relay:start';
    status: 'pnpm relay:status';
    logs: 'pnpm relay:logs';
    restart: 'pnpm relay:restart';
    stop: 'pnpm relay:stop';
    doctor: 'pnpm relay:doctor';
  };
  recommendedAction:
    | { kind: 'restartKookr'; command: 'pnpm prod:restart'; reason: string }
    | { kind: 'restartRelay'; command: 'pnpm relay:restart'; reason: string }
    | { kind: 'repairRelayPairing'; command: string; reason: string }
    | { kind: 'fixEnv'; command: string; reason: string }
    | { kind: 'none'; reason: string };
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
