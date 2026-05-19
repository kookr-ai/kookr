import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { TaskShareSummary } from '../remote/share-contract.js';
import type {
  SessionSharingRecoveryAction,
  SessionSharingRecoveryActionDescriptor,
  SessionSharingRecoveryActionResult,
  SessionSharingRecoveryCredential,
  SessionSharingRecoveryExecutor,
  SessionSharingRecoveryResultState,
} from '../shared/contracts/session-sharing-recovery.js';
import { SESSION_SHARING_TERMINAL_TRUST_ENV_NAME } from '../shared/contracts/session-sharing-recovery.js';
import { backupAndResetRelayState } from './relay-lifecycle.js';
import type { RelayLifecycleOptions } from './relay-lifecycle-contracts.js';
import { relayLifecyclePaths } from './relay-lifecycle-paths.js';
import type { RelayConnectionManager } from './relay-connection-manager.js';
import type { RelayShareClient } from './relay-share-client.js';
import type { TaskShareService } from './task-share-service.js';

export const SESSION_SHARING_RECOVERY_AUDIT_FILE = 'session-sharing-recovery-audit.jsonl';

export const SESSION_SHARING_RECOVERY_ACTIONS: readonly SessionSharingRecoveryActionDescriptor[] = [
  {
    id: 'revokeAllShares',
    label: 'Revoke all active shares',
    executor: 'share-scoped-owner',
    credential: 'current-node-token',
    destructive: true,
    confirmation: 'revoke all shares',
    affects: ['Every non-expired, non-revoked task share owned by this local node.'],
  },
  {
    id: 'disableTerminalSharing',
    label: 'Disable terminal sharing',
    executor: 'local-filesystem-process',
    credential: 'local-filesystem',
    destructive: true,
    confirmation: 'disable terminal sharing',
    affects: [`Writes ${SESSION_SHARING_TERMINAL_TRUST_ENV_NAME}=false to the local .env file.`, 'Disconnects the current relay runtime so stale terminal streams stop.'],
  },
  {
    id: 'rotateNodeCredential',
    label: 'Rotate node credential',
    executor: 'node-credential-rotation',
    credential: 'relay-admin-token',
    destructive: true,
    confirmation: 'rotate node credential',
    affects: ['Invalidates the current relay node token and reconnects with the replacement token.'],
  },
  {
    id: 'repairRelayPairing',
    label: 'Re-pair local node',
    executor: 'relay-admin-token',
    credential: 'relay-admin-token',
    destructive: false,
    affects: ['Issues a fresh relay node registration for this Kookr instance.'],
  },
  {
    id: 'openRelayLogs',
    label: 'Open relay logs',
    executor: 'local-filesystem-process',
    credential: 'none',
    destructive: false,
    affects: ['Shows the local relay log path and equivalent command.'],
  },
  {
    id: 'resetRelayState',
    label: 'Reset local relay state',
    executor: 'local-filesystem-process',
    credential: 'local-filesystem',
    destructive: true,
    confirmation: 'reset local relay state',
    affects: ['Stops an owned local relay process.', 'Backs up relay SQLite/WAL files.', 'Deletes local relay state so the next start is clean.'],
  },
];

export interface SessionSharingRecoveryDeps {
  kookrDir: string;
  serverCwd: string;
  env?: NodeJS.ProcessEnv;
  remoteShare?: {
    client: RelayShareClient | null;
    service?: TaskShareService;
  };
  relayConnection?: RelayConnectionManager;
  now?: () => Date;
}

interface RecoveryAuditRow {
  schemaVersion: 'session-sharing-recovery-audit.v1';
  auditId: string;
  at: string;
  action: SessionSharingRecoveryAction;
  state: SessionSharingRecoveryResultState;
  executor: SessionSharingRecoveryExecutor;
  credential: SessionSharingRecoveryCredential;
  message: string;
  affected: string[];
  verification: string;
  backupPath?: string;
  command?: string;
  revokedCount?: number;
  failedCount?: number;
}

export function recoveryAuditPath(kookrDir: string): string {
  return join(kookrDir, SESSION_SHARING_RECOVERY_AUDIT_FILE);
}

export function recoveryActionDescriptor(action: SessionSharingRecoveryAction): SessionSharingRecoveryActionDescriptor {
  const descriptor = SESSION_SHARING_RECOVERY_ACTIONS.find((candidate) => candidate.id === action);
  if (!descriptor) throw new Error(`Unknown recovery action: ${action}`);
  return descriptor;
}

export function validateRecoveryConfirmation(action: SessionSharingRecoveryAction, confirmation: unknown): string | null {
  const required = recoveryActionDescriptor(action).confirmation;
  if (!required) return null;
  return confirmation === required ? null : `confirmation must be "${required}"`;
}

