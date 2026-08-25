import { appendFile, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

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

interface CommandJournalSnapshot {
  version: 1;
  auditSizeBytes: number;
  createdAt: string;
  intents: Array<CommandAuditRow & { type: 'command.intent' }>;
  results: Array<{ commandId: CommandId; result: CommandResult; lastSeenAt: number }>;
  idempotency: IdempotencyEntry[];
  tombstones: GrantId[];
}

interface CommandArchiveRetentionOptions {
  /** Maximum rotated audit segments to keep. Undefined disables count pruning. */
  maxArchiveCount?: number;
  /** Maximum age for rotated audit segments. Undefined disables age pruning. */
  maxArchiveAgeMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_IDEMPOTENCY_ENTRIES = 100_000;
const DEFAULT_COMPACT_AFTER_BYTES = 8 * 1024 * 1024;
const MAX_COMMAND_STATE_ENTRIES = MAX_IDEMPOTENCY_ENTRIES;
const AUDIT_ARCHIVE_RE = /^audit\..+\.jsonl$/;

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
    && (row.type === 'command.intent'
      || row.type === 'command.result'
      || row.type === 'command.pre-audit-reject'
      || row.type === 'grant.revoke')
    && typeof row.timestamp === 'string';
}

function isSnapshot(value: unknown): value is CommandJournalSnapshot {
  const snapshot = value as Partial<CommandJournalSnapshot>;
  return typeof value === 'object'
    && value !== null
    && snapshot.version === 1
    && typeof snapshot.auditSizeBytes === 'number'
    && typeof snapshot.createdAt === 'string'
    && Array.isArray(snapshot.intents)
    && snapshot.intents.every((row) => isAuditRow(row) && row.type === 'command.intent')
    && Array.isArray(snapshot.results)
    && snapshot.results.every((entry) => typeof entry === 'object'
      && entry !== null
      && typeof entry.commandId === 'string'
      && typeof entry.lastSeenAt === 'number'
      && typeof entry.result === 'object'
      && entry.result !== null)
    && Array.isArray(snapshot.idempotency)
    && Array.isArray(snapshot.tombstones)
    && snapshot.tombstones.every((grantId) => typeof grantId === 'string');
}

function normalizeNonNegativeInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function normalizeNonNegativeNumber(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, value);
}

export class CommandJournal {
  private readonly intents = new Map<CommandId, CommandAuditRow & { type: 'command.intent' }>();
  private readonly results = new Map<CommandId, CommandResult>();
  private readonly idempotency = new Map<string, IdempotencyEntry>();
  private readonly tombstones = new Set<GrantId>();
  private readonly commandLastSeenAt = new Map<CommandId, number>();
  private lastCompactedAuditSize = 0;
  private archiveCounter = 0;

  private constructor(
    private readonly auditPath: string,
    private readonly snapshotPath: string,
    private readonly nodeId: NodeId,
    private readonly nodeEpoch: NodeEpoch,
    private readonly now: () => Date,
    private readonly compactAfterBytes: number,
    private readonly archiveRetention: CommandArchiveRetentionOptions,
  ) {}

  static auditPathFor(kookrDir: string): string {
    return join(kookrDir, 'audit.jsonl');
  }

  static snapshotPathFor(kookrDir: string): string {
    return join(kookrDir, 'audit.snapshot.json');
  }

  static async open(opts: {
    kookrDir: string;
    nodeId: NodeId;
    nodeEpoch: NodeEpoch;
    now?: () => Date;
    compactAfterBytes?: number;
    maxArchiveCount?: number;
    maxArchiveAgeMs?: number;
  }): Promise<CommandJournal> {
    const journal = new CommandJournal(
      CommandJournal.auditPathFor(opts.kookrDir),
      CommandJournal.snapshotPathFor(opts.kookrDir),
      opts.nodeId,
      opts.nodeEpoch,
      opts.now ?? (() => new Date()),
      opts.compactAfterBytes ?? DEFAULT_COMPACT_AFTER_BYTES,
      {
        maxArchiveCount: normalizeNonNegativeInteger(opts.maxArchiveCount),
        maxArchiveAgeMs: normalizeNonNegativeNumber(opts.maxArchiveAgeMs),
      },
    );
    await journal.load();
    return journal;
  }

