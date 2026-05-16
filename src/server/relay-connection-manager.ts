import { createRelayShareClient } from './relay-share-client.js';
import {
  deleteStoredRelayConnectionCredentials,
  envRelayConnectionCredentials,
  loadStoredRelayConnectionCredentials,
  parseRelayConnectionCredentials,
  saveRelayNodeId,
  saveStoredRelayConnectionCredentials,
  type RelayConnectionCredentials,
} from './relay-connection-store.js';
import type { RemoteNodeStatus } from '../remote/node-client.js';
import type {
  RelayConnectionConnectRequest,
  RelayConnectionErrorView,
  RelayNodeCredentialStatusResponse,
  RelayConnectionSource,
  RelayConnectionState,
  RelayConnectionStatus,
} from '../shared/contracts/relay-connection.js';

export interface RelayRuntimeHandle {
  readonly nodeStatus: RemoteNodeStatus;
  start(): void;
  stop(): Promise<void>;
}

export interface RelayConnectionManagerOptions {
  kookrDir: string;
  env?: NodeJS.ProcessEnv;
  startRuntime: (credentials: RelayConnectionCredentials) => Promise<RelayRuntimeHandle>;
  onStatusChange?: (status: RelayConnectionStatus) => void;
}

export interface RelayConnectionManager {
  status(): RelayConnectionStatus;
  startConfigured(): Promise<RelayConnectionStatus>;
  connect(input: RelayConnectionConnectRequest): Promise<RelayConnectionStatus>;
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

async function validateNodeCredentials(credentials: RelayConnectionCredentials): Promise<RelayConnectionErrorView | null> {
  try {
    const statusUrl = new URL('/relay/node/status', credentials.relayUrl);
    const res = await fetch(statusUrl, {
      headers: { authorization: `Bearer ${credentials.relayToken}` },
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

export function createRelayConnectionManager(opts: RelayConnectionManagerOptions): RelayConnectionManager {
  const env = opts.env ?? process.env;
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
    if (persist && config.source === 'stored') {
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