async function appendRecoveryAudit(kookrDir: string, row: RecoveryAuditRow): Promise<string> {
  const path = recoveryAuditPath(kookrDir);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(row)}\n`, 'utf8');
  return path;
}

async function auditedResult(
  deps: SessionSharingRecoveryDeps,
  result: Omit<SessionSharingRecoveryActionResult, 'auditPath'>,
): Promise<SessionSharingRecoveryActionResult> {
  const descriptor = recoveryActionDescriptor(result.action);
  const auditPath = await appendRecoveryAudit(deps.kookrDir, {
    schemaVersion: 'session-sharing-recovery-audit.v1',
    auditId: result.auditId,
    at: (deps.now ?? (() => new Date()))().toISOString(),
    action: result.action,
    state: result.state,
    executor: descriptor.executor,
    credential: descriptor.credential,
    message: result.message,
    affected: result.affected,
    verification: result.verification,
    ...(result.backupPath ? { backupPath: result.backupPath } : {}),
    ...(result.command ? { command: result.command } : {}),
    ...(typeof result.revokedCount === 'number' ? { revokedCount: result.revokedCount } : {}),
    ...(typeof result.failedCount === 'number' ? { failedCount: result.failedCount } : {}),
  });
  return { ...result, auditPath };
}

function activeShare(share: TaskShareSummary): boolean {
  return share.state !== 'revoked' && share.state !== 'expired';
}

export async function revokeAllShares(deps: SessionSharingRecoveryDeps): Promise<SessionSharingRecoveryActionResult> {
  const target = deps.remoteShare?.service ?? deps.remoteShare?.client;
  const auditId = randomUUID();
  if (!target) {
    return auditedResult(deps, {
      action: 'revokeAllShares',
      auditId,
      state: 'failed',
      message: 'Relay sharing is not connected.',
      affected: recoveryActionDescriptor('revokeAllShares').affects,
      verification: 'No relay share client was configured.',
      revokedCount: 0,
      failedCount: 0,
    });
  }
  const shares = (await target.listTaskShares()).filter(activeShare);
  let revokedCount = 0;
  let failedCount = 0;
  for (const share of shares) {
    try {
      await target.revokeTaskShare(share.invitationId);
      revokedCount += 1;
    } catch {
      failedCount += 1;
    }
  }
  return auditedResult(deps, {
    action: 'revokeAllShares',
    auditId,
    state: failedCount > 0 ? 'partial' : 'succeeded',
    message: failedCount > 0
      ? `Revoked ${revokedCount} shares; ${failedCount} revocations failed.`
      : `Revoked ${revokedCount} active shares.`,
    affected: recoveryActionDescriptor('revokeAllShares').affects,
    verification: failedCount > 0 ? 'Some relay revoke calls failed; retry after checking relay logs.' : 'All active shares were revoked or no active shares existed.',
    revokedCount,
    failedCount,
  });
}

export async function disableTerminalSharing(deps: SessionSharingRecoveryDeps): Promise<SessionSharingRecoveryActionResult> {
  const auditId = randomUUID();
  const envPath = join(deps.serverCwd, '.env');
  const previous = existsSync(envPath) ? await readFile(envPath, 'utf8') : '';
  const backupPath = existsSync(envPath)
    ? `${envPath}.session-sharing-disable.${(deps.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-')}.bak`
    : undefined;
  if (backupPath) await copyFile(envPath, backupPath);
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(envPath, setEnvValue(previous, SESSION_SHARING_TERMINAL_TRUST_ENV_NAME, 'false'), 'utf8');
  (deps.env ?? process.env)[SESSION_SHARING_TERMINAL_TRUST_ENV_NAME] = 'false';
  await deps.relayConnection?.disconnect().catch(() => undefined);
  return auditedResult(deps, {
    action: 'disableTerminalSharing',
    auditId,
    state: 'requiresRestart',
    message: `Terminal sharing trust was disabled in ${envPath}. Restart Kookr before reconnecting the relay.`,
    affected: recoveryActionDescriptor('disableTerminalSharing').affects,
    verification: `${SESSION_SHARING_TERMINAL_TRUST_ENV_NAME}=false is present in the local env file; relay runtime was disconnected if it was active.`,
    ...(backupPath ? { backupPath } : {}),
    command: 'pnpm prod:restart',
  });
}

export async function rotateNodeCredential(deps: SessionSharingRecoveryDeps, body: { relayAdminToken?: unknown }): Promise<SessionSharingRecoveryActionResult> {
  const auditId = randomUUID();
  const secretValues = [typeof body.relayAdminToken === 'string' ? body.relayAdminToken : ''];
  try {
    if (!deps.relayConnection) throw new Error('relay connection manager is unavailable');
    await deps.relayConnection.rotate({ relayAdminToken: typeof body.relayAdminToken === 'string' ? body.relayAdminToken : '' });
    return auditedResult(deps, {
      action: 'rotateNodeCredential',
      auditId,
      state: 'succeeded',
      message: 'Node credential rotated and runtime reconnected.',
      affected: recoveryActionDescriptor('rotateNodeCredential').affects,
      verification: 'Relay credential rotation returned a connected status.',
    });
  } catch (err) {
    return auditedResult(deps, {
      action: 'rotateNodeCredential',
      auditId,
      state: 'failed',
      message: redactRecoverySecrets(err instanceof Error ? err.message : 'Node credential rotation failed.', secretValues),
      affected: recoveryActionDescriptor('rotateNodeCredential').affects,
      verification: 'Rotation did not complete; stored credentials were not replaced by this recovery action.',
    });
  }
}

export async function repairRelayPairing(
  deps: SessionSharingRecoveryDeps,
  body: { relayUrl?: unknown; relayAdminToken?: unknown; displayName?: unknown },
): Promise<SessionSharingRecoveryActionResult> {
  const auditId = randomUUID();
  const secretValues = [typeof body.relayAdminToken === 'string' ? body.relayAdminToken : ''];
  try {
    if (!deps.relayConnection) throw new Error('relay connection manager is unavailable');
    await deps.relayConnection.pair({
      relayUrl: typeof body.relayUrl === 'string' ? body.relayUrl : '',
      relayAdminToken: typeof body.relayAdminToken === 'string' ? body.relayAdminToken : '',
      ...(typeof body.displayName === 'string' && body.displayName.trim() ? { displayName: body.displayName.trim() } : {}),
    });
    return auditedResult(deps, {
      action: 'repairRelayPairing',
      auditId,
      state: 'succeeded',
      message: 'Relay node was paired and connected.',
      affected: recoveryActionDescriptor('repairRelayPairing').affects,
      verification: 'Relay pairing returned a connected status.',
    });
  } catch (err) {
    return auditedResult(deps, {
      action: 'repairRelayPairing',
      auditId,
      state: 'failed',
      message: redactRecoverySecrets(err instanceof Error ? err.message : 'Relay pairing failed.', secretValues),
      affected: recoveryActionDescriptor('repairRelayPairing').affects,
      verification: 'Pairing did not complete; check the relay URL and admin token.',
    });
  }
}

export async function openRelayLogs(deps: SessionSharingRecoveryDeps): Promise<SessionSharingRecoveryActionResult> {
  const auditId = randomUUID();
  const path = relayLifecyclePaths(deps.kookrDir).logPath;
  return auditedResult(deps, {
    action: 'openRelayLogs',
    auditId,
    state: 'succeeded',
    message: `Relay logs are at ${path}.`,
    affected: recoveryActionDescriptor('openRelayLogs').affects,
    verification: existsSync(path) ? 'Relay log file exists.' : 'Relay log file does not exist yet.',
    command: 'pnpm relay:logs',
  });
}

export async function resetRelayState(deps: SessionSharingRecoveryDeps): Promise<SessionSharingRecoveryActionResult> {
  const auditId = randomUUID();
  try {
    const result = await backupAndResetRelayState({
      kookrDir: deps.kookrDir,
      cwd: deps.serverCwd,
      env: deps.env,
      now: deps.now,
    } satisfies RelayLifecycleOptions);
    return auditedResult(deps, {
      action: 'resetRelayState',
      auditId,
      state: 'succeeded',
      message: `Relay state reset complete. Backup: ${result.backupDir}.`,
      affected: recoveryActionDescriptor('resetRelayState').affects,
      verification: `Backed up ${result.backedUpPaths.length} files and removed ${result.removedPaths.length} relay state files.`,
      backupPath: result.backupDir,
      command: 'pnpm relay:start',
    });
  } catch (err) {
    return auditedResult(deps, {
      action: 'resetRelayState',
      auditId,
      state: 'failed',
      message: err instanceof Error ? err.message : 'Relay state reset failed.',
      affected: recoveryActionDescriptor('resetRelayState').affects,
      verification: 'Reset did not complete; existing relay state was left for manual inspection or retry.',
    });
  }
}

function redactRecoverySecrets(message: string, secrets: string[]): string {
  let redacted = message;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    redacted = redacted.split(secret).join('[redacted]');
  }
  return redacted;
}

function setEnvValue(text: string, key: string, value: string): string {
  const lines = text ? text.split(/\r?\n/) : [];
  let replaced = false;
  const next = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.startsWith(`${key}=`)) return line;
    replaced = true;
    return `${key}=${value}`;
  });
  if (!replaced) next.push(`${key}=${value}`);
  return `${next.filter((line, index) => index < next.length - 1 || line.length > 0).join('\n')}\n`;
}
