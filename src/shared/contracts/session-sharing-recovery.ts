/** Owner recovery writes this env var; remote modules remain the only readers. */
export const SESSION_SHARING_TERMINAL_TRUST_ENV_NAME = 'KOOKR_RELAY_TRUSTED';

export type SessionSharingRecoveryAction =
  | 'revokeAllShares'
  | 'disableTerminalSharing'
  | 'rotateNodeCredential'
  | 'repairRelayPairing'
  | 'openRelayLogs'
  | 'resetRelayState';

export type SessionSharingRecoveryExecutor =
  | 'share-scoped-owner'
  | 'local-filesystem-process'
  | 'relay-admin-token'
  | 'node-credential-rotation';

export type SessionSharingRecoveryCredential =
  | 'current-node-token'
  | 'local-filesystem'
  | 'relay-admin-token'
  | 'none';

export interface SessionSharingRecoveryActionDescriptor {
  id: SessionSharingRecoveryAction;
  label: string;
  executor: SessionSharingRecoveryExecutor;
  credential: SessionSharingRecoveryCredential;
  destructive: boolean;
  confirmation?: string;
  affects: string[];
}

export type SessionSharingRecoveryResultState =
  | 'succeeded'
  | 'failed'
  | 'partial'
  | 'requiresRestart';

export interface SessionSharingRecoveryActionResult {
  action: SessionSharingRecoveryAction;
  auditId: string;
  state: SessionSharingRecoveryResultState;
  message: string;
  affected: string[];
  verification: string;
  auditPath?: string;
  backupPath?: string;
  command?: string;
  revokedCount?: number;
  failedCount?: number;
}

export interface SessionSharingRecoveryStatusResponse {
  actions: SessionSharingRecoveryActionDescriptor[];
  auditPath?: string;
}

export interface SessionSharingRecoveryActionResponse {
  result: SessionSharingRecoveryActionResult;
}
