import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdtemp, rm, mkdir, writeFile, chmod, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerPluginRoutes } from './plugin-routes.js';
import type { DeployRouteDeps } from './shared.js';
import { PluginMutationService } from '../plugin-manager/mutation-service.js';
import type { ManagedPlugin, PluginsReadModel } from '../../shared/contracts/plugins.js';

const TOOLKIT = 'kookr-toolkit@kookr';

/**
 * A fake `claude` binary that reads its canned list output and failure flag
 * from the test HOME, mirroring deploy-routes.test.ts's real-subprocess style.
 * The `update` subcommand mutates the plugins dir BEFORE checking the failure
 * flag, so the backup/restore path is exercised.
 */
async function writeFakeClaude(dir: string): Promise<string> {
  const bin = join(dir, 'fake-claude.sh');
  await writeFile(
    bin,
    `#!/usr/bin/env bash
sub="$2"
case "$sub" in
  list) cat "$HOME/.kookr-fake/list.json" 2>/dev/null || echo "[]";;
  details) echo "Always-on:   ~100 tok";;
  update)
    mkdir -p "$HOME/.claude/plugins"
    echo partial > "$HOME/.claude/plugins/partial-marker"
    if [ -f "$HOME/.kookr-fake/update-fail" ]; then echo "simulated update failure" >&2; exit 1; fi
    echo updated > "$HOME/.claude/plugins/updated-marker"
    exit 0;;
esac
exit 0
`,
    'utf8',
  );
  await chmod(bin, 0o755);
  return bin;
}

interface Env {
  root: string;
  home: string;
  serverCwd: string;
  bin: string;
  mutation: PluginMutationService;
  cleanup: () => Promise<void>;
}

async function setup(listRecords: unknown[]): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), 'plugin-routes-'));
  const home = join(root, 'home');
  const serverCwd = join(root, 'server');
  await mkdir(join(home, '.claude', 'plugins'), { recursive: true });
  await mkdir(join(home, '.kookr-fake'), { recursive: true });
  await mkdir(serverCwd, { recursive: true });
  await writeFile(join(home, '.kookr-fake', 'list.json'), JSON.stringify(listRecords));
  // A real installed_plugins.json so the registry fallback also has data.
  await writeFile(
    join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: Object.fromEntries(
        (listRecords as Array<{ id: string; version: string }>).map((r) => [
          r.id,
          [{ scope: 'user', version: r.version }],
        ]),
      ),
    }),
  );
  const bin = await writeFakeClaude(root);
  const mutation = new PluginMutationService();
  return { root, home, serverCwd, bin, mutation, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function makeApp(env: Env): Hono {
  const app = new Hono();
  registerPluginRoutes(app, {
    serverCwd: env.serverCwd,
    serverPort: 4800,
    hookHomeDir: env.home,
    pluginUpdateBin: env.bin,
    pluginMutationService: env.mutation,
  } satisfies DeployRouteDeps);
  return app;
}

describe('GET /api/plugins', () => {
  let env: Env;
  afterEach(async () => env?.cleanup());

  it('returns every installed plugin with tri-state enablement and staleness provenance', async () => {
    env = await setup([
      { id: TOOLKIT, version: '0.16.81', scope: 'user', enabled: true },
      { id: 'stripe@anthropic-plugin-directory', version: '0.11.40', scope: 'user', enabled: true },
      { id: 'claude-notifications-go@claude-notifications-go', version: '1.14.0', scope: 'user', enabled: false },
    ]);
    // toolkit explicitly enabled, stripe explicitly disabled, notifications absent → default.
    await writeFile(
      join(env.home, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { [TOOLKIT]: true, 'stripe@anthropic-plugin-directory': false } }),
    );
    const res = await makeApp(env).request('/api/plugins');
    expect(res.status).toBe(200);
    const body = (await res.json()) as PluginsReadModel;
    const byId = Object.fromEntries(body.plugins.map((p) => [p.id, p]));
    expect(byId[TOOLKIT].enablement).toBe('enabled');
    expect(byId['stripe@anthropic-plugin-directory'].enablement).toBe('disabled');
    expect(byId['claude-notifications-go@claude-notifications-go'].enablement).toBe('default');
    // Non-toolkit staleness is catalog-sourced and unknown in P1 (provenance shown).
    expect(byId['stripe@anthropic-plugin-directory'].staleness.source).toBe('catalog');
    expect(byId['stripe@anthropic-plugin-directory'].staleness.state).toBe('unknown');
    // Token cost comes through from `details`.
    expect(byId[TOOLKIT].alwaysOnTokens).toBe(100);
    expect(byId[TOOLKIT].uninstallGuard).toBe(true);
  });
});

describe('POST /api/plugins/:id/update', () => {
  let env: Env;
  afterEach(async () => env?.cleanup());

  it('updates a plugin and returns the refreshed row', async () => {
    env = await setup([{ id: 'stripe@anthropic-plugin-directory', version: '0.11.40', scope: 'user', enabled: true }]);
    const res = await makeApp(env).request('/api/plugins/stripe@anthropic-plugin-directory/update', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; plugin: ManagedPlugin };
    expect(body.status).toBe('updated');
    expect(body.plugin.id).toBe('stripe@anthropic-plugin-directory');
    // The successful update left its marker and the backup was discarded.
    await access(join(env.home, '.claude', 'plugins', 'updated-marker'));
  });

  it('rejects an invalid plugin id with 400', async () => {
    env = await setup([]);
    const res = await makeApp(env).request('/api/plugins/not-an-id/update', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('returns 409 naming the lock holder when a mutation is already in flight', async () => {
    env = await setup([{ id: TOOLKIT, version: '0.16.81' }]);
    const app = makeApp(env);
    // Hold the shared lock as if another mutation were running.
    let release: (() => void) | undefined;
    const held = new Promise<void>((r) => (release = r));
    const holding = env.mutation.withLock('plugin-install', () => held);
    const res = await app.request(`/api/plugins/${TOOLKIT}/update`, { method: 'POST' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; lockHolder?: { operation: string } };
    expect(body.lockHolder?.operation).toBe('plugin-install');
    release?.();
    await holding;
  });

  it('restores the plugins dir from backup when the update fails (R8)', async () => {
    env = await setup([{ id: 'stripe@anthropic-plugin-directory', version: '0.11.40' }]);
    await writeFile(join(env.home, '.kookr-fake', 'update-fail'), '1');
    const res = await makeApp(env).request('/api/plugins/stripe@anthropic-plugin-directory/update', {
      method: 'POST',
    });
    expect(res.status).toBe(500);
    // The fake mutated the dir (partial-marker) then failed; restore removed it.
    await expect(access(join(env.home, '.claude', 'plugins', 'partial-marker'))).rejects.toBeTruthy();
    // The original registry file survives the restore.
    await access(join(env.home, '.claude', 'plugins', 'installed_plugins.json'));
  });
});
