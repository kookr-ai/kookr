export type RelayProcessState = 'running' | 'stopped' | 'stale-pid' | 'foreign-process' | 'foreign-port';
export type RelayEnvState = 'ok' | 'missing-env' | 'missing-admin-token' | 'restart-required';
export type RelayNodeState = 'not-configured' | 'ok' | 'token-rejected' | 'unreachable' | 'error';

export interface RelayLifecyclePaths {
  kookrDir: string;
  pidPath: string;
  logPath: string;
  statePath: string;
  dbPath: string;
}

export interface RelayProcessDiagnosis {
  state: RelayProcessState;
  pid?: number;
  expectedPid?: number;
  commandLine?: string;
  bindHost: string;
  port: number;
  relayUrl: string;
  message: string;
}

export interface RelayEnvDiagnosis {
  state: RelayEnvState;
  envFilePath: string;
  envFilePresent: boolean;
  adminTokenConfigured: boolean;
  insecureDev: boolean;
  processAdminTokenConfigured: boolean;
  requiresRestart: boolean;
  message: string;
}

export interface RelayNodeDiagnosis {
  state: RelayNodeState;
  relayUrl?: string;
  nodeId?: string;
  message: string;
}

export interface RelayStorageDiagnosis {
  state: 'ok' | 'db-write-failed';
  dbPath: string;
  message: string;
}

export interface RelayDoctorReport {
  checkedAt: string;
  paths: RelayLifecyclePaths;
  process: RelayProcessDiagnosis;
  env: RelayEnvDiagnosis;
  node: RelayNodeDiagnosis;
  storage: RelayStorageDiagnosis;
  policy: {
    nodeCount?: number;
    invitationCount?: number;
    maxPolicyVersion?: number;
    status: 'unavailable' | 'ok' | 'unauthorized';
  };
  recentLogs: string[];
  nextActions: string[];
}

export interface RelayStateResetResult {
  backupDir: string;
  backedUpPaths: string[];
  removedPaths: string[];
}

export interface RelayLifecycleOptions {
  cwd?: string;
  kookrDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}
