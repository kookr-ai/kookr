import { createHash } from 'node:crypto';
import { statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BackendStats } from '../adapters/terminal-backend.js';
import type { RemoteNodeStatus } from '../remote/node-client.js';
import type { TaskShareSummary } from '../remote/share-contract.js';
import type { OwnerRemediation, OwnerTerminalSharingStatus } from '../shared/contracts/session-sharing-owner.js';

interface EnvSnapshot {
  loadedEnvPath?: string;
  envFileHash?: string;
  envFileMtime?: string;
  envFileValue?: string;
  processValue: string | null;
  processStartedAt?: string;
}

export function terminalAdapterAvailableFromStats(stats: BackendStats): boolean {
  return !(stats.lastError?.kind === 'dtach-unavailable' || stats.lastError?.kind === 'manifest-corrupt');
}

export interface ShareDiagnosticsServiceOptions {
  serverCwd: string;
  processStartedAt: string;
  getRemoteNodeStatus: () => RemoteNodeStatus | null;
  getRelayConfigured: () => boolean;
  getTerminalAdapterAvailable: () => boolean;
  getPolicySynced: (share: TaskShareSummary) => boolean;
  relayTrustedEnvName: string;
  relayTrustedProcessValue: (env: NodeJS.ProcessEnv) => string | null;
  parseTerminalInputKillSwitch: (raw: string | undefined) => { disabled: boolean };
  env?: NodeJS.ProcessEnv;
}

