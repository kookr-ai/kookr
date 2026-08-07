import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pluginDirIsValid, resolvePluginDir } from './plugin-paths.js';

/**
 * Create a plugin tree at `<dir>/.claude-plugin/plugin.json` so
 * `pluginDirIsValid(dir)` returns true. Returns `dir` for chaining.
 */
function writePluginManifest(dir: string): string {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), '{"name":"kookr-toolkit"}');
  return dir;
}

function withTempRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'kookr-plugin-paths-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('resolvePluginDir', () => {
  it('returns an explicit valid path that contains a plugin manifest', () => {
    withTempRoot((root) => {
      const pluginDir = writePluginManifest(join(root, 'plugin'));
      expect(resolvePluginDir(pluginDir, {}, root)).toBe(pluginDir);
    });
  });

  it('returns undefined for an explicit path without a manifest', () => {
    withTempRoot((root) => {
      const pluginDir = join(root, 'plugin');
      mkdirSync(pluginDir, { recursive: true }); // exists, but no .claude-plugin/plugin.json
      expect(resolvePluginDir(pluginDir, {}, root)).toBeUndefined();
    });
  });

  it('treats an explicit empty string as an explicit disable (undefined)', () => {
    withTempRoot((root) => {
      // Even with a valid auto-discoverable tree present, "" short-circuits
      // to disabled and never falls through to env or auto-discovery.
      writePluginManifest(join(root, 'plugin'));
      const baseDir = join(root, 'a', 'b');
      mkdirSync(baseDir, { recursive: true });
      expect(resolvePluginDir('', { KOOKR_PLUGIN_DIR: root }, baseDir)).toBeUndefined();
    });
  });

  it('honors KOOKR_PLUGIN_DIR when explicit is undefined', () => {
    withTempRoot((root) => {
      const envDir = writePluginManifest(join(root, 'from-env'));
      expect(resolvePluginDir(undefined, { KOOKR_PLUGIN_DIR: envDir }, root)).toBe(envDir);
    });
  });

  it('returns undefined when KOOKR_PLUGIN_DIR points at a path without a manifest', () => {
    withTempRoot((root) => {
      const envDir = join(root, 'from-env');
      mkdirSync(envDir, { recursive: true });
      expect(resolvePluginDir(undefined, { KOOKR_PLUGIN_DIR: envDir }, root)).toBeUndefined();
    });
  });

  it('treats an empty KOOKR_PLUGIN_DIR as an explicit disable, skipping auto-discovery', () => {
    withTempRoot((root) => {
      // A valid auto-discoverable tree exists, but an empty env var disables.
      writePluginManifest(join(root, 'plugin'));
      const baseDir = join(root, 'a', 'b');
      mkdirSync(baseDir, { recursive: true });
      expect(resolvePluginDir(undefined, { KOOKR_PLUGIN_DIR: '' }, baseDir)).toBeUndefined();
    });
  });

  it('skips the repo fallback when autoDiscover is false', () => {
    withTempRoot((root) => {
      // <root>/plugin holds a valid manifest and would be auto-discovered from
      // baseDir <root>/a/b, but autoDiscover:false opts out.
      writePluginManifest(join(root, 'plugin'));
      const baseDir = join(root, 'a', 'b');
      mkdirSync(baseDir, { recursive: true });
      expect(
        resolvePluginDir(undefined, {}, baseDir, { autoDiscover: false }),
      ).toBeUndefined();
    });
  });

  it('auto-discovers <repo-root>/plugin two levels up from baseDir', () => {
    withTempRoot((root) => {
      const pluginDir = writePluginManifest(join(root, 'plugin'));
      // Mirror dist/core or src/core: two levels below the repo root.
      const baseDir = join(root, 'a', 'b');
      mkdirSync(baseDir, { recursive: true });
      expect(resolvePluginDir(undefined, {}, baseDir)).toBe(pluginDir);
    });
  });

  it('returns undefined when auto-discovery finds no manifest', () => {
    withTempRoot((root) => {
      const baseDir = join(root, 'a', 'b');
      mkdirSync(baseDir, { recursive: true });
      expect(resolvePluginDir(undefined, {}, baseDir)).toBeUndefined();
    });
  });

  it('prefers the explicit path over KOOKR_PLUGIN_DIR', () => {
    withTempRoot((root) => {
      const explicitDir = writePluginManifest(join(root, 'explicit'));
      const envDir = writePluginManifest(join(root, 'from-env'));
      expect(resolvePluginDir(explicitDir, { KOOKR_PLUGIN_DIR: envDir }, root)).toBe(
        explicitDir,
      );
    });
  });
});

describe('pluginDirIsValid', () => {
  it('is true when the directory contains .claude-plugin/plugin.json', () => {
    withTempRoot((root) => {
      const pluginDir = writePluginManifest(join(root, 'plugin'));
      expect(pluginDirIsValid(pluginDir)).toBe(true);
    });
  });

  it('is false when the manifest is missing', () => {
    withTempRoot((root) => {
      const pluginDir = join(root, 'plugin');
      mkdirSync(pluginDir, { recursive: true });
      expect(pluginDirIsValid(pluginDir)).toBe(false);
    });
  });

  it('is false for a nonexistent path', () => {
    withTempRoot((root) => {
      expect(pluginDirIsValid(join(root, 'does-not-exist'))).toBe(false);
    });
  });
});
