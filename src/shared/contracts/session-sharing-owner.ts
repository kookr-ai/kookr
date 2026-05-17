export type OwnerTerminalBlockedReason =
  | 'relayNotConfigured'
  | 'relayNodeOffline'
  | 'relayPairingRequired'
  | 'nodeUntrusted'
  | 'nodeFeatureUnavailable'
  | 'terminalAdapterUnavailable'
  | 'policySyncPending'
  | 'policySyncFailed';

export type OwnerRemediation =
  | {
      kind: 'setEnvAndRestart';
      envName: string;
      expectedValue: 'true';
      loadedEnvPath?: string;
      envFileHash?: string;
      envFileMtime?: string;
      processValue: string | null;
      processStartedAt?: string;
      diagnosedAt: string;
      requiresRestart: boolean;
      command: 'pnpm prod:restart' | 'pnpm prod:update';
    }
  | { kind: 'repairRelayPairing'; command: string }
  | { kind: 'openLogs'; command: string }
  | { kind: 'disableTerminalSharing'; command: string };

export type OwnerTerminalSharingStatus =
  | {
      state: 'available';
      message: string;
      checkedAt: string;
    }
  | {
      state: 'blocked';
      reason: OwnerTerminalBlockedReason;
      message: string;
      checkedAt: string;
      remediation?: OwnerRemediation;
    };