export class ShareDiagnosticsService {
  private readonly serverCwd: string;
  private readonly processStartedAt: string;
  private readonly getRemoteNodeStatus: ShareDiagnosticsServiceOptions['getRemoteNodeStatus'];
  private readonly getRelayConfigured: ShareDiagnosticsServiceOptions['getRelayConfigured'];
  private readonly getTerminalAdapterAvailable: ShareDiagnosticsServiceOptions['getTerminalAdapterAvailable'];
  private readonly getPolicySynced: ShareDiagnosticsServiceOptions['getPolicySynced'];
  private readonly relayTrustedEnvName: string;
  private readonly relayTrustedProcessValue: ShareDiagnosticsServiceOptions['relayTrustedProcessValue'];
  private readonly parseTerminalInputKillSwitch: ShareDiagnosticsServiceOptions['parseTerminalInputKillSwitch'];
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: ShareDiagnosticsServiceOptions) {
    this.serverCwd = opts.serverCwd;
    this.processStartedAt = opts.processStartedAt;
    this.getRemoteNodeStatus = opts.getRemoteNodeStatus;
    this.getRelayConfigured = opts.getRelayConfigured;
    this.getTerminalAdapterAvailable = opts.getTerminalAdapterAvailable;
    this.getPolicySynced = opts.getPolicySynced;
    this.relayTrustedEnvName = opts.relayTrustedEnvName;
    this.relayTrustedProcessValue = opts.relayTrustedProcessValue;
    this.parseTerminalInputKillSwitch = opts.parseTerminalInputKillSwitch;
    this.env = opts.env ?? process.env;
  }

  diagnoseTerminalSharing(share: TaskShareSummary): OwnerTerminalSharingStatus {
    const checkedAt = new Date().toISOString();
    if (!this.getRelayConfigured()) {
      return {
        state: 'blocked',
        reason: 'relayNotConfigured',
        message: 'Relay sharing is not connected for this Kookr instance.',
        checkedAt,
        remediation: { kind: 'repairRelayPairing', command: 'Open Settings > Sharing and connect a relay node token.' },
      };
    }
    const trust = this.trustSnapshot();
    if (trust.processValue !== 'true') {
      return {
        state: 'blocked',
        reason: 'nodeUntrusted',
        message: `Terminal sharing is disabled for this node. Set ${this.relayTrustedEnvName}=true in ${trust.loadedEnvPath ?? join(this.serverCwd, '.env')} and restart with pnpm prod:restart.`,
        checkedAt,
        remediation: this.trustRemediation(trust, checkedAt),
      };
    }
    if (this.parseTerminalInputKillSwitch(this.env.KOOKR_RELAY_FEATURES).disabled) {
      return {
        state: 'blocked',
        reason: 'nodeFeatureUnavailable',
        message: 'Terminal sharing is disabled by KOOKR_RELAY_FEATURES.',
        checkedAt,
        remediation: { kind: 'disableTerminalSharing', command: 'Remove terminal-input from KOOKR_RELAY_FEATURES and restart Kookr.' },
      };
    }
    if (!this.getTerminalAdapterAvailable()) {
      return {
        state: 'blocked',
        reason: 'terminalAdapterUnavailable',
        message: 'Terminal sharing is not available because the terminal adapter is unavailable.',
        checkedAt,
        remediation: { kind: 'openLogs', command: 'pnpm prod:logs' },
      };
    }
    const status = this.getRemoteNodeStatus();
    if (!status?.relayConnected) {
      return {
        state: 'blocked',
        reason: 'relayNodeOffline',
        message: 'Relay node is offline; reconnect the relay before sharing terminal access.',
        checkedAt,
        remediation: { kind: 'repairRelayPairing', command: 'pnpm prod:restart' },
      };
    }
    const enabled = new Set(status.features.enabled);
    if (!enabled.has('terminal-stream') || !enabled.has('terminal-input')) {
      return {
        state: 'blocked',
        reason: 'nodeFeatureUnavailable',
        message: 'Relay node did not advertise terminal sharing capability.',
        checkedAt,
        remediation: { kind: 'openLogs', command: 'pnpm prod:logs' },
      };
    }
    if (share.grants.includes('terminalInput') && !this.getPolicySynced(share)) {
      return {
        state: 'blocked',
        reason: 'policySyncPending',
        message: 'Owner approval is still syncing to the local node.',
        checkedAt,
        remediation: { kind: 'openLogs', command: 'pnpm prod:logs' },
      };
    }
    return {
      state: 'available',
      message: 'Terminal sharing is available for approved collaborators.',
      checkedAt,
    };
  }

  private trustRemediation(snapshot: EnvSnapshot, diagnosedAt: string): OwnerRemediation {
    return {
      kind: 'setEnvAndRestart',
      envName: this.relayTrustedEnvName,
      expectedValue: 'true',
      ...(snapshot.loadedEnvPath ? { loadedEnvPath: snapshot.loadedEnvPath } : {}),
      ...(snapshot.envFileHash ? { envFileHash: snapshot.envFileHash } : {}),
      ...(snapshot.envFileMtime ? { envFileMtime: snapshot.envFileMtime } : {}),
      processValue: snapshot.processValue,
      processStartedAt: snapshot.processStartedAt,
      diagnosedAt,
      requiresRestart: snapshot.envFileValue === 'true' && snapshot.processValue !== 'true',
      command: 'pnpm prod:restart',
    };
  }

  private trustSnapshot(): EnvSnapshot {
    const envPath = join(this.serverCwd, '.env');
    const base: EnvSnapshot = {
      processValue: this.relayTrustedProcessValue(this.env),
      processStartedAt: this.processStartedAt,
    };
    try {
      const text = readFileSync(envPath, 'utf8');
      const stat = statSync(envPath);
      return {
        ...base,
        loadedEnvPath: envPath,
        envFileHash: createHash('sha256').update(text).digest('hex'),
        envFileMtime: stat.mtime.toISOString(),
        envFileValue: parseEnvValue(text, this.relayTrustedEnvName),
      };
    } catch {
      // Missing/unreadable .env is common in dev and test runs; process env still tells us what this node advertised.
      return base;
    }
  }
}

function parseEnvValue(text: string, key: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq).trim() !== key) continue;
    return unquoteEnvValue(trimmed.slice(eq + 1).trim());
  }
  return undefined;
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
