import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { executeWithPipeline } from '../command-pipeline.js';
import { CommandJournal, type CommandEnvelope } from '../command-journal.js';
import { asActorId, asClientId, asCommandId, asGrantId, asIdempotencyKey, asNodeEpoch, asNodeId, asSessionEpoch, asSessionId } from '../ids.js';

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
});
