import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeSettingsStore, applyAutoUpdateEdit, defaultScopeFiles, scopeOutranks } from './settings-store.js';

const identityLock = <T>(fn: () => Promise<T>): Promise<T> => fn();

describe('applyAutoUpdateEdit (pure)', () => {
  test('sets the boolean, preserving other marketplace fields and other marketplaces', () => {
    const next = applyAutoUpdateEdit(
      { extraKnownMarketplaces: { mkt: { source: 'owner/repo' } as never, other: { autoUpdate: true } } },
      'mkt',
      false,
    );
    expect(next.extraKnownMarketplaces).toEqual({
      mkt: { source: 'owner/repo', autoUpdate: false },
      other: { autoUpdate: true },
    });
  });

  test('removing the only key prunes the entry and the map', () => {
    const next = applyAutoUpdateEdit({ extraKnownMarketplaces: { mkt: { autoUpdate: false } } }, 'mkt', undefined);
    expect(next.extraKnownMarketplaces).toBeUndefined();
  });

  test('removing autoUpdate keeps a non-empty entry', () => {
    const next = applyAutoUpdateEdit(
      { extraKnownMarketplaces: { mkt: { source: 'owner/repo', autoUpdate: false } as never } },
      'mkt',
      undefined,
    );
    expect(next.extraKnownMarketplaces).toEqual({ mkt: { source: 'owner/repo' } });
  });

  test('never mutates unrelated keys', () => {
    const current = { enabledPlugins: { 'a@m': true }, permissions: { deny: ['x'] } };
    const next = applyAutoUpdateEdit(current as never, 'mkt', false);
    expect(next.enabledPlugins).toEqual({ 'a@m': true });
    expect(next.permissions).toEqual({ deny: ['x'] });
  });
});

describe('scopeOutranks', () => {
  test('follows Claude Code precedence: projectLocal > project > userLocal > user', () => {
    expect(scopeOutranks('projectLocal', 'user')).toBe(true);
    expect(scopeOutranks('project', 'userLocal')).toBe(true);
    expect(scopeOutranks('user', 'userLocal')).toBe(false);
    expect(scopeOutranks('user', 'user')).toBe(false);
  });
});

describe('ClaudeSettingsStore.writeAutoUpdate (write + revert)', () => {
  let home: string;
  let cwd: string;
  let store: ClaudeSettingsStore;
  let userSettings: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kookr-au-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'kookr-au-cwd-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
    userSettings = join(home, '.claude', 'settings.json');
    store = new ClaudeSettingsStore(defaultScopeFiles(cwd, home));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test('writes autoUpdate:false then reverts to native default (key removed)', async () => {
    writeFileSync(userSettings, JSON.stringify({ enabledPlugins: { 'a@mkt': true } }));

    const w = await store.writeAutoUpdate('mkt', false, { scope: 'user', withLock: identityLock });
    expect(w.previousValue).toBeUndefined();
    expect(await store.readAutoUpdate('mkt')).toBe(false);
    // unrelated key preserved
    expect(JSON.parse(readFileSync(userSettings, 'utf8')).enabledPlugins).toEqual({ 'a@mkt': true });

    const r = await store.writeAutoUpdate('mkt', undefined, { scope: 'user', withLock: identityLock });
    expect(r.previousValue).toBe(false);
    expect(await store.readAutoUpdate('mkt')).toBeUndefined();
    expect(JSON.parse(readFileSync(userSettings, 'utf8')).enabledPlugins).toEqual({ 'a@mkt': true });
  });

  test('resolveAutoUpdate reports the highest-precedence scope that sets the flag', async () => {
    expect(await store.resolveAutoUpdate('mkt')).toEqual({ value: undefined });

    await store.writeAutoUpdate('mkt', false, { scope: 'user', withLock: identityLock });
    expect(await store.resolveAutoUpdate('mkt')).toEqual({ value: false, decidedBy: 'user' });

    mkdirSync(join(cwd, '.claude'), { recursive: true });
    await store.writeAutoUpdate('mkt', true, { scope: 'projectLocal', withLock: identityLock });
    expect(await store.resolveAutoUpdate('mkt')).toEqual({ value: true, decidedBy: 'projectLocal' });
    expect(await store.readAutoUpdate('mkt')).toBe(true);
  });

  test('backs the file up before writing', async () => {
    writeFileSync(userSettings, JSON.stringify({ foo: 1 }));
    const w = await store.writeAutoUpdate('mkt', false, { scope: 'user', withLock: identityLock });
    expect(w.backupPath).not.toBeNull();
    expect(JSON.parse(readFileSync(w.backupPath!, 'utf8'))).toEqual({ foo: 1 });
  });
});
