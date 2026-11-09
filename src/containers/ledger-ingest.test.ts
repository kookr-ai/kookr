import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { HookFileWatcher } from '../server/hook-watcher.js';
import type { HookEventInjector } from '../server/hook-ingestion.js';
import { ContainerLedgerIngest, containerSessionKey, ledgerLocation, type LedgerWatcherPort } from './ledger-ingest.js';

describe('ledger identity and paths', () => {
  test('session key is a pure function of task id + launch token and matches the container name shape', () => {
    expect(containerSessionKey('abcdef1234567890', 'tok123')).toBe('kookr-oc-abcdef12-tok123');
    expect(containerSessionKey('abcdef1234567890', 'tok123')).toBe(containerSessionKey('abcdef1234567890', 'tok123'));
    expect(containerSessionKey('abcdef1234567890', 'tok124')).not.toBe(containerSessionKey('abcdef1234567890', 'tok123'));
  });
  test('rejects ids that could escape the spool dir', () => {
    for (const bad of ['../x', 'a/b', '', 'a b', '.']) expect(() => ledgerLocation('/s', bad, 'tok123')).toThrow('invalid task id');
    for (const bad of ['../x', 'ab', 'a/b', 'tok 12', 'x'.repeat(40)]) expect(() => ledgerLocation('/s', 'task1', bad)).toThrow('invalid launch token');
  });
  test('layout is <spool>/<task>/<token>/ledger.jsonl', () => {
    expect(ledgerLocation('/s', 'task1', 'tok123').file).toBe('/s/task1/tok123/ledger.jsonl');
  });
});

describe('ContainerLedgerIngest.prepare', () => {
  let dir: string;
  const noWatch: LedgerWatcherPort = { watch() {}, stop() {}, isWatching: () => false };
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oc-spool-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('creates private dirs and an empty 0600 ledger, idempotently and without truncating', async () => {
    const ing = new ContainerLedgerIngest(dir, noWatch);
    const loc = await ing.prepare('task1', 'tok123');
    expect(statSync(loc.dir).mode & 0o777).toBe(0o700);
    expect(statSync(loc.file).mode & 0o777).toBe(0o600);
    appendFileSync(loc.file, '{"a":1}\n');
    await ing.prepare('task1', 'tok123');
    expect(readFileSync(loc.file, 'utf8')).toBe('{"a":1}\n');
  });
  test('refuses a symlinked spool component or ledger', async () => {
    const ing = new ContainerLedgerIngest(dir, noWatch);
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'task2'));
    await expect(ing.prepare('task2', 'tok123')).rejects.toThrow('not a plain directory');
    const loc = await ing.prepare('task3', 'tok123');
    rmSync(loc.file);
    writeFileSync(join(dir, 'secret'), 'hostdata');
    symlinkSync(join(dir, 'secret'), loc.file);
    await expect(ing.prepare('task3', 'tok123')).rejects.toThrow('not a regular file');
  });
  test('attach starts one untrusted watch under the derived key; adopt replays from the checkpoint; detach stops', async () => {
    const calls: Array<[string, unknown]> = [];
    let watching = false;
    const w: LedgerWatcherPort = {
      watch: (k, o) => { calls.push([k, o]); watching = true; },
      stop: (k) => { calls.push([`stop:${k}`, null]); watching = false; },
      isWatching: () => watching,
    };
    const ing = new ContainerLedgerIngest(dir, w);
    const key = ing.attach('task1', 'tok123');
    ing.attach('task1', 'tok123'); // idempotent
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toMatchObject({ untrusted: true, replayExisting: false, filePath: join(dir, 'task1', 'tok123', 'ledger.jsonl') });
    ing.detach('task1', 'tok123');
    ing.attach('task1', 'tok123', { adopt: true });
    expect(calls[2]![1]).toMatchObject({ replayExisting: true, suppressParseAlertsForExisting: true, useReplayCheckpoint: true });
    expect(key).toBe('kookr-oc-task1-tok123');
  });
});

describe('real HookFileWatcher on a spool ledger', () => {
  let dir: string;
  let hooksDir: string;
  let seen: Array<{ key: string; raw: string }>;
  let watcher: HookFileWatcher;
  const injector: HookEventInjector = {
    injectHookEvent(tmux, raw) {
      seen.push({ key: tmux, raw });
      return { parseStatus: 'parsed', agentType: 'opencode', sequence: seen.length, origin: 'live' } as never;
    },
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-spool-w-'));
    hooksDir = mkdtempSync(join(tmpdir(), 'oc-hooks-'));
    seen = [];
    watcher = new HookFileWatcher(hooksDir, injector, { pollIntervalMs: 50 });
  });
  afterEach(() => { watcher.stopAll(); rmSync(dir, { recursive: true, force: true }); rmSync(hooksDir, { recursive: true, force: true }); });
  const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 30)); };

  test('events appended to the ledger reach the injector under the taskId+token key (not under hooksDir)', async () => {
    const ing = new ContainerLedgerIngest(dir, watcher);
    const loc = await ing.prepare('task1', 'tok123');
    ing.attach('task1', 'tok123');
    appendFileSync(loc.file, '{"hook_event_name":"SessionStart"}\n');
    await until(() => seen.length > 0);
    expect(seen).toEqual([{ key: 'kookr-oc-task1-tok123', raw: '{"hook_event_name":"SessionStart"}' }]);
  });

  test('adopt after a restart replays existing records under the same key', async () => {
    const ing = new ContainerLedgerIngest(dir, watcher);
    const loc = await ing.prepare('task1', 'tok123');
    appendFileSync(loc.file, '{"n":1}\n{"n":2}\n');
    ing.attach('task1', 'tok123', { adopt: true });
    await until(() => seen.length >= 2);
    expect(seen.map((s) => s.key)).toEqual(['kookr-oc-task1-tok123', 'kookr-oc-task1-tok123']);
  });

  test('a worker that swaps the ledger for a symlink to a host file never gets that file read', async () => {
    const ing = new ContainerLedgerIngest(dir, watcher);
    const loc = await ing.prepare('task1', 'tok123');
    ing.attach('task1', 'tok123');
    rmSync(loc.file);
    writeFileSync(join(dir, 'hostsecret'), '{"stolen":"host-file-content"}\n');
    symlinkSync(join(dir, 'hostsecret'), loc.file);
    await new Promise((r) => setTimeout(r, 400));
    expect(seen).toEqual([]);
    const h = watcher.getHealthSnapshot().sessions.find((x) => x.tmuxName === 'kookr-oc-task1-tok123');
    expect(h?.errorCount).toBeGreaterThan(0);
    expect(h?.lastError).toContain('not a regular file');
  });

  test('TUI sessions are unaffected: the default path under hooksDir still works', async () => {
    writeFileSync(join(hooksDir, 'kookr-tui1.jsonl'), '');
    watcher.watch('kookr-tui1');
    appendFileSync(join(hooksDir, 'kookr-tui1.jsonl'), '{"x":1}\n');
    await until(() => seen.length > 0);
    expect(seen[0]).toEqual({ key: 'kookr-tui1', raw: '{"x":1}' });
  });
});
