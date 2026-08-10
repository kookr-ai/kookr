import { createRelayShareClient } from './relay-share-client.js';
import {
  deleteStoredRelayConnectionCredentials,
  envRelayConnectionCredentials,
  loadStoredRelayConnectionCredentials,
  normalizeRelayUrl,
  parseRelayConnectionCredentials,
  saveRelayNodeId,
  saveStoredRelayConnectionCredentials,
  type RelayConnectionCredentials,
} from './relay-connection-store.js';
import type { RemoteNodeStatus } from '../remote/node-client.js';
import type {
  RelayConnectionConnectRequest,
  RelayConnectionErrorView,
  RelayConnectionHostedPairRequest,
  RelayConnectionPairRequest,
  RelayConnectionRotateRequest,
  RelayNodeCredentialStatusResponse,
  RelayConnectionSource,
  RelayConnectionState,
  RelayConnectionStatus,
  RelaySetupDiagnosis,
} from '../shared/contracts/relay-connection.js';
import type { HostedRelayNodeCredentialResponse, HostedRelayStatus } from '../shared/contracts/hosted-relay.js';
import { hostedRelayStatusFromEnv } from './hosted-relay-config.js';
import { diagnoseRelayEnv, RELAY_HTTP_TIMEOUT_MS } from './relay-lifecycle.js';

export interface RelayRuntimeHandle {
  readonly nodeStatus: RemoteNodeStatus;
  start(): void;
  stop(): Promise<void>;
}

export interface RelayConnectionManagerOptions {
  kookrDir: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  getHostedRelayStatus?: () => HostedRelayStatus;
  startRuntime: (credentials: RelayConnectionCredentials) => Promise<RelayRuntimeHandle>;
  onStatusChange?: (status: RelayConnectionStatus) => void;
}

export interface RelayConnectionManager {
  status(): RelayConnectionStatus;
  startConfigured(): Promise<RelayConnectionStatus>;
  connect(input: RelayConnectionConnectRequest): Promise<RelayConnectionStatus>;
  pair(input: RelayConnectionPairRequest): Promise<RelayConnectionStatus>;
  pairHosted(input: RelayConnectionHostedPairRequest): Promise<RelayConnectionStatus>;
  rotate(input: RelayConnectionRotateRequest): Promise<RelayConnectionStatus>;
  disconnect(): Promise<RelayConnectionStatus>;
  forget(): Promise<RelayConnectionStatus>;
}

interface ActiveConfig {
  source: Exclude<RelayConnectionSource, 'none'>;
  credentials: RelayConnectionCredentials;
}

const AUTH_FAILED_CODES = new Set(['relay-rejected-token']);

function errorView(code: string, message: string): RelayConnectionErrorView {
  return { code, message, at: new Date().toISOString() };
}

class RelayAdminOperationError extends Error {
  readonly code: string;
  readonly status: 400 | 401 | 502;

  constructor(code: string, message: string, status: 400 | 401 | 502 = 400) {
    super(message);
    this.name = 'RelayAdminOperationError';
    this.code = code;
    this.status = status;
  }
}

function statusFromNodeState(state: RemoteNodeStatus['connectionState']): RelayConnectionState {
  switch (state) {
    case 'idle':
      return 'configured';
    case 'connecting':
      return 'connecting';
    case 'connected':
      return 'connected';
    case 'backing-off':
      return 'backingOff';
    case 'stopped':
      return 'stopped';
  }
}

