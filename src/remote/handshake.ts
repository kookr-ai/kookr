import type { NodeEpoch, NodeId } from './ids.js';

export const REMOTE_PROTOCOL_VERSION = 1;

export type RemoteFeature =
  | 'control.snapshot'
  | 'control.state-delta'
  | 'policy-sync'
  | 'terminal-stream';

export const PHASE1_SUPPORTED_FEATURES: readonly RemoteFeature[] = [
  'control.snapshot',
  'control.state-delta',
  'policy-sync',
];

export type RelayHelloOutcome = 'accepted' | 'downgraded' | 'refused';
export type RelayRefusalReason = 'unsupported-version' | 'credential-revoked' | 'feature-incompatible';

export interface NodeHello {
  type: 'node.hello';
  nodeId: NodeId;
  nodeEpoch: NodeEpoch;
  protocolVersion: number;
  supportedFeatures: RemoteFeature[];
  softwareVersion: string;
  displayName?: string;
  publicBaseUrl?: string;
}

export interface RelayHello {
  type: 'relay.hello';
  outcome: RelayHelloOutcome;
  acceptedVersion: number;
  enabledFeatures: RemoteFeature[];
  disabledFeatures?: RemoteFeature[];
  refusalReason?: RelayRefusalReason;
}

export type HandshakeState =
  | { state: 'idle' }
  | { state: 'awaiting-relay-hello'; nodeHello: NodeHello }
  | { state: 'accepted'; relayHello: RelayHello }
  | { state: 'refused'; relayHello?: RelayHello; reason: RelayRefusalReason | 'invalid-relay-hello' | 'closed-before-hello' };

export function makeNodeHello(opts: {
  nodeId: NodeId;
  nodeEpoch: NodeEpoch;
  softwareVersion: string;
  supportedFeatures?: readonly RemoteFeature[];
  displayName?: string;
  publicBaseUrl?: string;
}): NodeHello {
  return {
    type: 'node.hello',
    nodeId: opts.nodeId,
    nodeEpoch: opts.nodeEpoch,
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    supportedFeatures: [...(opts.supportedFeatures ?? PHASE1_SUPPORTED_FEATURES)],
    softwareVersion: opts.softwareVersion,
    ...(opts.displayName ? { displayName: opts.displayName } : {}),
    ...(opts.publicBaseUrl ? { publicBaseUrl: opts.publicBaseUrl } : {}),
  };
}

export function makeRelayHello(opts: {
  outcome: RelayHelloOutcome;
  acceptedVersion: number;
  enabledFeatures?: readonly RemoteFeature[];
  disabledFeatures?: readonly RemoteFeature[];
  refusalReason?: RelayRefusalReason;
}): RelayHello {
  return {
    type: 'relay.hello',
    outcome: opts.outcome,
    acceptedVersion: opts.acceptedVersion,
    enabledFeatures: [...(opts.enabledFeatures ?? [])],
    ...(opts.disabledFeatures ? { disabledFeatures: [...opts.disabledFeatures] } : {}),
    ...(opts.refusalReason ? { refusalReason: opts.refusalReason } : {}),
  };
}

export function isNodeHello(value: unknown): value is NodeHello {
  const msg = value as Partial<NodeHello>;
  return typeof value === 'object'
    && value !== null
    && msg.type === 'node.hello'
    && typeof msg.nodeId === 'string'
    && typeof msg.nodeEpoch === 'string'
    && typeof msg.protocolVersion === 'number'
    && Array.isArray(msg.supportedFeatures)
    && msg.supportedFeatures.every((feature) => typeof feature === 'string')
    && typeof msg.softwareVersion === 'string';
}

export function isRelayHello(value: unknown): value is RelayHello {
  const msg = value as Partial<RelayHello>;
  return typeof value === 'object'
    && value !== null
    && msg.type === 'relay.hello'
    && (msg.outcome === 'accepted' || msg.outcome === 'downgraded' || msg.outcome === 'refused')
    && typeof msg.acceptedVersion === 'number'
    && Array.isArray(msg.enabledFeatures)
    && msg.enabledFeatures.every((feature) => typeof feature === 'string');
}
