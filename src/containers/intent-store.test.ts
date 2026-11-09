import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { INTENT_MAX_OPEN_MS, IntentStore } from './intent-store.js';

describe('IntentStore', () => {
  let dir: string;
  let now: Date;
  let store: IntentStore;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oc-intent-')); now = new Date('2026-01-01T00:00:00Z'); store = new IntentStore(dir, () => now); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('open until closed; closing is durable', async () => {
    await store.open('t1', 'token-aaaa1', 'inst');
    expect(await store.isOpen('token-aaaa1')).toBe(true);
    await store.close('token-aaaa1');
    expect(await store.isOpen('token-aaaa1')).toBe(false);
    expect((await new IntentStore(dir).read('token-aaaa1'))?.closedAt).toBeDefined();
  });
  test('an abandoned intent stops protecting after the max-open time', async () => {
    await store.open('t1', 'token-aaaa1', 'inst');
    now = new Date(now.getTime() + INTENT_MAX_OPEN_MS + 1);
    expect(await store.isOpen('token-aaaa1')).toBe(false);
  });
  test('unknown tokens are not open; path-like tokens are rejected', async () => {
    expect(await store.isOpen('token-zzzz9')).toBe(false);
    await expect(store.open('t', '../evil', 'i')).rejects.toThrow('invalid launch token');
  });
  test('prune removes only old closed/abandoned token files and leaves foreign files and open intents', async () => {
    await store.open('t1', 'token-old01', 'inst');
    await store.close('token-old01');
    await store.open('t2', 'token-open2', 'inst');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    now = new Date(now.getTime() + 60_000);
    expect(await store.prune(30_000)).toBe(1);
    expect(existsSync(join(dir, 'token-old01.json'))).toBe(false);
    expect(existsSync(join(dir, 'token-open2.json'))).toBe(true);
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
  });
});