function setupDiagnosis(opts: { kookrDir: string; cwd?: string; env: NodeJS.ProcessEnv; lastError?: RelayConnectionErrorView }): RelaySetupDiagnosis {
  const envDiagnosis = diagnoseRelayEnv({ kookrDir: opts.kookrDir, cwd: opts.cwd, env: opts.env });
  let recommendedAction: RelaySetupDiagnosis['recommendedAction'];
  if (opts.lastError?.code === 'authFailed') {
    recommendedAction = {
      kind: 'repairRelayPairing',
      command: 'Open Settings > Sharing and pair this node again.',
      reason: 'Relay rejected the configured node credential.',
    };
  } else if (opts.lastError?.code === 'relay-validation-failed') {
    recommendedAction = {
      kind: 'restartRelay',
      command: 'pnpm relay:restart',
      reason: 'Relay is unreachable or did not validate credentials.',
    };
  } else if (envDiagnosis.state === 'restart-required') {
    recommendedAction = {
      kind: 'restartRelay',
      command: 'pnpm relay:restart',
      reason: 'Relay env changed after the relay process started.',
    };
  } else if (
    envDiagnosis.envFilePresent
    && envDiagnosis.adminTokenConfigured
    && !envDiagnosis.processAdminTokenConfigured
    && !envDiagnosis.insecureDev
  ) {
    recommendedAction = {
      kind: 'restartKookr',
      command: 'pnpm prod:restart',
      reason: 'The relay admin token is present in .env but the running Kookr process has not loaded it.',
    };
  } else if (envDiagnosis.state === 'missing-env' || envDiagnosis.state === 'missing-admin-token') {
    recommendedAction = {
      kind: 'fixEnv',
      command: `Set KOOKR_RELAY_ADMIN_TOKEN in ${envDiagnosis.envFilePath} or use KOOKR_RELAY_INSECURE_DEV=1 locally.`,
      reason: envDiagnosis.message,
    };
  } else {
    recommendedAction = { kind: 'none', reason: 'Relay setup has no immediate local action.' };
  }
  return {
    envState: envDiagnosis.state,
    envMessage: envDiagnosis.message,
    requiresRelayRestart: envDiagnosis.requiresRestart,
    envFilePath: envDiagnosis.envFilePath,
    localRelayCommands: {
      start: 'pnpm relay:start',
      status: 'pnpm relay:status',
      logs: 'pnpm relay:logs',
      restart: 'pnpm relay:restart',
      stop: 'pnpm relay:stop',
      doctor: 'pnpm relay:doctor',
    },
    recommendedAction,
  };
}

