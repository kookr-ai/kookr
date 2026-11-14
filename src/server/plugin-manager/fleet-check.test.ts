import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildFleetCheckArgs,
  evaluateFleetCheck,
  findInitMessage,
  FleetCheckService,
  type ClaudeInitMessage,
  type InitProbe,
} from './fleet-check.js';
import { LoadoutStore } from './loadout-store.js';
import type { InstalledPluginRecord } from './registry.js';

// Shapes captured from Claude Code 2.1.325 print-mode `system/init` messages
// (home paths replaced). The first enabled an installed plugin whose
// marketplace has since renamed it: it did not load, and the error names the
// NEW id, not the requested one.
const INIT_RENAMED: ClaudeInitMessage = {
  plugins: [
    { name: 'kookr-toolkit', path: '/srv/kookr/plugin', source: 'kookr-toolkit@inline', version: '0.16.106' },
    { name: 'cc-plugin-telemetry', path: 'builtin', source: 'cc-plugin-telemetry@builtin' },
  ],
  plugin_errors: [
    {
      plugin: 'ralph-loop@claude-code-plugins',
      type: 'plugin-not-installed',
      message: 'Plugin "ralph-loop" is enabled in project settings but isn\'t installed',
    },
  ],
};
const INIT_LOADED: ClaudeInitMessage = {
  plugins: [
    { name: 'kookr-toolkit', path: '/srv/kookr/plugin', source: 'kookr-toolkit@inline', version: '0.16.106' },
    { name: 'rust-analyzer-lsp', path: '/home/u/.claude/plugins/cache/x', source: 'rust-analyzer-lsp@claude-plugins-official', version: '1.0.0' },
    { name: 'cc-plugin-privacy', path: 'builtin', source: 'cc-plugin-privacy@builtin' },
  ],
  plugin_errors: [],
};

describe('findInitMessage', () => {
  test('skips earlier system messages (hook_started) and finds init', () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart' }),
      'not json',
      JSON.stringify({ type: 'system', subtype: 'init', plugins: [] }),
    ];
    expect(findInitMessage(lines)).toEqual({ type: 'system', subtype: 'init', plugins: [] });
  });
  test('null when there is no init line', () => {
    expect(findInitMessage([JSON.stringify({ type: 'assistant' })])).toBeNull();
  });
});

describe('evaluateFleetCheck', () => {
  test('a requested installed plugin that loaded → loaded with its version; toolkit and builtins not unexpected', () => {
    const r = evaluateFleetCheck(['rust-analyzer-lsp@claude-plugins-official'], INIT_LOADED, ['kookr-toolkit']);
    expect(r.plugins).toEqual([{ id: 'rust-analyzer-lsp@claude-plugins-official', state: 'loaded', version: '1.0.0' }]);
    expect(r.unexpected).toEqual([]);
    expect(r.otherErrors).toEqual([]);
  });

  test('renamed plugin: requested id is missing, and the error under the new id is kept in otherErrors', () => {
    const r = evaluateFleetCheck(['ralph-wiggum@claude-code-plugins'], INIT_RENAMED, ['kookr-toolkit']);
    expect(r.plugins).toEqual([{ id: 'ralph-wiggum@claude-code-plugins', state: 'missing' }]);
    expect(r.otherErrors).toEqual([
      expect.objectContaining({ plugin: 'ralph-loop@claude-code-plugins', type: 'plugin-not-installed' }),
    ]);
  });

  test('an error naming the requested id → errored with its text', () => {
    const r = evaluateFleetCheck(['dep@m'], {
      plugins: [],
      plugin_errors: [{ plugin: 'dep@m', type: 'dependency-unsatisfied', message: 'needs x@m' }],
    }, []);
    expect(r.plugins).toEqual([{ id: 'dep@m', state: 'errored', error: 'needs x@m' }]);
    expect(r.otherErrors).toEqual([]);
  });

  test('a marketplace plugin that loaded without being requested → unexpected', () => {
    const r = evaluateFleetCheck([], INIT_LOADED, ['kookr-toolkit']);
    expect(r.unexpected).toEqual(['rust-analyzer-lsp@claude-plugins-official']);
  });
});

describe('buildFleetCheckArgs', () => {
  test('print-mode stream-json, adapter flags, then the enabledPlugins settings', () => {
    expect(buildFleetCheckArgs(['--dangerously-skip-permissions', '--setting-sources', '', '--plugin-dir', '/p'], { 'a@m': true }))
      .toEqual([
        '-p', 'say OK', '--output-format', 'stream-json', '--verbose',
        '--dangerously-skip-permissions', '--setting-sources', '', '--plugin-dir', '/p',
        '--settings', '{"enabledPlugins":{"a@m":true}}',
      ]);
  });
  test('no settings flag when nothing is enabled', () => {
    expect(buildFleetCheckArgs([], undefined)).not.toContain('--settings');
  });
});

describe('FleetCheckService', () => {
  let dir: string;
  let store: LoadoutStore;
  let installed: Map<string, InstalledPluginRecord[]>;
  let probeCalls: Array<{ bin: string; args: string[] }>;
  let probeResult: Awaited<ReturnType<InitProbe>>;

  const service = (): FleetCheckService =>
    new FleetCheckService({
      loadoutStore: store,
      installedPlugins: { read: async () => installed },
      probeCommand: async () => ({ bin: 'claude', args: ['--plugin-dir', '/p'], dirLoadedPluginNames: ['kookr-toolkit'] }),
      probe: async (bin, args) => {
        probeCalls.push({ bin, args });
        return probeResult;
      },
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kookr-fleet-check-'));
    store = new LoadoutStore(dir);
    installed = new Map([
      ['rust-analyzer-lsp@claude-plugins-official', [{ scope: 'user', version: '1.0.0', installPath: '/c', gitCommitSha: null }]],
    ]);
    probeCalls = [];
    probeResult = { init: INIT_LOADED };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  test('probes with only the installed fleet plugins enabled and reports loaded + skipped', async () => {
    await store.writeFleet({ 'rust-analyzer-lsp@claude-plugins-official': true, 'gone@m': true });
    const r = await service().run('manual');
    expect(probeCalls).toHaveLength(1);
    const settings = probeCalls[0].args[probeCalls[0].args.indexOf('--settings') + 1];
    expect(JSON.parse(settings)).toEqual({ enabledPlugins: { 'rust-analyzer-lsp@claude-plugins-official': true } });
    expect(r).toMatchObject({
      ok: true,
      trigger: 'manual',
      plugins: [{ id: 'rust-analyzer-lsp@claude-plugins-official', state: 'loaded', version: '1.0.0' }],
      skipped: [{ id: 'gone@m', reason: 'not_installed' }],
    });
  });

  test('probe failure → ok false with the error, kept as the last result', async () => {
    probeResult = { init: null, error: 'no init message within 30000 ms' };
    const svc = service();
    const r = await svc.run('manual');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('no init');
    expect(svc.lastResult).toBe(r);
  });

  test('concurrent runs share one probe', async () => {
    const svc = service();
    const [a, b] = await Promise.all([svc.run('manual'), svc.run('fleet-change')]);
    expect(a).toBe(b);
    expect(probeCalls).toHaveLength(1);
    expect(svc.running).toBe(false);
  });

  test('no Claude adapter → ok false, no probe', async () => {
    const svc = new FleetCheckService({
      loadoutStore: store,
      installedPlugins: { read: async () => installed },
      probeCommand: async () => null,
      probe: async () => { throw new Error('should not run'); },
    });
    expect((await svc.run('manual')).ok).toBe(false);
  });
});
