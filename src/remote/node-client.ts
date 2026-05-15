import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { RelayHello, RemoteFeature } from './handshake.js';
import type { CommandEnvelope, CommandResult } from './command-journal.js';
import type { RemoteControlEvent } from './control-events.js';
import type { NodeEpoch, NodeId } from './ids.js';
import type { PolicySyncProtocolMessage } from './policy-sync.js';
import type { TerminalStreamEvent } from './stream-events.js';

import type { WebSocket } from 'ws';

export type RemoteNodeMode = 'active' | 'degraded';
export type RemoteNodeConnectionState = 'idle' | 'connecting' | 'connected' | 'backing-off' | 'stopped';

export interface RemoteNodeStatus {
  relayConnected: boolean;
  protocolVersion: number;
  nodeId: NodeId;
  nodeEpoch: NodeEpoch;
  nodeMode: RemoteNodeMode;
  connectionState: RemoteNodeConnectionState;
  lastRelayHello?: RelayHello;
  features: {
    enabled: RemoteFeature[];
    disabled: RemoteFeature[];
  };
}

export interface RemoteNodeClientOptions {
  relayUrl: string;
  token: string;
  kookrDir: string;
  softwareVersion: string;
  displayName?: string;
  publicBaseUrl?: string;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  logger?: Pick<typeof console, 'log' | 'warn' | 'error'>;
  wsImporter?: () => Promise<typeof import('ws')>;
  onCommand?: (command: CommandEnvelope) => Promise<CommandResult>;
  onPolicyMessage?: (message: PolicySyncProtocolMessage) => Promise<void> | void;
}

export interface RemoteNodeClient {
  readonly status: RemoteNodeStatus;
  start(): void;
  stop(): Promise<void>;
  publish(event: RemoteControlEvent | TerminalStreamEvent): boolean;
  setCommandHandler(handler: ((command: CommandEnvelope) => Promise<CommandResult>) | null): void;
  setConnectionObserver(handler: ((state: 'connected' | 'disconnected') => void) | null): void;
}

interface NodeIdentity {
  nodeId: NodeId;
  nodeEpoch: NodeEpoch;
  nodeMode: RemoteNodeMode;
}

async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDir(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomicFsynced(path: string, contents: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, contents, 'utf8');
  await fsyncFile(tmp);
  await rename(tmp, path);
  await fsyncDir(dir);
}

async function readTextIfPresent(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function loadNodeIdentity(kookrDir: string, logger: Pick<typeof console, 'warn'>): Promise<NodeIdentity> {
  const nodeIdPath = join(kookrDir, 'node-id');
  const nodeEpochPath = join(kookrDir, 'node-epoch');

  let nodeId = await readTextIfPresent(nodeIdPath);
  try {
    if (!nodeId) {
      nodeId = `kookr-node-${randomUUID()}`;
      await writeAtomicFsynced(nodeIdPath, `${nodeId}\n`);
    }

    const previousEpoch = BigInt(await readTextIfPresent(nodeEpochPath) ?? '0');
    const nodeEpoch = (previousEpoch + 1n).toString();
    await writeAtomicFsynced(nodeEpochPath, `${nodeEpoch}\n`);
    return { nodeId: nodeId as NodeId, nodeEpoch: nodeEpoch as NodeEpoch, nodeMode: 'active' };
  } catch (err) {
    logger.warn(JSON.stringify({
      event: 'node.degraded',
      reason: 'epoch-persist-failed',
      error: err instanceof Error ? err.message : String(err),
    }));
    return {
      nodeId: (nodeId ?? 'kookr-node-degraded') as NodeId,
      nodeEpoch: '0' as NodeEpoch,
      nodeMode: 'degraded',
    };
  }
}

function toNodeWebSocketUrl(relayUrl: string): string {
  const url = new URL('/relay/node', relayUrl);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol === 'http:') url.protocol = 'ws:';
  return url.toString();
}