async function validateNodeCredentials(credentials: RelayConnectionCredentials): Promise<RelayConnectionErrorView | null> {
  try {
    // Fail closed before any outbound fetch (issue #2107). Credentials may come
    // from stored JSON that pre-dates host validation, or from API payloads.
    try {
      normalizeRelayUrl(credentials.relayUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Relay URL is invalid.';
      return errorView('relay-validation-failed', message);
    }
    const statusUrl = new URL('/relay/node/status', credentials.relayUrl);
    const res = await fetch(statusUrl, {
      headers: { authorization: `Bearer ${credentials.relayToken}` },
      signal: AbortSignal.timeout(RELAY_HTTP_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      return errorView('authFailed', 'Relay rejected the node token.');
    }
    if (!res.ok) {
      return errorView('relay-validation-failed', 'Relay credential validation failed.');
    }
    const body = await res.json() as Partial<RelayNodeCredentialStatusResponse>;
    if (typeof body.nodeId !== 'string' || !body.nodeId) {
      return errorView('relay-validation-failed', 'Relay credential validation failed.');
    }
    if (credentials.nodeId && body.nodeId !== credentials.nodeId) {
      return errorView('authFailed', 'Relay node ID does not match the node token.');
    }
    return null;
  } catch (err) {
    const relayError = err as { code?: unknown; message?: unknown };
    const code = typeof relayError.code === 'string' ? relayError.code : 'relay-validation-failed';
    const state = AUTH_FAILED_CODES.has(code) ? 'authFailed' : 'error';
    const message = state === 'authFailed'
      ? 'Relay rejected the node token.'
      : 'Relay credential validation failed.';
    return errorView(state, message);
  }
}

function parsePairingInput(raw: RelayConnectionPairRequest): RelayConnectionPairRequest {
  let relayUrl = '';
  try {
    relayUrl = normalizeRelayUrl(raw.relayUrl);
  } catch {
    throw new RelayAdminOperationError('relay-url-invalid', 'Relay URL is invalid.');
  }
  const relayAdminToken = typeof raw.relayAdminToken === 'string' ? raw.relayAdminToken.trim() : '';
  if (!relayAdminToken) {
    throw new RelayAdminOperationError(
      'relay-admin-token-required',
      'A relay admin token is required to pair this Kookr node.',
    );
  }
  const displayName = typeof raw.displayName === 'string' && raw.displayName.trim()
    ? raw.displayName.trim()
    : undefined;
  const publicBaseUrl = typeof raw.publicBaseUrl === 'string' && raw.publicBaseUrl.trim()
    ? raw.publicBaseUrl.trim()
    : undefined;
  return {
    relayUrl,
    relayAdminToken,
    ...(displayName ? { displayName } : {}),
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
  };
}

async function requestNodePairing(input: RelayConnectionPairRequest): Promise<RelayConnectionCredentials> {
  const parsed = parsePairingInput(input);
  let res: Response;
  try {
    res = await fetch(new URL('/relay/admin/nodes', parsed.relayUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${parsed.relayAdminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...(parsed.displayName ? { displayName: parsed.displayName } : {}),
      }),
      signal: AbortSignal.timeout(RELAY_HTTP_TIMEOUT_MS),
    });
  } catch {
    throw new RelayAdminOperationError('relay-unreachable', 'Relay could not be reached.', 502);
  }
  if (res.status === 401 || res.status === 403) {
    throw new RelayAdminOperationError('relay-pairing-auth-failed', 'Relay rejected the pairing credential.', 401);
  }
  if (!res.ok) {
    throw new RelayAdminOperationError('relay-pairing-failed', 'Relay pairing failed.', 502);
  }
  const body = await res.json().catch(() => null) as { nodeId?: unknown; nodeToken?: unknown } | null;
  if (typeof body?.nodeId !== 'string' || typeof body.nodeToken !== 'string') {
    throw new RelayAdminOperationError('relay-pairing-bad-response', 'Relay pairing response was invalid.', 502);
  }
  return {
    relayUrl: parsed.relayUrl,
    nodeId: body.nodeId,
    relayToken: body.nodeToken,
    ...(parsed.displayName ? { displayName: parsed.displayName } : {}),
    ...(parsed.publicBaseUrl ? { publicBaseUrl: parsed.publicBaseUrl } : {}),
  };
}

async function requestHostedNodePairing(
  input: RelayConnectionHostedPairRequest,
  hostedRelay: HostedRelayStatus,
): Promise<RelayConnectionCredentials> {
  if (!hostedRelay.configured || hostedRelay.mode !== 'available') {
    throw new RelayAdminOperationError(
      hostedRelay.mode === 'maintenance' ? 'hosted-relay-maintenance' : 'hosted-relay-unavailable',
      hostedRelay.message,
      hostedRelay.mode === 'maintenance' ? 502 : 400,
    );
  }
  const relayUrl = normalizeRelayUrl(hostedRelay.relayUrl);
  const accountToken = typeof input.accountToken === 'string' ? input.accountToken.trim() : '';
  if (!accountToken) {
    throw new RelayAdminOperationError('account-token-required', 'An account token is required for hosted relay pairing.');
  }
  const displayName = typeof input.displayName === 'string' && input.displayName.trim()
    ? input.displayName.trim()
    : undefined;
  const publicBaseUrl = typeof input.publicBaseUrl === 'string' && input.publicBaseUrl.trim()
    ? input.publicBaseUrl.trim()
    : undefined;
  let res: Response;
  try {
    res = await fetch(new URL('/relay/account/nodes', relayUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accountToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...(displayName ? { displayName } : {}),
      }),
      signal: AbortSignal.timeout(RELAY_HTTP_TIMEOUT_MS),
    });
  } catch {
    throw new RelayAdminOperationError('relay-unreachable', 'Hosted relay could not be reached.', 502);
  }
  if (res.status === 401 || res.status === 403) {
    throw new RelayAdminOperationError('hosted-account-auth-failed', 'Hosted relay rejected the account credential.', 401);
  }
  if (res.status === 429) {
    throw new RelayAdminOperationError('hosted-pairing-rate-limited', 'Hosted relay pairing is rate-limited.', 502);
  }
  if (res.status === 503) {
    const body = await res.json().catch(() => ({})) as { error?: unknown };
    throw new RelayAdminOperationError(
      body.error === 'hosted-relay-maintenance' ? 'hosted-relay-maintenance' : 'hosted-relay-emergency-disabled',
      'Hosted relay is temporarily unavailable for new pairings.',
      502,
    );
  }
  if (!res.ok) {
    throw new RelayAdminOperationError('hosted-pairing-failed', 'Hosted relay pairing failed.', 502);
  }
  const body = await res.json().catch(() => null) as Partial<HostedRelayNodeCredentialResponse> | null;
  if (typeof body?.nodeId !== 'string' || typeof body.nodeToken !== 'string') {
    throw new RelayAdminOperationError('hosted-pairing-bad-response', 'Hosted relay pairing response was invalid.', 502);
  }
  return {
    relayUrl,
    nodeId: body.nodeId,
    relayToken: body.nodeToken,
    ...(displayName ? { displayName } : {}),
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
  };
}

