import { mkdtemp, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { executeWithPipeline } from '../command-pipeline.js';
import { CommandJournal, type CommandEnvelope } from '../command-journal.js';
import { asActorId, asClientId, asCommandId, asGrantId, asIdempotencyKey, asNodeEpoch, asNodeId, asSessionEpoch, asSessionId } from '../ids.js';

const AUDIT_ARCHIVE_RE = /^audit\..+\.jsonl$/;

function command(overrides: Partial<CommandEnvelope> = {}): CommandEnvelope {
  return {
    commandId: asCommandId('cmd-1'),
    actorId: asActorId('local-owner'),
    clientId: asClientId('client-1'),
    nodeId: asNodeId('node-1'),
    nodeEpoch: asNodeEpoch('1'),
    sessionId: asSessionId('session-1'),
    sessionEpoch: asSessionEpoch('1'),
    grantId: asGrantId('grant-1'),
    idempotencyKey: asIdempotencyKey('idem-1'),
    action: 'presetReply',
    payload: { presetId: 'continue' },
    ...overrides,
  };
}

async function archiveNames(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((entry) => AUDIT_ARCHIVE_RE.test(entry)).sort();
}

async function writeCommandArchive(dir: string, name: string, mtime: Date): Promise<void> {
  const row = {
    ...command({ commandId: asCommandId(`cmd-${name}`) }),
    type: 'command.intent',
    timestamp: mtime.toISOString(),
  };
  const path = join(dir, name);
  await writeFile(path, `${JSON.stringify(row)}\n`, 'utf8');
  await utimes(path, mtime, mtime);
}

async function writeTaskLifecycleArchive(dir: string, name: string, mtime: Date): Promise<void> {
  const path = join(dir, name);
  const commandRow = {
    ...command({ commandId: asCommandId(`cmd-${name}`) }),
    type: 'command.intent',
    timestamp: mtime.toISOString(),
  };
  const taskRow = {
    type: 'task.deleteTask',
    timestamp: mtime.toISOString(),
    actor: { source: 'api' },
    scope: { kind: 'all' },
    count: 1,
    deletedTaskIds: ['task-1'],
    outcome: 'deleted',
  };
  await writeFile(path, `${JSON.stringify(commandRow)}\n${JSON.stringify(taskRow)}\n`, 'utf8');
  await utimes(path, mtime, mtime);
}

describe('CommandJournal and pipeline', () => {
  it('replays the original result for idempotent retries and treats a different key as new intent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-command-journal-'));
    const journal = await CommandJournal.open({ kookrDir: dir, nodeId: asNodeId('node-1'), nodeEpoch: asNodeEpoch('1') });
    let executions = 0;
    const handler = {
      action: 'presetReply' as const,
      authorize: () => ({ ok: true as const }),
      validate: () => ({ ok: true as const }),
      execute: async () => ({ executions: ++executions }),
    };

    const first = await executeWithPipeline({ journal, handler, request: command(), isOwnerLocal: () => true });
    const replay = await executeWithPipeline({ journal, handler, request: command({ commandId: asCommandId('cmd-2') }), isOwnerLocal: () => true });
    const next = await executeWithPipeline({
      journal,
      handler,
      request: command({ commandId: asCommandId('cmd-3'), idempotencyKey: asIdempotencyKey('idem-2') }),
      isOwnerLocal: () => true,
    });

    expect(first).toMatchObject({ outcome: 'accepted', result: { executions: 1 } });
    expect(replay).toMatchObject({ commandId: 'cmd-2', outcome: 'accepted', result: { executions: 1 } });
    expect(next).toMatchObject({ outcome: 'accepted', result: { executions: 2 } });
    const audit = await readFile(join(dir, 'audit.jsonl'), 'utf8');
    expect(audit.match(/command\.intent/g)).toHaveLength(2);
  });

  it('preserves idempotency entries across concurrent session epochs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-command-concurrent-sessions-'));
    const journal = await CommandJournal.open({ kookrDir: dir, nodeId: asNodeId('node-1'), nodeEpoch: asNodeEpoch('1') });
    const execute = vi.fn(async () => ({ execution: execute.mock.calls.length }));
    const handler = {
      action: 'presetReply' as const,
      authorize: () => ({ ok: true as const }),
      validate: () => ({ ok: true as const }),
      execute,
    };
    const sessionA = command({
      sessionId: asSessionId('session-a'),
      sessionEpoch: asSessionEpoch('epoch-a'),
      idempotencyKey: asIdempotencyKey('idem-a'),
    });
    const sessionB = command({
      commandId: asCommandId('cmd-b'),
      sessionId: asSessionId('session-b'),
      sessionEpoch: asSessionEpoch('epoch-b'),
      idempotencyKey: asIdempotencyKey('idem-b'),
    });

    const firstA = await executeWithPipeline({ journal, handler, request: sessionA, isOwnerLocal: () => true });
    await executeWithPipeline({ journal, handler, request: sessionB, isOwnerLocal: () => true });
    const replayA = await executeWithPipeline({
      journal,
      handler,
      request: { ...sessionA, commandId: asCommandId('cmd-a-retry') },
      isOwnerLocal: () => true,
    });

    expect(firstA).toMatchObject({ outcome: 'accepted', result: { execution: 1 } });
    expect(replayA).toMatchObject({ commandId: 'cmd-a-retry', outcome: 'accepted', result: { execution: 1 } });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not replay snapshot idempotency entries from a stale node epoch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-command-stale-node-epoch-'));
    const first = await CommandJournal.open({
      kookrDir: dir,
      nodeId: asNodeId('node-1'),
      nodeEpoch: asNodeEpoch('1'),
      compactAfterBytes: 1,
    });
    const request = command({ idempotencyKey: asIdempotencyKey('idem-stale-node') });
    await first.appendIntent(request);
    await first.appendResult(request, {
      commandId: request.commandId,
      action: request.action,
      outcome: 'accepted',
      result: { ok: true },
    });

    const restarted = await CommandJournal.open({
      kookrDir: dir,
      nodeId: asNodeId('node-1'),
      nodeEpoch: asNodeEpoch('2'),
      compactAfterBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(restarted.begin({ ...request, commandId: asCommandId('cmd-stale-retry') })).toBeNull();
  });

  it('records deterministic validation failures as rejected-pre-audit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-command-preaudit-'));
    const journal = await CommandJournal.open({ kookrDir: dir, nodeId: asNodeId('node-1'), nodeEpoch: asNodeEpoch('1') });
    const execute = vi.fn(async () => ({}));
    const result = await executeWithPipeline({
      journal,
      request: command({ commandId: asCommandId('cmd-bad') }),
      isOwnerLocal: () => true,
      handler: {
        action: 'presetReply',
        authorize: () => ({ ok: true as const }),
        validate: () => ({ ok: false as const, reason: 'stale baseRevision' }),
        execute,
      },
    });

    expect(result).toMatchObject({ outcome: 'rejected-pre-audit', reason: 'stale baseRevision' });
    expect(journal.outcome(asCommandId('cmd-bad')).outcome).toBe('rejected-pre-audit');
    expect(execute).not.toHaveBeenCalled();
    const audit = await readFile(join(dir, 'audit.jsonl'), 'utf8');
    expect(audit).toContain('"type":"command.pre-audit-reject"');
    expect(audit).not.toContain('"type":"command.intent"');
  });

  it('returns unknown-intent-only for write-ahead rows without results after restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-command-recovery-'));
    const first = await CommandJournal.open({ kookrDir: dir, nodeId: asNodeId('node-1'), nodeEpoch: asNodeEpoch('1') });
    await first.appendIntent(command({ commandId: asCommandId('cmd-intent-only') }));

    const restarted = await CommandJournal.open({ kookrDir: dir, nodeId: asNodeId('node-1'), nodeEpoch: asNodeEpoch('1') });
    expect(restarted.outcome(asCommandId('cmd-intent-only')).outcome).toBe('unknown-intent-only');
    expect(restarted.outcome(asCommandId('missing')).outcome).toBe('unknown-never-seen');
    const replay = restarted.begin(command({ commandId: asCommandId('cmd-intent-retry') }));
    expect(replay).toMatchObject({ outcome: 'unknown-intent-only' });
  });

  it('persists grant tombstones across restarts and rejects reintroduction', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-command-tombstone-'));
    const first = await CommandJournal.open({ kookrDir: dir, nodeId: asNodeId('node-1'), nodeEpoch: asNodeEpoch('1') });
    await first.revokeGrant(asGrantId('grant-dead'));

    const restarted = await CommandJournal.open({ kookrDir: dir, nodeId: asNodeId('node-1'), nodeEpoch: asNodeEpoch('1') });
    expect(restarted.hasTombstone(asGrantId('grant-dead'))).toBe(true);
    const rejected = await executeWithPipeline({
      journal: restarted,
      request: command({ commandId: asCommandId('cmd-revoked'), grantId: asGrantId('grant-dead') }),
      isOwnerLocal: () => true,
      handler: {
        action: 'presetReply',
        authorize: () => ({ ok: true as const }),
        validate: () => ({ ok: true as const }),
        execute: async () => ({}),
      },
    });
    expect(rejected.outcome).toBe('rejected-pre-audit');
  });

  it('compacts live command state into a snapshot while preserving append-only audit history', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-command-compaction-'));
    const first = await CommandJournal.open({
      kookrDir: dir,
      nodeId: asNodeId('node-1'),
      nodeEpoch: asNodeEpoch('1'),
      compactAfterBytes: 1,
    });
    const request = command({ commandId: asCommandId('cmd-compacted') });
    await first.appendIntent(request);
    await first.appendResult(request, {
      commandId: request.commandId,
      action: request.action,
      outcome: 'accepted',
      result: { ok: true },
    });

    const snapshot = JSON.parse(await readFile(first.getSnapshotPath(), 'utf8')) as {
      auditSizeBytes: number;
      intents: unknown[];
      results: Array<{ commandId: string }>;
    };
    expect(snapshot.auditSizeBytes).toBe(0);
    expect(snapshot.intents).toHaveLength(0);
    expect(snapshot.results).toEqual([expect.objectContaining({ commandId: 'cmd-compacted' })]);

    const activeAudit = await readFile(join(dir, 'audit.jsonl'), 'utf8');
    expect(activeAudit).toBe('');
    const archives = await readdir(dir);
    const archivedAudit = (await Promise.all(
      archives.filter((entry) => AUDIT_ARCHIVE_RE.test(entry))
        .map((entry) => readFile(join(dir, entry), 'utf8')),
    )).join('\n');
    expect(archivedAudit).toContain('"type":"command.intent"');
    expect(archivedAudit).toContain('"type":"command.result"');

    const restarted = await CommandJournal.open({
      kookrDir: dir,
      nodeId: asNodeId('node-1'),
      nodeEpoch: asNodeEpoch('1'),
      compactAfterBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(restarted.outcome(asCommandId('cmd-compacted'))).toMatchObject({
      outcome: 'accepted',
      result: { ok: true },
    });
    expect(restarted.begin(command({
      commandId: asCommandId('cmd-compacted-retry'),
      idempotencyKey: request.idempotencyKey,
    }))).toMatchObject({
      outcome: 'accepted',
      result: { ok: true },
    });
  });

  it('prunes oldest rotated audit archives by count after compaction', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-command-archive-count-'));
    await writeCommandArchive(dir, 'audit.2025-01-01T00-00-00.000Z.1.1.jsonl', new Date('2025-01-01T00:00:00.000Z'));
    await writeCommandArchive(dir, 'audit.2025-01-02T00-00-00.000Z.1.2.jsonl', new Date('2025-01-02T00:00:00.000Z'));
    await writeCommandArchive(dir, 'audit.2025-01-03T00-00-00.000Z.1.3.jsonl', new Date('2025-01-03T00:00:00.000Z'));

    const first = await CommandJournal.open({
      kookrDir: dir,
      nodeId: asNodeId('node-1'),
      nodeEpoch: asNodeEpoch('1'),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      compactAfterBytes: 1,
      maxArchiveCount: 2,
    });
    const request = command({
      commandId: asCommandId('cmd-pruned-count'),
      idempotencyKey: asIdempotencyKey('idem-pruned-count'),
    });
    await first.appendIntent(request);
    await first.appendResult(request, {
      commandId: request.commandId,
      action: request.action,
      outcome: 'accepted',
      result: { ok: true },
    });

    const archives = await archiveNames(dir);
    expect(archives).toHaveLength(2);
    expect(archives.every((entry) => entry.startsWith('audit.2026-01-01T00-00-00.000Z.'))).toBe(true);
    await expect(stat(CommandJournal.auditPathFor(dir))).resolves.toBeDefined();
    await expect(stat(CommandJournal.snapshotPathFor(dir))).resolves.toBeDefined();

    const restarted = await CommandJournal.open({
      kookrDir: dir,
      nodeId: asNodeId('node-1'),
      nodeEpoch: asNodeEpoch('1'),
      compactAfterBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(restarted.outcome(asCommandId('cmd-pruned-count'))).toMatchObject({
      outcome: 'accepted',
      result: { ok: true },
    });
  });

  it('prunes rotated audit archives by age without deleting the current rotation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-command-archive-age-'));
    const activeAuditMtime = new Date('2025-01-01T00:00:00.000Z');
    await writeCommandArchive(dir, 'audit.2025-01-01T00-00-00.000Z.1.1.jsonl', new Date('2025-01-01T00:00:00.000Z'));
    await writeCommandArchive(dir, 'audit.2025-01-09T00-00-00.000Z.1.2.jsonl', new Date('2025-01-09T00:00:00.000Z'));
    await writeFile(CommandJournal.auditPathFor(dir), '', 'utf8');
    await utimes(CommandJournal.auditPathFor(dir), activeAuditMtime, activeAuditMtime);

    const journal = await CommandJournal.open({
      kookrDir: dir,
      nodeId: asNodeId('node-1'),
      nodeEpoch: asNodeEpoch('1'),
      now: () => new Date('2025-01-10T00:00:00.000Z'),
      compactAfterBytes: 1,
      maxArchiveAgeMs: 2 * 24 * 60 * 60 * 1000,
    });
    await journal.appendIntent(command({ commandId: asCommandId('cmd-pruned-age') }));

    const archives = await archiveNames(dir);
    expect(archives).not.toContain('audit.2025-01-01T00-00-00.000Z.1.1.jsonl');
    expect(archives).toContain('audit.2025-01-09T00-00-00.000Z.1.2.jsonl');
    expect(archives.some((entry) => entry.startsWith('audit.2025-01-10T00-00-00.000Z.'))).toBe(true);
  });

  it('leaves rotated audit archives unbounded when retention options are unset', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-command-archive-disabled-'));
    await writeCommandArchive(dir, 'audit.2025-01-01T00-00-00.000Z.1.1.jsonl', new Date('2025-01-01T00:00:00.000Z'));
    await writeCommandArchive(dir, 'audit.2025-01-02T00-00-00.000Z.1.2.jsonl', new Date('2025-01-02T00:00:00.000Z'));

    const journal = await CommandJournal.open({
      kookrDir: dir,
      nodeId: asNodeId('node-1'),
      nodeEpoch: asNodeEpoch('1'),
      now: () => new Date('2025-01-10T00:00:00.000Z'),
      compactAfterBytes: 1,
    });
    await journal.appendIntent(command({ commandId: asCommandId('cmd-retention-disabled') }));

    const archives = await archiveNames(dir);
    expect(archives).toHaveLength(3);
    expect(archives).toContain('audit.2025-01-01T00-00-00.000Z.1.1.jsonl');
    expect(archives).toContain('audit.2025-01-02T00-00-00.000Z.1.2.jsonl');
  });

  it('does not prune mixed audit archives containing task lifecycle rows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-command-archive-mixed-'));
    await writeCommandArchive(dir, 'audit.2025-01-01T00-00-00.000Z.1.1.jsonl', new Date('2025-01-01T00:00:00.000Z'));
    await writeTaskLifecycleArchive(dir, 'audit.2025-01-02T00-00-00.000Z.1.2.jsonl', new Date('2025-01-02T00:00:00.000Z'));

    const journal = await CommandJournal.open({
      kookrDir: dir,
      nodeId: asNodeId('node-1'),
      nodeEpoch: asNodeEpoch('1'),
      now: () => new Date('2025-01-10T00:00:00.000Z'),
      compactAfterBytes: 1,
      maxArchiveCount: 0,
      maxArchiveAgeMs: 0,
    });
    await journal.appendIntent(command({ commandId: asCommandId('cmd-protected-mixed') }));

    const archives = await archiveNames(dir);
    expect(archives).not.toContain('audit.2025-01-01T00-00-00.000Z.1.1.jsonl');
    expect(archives).toContain('audit.2025-01-02T00-00-00.000Z.1.2.jsonl');
    expect(archives.some((entry) => entry.startsWith('audit.2025-01-10T00-00-00.000Z.'))).toBe(true);
  });

  it('restores compacted grant tombstones from the snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-command-tombstone-snapshot-'));
    const first = await CommandJournal.open({
      kookrDir: dir,
      nodeId: asNodeId('node-1'),
      nodeEpoch: asNodeEpoch('1'),
      compactAfterBytes: 1,
    });
    await first.revokeGrant(asGrantId('grant-dead'));

    const restarted = await CommandJournal.open({
      kookrDir: dir,
      nodeId: asNodeId('node-1'),
      nodeEpoch: asNodeEpoch('1'),
      compactAfterBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(restarted.hasTombstone(asGrantId('grant-dead'))).toBe(true);
    const rejected = await executeWithPipeline({
      journal: restarted,
      request: command({ commandId: asCommandId('cmd-revoked-snapshot'), grantId: asGrantId('grant-dead') }),
      isOwnerLocal: () => true,
      handler: {
        action: 'presetReply',
        authorize: () => ({ ok: true as const }),
        validate: () => ({ ok: true as const }),
        execute: async () => ({}),
      },
    });
    expect(rejected.outcome).toBe('rejected-pre-audit');
  });

  it('replays the compacted snapshot plus rows appended after the snapshot offset', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-command-snapshot-tail-'));
    const compacted = await CommandJournal.open({
      kookrDir: dir,
      nodeId: asNodeId('node-1'),
      nodeEpoch: asNodeEpoch('1'),
      compactAfterBytes: 1,
    });
    const finished = command({ commandId: asCommandId('cmd-finished'), idempotencyKey: asIdempotencyKey('idem-finished') });
    await compacted.appendIntent(finished);
    await compacted.appendResult(finished, {
      commandId: finished.commandId,
      action: finished.action,
      outcome: 'accepted',
      result: { ok: true },
    });

    const tailWriter = await CommandJournal.open({
      kookrDir: dir,
      nodeId: asNodeId('node-1'),
      nodeEpoch: asNodeEpoch('1'),
      compactAfterBytes: Number.MAX_SAFE_INTEGER,
    });
    await tailWriter.appendIntent(command({
      commandId: asCommandId('cmd-tail'),
      idempotencyKey: asIdempotencyKey('idem-tail'),
    }));

    const restarted = await CommandJournal.open({
      kookrDir: dir,
      nodeId: asNodeId('node-1'),
      nodeEpoch: asNodeEpoch('1'),
      compactAfterBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(restarted.outcome(asCommandId('cmd-finished')).outcome).toBe('accepted');
    expect(restarted.outcome(asCommandId('cmd-tail')).outcome).toBe('unknown-intent-only');
    expect(restarted.begin(command({
      commandId: asCommandId('cmd-tail-retry'),
      idempotencyKey: asIdempotencyKey('idem-tail'),
    }))).toMatchObject({ outcome: 'unknown-intent-only' });
  });

  it('ignores a snapshot whose audit offset is beyond the current audit file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-command-stale-snapshot-'));
    await writeFile(CommandJournal.snapshotPathFor(dir), JSON.stringify({
      version: 1,
      auditSizeBytes: 100,
      createdAt: new Date().toISOString(),
      intents: [{
        ...command({ commandId: asCommandId('cmd-stale-snapshot') }),
        type: 'command.intent',
        timestamp: new Date().toISOString(),
      }],
      results: [],
      idempotency: [],
      tombstones: [],
    }));
    await writeFile(CommandJournal.auditPathFor(dir), '', 'utf8');

    const restarted = await CommandJournal.open({
      kookrDir: dir,
      nodeId: asNodeId('node-1'),
      nodeEpoch: asNodeEpoch('1'),
    });
    expect(restarted.outcome(asCommandId('cmd-stale-snapshot')).outcome).toBe('unknown-never-seen');
  });
});
