import type { NodeEpoch, NodeId, PolicyVersion, Seq, SessionEpoch, SessionId } from './ids.js';

export type TerminalStreamEventKind =
  | 'terminal.bytes'
  | 'terminal.replay-gap';

export interface TerminalBytesPayload {
  encoding: 'base64';
  data: string;
  byteLength: number;
}

export type TerminalPublicationPrincipal =
  | { kind: 'contact-device'; contactId: string; deviceId: string }
  | { kind: 'guest-member'; invitationId: string; memberSessionId: string; deviceId: string };

export interface TerminalPublicationMetadata {
  publicationScopeId: string;
  principal: TerminalPublicationPrincipal;
  policyVersion: PolicyVersion;
  streamEncryption?:
    | {
      kind: 'contact-e2ee';
      recipientDeviceId: string;
      streamKeyId: string;
      alg: 'RSA-OAEP-SHA256+A256GCM';
      wrappedKey: string;
      iv: string;
      tag: string;
    }
    | { kind: 'guest-transport'; memberSessionId: string };
}

export interface TerminalReplayGapPayload {
  fromSeq: Seq;
  toSeq: Seq;
  reason: 'replay-buffer-miss' | 'session-epoch-mismatch';
}

export interface TerminalStreamEventBase<K extends TerminalStreamEventKind, P> {
  nodeId: NodeId;
  nodeEpoch: NodeEpoch;
  sessionId: SessionId;
  sessionEpoch: SessionEpoch;
  seq: Seq;
  ts: string;
  kind: K;
  payload: P;
  publication?: TerminalPublicationMetadata;
}

export type TerminalBytesEvent = TerminalStreamEventBase<'terminal.bytes', TerminalBytesPayload>;
export type TerminalReplayGapEvent = TerminalStreamEventBase<'terminal.replay-gap', TerminalReplayGapPayload>;

export type TerminalStreamEvent =
  | TerminalBytesEvent
  | TerminalReplayGapEvent;

export function isTerminalPublicationPrincipal(value: unknown): value is TerminalPublicationPrincipal {
  const principal = value as Partial<TerminalPublicationPrincipal>;
  return typeof value === 'object'
    && value !== null
    && (
      (
        principal.kind === 'contact-device'
        && typeof (principal as { contactId?: unknown }).contactId === 'string'
        && typeof (principal as { deviceId?: unknown }).deviceId === 'string'
      )
      || (
        principal.kind === 'guest-member'
        && typeof (principal as { invitationId?: unknown }).invitationId === 'string'
        && typeof (principal as { memberSessionId?: unknown }).memberSessionId === 'string'
        && typeof (principal as { deviceId?: unknown }).deviceId === 'string'
      )
    );
}

export function isTerminalStreamEvent(value: unknown): value is TerminalStreamEvent {
  const msg = value as Partial<TerminalStreamEvent>;
  if (
    typeof value !== 'object'
    || value === null
    || typeof msg.nodeId !== 'string'
    || typeof msg.nodeEpoch !== 'string'
    || typeof msg.sessionId !== 'string'
    || typeof msg.sessionEpoch !== 'string'
    || typeof msg.seq !== 'number'
    || !Number.isInteger(msg.seq)
    || msg.seq < 0
    || typeof msg.ts !== 'string'
    || !('payload' in msg)
  ) {
    return false;
  }

  if (msg.kind === 'terminal.bytes') {
    const payload = msg.payload as Partial<TerminalBytesPayload>;
    const publication = msg.publication as Partial<TerminalPublicationMetadata> | undefined;
    return payload.encoding === 'base64'
      && typeof payload.data === 'string'
      && typeof payload.byteLength === 'number'
      && Number.isInteger(payload.byteLength)
      && payload.byteLength >= 0
      && (
        publication === undefined
        || (
          typeof publication.publicationScopeId === 'string'
          && typeof publication.policyVersion === 'number'
          && isTerminalPublicationPrincipal(publication.principal)
        )
      );
  }

  if (msg.kind === 'terminal.replay-gap') {
    const payload = msg.payload as Partial<TerminalReplayGapPayload>;
    return Number.isInteger(payload.fromSeq)
      && Number.isInteger(payload.toSeq)
      && (payload.fromSeq ?? -1) >= 0
      && (payload.toSeq ?? -1) >= 0
      && (payload.reason === 'replay-buffer-miss' || payload.reason === 'session-epoch-mismatch');
  }

  return false;
}
