import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  openCodeDbPathFor,
  readOpenCodeDbUsage,
  readOpenCodeSessionUsage,
  mapOpenCodeUsageToTokenUsage,
} from './opencode-usage-scanner.js';

const FIXTURE = fileURLToPath(new URL('./__fixtures__/opencode-session.db', import.meta.url));

describe('opencode usage scanner', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'opencode-usage-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function stageFixture(): string {
    const dbPath = openCodeDbPathFor(root);
    mkdirSync(join(dbPath, '..'), { recursive: true });
    copyFileSync(FIXTURE, dbPath);
    return dbPath;
  }

  test('reads the real-session fixture', async () => {
    stageFixture();
    const result = await readOpenCodeSessionUsage(root);
    expect(result).toEqual({
      kind: 'ok',
      usage: {
        inputTokens: 5545,
        outputTokens: 2,
        cachedReadTokens: 1792,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: 0.001120952,
        model: 'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash-1017',
        requestCount: 1,
        firstTimestamp: 1794211472969,
        lastTimestamp: 1794211475034,
      },
    });
  });

  test('sums multiple assistant messages and ignores user/in-flight rows', async () => {
    const dbPath = stageFixture();
    const db = new Database(dbPath);
    const add = (id: string, data: unknown) =>
      db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(id, 'ses', 1, 1, JSON.stringify(data));
    add('m2', {
      role: 'assistant', cost: 0.5, modelID: 'big', providerID: 'p',
      tokens: { input: 100000, output: 10, reasoning: 7, cache: { write: 3, read: 4 } },
      time: { created: 1794211480000, completed: 1794211490000 },
    });
    add('m3', { role: 'assistant', modelID: 'big', providerID: 'p', time: { created: 1 } }); // no tokens yet
    db.close();

    const result = await readOpenCodeDbUsage(dbPath);
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.usage).toMatchObject({
      inputTokens: 105545, outputTokens: 12, reasoningTokens: 7, cachedReadTokens: 1796,
      cacheWriteTokens: 3, requestCount: 2, model: 'p/big',
      firstTimestamp: 1794211472969, lastTimestamp: 1794211490000,
    });
    expect(result.usage.costUsd).toBeCloseTo(0.501120952, 9);
    expect(mapOpenCodeUsageToTokenUsage(result.usage)).toMatchObject({
      inputTokens: 105545, outputTokens: 19, cacheReadTokens: 1796, cacheWriteTokens: 3, model: 'p/big',
    });
  });

  test('missing DB is no-data', async () => {
    expect(await readOpenCodeSessionUsage(root)).toEqual({ kind: 'no-data' });
  });

  test('schema without a message table is unsupported-schema, never a throw', async () => {
    const dbPath = join(root, 'other.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE events (id text)');
    db.close();
    expect((await readOpenCodeDbUsage(dbPath)).kind).toBe('unsupported-schema');
  });

  test('garbage file is unreadable, never a throw', async () => {
    const dbPath = join(root, 'junk.db');
    writeFileSync(dbPath, 'not a sqlite database at all'.repeat(50));
    expect((await readOpenCodeDbUsage(dbPath)).kind).toBe('unreadable');
  });

  test('tolerates a concurrent WAL writer holding the DB open', async () => {
    const dbPath = stageFixture();
    const writer = new Database(dbPath);
    writer.pragma('journal_mode = WAL');
    writer.exec('BEGIN IMMEDIATE');
    try {
      const result = await readOpenCodeDbUsage(dbPath);
      expect(result.kind).toBe('ok');
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
    }
  });
});
