import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
  ActorId,
  ClientId,
  CommandId,
  GrantId,
  IdempotencyKey,
  LeaseId,
  NodeEpoch,
  NodeId,
  Seq,
  SessionEpoch,
  SessionId,
} from './ids.js';

export type RemoteCommandAction =
  | 'presetReply'
  | 'permissionApprove'
  | 'skip'
  | 'snooze'
  | 'mark-done'
  | 'launch'
  | 'leaseAcquire'
  | 'leaseHeartbeat'
  | 'leaseOverride'
  | 'submitMessage';
export type CommandOutcome =
  | 'accepted'
  | 'rejected'
  | 'rejected-pre-audit'
  | 'unknown-intent-only'
  | 'unknown-never-seen'
  | 'node-offline';

export interface IdempotencyTuple {
  nodeId: NodeId;
  nodeEpoch: NodeEpoch;
  sessionId: SessionId;
  sessionEpoch: SessionEpoch;
  grantId: GrantId;
  idempotencyKey: IdempotencyKey;
}

export interface CommandEnvelope extends IdempotencyTuple {
  commandId: CommandId;
  actorId: ActorId;
  clientId: ClientId;
  action: RemoteCommandAction;
  baseRevision?: number;
  leaseId?: LeaseId;
  lastSeenSeq?: Seq;
  payload?: unknown;
}

export interface CommandResult<Res = unknown> {
  outcome: CommandOutcome;
  commandId: CommandId;
  action: RemoteCommandAction;
  result?: Res;
  reason?: string;
}

export type CommandAuditRow =
  | (CommandEnvelope & { type: 'command.intent'; timestamp: string })
  | (Partial<CommandEnvelope> & {
      type: 'command.result' | 'command.pre-audit-reject';
      commandId: CommandId;
      action: RemoteCommandAction;
      outcome: CommandOutcome;
      reason?: string;
      result?: unknown;
      timestamp: string;
    })
  | { type: 'grant.revoke'; grantId: GrantId; nodeId: NodeId; nodeEpoch: NodeEpoch; policyVersion?: number; timestamp: string };

interface IdempotencyEntry {
  tupleKey: string;
  lastUsedAt: number;
  createdAt: number;
  commandId: CommandId;
  result?: CommandResult;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_IDEMPOTENCY_ENTRIES = 100_000;

function tupleKey(tuple: IdempotencyTuple): string {
  return [
    tuple.nodeId,
    tuple.nodeEpoch,
    tuple.sessionId,
    tuple.sessionEpoch,
    tuple.grantId,
    tuple.idempotencyKey,
  ].join('\0');
}

function isAuditRow(value: unknown): value is CommandAuditRow {
  const row = value as Partial<CommandAuditRow>;
  return typeof value === 'object'
    && value !== null
    && typeof row.type === 'string'
    && typeof row.timestamp === 'string';
}

export class CommandJournal {
  private readonly intents = new Map<CommandId, CommandAuditRow & { type: 'command.intent' }>();
  private readonly results = new Map<CommandId, CommandResult>();
  private readonly idempotency = new Map<string, IdempotencyEntry>();
  private readonly tombstones = new Set<GrantId>();

  private constructor(
    private readonly auditPath: string,
    private readonly nodeId: NodeId,
    private readonly nodeEpoch: NodeEpoch,
    private readonly now: () => Date,
  ) {}

  static auditPathFor(kookrDir: string): string {
    return join(kookrDir, 'audit.jsonl');
  }

  static async open(opts: {
    kookrDir: string;
    nodeId: NodeId;
    nodeEpoch: NodeEpoch;
    now?: () => Date;
  }): Promise<CommandJournal> {
    const journal = new CommandJournal(
      CommandJournal.auditPathFor(opts.kookrDir),
      opts.nodeId,
      opts.nodeEpoch,
      opts.now ?? (() => new Date()),
    );
    await journal.load();
    return journal;
  }

  getAuditPath(): string {
    return this.auditPath;
  }

  hasTombstone(grantId: GrantId): boolean {
    return this.tombstones.has(grantId);
  }

  async revokeGrant(grantId: GrantId, policyVersion?: number): Promise<void> {
    this.tombstones.add(grantId);
    await this.append({
      type: 'grant.revoke',
      grantId,
      nodeId: this.nodeId,
      nodeEpoch: this.nodeEpoch,
      ...(policyVersion !== undefined ? { policyVersion } : {}),
      timestamp: this.now().toISOString(),
    });
  }

