import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudePluginCli, type PluginCliRunner } from './cli.js';
import { ClaudeSettingsStore, defaultScopeFiles } from '../../core/claude-settings/settings-store.js';
import { assembleManagedPlugins } from './read-model.js';

const TOOLKIT = 'kookr-toolkit@kookr';

/** A fake `claude plugin` runner driven by canned stdout per subcommand. */
function fakeRunner(opts: {
  list?: string;
  listThrows?: boolean;
  details?: Record<string, string>;
}): PluginCliRunner {
  return {
    async run(args: string[]) {
      if (args[1] === 'list') {
        if (opts.listThrows) throw new Error('claude not found');
        return { stdout: opts.list ?? '[]', stderr: '' };
      }
      if (args[1] === 'details') {
        const id = args[2];
        return { stdout: opts.details?.[id] ?? '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
  };
}

const NOW = () => new Date('2026-11-07T12:00:00.000Z');

describe('assembleManagedPlugins', () => {
  let dir: string;
  let home: string;
  let cwd: string;
  let settings: ClaudeSettingsStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kookr-readmodel-'));
    home = join(dir, 'home');
    cwd = join(dir, 'proj');
    await mkdir(join(home, '.claude'), { recursive: true });
    await mkdir(join(cwd, '.claude'), { recursive: true });
    settings = new ClaudeSettingsStore(defaultScopeFiles(cwd, home));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const listJson = JSON.stringify([
    { id: TOOLKIT, version: '0.16.81', scope: 'user', enabled: true },
    { id: 'stripe@anthropic-plugin-directory', version: '0.11.40', scope: 'user', enabled: true },
    { id: 'claude-notifications-go@claude-notifications-go', version: '1.14.0', scope: 'user', enabled: false },
  ]);

  it('resolves tri-state enablement (absent ≠ false) via the settings store, not the CLI boolean', async () => {
    // Settings: toolkit explicitly true, stripe explicitly false, notifications ABSENT.
    await writeFile(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { [TOOLKIT]: true, 'stripe@anthropic-plugin-directory': false } }),
    );
    const cli = new ClaudePluginCli(fakeRunner({ list: listJson }));
    const rows = await assembleManagedPlugins({
      cli,
      settings,
      homeDir: home,
      toolkitAvailable: { pluginId: TOOLKIT, availableVersion: '0.16.90' },
      now: NOW,
    });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[TOOLKIT].enablement).toBe('enabled');
    expect(byId['stripe@anthropic-plugin-directory'].enablement).toBe('disabled');
    // Absent from enabledPlugins → default, even though `claude plugin list` said enabled:false.
    expect(byId['claude-notifications-go@claude-notifications-go'].enablement).toBe('default');
  });

  it('shows ALL installed plugins, including one whose marketplace is unregistered', async () => {
    const cli = new ClaudePluginCli(fakeRunner({ list: listJson }));
    const rows = await assembleManagedPlugins({
      cli,
      settings,
      homeDir: home,
      toolkitAvailable: { pluginId: TOOLKIT, availableVersion: '0.16.81' },
      now: NOW,
    });
    expect(rows.map((r) => r.id)).toContain('stripe@anthropic-plugin-directory');
    expect(rows).toHaveLength(3);
  });

  it('computes git staleness for the toolkit and catalog-unknown for the rest', async () => {
    const cli = new ClaudePluginCli(fakeRunner({ list: listJson }));
    const rows = await assembleManagedPlugins({
      cli,
      settings,
      homeDir: home,
      toolkitAvailable: { pluginId: TOOLKIT, availableVersion: '0.16.90' },
      now: NOW,
    });
    const toolkit = rows.find((r) => r.id === TOOLKIT)!;
    expect(toolkit.staleness).toEqual({
      state: 'behind',
      source: 'git',
      observedAt: '2026-11-07T12:00:00.000Z',
    });
    expect(toolkit.availableVersion).toBe('0.16.90');

    const stripe = rows.find((r) => r.id === 'stripe@anthropic-plugin-directory')!;
    expect(stripe.staleness.state).toBe('unknown');
    expect(stripe.staleness.source).toBe('catalog');
    expect(stripe.staleness.reason).toMatch(/catalog not refreshed/i);
    expect(stripe.availableVersion).toBeNull();
  });

  it('reports the toolkit as current when installed matches available', async () => {
    const cli = new ClaudePluginCli(fakeRunner({ list: listJson }));
    const rows = await assembleManagedPlugins({
      cli,
      settings,
      homeDir: home,
      toolkitAvailable: { pluginId: TOOLKIT, availableVersion: '0.16.81' },
      now: NOW,
    });
    expect(rows.find((r) => r.id === TOOLKIT)!.staleness.state).toBe('current');
  });

  it('sets uninstallGuard only for the toolkit', async () => {
    const cli = new ClaudePluginCli(fakeRunner({ list: listJson }));
    const rows = await assembleManagedPlugins({
      cli,
      settings,
      homeDir: home,
      toolkitAvailable: { pluginId: TOOLKIT, availableVersion: '0.16.81' },
      now: NOW,
    });
    expect(rows.find((r) => r.id === TOOLKIT)!.uninstallGuard).toBe(true);
    expect(rows.find((r) => r.id === 'stripe@anthropic-plugin-directory')!.uninstallGuard).toBe(false);
  });

  it('fetches always-on tokens from details when asked (best-effort)', async () => {
    const cli = new ClaudePluginCli(
      fakeRunner({
        list: listJson,
        details: { [TOOLKIT]: 'kookr-toolkit 0.16.81\n\nProjected token cost\n  Always-on:   ~8,994 tok   added to every session\n' },
      }),
    );
    const rows = await assembleManagedPlugins({
      cli,
      settings,
      homeDir: home,
      toolkitAvailable: { pluginId: TOOLKIT, availableVersion: '0.16.81' },
      fetchTokens: true,
      now: NOW,
    });
    expect(rows.find((r) => r.id === TOOLKIT)!.alwaysOnTokens).toBe(8994);
    // A plugin whose details output lacks the figure → null (no throw).
    expect(rows.find((r) => r.id === 'stripe@anthropic-plugin-directory')!.alwaysOnTokens).toBeNull();
  });

  it('falls back to the on-disk registry when the CLI returns nothing', async () => {
    await mkdir(join(home, '.claude', 'plugins'), { recursive: true });
    await writeFile(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          [TOOLKIT]: [
            { scope: 'project', version: '0.16.50' },
            { scope: 'user', version: '0.16.81' },
          ],
        },
      }),
    );
    const cli = new ClaudePluginCli(fakeRunner({ listThrows: true }));
    const rows = await assembleManagedPlugins({
      cli,
      settings,
      homeDir: home,
      toolkitAvailable: { pluginId: TOOLKIT, availableVersion: '0.16.81' },
      now: NOW,
    });
    expect(rows).toHaveLength(1);
    // Highest version across scopes wins.
    expect(rows[0].installedVersion).toBe('0.16.81');
  });
});
