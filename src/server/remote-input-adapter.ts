import type { TerminalBackend } from '../adapters/terminal-backend.js';
import type {
  ActorId,
  ClientId,
  CommandId,
  IdempotencyKey,
  InputContextId,
  LeaseId,
  Seq,
  SessionEpoch,
  SessionId,
} from '../remote/ids.js';
import type { CommandEnvelope } from '../remote/command-journal.js';
import type { ControllerLeaseManager } from '../remote/controller-lease.js';

export interface SubmitMessageRequest {
  type: 'submit-message';
  sessionId: SessionId;
  sessionEpoch: SessionEpoch;
  leaseId: LeaseId;
  commandId: CommandId;
  idempotencyKey: IdempotencyKey;
  text: string;
  appendNewline: boolean;
  baseRevision: number;
  lastSeenSeq: Seq;
  inputContextId?: InputContextId;
  maxAgeMs: number;
  commandMetadata?: {
    provenance?: 'typed' | 'stt-draft' | 'paste';
    sttCapabilityId?: string;
    edited?: boolean;
  };
}

export interface SubmitMessageCommand extends CommandEnvelope {
  action: 'submitMessage';
  actorId: ActorId;
  clientId: ClientId;
  sessionId: SessionId;
  sessionEpoch: SessionEpoch;
  leaseId: LeaseId;
  baseRevision: number;
  lastSeenSeq: Seq;
  payload: SubmitMessageRequest;
}

export interface RemoteInputAdapter {
  submit(command: SubmitMessageCommand): Promise<{ bytesWritten: number; appendNewline: boolean }>;
}

export interface RemoteInputAdapterDeps {
  terminalBackend: Pick<TerminalBackend, 'write'>;
  leaseManager: ControllerLeaseManager;
  getCurrentSeq?: (sessionId: SessionId, sessionEpoch: SessionEpoch) => number | null;
}

const encoder = new TextEncoder();

export function isSubmitMessageRequest(value: unknown): value is SubmitMessageRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const req = value as Partial<SubmitMessageRequest>;
  return req.type === 'submit-message'
    && typeof req.sessionId === 'string'
    && typeof req.sessionEpoch === 'string'
    && typeof req.leaseId === 'string'
    && typeof req.commandId === 'string'
    && typeof req.idempotencyKey === 'string'
    && typeof req.text === 'string'
    && req.text.length > 0
    && typeof req.appendNewline === 'boolean'
    && typeof req.baseRevision === 'number'
    && Number.isInteger(req.baseRevision)
    && req.baseRevision >= 0
    && typeof req.lastSeenSeq === 'number'
    && Number.isInteger(req.lastSeenSeq)
    && req.lastSeenSeq >= 0
    && typeof req.maxAgeMs === 'number'
    && Number.isFinite(req.maxAgeMs)
    && req.maxAgeMs > 0
    && (req.inputContextId === undefined || typeof req.inputContextId === 'string')
    && (
      req.commandMetadata === undefined
      || (
        typeof req.commandMetadata === 'object'
        && req.commandMetadata !== null
        && (
          req.commandMetadata.provenance === undefined
          || req.commandMetadata.provenance === 'typed'
          || req.commandMetadata.provenance === 'stt-draft'
          || req.commandMetadata.provenance === 'paste'
        )
        && (req.commandMetadata.sttCapabilityId === undefined || typeof req.commandMetadata.sttCapabilityId === 'string')
        && (req.commandMetadata.edited === undefined || typeof req.commandMetadata.edited === 'boolean')
      )
    );
}

export function isSubmitMessageCommand(command: CommandEnvelope): command is SubmitMessageCommand {
  return command.action === 'submitMessage'
    && typeof command.leaseId === 'string'
    && typeof command.baseRevision === 'number'
    && typeof command.lastSeenSeq === 'number'
    && isSubmitMessageRequest(command.payload);
}

export async function createRemoteInputAdapter(deps: RemoteInputAdapterDeps): Promise<RemoteInputAdapter> {
  return {
    async submit(command: SubmitMessageCommand): Promise<{ bytesWritten: number; appendNewline: boolean }> {
      const lease = deps.leaseManager.validateRemoteSubmit({
        sessionId: command.sessionId,
        sessionEpoch: command.sessionEpoch,
        actorId: command.actorId,
        clientId: command.clientId,
        leaseId: command.leaseId,
      });
      if (!lease.ok) throw new Error(lease.reason);
      const currentSeq = deps.getCurrentSeq?.(command.sessionId, command.sessionEpoch);
      if (currentSeq !== null && currentSeq !== undefined && command.lastSeenSeq < currentSeq) {
        throw new Error('error.staleTerminalView');
      }
      if (
        command.payload.sessionId !== command.sessionId
        || command.payload.sessionEpoch !== command.sessionEpoch
        || command.payload.leaseId !== command.leaseId
        || command.payload.commandId !== command.commandId
        || command.payload.idempotencyKey !== command.idempotencyKey
        || command.payload.baseRevision !== command.baseRevision
        || command.payload.lastSeenSeq !== command.lastSeenSeq
      ) {
        throw new Error('submit-message envelope mismatch');
      }

      const payload = encoder.encode(command.payload.text + (command.payload.appendNewline ? '\r' : ''));
      await deps.terminalBackend.write(command.sessionId, payload);
      return { bytesWritten: payload.byteLength, appendNewline: command.payload.appendNewline };
    },
  };
}
