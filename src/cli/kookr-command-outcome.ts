import { open, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { CommandJournal, type CommandAuditRow, type CommandOutcome, type CommandResult, type RemoteCommandAction } from '../remote/command-journal.js';

export interface AggregatedCommandOutcome {
  source: 'local' | 'remote';
  commandId?: string;
  action: string;
  outcome: CommandOutcome;
  timestamp?: string;
  agentId?: string;
  taskId?: string;
  reason?: string;
}

async function readJsonl(path: string): Promise<unknown[]> {
  let raw = '';
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return parseJsonl(raw);
}

function parseJsonl(raw: string): unknown[] {
  return raw.split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

async function readFileTail(path: string, offset: number): Promise<string> {
  const size = await fileSize(path);
  if (size === 0) return '';
  if (offset <= 0 || offset > size) return readFile(path, 'utf8');
  if (offset === size) return '';
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(size - offset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function collectLocalInteractionPaths(kookrDir: string): Promise<string[]> {
  const sessionsDir = join(kookrDir, 'sessions');
  let entries: string[] = [];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return [join(kookrDir, 'interaction-log.jsonl')];
  }
  return [
    join(kookrDir, 'interaction-log.jsonl'),
    ...entries.map((entry) => join(sessionsDir, entry, 'interactions.jsonl')),
  ];
}

interface CommandJournalSnapshotResult {
  commandId: string;
  result: CommandResult;
  lastSeenAt: number;
}

interface CommandJournalSnapshotProjection {
  version: 1;
  auditSizeBytes: number;
  intents: Array<CommandAuditRow & { type: 'command.intent' }>;
  results: CommandJournalSnapshotResult[];
}

function isSnapshotProjection(value: unknown): value is CommandJournalSnapshotProjection {
  const snapshot = value as Partial<CommandJournalSnapshotProjection>;
  return typeof value === 'object'
    && value !== null
    && snapshot.version === 1
    && typeof snapshot.auditSizeBytes === 'number'
    && Array.isArray(snapshot.intents)
    && snapshot.intents.every(isIntentRow)
    && Array.isArray(snapshot.results)
    && snapshot.results.every((entry) => typeof entry === 'object'
      && entry !== null
      && typeof entry.commandId === 'string'
      && typeof entry.lastSeenAt === 'number'
      && isCommandResult(entry.result));
}

function isIntentRow(value: unknown): value is CommandAuditRow & { type: 'command.intent' } {
  const row = value as Partial<CommandAuditRow>;
  return typeof value === 'object'
    && value !== null
    && row.type === 'command.intent'
    && typeof row.commandId === 'string'
    && typeof row.action === 'string'
    && typeof row.timestamp === 'string';
}

function isCommandResult(value: unknown): value is CommandResult {
  const result = value as Partial<CommandResult>;
  return typeof value === 'object'
    && value !== null
    && typeof result.commandId === 'string'
    && typeof result.action === 'string'
    && typeof result.outcome === 'string';
}

async function readSnapshotProjection(kookrDir: string, activeAuditSize: number): Promise<CommandJournalSnapshotProjection | null> {
  let raw = '';
  try {
    raw = await readFile(CommandJournal.snapshotPathFor(kookrDir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    // Snapshots are a compact projection over the active audit tail. If the
    // projection is malformed or points past the active audit, replay the
    // authoritative audit from zero instead.
    if (!isSnapshotProjection(parsed) || parsed.auditSizeBytes > activeAuditSize) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function collectRemoteOutcomes(kookrDir: string, commandId?: string): Promise<AggregatedCommandOutcome[]> {
  const auditPath = CommandJournal.auditPathFor(kookrDir);
  const activeAuditSize = await fileSize(auditPath);
  const snapshot = await readSnapshotProjection(kookrDir, activeAuditSize);
  const outcomes = new Map<string, AggregatedCommandOutcome>();

  for (const intent of snapshot?.intents ?? []) {
    if (commandId && intent.commandId !== commandId) continue;
    outcomes.set(intent.commandId, {
      source: 'remote',
      commandId: intent.commandId,
      action: intent.action,
      outcome: 'unknown-intent-only',
      timestamp: intent.timestamp,
    });
  }

  for (const entry of snapshot?.results ?? []) {
    if (commandId && entry.commandId !== commandId) continue;
    outcomes.set(entry.commandId, {
      source: 'remote',
      commandId: entry.commandId,
      action: entry.result.action,
      outcome: entry.result.outcome,
      timestamp: new Date(entry.lastSeenAt).toISOString(),
      reason: entry.result.reason,
    });
  }

  const tail = await readFileTail(auditPath, snapshot?.auditSizeBytes ?? 0);
  for (const row of parseJsonl(tail)) {
    const event = row as {
      type?: unknown;
      commandId?: unknown;
      action?: unknown;
      outcome?: unknown;
      timestamp?: unknown;
      reason?: unknown;
    };
    if (event.type === 'command.intent') {
      if (typeof event.commandId !== 'string' || typeof event.action !== 'string') continue;
      if (commandId && event.commandId !== commandId) continue;
      outcomes.set(event.commandId, {
        source: 'remote',
        commandId: event.commandId,
        action: event.action as RemoteCommandAction,
        outcome: 'unknown-intent-only',
        timestamp: typeof event.timestamp === 'string' ? event.timestamp : undefined,
      });
      continue;
    }
    if (event.type !== 'command.result' && event.type !== 'command.pre-audit-reject') continue;
    if (typeof event.commandId !== 'string' || typeof event.action !== 'string' || typeof event.outcome !== 'string') continue;
    if (commandId && event.commandId !== commandId) continue;
    outcomes.set(event.commandId, {
      source: 'remote',
      commandId: event.commandId,
      action: event.action as RemoteCommandAction,
      outcome: event.outcome as CommandOutcome,
      timestamp: typeof event.timestamp === 'string' ? event.timestamp : undefined,
      reason: typeof event.reason === 'string' ? event.reason : undefined,
    });
  }

  return [...outcomes.values()];
}

function localAction(type: string): string | null {
  switch (type) {
    case 'user_input': return 'presetReply';
    case 'finding_skipped': return 'skip';
    case 'finding_snoozed': return 'snooze';
    case 'task_completed': return 'mark-done';
    default: return null;
  }
}

export async function collectCommandOutcomes(opts: {
  kookrDir?: string;
  commandId?: string;
} = {}): Promise<AggregatedCommandOutcome[]> {
  const kookrDir = opts.kookrDir ?? join(process.env.HOME ?? '.', '.kookr');
  const outcomes: AggregatedCommandOutcome[] = [];

  for (const path of await collectLocalInteractionPaths(kookrDir)) {
    for (const row of await readJsonl(path)) {
      const event = row as { type?: unknown; timestamp?: unknown; agentId?: unknown; taskId?: unknown; commandId?: unknown };
      if (typeof event.type !== 'string') continue;
      const action = localAction(event.type);
      if (!action) continue;
      if (opts.commandId && event.commandId !== opts.commandId) continue;
      outcomes.push({
        source: 'local',
        commandId: typeof event.commandId === 'string' ? event.commandId : undefined,
        action,
        outcome: 'accepted',
        timestamp: typeof event.timestamp === 'string' ? event.timestamp : undefined,
        agentId: typeof event.agentId === 'string' ? event.agentId : undefined,
        taskId: typeof event.taskId === 'string' ? event.taskId : undefined,
      });
    }
  }

  outcomes.push(...await collectRemoteOutcomes(kookrDir, opts.commandId));

  return outcomes.sort((a, b) => String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? '')));
}

export async function runCommandOutcomeCli(argv = process.argv.slice(2)): Promise<number> {
  const commandId = argv[0];
  const outcomes = await collectCommandOutcomes({ commandId });
  if (commandId && outcomes.length === 0) {
    console.log(JSON.stringify({ commandId, outcome: 'unknown-never-seen' }));
    return 0;
  }
  for (const outcome of outcomes) console.log(JSON.stringify(outcome));
  return 0;
}