function isRemoteCommandEnvelope(value: unknown): value is CommandEnvelope {
  const msg = value as Partial<CommandEnvelope> & { type?: unknown };
  return typeof value === 'object'
    && value !== null
    && msg.type === 'remote.command'
    && typeof msg.commandId === 'string'
    && typeof msg.actorId === 'string'
    && typeof msg.clientId === 'string'
    && typeof msg.nodeId === 'string'
    && typeof msg.nodeEpoch === 'string'
    && typeof msg.sessionId === 'string'
    && typeof msg.sessionEpoch === 'string'
    && typeof msg.grantId === 'string'
    && typeof msg.idempotencyKey === 'string'
    && (
      msg.action === 'presetReply'
      || msg.action === 'permissionApprove'
      || msg.action === 'skip'
      || msg.action === 'snooze'
      || msg.action === 'mark-done'
      || msg.action === 'launch'
      || msg.action === 'leaseAcquire'
      || msg.action === 'leaseHeartbeat'
      || msg.action === 'leaseOverride'
      || msg.action === 'submitMessage'
    );
}

function makeRemoteCommandResultMessage(result: CommandResult): { type: 'remote.command.result' } & CommandResult {
  return { type: 'remote.command.result', ...result };
}

function isPolicySyncProtocolMessage(value: unknown): value is PolicySyncProtocolMessage {
  const msg = value as Partial<PolicySyncProtocolMessage>;
  if (typeof value !== 'object' || value === null || typeof msg.type !== 'string') return false;
  if (
    msg.type !== 'policy.sync'
    && msg.type !== 'policy.delta'
    && msg.type !== 'policy.delta.ack'
    && msg.type !== 'policy.revoke'
  ) {
    return false;
  }
  return typeof msg.nodeId === 'string'
    && typeof msg.policyVersion === 'number';
}