  getAuditPath(): string {
    return this.auditPath;
  }

  getSnapshotPath(): string {
    return this.snapshotPath;
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
    this.prune();
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
    const now = this.now();
    const row = { ...command, type: 'command.intent' as const, timestamp: now.toISOString() };
    this.intents.set(command.commandId, row);
    this.commandLastSeenAt.set(command.commandId, now.getTime());
    this.idempotency.set(tupleKey(command), {
      tupleKey: tupleKey(command),
      commandId: command.commandId,
      createdAt: now.getTime(),
      lastUsedAt: now.getTime(),
    });
    await this.append(row);
  }

  async appendResult(command: CommandEnvelope, result: CommandResult): Promise<void> {
    const now = this.now();
    this.intents.delete(command.commandId);
    this.results.set(command.commandId, result);
    this.commandLastSeenAt.set(command.commandId, now.getTime());
    const entry = this.idempotency.get(tupleKey(command));
    if (entry) {
      entry.result = result;
      entry.lastUsedAt = now.getTime();
    }
    await this.append({
      ...command,
      type: 'command.result',
      outcome: result.outcome,
      reason: result.reason,
      result: result.result,
      timestamp: now.toISOString(),
    });
  }

  async appendPreAuditReject(command: Partial<CommandEnvelope> & Pick<CommandEnvelope, 'commandId' | 'action'>, reason: string): Promise<CommandResult> {
    const now = this.now();
    const result: CommandResult = {
      commandId: command.commandId,
      action: command.action,
      outcome: 'rejected-pre-audit',
      reason,
    };
    this.results.set(command.commandId, result);
    this.commandLastSeenAt.set(command.commandId, now.getTime());
    await this.append({
      ...command,
      type: 'command.pre-audit-reject',
      outcome: 'rejected-pre-audit',
      reason,
      timestamp: now.toISOString(),
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

  private prune(): void {
    const cutoff = this.now().getTime() - DAY_MS;
    for (const [key, entry] of this.idempotency) {
      const expired = entry.createdAt < cutoff;
      // tupleKey stores nodeEpoch as its second null-delimited field.
      const nodeEpochBumped = key.split('\0', 3)[1] !== this.nodeEpoch;
      if (expired || nodeEpochBumped) this.idempotency.delete(key);
    }
    if (this.idempotency.size <= MAX_IDEMPOTENCY_ENTRIES) return;
    const lru = [...this.idempotency.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const entry of lru.slice(0, this.idempotency.size - MAX_IDEMPOTENCY_ENTRIES)) {
      this.idempotency.delete(entry.tupleKey);
    }
    this.pruneCommandState();
  }

  private async load(): Promise<void> {
    let auditOffset = 0;
    const snapshot = await this.readSnapshot();
    const auditSize = await this.auditSize();
    // A snapshot is only a projection cache. If the active audit was truncated
    // or replaced after the snapshot was written, replay the audit from zero
    // rather than resurrecting state the current log no longer contains.
    if (snapshot && snapshot.auditSizeBytes <= auditSize) {
      this.applySnapshot(snapshot);
      auditOffset = snapshot.auditSizeBytes;
      this.lastCompactedAuditSize = snapshot.auditSizeBytes;
    }
    const raw = await this.readAuditTail(auditOffset);
    this.applyAuditLines(raw);
    this.pruneCommandState();
  }

  private applySnapshot(snapshot: CommandJournalSnapshot): void {
    this.intents.clear();
    this.results.clear();
    this.idempotency.clear();
    this.tombstones.clear();
    this.commandLastSeenAt.clear();

    for (const intent of snapshot.intents) {
      this.intents.set(intent.commandId, intent);
      this.commandLastSeenAt.set(intent.commandId, Date.parse(intent.timestamp));
    }
    for (const entry of snapshot.results) {
      this.results.set(entry.commandId, entry.result);
      this.commandLastSeenAt.set(entry.commandId, entry.lastSeenAt);
    }
    for (const entry of snapshot.idempotency) {
      this.idempotency.set(entry.tupleKey, entry);
      this.commandLastSeenAt.set(entry.commandId, Math.max(
        this.commandLastSeenAt.get(entry.commandId) ?? 0,
        entry.lastUsedAt,
      ));
    }
    for (const grantId of snapshot.tombstones) this.tombstones.add(grantId);
  }

  private applyAuditLines(raw: string): void {
    try {
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          continue;
        }
        if (isAuditRow(parsed)) this.applyAuditRow(parsed);
      }
    } finally {
      this.pruneCommandState();
    }
  }

  private applyAuditRow(row: CommandAuditRow): void {
    if (row.type === 'grant.revoke') {
      this.tombstones.add(row.grantId);
      return;
    }
    const timestamp = Date.parse(row.timestamp);
    this.commandLastSeenAt.set(row.commandId, timestamp);
    if (row.type === 'command.intent') {
      this.intents.set(row.commandId, row);
      if (row.nodeEpoch === this.nodeEpoch) {
        this.idempotency.set(tupleKey(row), {
          tupleKey: tupleKey(row),
          commandId: row.commandId,
          createdAt: timestamp,
          lastUsedAt: timestamp,
        });
      }
      return;
    }
    const result: CommandResult = {
      commandId: row.commandId,
      action: row.action,
      outcome: row.outcome,
      reason: row.reason,
      result: row.result,
    };
    this.intents.delete(row.commandId);
    this.results.set(row.commandId, result);
    if (row.type === 'command.result' && row.nodeEpoch === this.nodeEpoch) {
      const key = tupleKey(row as CommandEnvelope);
      this.idempotency.set(key, {
        tupleKey: key,
        commandId: row.commandId,
        result,
        createdAt: timestamp,
        lastUsedAt: timestamp,
      });
    }
  }

  private async append(row: CommandAuditRow): Promise<void> {
    await mkdir(dirname(this.auditPath), { recursive: true });
    await appendFile(this.auditPath, `${JSON.stringify(row)}\n`, 'utf8');
    await this.compactIfNeeded();
  }

  private async readSnapshot(): Promise<CommandJournalSnapshot | null> {
    let raw: string;
    try {
      raw = await readFile(this.snapshotPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      return isSnapshot(parsed) ? parsed : null;
    } catch {
      // Snapshots are rebuildable; malformed projection state should not block
      // recovery from the authoritative audit log.
      return null;
    }
  }

  private async readAuditTail(offset: number): Promise<string> {
    const size = await this.auditSize();
    if (size === 0) return '';
    if (offset <= 0 || offset > size) return readFile(this.auditPath, 'utf8');
    if (offset === size) return '';
    const handle = await open(this.auditPath, 'r');
    try {
      const buffer = Buffer.alloc(size - offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  }

  private async auditSize(): Promise<number> {
    try {
      return (await stat(this.auditPath)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
  }

  private pruneCommandState(): void {
    const commandStateSize = new Set([...this.intents.keys(), ...this.results.keys()]).size;
    if (commandStateSize <= MAX_COMMAND_STATE_ENTRIES) return;

    const keep = new Set<CommandId>();
    for (const entry of this.idempotency.values()) keep.add(entry.commandId);
    for (const [commandId] of [...this.commandLastSeenAt.entries()].sort((a, b) => b[1] - a[1])) {
      if (keep.size >= MAX_COMMAND_STATE_ENTRIES) break;
      keep.add(commandId);
    }

    for (const commandId of this.intents.keys()) {
      if (!keep.has(commandId)) this.intents.delete(commandId);
    }
    for (const commandId of this.results.keys()) {
      if (!keep.has(commandId)) this.results.delete(commandId);
    }
    for (const commandId of this.commandLastSeenAt.keys()) {
      if (!keep.has(commandId)) this.commandLastSeenAt.delete(commandId);
    }
  }

  private async compactIfNeeded(): Promise<void> {
    if (this.compactAfterBytes <= 0) return;
    const size = (await stat(this.auditPath)).size;
    if (size - this.lastCompactedAuditSize < this.compactAfterBytes) return;
    await this.rotateActiveAudit();
  }

  private async rotateActiveAudit(): Promise<void> {
    // Snapshot the current live projection, then archive the covered active
    // audit and start a new empty tail. The snapshot offset is zero because it
    // applies to the newly-created active audit, not the archived segment.
    await this.writeSnapshot(0);
    const archivePath = this.nextArchivePath();
    await rename(this.auditPath, archivePath);
    await writeFile(this.auditPath, '', 'utf8');
    this.lastCompactedAuditSize = 0;
    await this.pruneArchives(archivePath);
  }

  private nextArchivePath(): string {
    const stamp = this.now().toISOString().replace(/[^0-9A-Za-z.-]/g, '-');
    this.archiveCounter += 1;
    return join(dirname(this.auditPath), `audit.${stamp}.${process.pid}.${this.archiveCounter}.jsonl`);
  }

  private async pruneArchives(protectedArchivePath: string): Promise<void> {
    const maxArchiveCount = this.archiveRetention.maxArchiveCount;
    const maxArchiveAgeMs = this.archiveRetention.maxArchiveAgeMs;
    if (maxArchiveCount === undefined && maxArchiveAgeMs === undefined) return;

    const dir = dirname(this.auditPath);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }

    const protectedArchiveName = basename(protectedArchivePath);
    const archives = (await Promise.all(
      entries
        .filter((entry) => AUDIT_ARCHIVE_RE.test(entry))
        .map(async (entry) => {
          const path = join(dir, entry);
          try {
            const info = await stat(path);
            const prunable = await this.archiveContainsOnlyCommandAuditRows(path);
            return { name: entry, path, mtimeMs: info.mtimeMs, prunable };
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw err;
          }
        }),
    )).filter((entry): entry is { name: string; path: string; mtimeMs: number; prunable: boolean } => entry !== null)
      .sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));

    const prunableArchives = archives.filter((archive) => archive.prunable);
    const removable = new Set<string>();
    const protectedArchive = prunableArchives.find((entry) => entry.name === protectedArchiveName);
    const nowMs = this.now().getTime();

    if (maxArchiveAgeMs !== undefined) {
      for (const archive of prunableArchives) {
        if (archive.name === protectedArchiveName) continue;
        if (nowMs - archive.mtimeMs > maxArchiveAgeMs) removable.add(archive.path);
      }
    }

    if (maxArchiveCount !== undefined && prunableArchives.length > maxArchiveCount) {
      const keep = new Set(
        (maxArchiveCount === 0 ? [] : prunableArchives.slice(-maxArchiveCount))
          .map((archive) => archive.path),
      );
      if (protectedArchive) keep.add(protectedArchive.path);
      for (const archive of prunableArchives) {
        if (!keep.has(archive.path)) removable.add(archive.path);
      }
    }

    for (const archivePath of removable) {
      try {
        await unlink(archivePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
  }

  private async archiveContainsOnlyCommandAuditRows(archivePath: string): Promise<boolean> {
    let sawRow = false;
    let raw: string;
    try {
      raw = await readFile(archivePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        return false;
      }
      if (!isAuditRow(parsed)) return false;
      sawRow = true;
    }
    return sawRow;
  }

  private async writeSnapshot(activeAuditSizeBytes: number): Promise<void> {
    this.pruneCommandState();
    const snapshot: CommandJournalSnapshot = {
      version: 1,
      auditSizeBytes: activeAuditSizeBytes,
      createdAt: this.now().toISOString(),
      intents: [...this.intents.values()].filter((intent) => !this.results.has(intent.commandId)),
      results: [...this.results.entries()].map(([commandId, result]) => ({
        commandId,
        result,
        lastSeenAt: this.commandLastSeenAt.get(commandId) ?? this.now().getTime(),
      })),
      idempotency: [...this.idempotency.values()],
      tombstones: [...this.tombstones],
    };
    await mkdir(dirname(this.snapshotPath), { recursive: true });
    const tmp = `${this.snapshotPath}.${process.pid}.tmp`;
    let renamed = false;
    try {
      await writeFile(tmp, `${JSON.stringify(snapshot)}\n`, 'utf8');
      await rename(tmp, this.snapshotPath);
      renamed = true;
    } finally {
      if (!renamed) {
        try { await unlink(tmp); } catch { /* best-effort temp cleanup */ }
      }
    }
    this.lastCompactedAuditSize = activeAuditSizeBytes;
  }
}
