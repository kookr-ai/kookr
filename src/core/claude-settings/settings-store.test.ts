import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ClaudeSettingsStore,
  ConcurrentSettingsWriteError,
  applyEnabledPluginEdit,
  resolveEnablementFromScopes,
  defaultScopeFiles,
  type ScopeFile,
} from './settings-store.js';

describe('resolveEnablementFromScopes (pure, tri-state + precedence)', () => {
  it('returns default when no scope mentions the plugin (absent ≠ false)', () => {
    const r = resolveEnablementFromScopes(
      [{ scope: 'user', enabledPlugins: { 'other@mkt': true } }],
      'claude-notifications-go@claude-notifications-go',
    );
    expect(r.state).toBe('default');
    expect(r.decidedBy).toBeUndefined();
  });

  it('resolves enabled/disabled from the explicit boolean', () => {
    expect(
      resolveEnablementFromScopes([{ scope: 'user', enabledPlugins: { 'p@m': true } }], 'p@m').state,
    ).toBe('enabled');
    expect(
      resolveEnablementFromScopes([{ scope: 'user', enabledPlugins: { 'p@m': false } }], 'p@m').state,
    ).toBe('disabled');
  });

  it('honors precedence: the highest-precedence explicit boolean wins', () => {
    const r = resolveEnablementFromScopes(
      [
        { scope: 'projectLocal', enabledPlugins: { 'p@m': false } },
        { scope: 'user', enabledPlugins: { 'p@m': true } },
      ],
      'p@m',
    );
    expect(r.state).toBe('disabled');
    expect(r.decidedBy).toBe('projectLocal');
  });

  it('falls through a scope that lacks the key to a lower scope that has it', () => {
    const r = resolveEnablementFromScopes(
      [
        { scope: 'projectLocal', enabledPlugins: { 'other@m': true } },
        { scope: 'user', enabledPlugins: { 'p@m': true } },
      ],
      'p@m',
    );
    expect(r.state).toBe('enabled');
    expect(r.decidedBy).toBe('user');
  });
});

describe('applyEnabledPluginEdit (pure, inverse single-key)', () => {
  it('sets a single key without disturbing other keys or other settings', () => {
    const next = applyEnabledPluginEdit(
      { enabledPlugins: { 'a@m': true }, permissions: { deny: ['Skill(x:y)'] } },
      'b@m',
      false,
    );
    expect(next.enabledPlugins).toEqual({ 'a@m': true, 'b@m': false });
    expect(next.permissions).toEqual({ deny: ['Skill(x:y)'] });
  });

  it('deletes the single key when value is undefined (restores default)', () => {
    const next = applyEnabledPluginEdit({ enabledPlugins: { 'a@m': true, 'b@m': false } }, 'b@m', undefined);
    expect(next.enabledPlugins).toEqual({ 'a@m': true });
  });

  it('removes the empty enabledPlugins object when the last key is deleted', () => {
    const next = applyEnabledPluginEdit({ enabledPlugins: { 'a@m': true } }, 'a@m', undefined);
    expect(next.enabledPlugins).toBeUndefined();
  });

  it('does not mutate its input', () => {
    const input = { enabledPlugins: { 'a@m': true } };
    applyEnabledPluginEdit(input, 'a@m', false);
    expect(input.enabledPlugins).toEqual({ 'a@m': true });
  });
});

describe('ClaudeSettingsStore (fs-backed)', () => {
  let dir: string;
  let home: string;
  let cwd: string;
  let scopeFiles: ScopeFile[];

  const userSettings = () => join(home, '.claude', 'settings.json');

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kookr-settings-'));
    home = join(dir, 'home');
    cwd = join(dir, 'proj');
    await mkdir(join(home, '.claude'), { recursive: true });
    await mkdir(join(cwd, '.claude'), { recursive: true });
    scopeFiles = defaultScopeFiles(cwd, home);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves across real files and tolerates a malformed scope', async () => {
    await writeFile(userSettings(), JSON.stringify({ enabledPlugins: { 'kookr-toolkit@kookr': true } }));
    await writeFile(join(cwd, '.claude', 'settings.json'), '{ this is not json');
    const store = new ClaudeSettingsStore(scopeFiles);
    // Malformed project scope is skipped; user scope still resolves.
    expect((await store.resolveEnablement('kookr-toolkit@kookr')).state).toBe('enabled');
    // Unmentioned plugin → default.
    expect((await store.resolveEnablement('stripe@anthropic-plugin-directory')).state).toBe('default');
  });

  it('reads deny union and autoUpdate default-absence', async () => {
    await writeFile(
      userSettings(),
      JSON.stringify({ permissions: { deny: ['Skill(a:b)', 42] }, extraKnownMarketplaces: { kookr: {} } }),
    );
    const store = new ClaudeSettingsStore(scopeFiles);
    expect(await store.readDenies()).toEqual(['Skill(a:b)']);
    // Field absent → undefined (caller applies documented default).
    expect(await store.readAutoUpdate('kookr')).toBeUndefined();
  });

  it('writeEnablement backs up, merges one key, and preserves unrelated keys', async () => {
    await writeFile(
      userSettings(),
      JSON.stringify({ enabledPlugins: { 'a@m': true }, model: 'sonnet' }, null, 2),
    );
    const store = new ClaudeSettingsStore(scopeFiles);
    const result = await store.writeEnablement('b@m', false, {
      scope: 'user',
      withLock: (fn) => fn(),
    });
    expect(result.previousValue).toBeUndefined();
    expect(result.backupPath).not.toBeNull();
    await access(result.backupPath as string); // backup exists

    const written = JSON.parse(await readFile(userSettings(), 'utf8'));
    expect(written.enabledPlugins).toEqual({ 'a@m': true, 'b@m': false });
    expect(written.model).toBe('sonnet'); // unrelated key untouched (no whole-file rewrite)
  });

  it('writeEnablement reports the previous value for inverse undo', async () => {
    await writeFile(userSettings(), JSON.stringify({ enabledPlugins: { 'a@m': true } }));
    const store = new ClaudeSettingsStore(scopeFiles);
    const result = await store.writeEnablement('a@m', false, { scope: 'user', withLock: (fn) => fn() });
    expect(result.previousValue).toBe(true);
  });

  it('throws ConcurrentSettingsWriteError when the file changes under the lock', async () => {
    await writeFile(userSettings(), JSON.stringify({ enabledPlugins: { 'a@m': true } }));
    const store = new ClaudeSettingsStore(scopeFiles);
    await expect(
      store.writeEnablement('b@m', false, {
        scope: 'user',
        // Simulate a concurrent terminal /plugin edit landing between the
        // store's read and its pre-write guard re-read.
        withLock: async (fn) => {
          await writeFile(userSettings(), JSON.stringify({ enabledPlugins: { 'a@m': false } }));
          return fn();
        },
      }),
    ).rejects.toBeInstanceOf(ConcurrentSettingsWriteError);
  });
});