async function requestNodeTokenRotation(
  credentials: RelayConnectionCredentials,
  input: RelayConnectionRotateRequest,
): Promise<RelayConnectionCredentials> {
  if (!credentials.nodeId) {
    throw new RelayAdminOperationError('node-id-required', 'A paired node ID is required to rotate the node token.');
  }
  const relayAdminToken = typeof input.relayAdminToken === 'string' ? input.relayAdminToken.trim() : '';
  if (!relayAdminToken) {
    throw new RelayAdminOperationError(
      'relay-admin-token-required',
      'A relay admin token is required to rotate this node token.',
    );
  }
  let res: Response;
  try {
    res = await fetch(new URL(
      `/relay/admin/nodes/${encodeURIComponent(credentials.nodeId)}/token/rotate`,
      credentials.relayUrl,
    ), {
      method: 'POST',
      headers: { authorization: `Bearer ${relayAdminToken}` },
      signal: AbortSignal.timeout(RELAY_HTTP_TIMEOUT_MS),
    });
  } catch {
    throw new RelayAdminOperationError('relay-unreachable', 'Relay could not be reached.', 502);
  }
  if (res.status === 401 || res.status === 403) {
    throw new RelayAdminOperationError('relay-pairing-auth-failed', 'Relay rejected the pairing credential.', 401);
  }
  if (res.status === 404) {
    throw new RelayAdminOperationError('relay-node-not-found', 'Relay no longer recognizes this node.', 400);
  }
  if (!res.ok) {
    throw new RelayAdminOperationError('relay-token-rotation-failed', 'Relay token rotation failed.', 502);
  }
  const body = await res.json().catch(() => null) as { nodeId?: unknown; nodeToken?: unknown } | null;
  if (body?.nodeId !== credentials.nodeId || typeof body.nodeToken !== 'string') {
    throw new RelayAdminOperationError('relay-token-rotation-bad-response', 'Relay token rotation response was invalid.', 502);
  }
  return { ...credentials, relayToken: body.nodeToken };
}