  begin(command: CommandEnvelope): CommandResult | null {
    this.prune(command);
    const existing = this.idempotency.get(tupleKey(command));
    if (existing?.result) {
      existing.lastUsedAt = this.now().getTime();
      return { ...existing.result, commandId: command.commandId };
    }
    if (existing) {
      existing.lastUsedAt = this.now().getTime();
      return {
        commandId: command.commandId,
        action: command.action,
        outcome: 'unknown-intent-only',
        reason: 'matching command intent has no result yet',
      };
    }
    return null;
  }

  async appendIntent(command: CommandEnvelope): Promise<void> {
    const row = { ...command, type: 'command.intent' as const, timestamp: this.now().toISOString() };
    this.intents.set(command.commandId, row);
    this.idempotency.set(tupleKey(command), {
      tupleKey: tupleKey(command),
      commandId: command.commandId,
      createdAt: this.now().getTime(),
      lastUsedAt: this.now().getTime(),
    });
    await this.append(row);
  }

  async appendResult(command: CommandEnvelope, result: CommandResult): Promise<void> {
    this.results.set(command.commandId, result);
    const entry = this.idempotency.get(tupleKey(command));
    if (entry) {
      entry.result = result;
      entry.lastUsedAt = this.now().getTime();
    }
    await this.append({
      ...command,
      type: 'command.result',
      outcome: result.outcome,
      reason: result.reason,
      result: result.result,
      timestamp: this.now().toISOString(),
    });
  }

  async appendPreAuditReject(command: Partial<CommandEnvelope> & Pick<CommandEnvelope, 'commandId' | 'action'>, reason: string): Promise<CommandResult> {
    const result: CommandResult = {
      commandId: command.commandId,
      action: command.action,
      outcome: 'rejected-pre-audit',
      reason,
    };
    this.results.set(command.commandId, result);
    await this.append({
      ...command,
      type: 'command.pre-audit-reject',
      outcome: 'rejected-pre-audit',
      reason,
      timestamp: this.now().toISOString(),
    });
    return result;
  }

  outcome(commandId: CommandId): CommandResult {
    const result = this.results.get(commandId);
    if (result) return result;
    const intent = this.intents.get(commandId);
    if (intent) return { commandId, action: intent.action, outcome: 'unknown-intent-only' };
    return { commandId, action: 'presetReply', outcome: 'unknown-never-seen' };
  }

  private prune(scope?: Pick<CommandEnvelope, 'nodeEpoch' | 'sessionEpoch'>): void {
    const cutoff = this.now().getTime() - DAY_MS;
    for (const [key, entry] of this.idempotency) {
      const expired = entry.createdAt < cutoff;
      const epochBumped = scope && !key.includes(`\0${scope.nodeEpoch}\0`) || scope && !key.includes(`\0${scope.sessionEpoch}\0`);
      if (expired || epochBumped) this.idempotency.delete(key);
    }
    if (this.idempotency.size <= MAX_IDEMPOTENCY_ENTRIES) return;
    const lru = [...this.idempotency.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const entry of lru.slice(0, this.idempotency.size - MAX_IDEMPOTENCY_ENTRIES)) {
      this.idempotency.delete(entry.tupleKey);
    }
  }

  private async load(): Promise<void> {
    let raw = '';
    try {
      raw = await readFile(this.auditPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (!isAuditRow(parsed)) continue;
      if (parsed.type === 'grant.revoke') {
        this.tombstones.add(parsed.grantId);
        continue;
      }
      if (parsed.type === 'command.intent') {
        this.intents.set(parsed.commandId, parsed);
        if (parsed.nodeEpoch === this.nodeEpoch) {
          this.idempotency.set(tupleKey(parsed), {
            tupleKey: tupleKey(parsed),
            commandId: parsed.commandId,
            createdAt: Date.parse(parsed.timestamp),
            lastUsedAt: Date.parse(parsed.timestamp),
          });
        }
        continue;
      }
      const result: CommandResult = {
        commandId: parsed.commandId,
        action: parsed.action,
        outcome: parsed.outcome,
        reason: parsed.reason,
        result: parsed.result,
      };
      this.results.set(parsed.commandId, result);
      if (parsed.type === 'command.result' && parsed.nodeEpoch === this.nodeEpoch) {
        const key = tupleKey(parsed as CommandEnvelope);
        this.idempotency.set(key, {
          tupleKey: key,
          commandId: parsed.commandId,
          result,
          createdAt: Date.parse(parsed.timestamp),
          lastUsedAt: Date.parse(parsed.timestamp),
        });
      }
    }
  }

  private async append(row: CommandAuditRow): Promise<void> {
    await mkdir(dirname(this.auditPath), { recursive: true });
    await appendFile(this.auditPath, `${JSON.stringify(row)}\n`, 'utf8');
  }
}
