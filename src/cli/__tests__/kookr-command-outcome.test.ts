import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectCommandOutcomes } from '../kookr-command-outcome.js';
import { CommandJournal, type CommandEnvelope } from '../../remote/command-journal.js';
import { asActorId, asClientId, asCommandId, asGrantId, asIdempotencyKey, asNodeEpoch, asNodeId, asSessionEpoch, asSessionId } from '../../remote/ids.js';

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
    ...overrides,
  };
}

describe('kookr command outcome', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `kookr-command-outcome-${Date.now()}-${Math.random()}`);
    await mkdir(join(dir, 'sessions', 's1'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns local interaction-log commands when remote audit.jsonl does not exist', async () => {
    await writeFile(join(dir, 'sessions', 's1', 'interactions.jsonl'), `${JSON.stringify({
      type: 'user_input',
      agentId: 's1',
      content: 'continue',
      timestamp: '2026-05-15T19:00:00.000Z',
    })}\n`, 'utf8');

    await expect(collectCommandOutcomes({ kookrDir: dir })).resolves.toMatchObject([
      { source: 'local', action: 'presetReply', outcome: 'accepted', agentId: 's1' },
    ]);
  });

  it('returns remote outcomes from the compacted command journal snapshot', async () => {
    const journal = await CommandJournal.open({
      kookrDir: dir,
      nodeId: asNodeId('node-1'),
      nodeEpoch: asNodeEpoch('1'),
      compactAfterBytes: 1,
    });
    const request = command({ commandId: asCommandId('cmd-compacted') });
    await journal.appendIntent(request);
    await journal.appendResult(request, {
      commandId: request.commandId,
      action: request.action,
      outcome: 'accepted',
      result: { ok: true },
    });

    await expect(collectCommandOutcomes({ kookrDir: dir, commandId: 'cmd-compacted' })).resolves.toMatchObject([
      {
        source: 'remote',
        commandId: 'cmd-compacted',
        action: 'presetReply',
        outcome: 'accepted',
      },
    ]);
  });

  it('returns compacted intent-only commands as unknown intent-only', async () => {
    const journal = await CommandJournal.open({
      kookrDir: dir,
      nodeId: asNodeId('node-1'),
      nodeEpoch: asNodeEpoch('1'),
      compactAfterBytes: 1,
    });
    await journal.appendIntent(command({ commandId: asCommandId('cmd-intent-only') }));

    await expect(collectCommandOutcomes({ kookrDir: dir, commandId: 'cmd-intent-only' })).resolves.toMatchObject([
      {
        source: 'remote',
        commandId: 'cmd-intent-only',
        action: 'presetReply',
        outcome: 'unknown-intent-only',
      },
    ]);
  });

  it('returns active audit intent-only commands as unknown intent-only', async () => {
    const journal = await CommandJournal.open({
      kookrDir: dir,
      nodeId: asNodeId('node-1'),
      nodeEpoch: asNodeEpoch('1'),
      compactAfterBytes: Number.MAX_SAFE_INTEGER,
    });
    await journal.appendIntent(command({ commandId: asCommandId('cmd-active-intent') }));

    await expect(collectCommandOutcomes({ kookrDir: dir, commandId: 'cmd-active-intent' })).resolves.toMatchObject([
      {
        source: 'remote',
        commandId: 'cmd-active-intent',
        action: 'presetReply',
        outcome: 'unknown-intent-only',
      },
    ]);
  });

  it('deduplicates remote outcomes when snapshot rows are still present in the active audit', async () => {
    const journal = await CommandJournal.open({
      kookrDir: dir,
      nodeId: asNodeId('node-1'),
      nodeEpoch: asNodeEpoch('1'),
      compactAfterBytes: 1,
    });
    const request = command({ commandId: asCommandId('cmd-duplicate-window') });
    await journal.appendIntent(request);
    await journal.appendResult(request, {
      commandId: request.commandId,
      action: request.action,
      outcome: 'accepted',
      result: { ok: true },
    });

    const archive = (await readdir(dir)).find((entry) => /^audit\..+\.jsonl$/.test(entry));
    expect(archive).toBeDefined();
    await writeFile(join(dir, 'audit.jsonl'), await readFile(join(dir, archive!), 'utf8'), 'utf8');

    await expect(collectCommandOutcomes({ kookrDir: dir, commandId: 'cmd-duplicate-window' })).resolves.toHaveLength(1);
  });

  it('ignores a command outcome snapshot whose audit offset is stale', async () => {
    await writeFile(CommandJournal.snapshotPathFor(dir), JSON.stringify({
      version: 1,
      auditSizeBytes: 100,
      results: [{
        commandId: 'cmd-stale-cli-snapshot',
        lastSeenAt: Date.now(),
        result: {
          commandId: 'cmd-stale-cli-snapshot',
          action: 'presetReply',
          outcome: 'accepted',
        },
      }],
    }));
    await writeFile(CommandJournal.auditPathFor(dir), '', 'utf8');

    await expect(collectCommandOutcomes({ kookrDir: dir, commandId: 'cmd-stale-cli-snapshot' })).resolves.toEqual([]);
  });
});