export function createRelayConnectionManager(opts: RelayConnectionManagerOptions): RelayConnectionManager {
  const env = opts.env ?? process.env;
  const getHostedRelayStatus = opts.getHostedRelayStatus ?? (() => hostedRelayStatusFromEnv(env));
  let activeConfig: ActiveConfig | null = null;
  let runtime: RelayRuntimeHandle | null = null;
  let state: RelayConnectionState = 'localOnly';
  let lastError: RelayConnectionErrorView | undefined;
  let lastConnectedAt: string | undefined;
  let operation: Promise<RelayConnectionStatus> | null = null;

  const publish = (): RelayConnectionStatus => {
    const nodeStatus = runtime?.nodeStatus;
    if (nodeStatus?.relayConnected) {
      lastConnectedAt = new Date().toISOString();
    }
    const status: RelayConnectionStatus = {
      configured: Boolean(activeConfig),
      source: activeConfig?.source ?? 'none',
      ...(activeConfig ? { relayUrl: activeConfig.credentials.relayUrl } : {}),
      ...(activeConfig?.credentials.displayName ? { displayName: activeConfig.credentials.displayName } : {}),
      connectionState: runtime ? statusFromNodeState(nodeStatus!.connectionState) : state,
      relayConnected: nodeStatus?.relayConnected ?? false,
      ...(nodeStatus ? { nodeId: nodeStatus.nodeId, nodeMode: nodeStatus.nodeMode } : activeConfig?.credentials.nodeId ? { nodeId: activeConfig.credentials.nodeId } : {}),
      ...(lastConnectedAt ? { lastConnectedAt } : {}),
      ...(lastError ? { lastError } : {}),
      setupDiagnosis: setupDiagnosis({ kookrDir: opts.kookrDir, cwd: opts.cwd, env, lastError }),
      hostedRelay: getHostedRelayStatus(),
    };
    opts.onStatusChange?.(status);
    return status;
  };

  const setError = (error: RelayConnectionErrorView): RelayConnectionStatus => {
    lastError = error;
    state = error.code === 'authFailed' ? 'authFailed' : 'error';
    return publish();
  };

  const stopRuntime = async (): Promise<void> => {
    const current = runtime;
    runtime = null;
    if (current) await current.stop();
  };

  const runExclusive = (work: () => Promise<RelayConnectionStatus>): Promise<RelayConnectionStatus> => {
    // Runtime connect/disconnect operations mutate the same node client,
    // share client, and credential file, so serialize them in request order.
    const next = (operation ?? Promise.resolve(publish())).then(work, work);
    operation = next.finally(() => {
      if (operation === next) operation = null;
    });
    return operation;
  };

  const start = async (config: ActiveConfig, persist: boolean): Promise<RelayConnectionStatus> => {
    activeConfig = config;
    state = 'connecting';
    lastError = undefined;
    await stopRuntime();
    if (persist && (config.source === 'stored' || config.source === 'hosted')) {
      await saveStoredRelayConnectionCredentials(opts.kookrDir, config.credentials);
    }
    if (config.credentials.nodeId) {
      await saveRelayNodeId(opts.kookrDir, config.credentials.nodeId);
    }

    const validationError = await validateNodeCredentials(config.credentials);
    if (validationError) {
      return setError(validationError);
    }

    runtime = await opts.startRuntime(config.credentials);
    runtime.start();
    return publish();
  };

  return {
    status: publish,
    async startConfigured(): Promise<RelayConnectionStatus> {
      return runExclusive(async () => {
        const envCredentials = envRelayConnectionCredentials(env);
        if (envCredentials) {
          return start({ source: 'env', credentials: envCredentials }, false);
        }
        let stored: RelayConnectionCredentials | null;
        try {
          stored = await loadStoredRelayConnectionCredentials(opts.kookrDir);
        } catch (err) {
          activeConfig = null;
          return setError(errorView(
            'credential-load-failed',
            err instanceof Error && err.name === 'RelayConnectionCredentialError'
              ? err.message
              : 'Stored relay credentials could not be loaded.',
          ));
        }
        if (stored) {
          return start({ source: 'stored', credentials: stored }, false);
        }
        activeConfig = null;
        state = 'localOnly';
        lastError = undefined;
        return publish();
      });
    },
    async connect(input: RelayConnectionConnectRequest): Promise<RelayConnectionStatus> {
      return runExclusive(async () => {
        const credentials = parseRelayConnectionCredentials(input as unknown as Record<string, unknown>);
        if (!credentials.nodeId) throw new Error('nodeId is required');
        return start({ source: 'stored', credentials }, true);
      });
    },
    async pair(input: RelayConnectionPairRequest): Promise<RelayConnectionStatus> {
      return runExclusive(async () => start({ source: 'stored', credentials: await requestNodePairing(input) }, true));
    },
    async pairHosted(input: RelayConnectionHostedPairRequest): Promise<RelayConnectionStatus> {
      return runExclusive(async () => start({
        source: 'hosted',
        credentials: await requestHostedNodePairing(input, getHostedRelayStatus()),
      }, true));
    },
    async rotate(input: RelayConnectionRotateRequest): Promise<RelayConnectionStatus> {
      return runExclusive(async () => {
        if (activeConfig?.source === 'env') {
          return setError(errorView('env-managed', 'Relay credentials are managed by environment variables.'));
        }
        if (!activeConfig?.credentials) {
          throw new RelayAdminOperationError('relay-not-paired', 'Pair this Kookr node before rotating its token.');
        }
        const rotated = await requestNodeTokenRotation(activeConfig.credentials, input);
        return start({ source: 'stored', credentials: rotated }, true);
      });
    },
    async disconnect(): Promise<RelayConnectionStatus> {
      return runExclusive(async () => {
        await stopRuntime();
        state = activeConfig ? 'stopped' : 'localOnly';
        return publish();
      });
    },
    async forget(): Promise<RelayConnectionStatus> {
      return runExclusive(async () => {
        if (activeConfig?.source === 'env') {
          return setError(errorView('env-managed', 'Relay credentials are managed by environment variables.'));
        }
        await stopRuntime();
        await deleteStoredRelayConnectionCredentials(opts.kookrDir);
        activeConfig = null;
        state = 'localOnly';
        lastError = undefined;
        return publish();
      });
    },
  };
}
