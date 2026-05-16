import type { NodeEpoch, NodeId, Seq, SessionEpoch, SessionId } from './ids.js';

export type TerminalStreamEventKind =
  | 'terminal.bytes'
  | 'terminal.replay-gap';

export interface TerminalBytesPayload {
  encoding: 'base64';
  data: string;
  byteLength: number;
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
}

export type TerminalBytesEvent = TerminalStreamEventBase<'terminal.bytes', TerminalBytesPayload>;
export type TerminalReplayGapEvent = TerminalStreamEventBase<'terminal.replay-gap', TerminalReplayGapPayload>;

export type TerminalStreamEvent =
  | TerminalBytesEvent
  | TerminalReplayGapEvent;

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
    return payload.encoding === 'base64'
      && typeof payload.data === 'string'
      && typeof payload.byteLength === 'number'
      && Number.isInteger(payload.byteLength)
      && payload.byteLength >= 0;
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
