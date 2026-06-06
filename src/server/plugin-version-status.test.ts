import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getPluginVersionStatus, compareVersions } from './plugin-version-status.js';

const PLUGIN_ID = 'kookr-toolkit@kookr';

async function writeRegistry(homeDir: string, content: unknown): Promise<void> {
  const dir = join(homeDir, '.claude', 'plugins');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'installed_plugins.json'), JSON.stringify(content));
}

function registryWith(version: string, pluginId = PLUGIN_ID) {
  return { version: 2, plugins: { [pluginId]: [{ scope: 'user', version }] } };
}

describe('compareVersions', () => {
  it('orders by numeric segment, not lexicographically', () => {
    expect(compareVersions('0.4.1', '0.7.4')).toBeLessThan(0);
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0); // 10 > 9, not "10" < "9"
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('treats missing trailing segments as zero', () => {
    expect(compareVersions('0.7', '0.7.0')).toBe(0);
    expect(compareVersions('0.7', '0.7.1')).toBeLessThan(0);
  });
});

describe('getPluginVersionStatus', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'plugin-version-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('is stale when the installed version is behind the available version', async () => {
    await writeRegistry(home, registryWith('0.4.1'));
    const status = await getPluginVersionStatus({ homeDir: home, pluginId: PLUGIN_ID, availableVersion: '0.7.4' });
    expect(status).toEqual({
      pluginId: PLUGIN_ID,
      installedVersion: '0.4.1',
      availableVersion: '0.7.4',
      stale: true,
    });
  });

  it('is not stale when installed equals available', async () => {
    await writeRegistry(home, registryWith('0.7.4'));
    const status = await getPluginVersionStatus({ homeDir: home, pluginId: PLUGIN_ID, availableVersion: '0.7.4' });
    expect(status.stale).toBe(false);
  });

  it('is not stale when the local install is ahead of available (no false alarm)', async () => {
    await writeRegistry(home, registryWith('0.8.0'));
    const status = await getPluginVersionStatus({ homeDir: home, pluginId: PLUGIN_ID, availableVersion: '0.7.4' });
    expect(status.stale).toBe(false);
  });

  it('reports installedVersion null and not stale when the plugin is not installed via the marketplace', async () => {
    await writeRegistry(home, registryWith('0.4.1', 'some-other-plugin@elsewhere'));
    const status = await getPluginVersionStatus({ homeDir: home, pluginId: PLUGIN_ID, availableVersion: '0.7.4' });
    expect(status.installedVersion).toBeNull();
    expect(status.stale).toBe(false);
  });

  it('reports installedVersion null when there is no registry file at all', async () => {
    const status = await getPluginVersionStatus({ homeDir: home, pluginId: PLUGIN_ID, availableVersion: '0.7.4' });
    expect(status.installedVersion).toBeNull();
    expect(status.stale).toBe(false);
  });

  it('is not stale when the available version is unknown', async () => {
    await writeRegistry(home, registryWith('0.4.1'));
    const status = await getPluginVersionStatus({ homeDir: home, pluginId: PLUGIN_ID, availableVersion: null });
    expect(status.installedVersion).toBe('0.4.1');
    expect(status.availableVersion).toBeNull();
    expect(status.stale).toBe(false);
  });

  it('uses the highest version across multiple install records (scopes)', async () => {
    await writeRegistry(home, {
      version: 2,
      plugins: { [PLUGIN_ID]: [{ scope: 'project', version: '0.4.1' }, { scope: 'user', version: '0.7.4' }] },
    });
    const status = await getPluginVersionStatus({ homeDir: home, pluginId: PLUGIN_ID, availableVersion: '0.7.4' });
    expect(status.installedVersion).toBe('0.7.4');
    expect(status.stale).toBe(false);
  });

  it('returns installedVersion null on malformed registry JSON rather than throwing', async () => {
    const dir = join(home, '.claude', 'plugins');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'installed_plugins.json'), '{ not valid json');
    const status = await getPluginVersionStatus({ homeDir: home, pluginId: PLUGIN_ID, availableVersion: '0.7.4' });
    expect(status.installedVersion).toBeNull();
    expect(status.stale).toBe(false);
  });
});