export async function createRemoteNodeClient(opts: RemoteNodeClientOptions): Promise<RemoteNodeClient> {
  const {
    isRelayHello,
    makeNodeHello,
    parseTerminalInputKillSwitch,
    PHASE1_SUPPORTED_FEATURES,
    REMOTE_PROTOCOL_VERSION,
  } = await import('./handshake.js');
  const logger = opts.logger ?? console;
  const identity = await loadNodeIdentity(opts.kookrDir, logger);
  const status: RemoteNodeStatus = {
    relayConnected: false,
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    nodeId: identity.nodeId,
    nodeEpoch: identity.nodeEpoch,
    nodeMode: identity.nodeMode,
    connectionState: 'idle',
    features: { enabled: [], disabled: [] },
  };

  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectPromise: Promise<void> | null = null;
  let stopped = false;
  let reconnectAttempt = 0;
  let commandHandler = opts.onCommand ?? null;
  let connectionObserver: ((state: 'connected' | 'disconnected') => void) | null = null;
  const reconnectBaseMs = opts.reconnectBaseMs ?? 1_000;
  const reconnectMaxMs = opts.reconnectMaxMs ?? 30_000;

  const clearReconnect = (): void => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = (reason: string): void => {
    if (stopped || status.nodeMode === 'degraded') return;
    clearReconnect();
    status.relayConnected = false;
    status.connectionState = 'backing-off';
    connectionObserver?.('disconnected');
    const delay = Math.min(reconnectMaxMs, reconnectBaseMs * (2 ** reconnectAttempt));
    reconnectAttempt += 1;
    logger.warn(`[remote-node] relay disconnected (${reason}); reconnecting in ${delay}ms`);
    reconnectTimer = setTimeout(() => {
      startConnect();
    }, delay);
  };

  const startConnect = (): void => {
    if (connectPromise || stopped || status.nodeMode === 'degraded') return;
    connectPromise = connect().finally(() => {
      connectPromise = null;
    });
  };

  const connect = async (): Promise<void> => {
    if (stopped || status.nodeMode === 'degraded') return;
    status.connectionState = 'connecting';
    const { WebSocket: Ws } = await (opts.wsImporter ?? (() => import('ws')))();
    if (stopped) {
      status.connectionState = 'stopped';
      return;
    }
    const next = new Ws(toNodeWebSocketUrl(opts.relayUrl), {
      headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : undefined,
    });
    ws = next;

    next.on('open', () => {
      const terminalInputKillSwitch = parseTerminalInputKillSwitch(process.env.KOOKR_RELAY_FEATURES);
      const disabled = new Set<RemoteFeature>(terminalInputKillSwitch.disabled ? ['terminal-input'] : []);
      const trustedFeatures: RemoteFeature[] = process.env.KOOKR_RELAY_TRUSTED === 'true'
        ? ['terminal-stream', 'terminal-input']
        : [];
      const supportedFeatures = [...PHASE1_SUPPORTED_FEATURES, ...trustedFeatures]
        .filter((feature) => !disabled.has(feature));
      status.features.disabled = [...disabled];
      logger.log(`[remote-node] features enabled=${supportedFeatures.join(',')} disabled=${[...disabled].join(',') || 'none'}`);
      const hello = makeNodeHello({
        nodeId: status.nodeId,
        nodeEpoch: status.nodeEpoch,
        softwareVersion: opts.softwareVersion,
        supportedFeatures,
        displayName: opts.displayName,
        publicBaseUrl: opts.publicBaseUrl,
      });
      next.send(JSON.stringify(hello));
    });

    next.on('message', (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        next.close(1002, 'invalid json');
        return;
      }
      if (!status.relayConnected) {
        if (!isRelayHello(parsed)) {
          next.close(1002, 'expected relay.hello');
          return;
        }
        status.lastRelayHello = parsed;
        status.features.enabled = [...parsed.enabledFeatures];
        status.features.disabled = [...(parsed.disabledFeatures ?? [])];
        if (parsed.outcome === 'refused') {
          next.close(1008, parsed.refusalReason ?? 'refused');
          return;
        }
        reconnectAttempt = 0;
        status.relayConnected = true;
        status.connectionState = 'connected';
        connectionObserver?.('connected');
        logger.log(`[remote-node] connected nodeId=${status.nodeId} protocol=${parsed.acceptedVersion}`);
        return;
      }
      if (isRemoteCommandEnvelope(parsed)) {
        if (parsed.nodeId !== status.nodeId || parsed.nodeEpoch !== status.nodeEpoch) return;
        void (async () => {
          const result: CommandResult = commandHandler
            ? await commandHandler(parsed)
            : {
                commandId: parsed.commandId,
                action: parsed.action,
                outcome: 'rejected',
                reason: 'remote command handler unavailable',
              };
          if (next.readyState === next.OPEN) {
            next.send(JSON.stringify(makeRemoteCommandResultMessage(result)));
          }
        })().catch((err) => {
          if (next.readyState === next.OPEN) {
            next.send(JSON.stringify(makeRemoteCommandResultMessage({
              commandId: parsed.commandId,
              action: parsed.action,
              outcome: 'rejected',
              reason: err instanceof Error ? err.message : String(err),
            })));
          }
        });
      }
      if (isPolicySyncProtocolMessage(parsed)) {
        if (parsed.nodeId !== status.nodeId) return;
        void Promise.resolve(opts.onPolicyMessage?.(parsed)).catch((err) => {
          logger.warn(`[remote-node] policy message handler failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    });

    next.on('close', (_code, reason) => {
      if (ws === next) ws = null;
      if (!stopped) {
        scheduleReconnect(reason.toString() || 'closed');
      }
    });

    next.on('error', (err) => {
      logger.warn(`[remote-node] websocket error: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  return {
    status,
    start(): void {
      if (stopped || status.nodeMode === 'degraded') return;
      if (status.connectionState !== 'idle' && status.connectionState !== 'backing-off') return;
      startConnect();
    },
    async stop(): Promise<void> {
      stopped = true;
      status.connectionState = 'stopped';
      status.relayConnected = false;
      connectionObserver?.('disconnected');
      clearReconnect();
      await connectPromise;
      const current = ws;
      ws = null;
      if (!current || current.readyState === current.CLOSED) return;
      await new Promise<void>((resolve) => {
        current.once('close', () => resolve());
        current.close(1001, 'node stopped');
      });
    },
    publish(event: RemoteControlEvent): boolean {
      if (event.nodeId !== status.nodeId || event.nodeEpoch !== status.nodeEpoch) return false;
      if (!ws || ws.readyState !== ws.OPEN || !status.relayConnected) return false;
      ws.send(JSON.stringify(event));
      return true;
    },
    setCommandHandler(handler): void {
      commandHandler = handler;
    },
    setConnectionObserver(handler): void {
      connectionObserver = handler;
    },
  };
}
