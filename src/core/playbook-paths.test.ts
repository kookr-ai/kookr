import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  playbookScopeDir,
  resolvePlaybookInScope,
  isPathInside,
} from './playbook-paths.js';
import type { PlaybookScope } from './playbook.js';

describe('playbook-paths', () => {
  let root: string;
  let projectCwd: string;
  let userDir: string;
  let pluginRoot: string;
  let pluginPlaybooksDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'playbook-paths-'));
    projectCwd = join(root, 'project');
    userDir = join(root, 'user-playbooks');
    pluginRoot = join(root, 'plugin');
    pluginPlaybooksDir = join(pluginRoot, 'playbooks');

    await mkdir(join(projectCwd, '.kookr', 'playbooks'), { recursive: true });
    await mkdir(userDir, { recursive: true });
    await mkdir(pluginPlaybooksDir, { recursive: true });
    // Make the plugin tree look like a real plugin so pluginPlaybooksDir() resolves it.
    await mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true });
    await writeFile(join(pluginRoot, '.claude-plugin', 'plugin.json'), '{"name":"kookr-toolkit"}');

    await writeFile(join(projectCwd, '.kookr', 'playbooks', 'proj.md'), '# project');
    await writeFile(join(userDir, 'usr.md'), '# user');
    await writeFile(join(pluginPlaybooksDir, 'plug.md'), '# plugin');

    process.env.KOOKR_USER_PLAYBOOKS_DIR = userDir;
    process.env.KOOKR_PLUGIN_DIR = pluginRoot;
  });

  afterEach(async () => {
    delete process.env.KOOKR_USER_PLAYBOOKS_DIR;
    delete process.env.KOOKR_PLUGIN_DIR;
    await rm(root, { recursive: true, force: true });
  });

  describe('playbookScopeDir', () => {
    it('maps project scope to <cwd>/.kookr/playbooks', () => {
      expect(playbookScopeDir('project', projectCwd)).toBe(join(projectCwd, '.kookr', 'playbooks'));
    });

    it('maps user scope to the user playbooks dir', () => {
      expect(playbookScopeDir('user', projectCwd)).toBe(userDir);
    });

    it('maps plugin scope to the plugin playbooks dir', () => {
      expect(playbookScopeDir('plugin', projectCwd)).toBe(pluginPlaybooksDir);
    });

    it('returns undefined when no plugin tree exists', () => {
      delete process.env.KOOKR_PLUGIN_DIR;
      process.env.KOOKR_PLUGIN_DIR = join(root, 'does-not-exist');
      expect(playbookScopeDir('plugin', projectCwd)).toBeUndefined();
    });

    it('returns undefined for an unrecognised scope value', () => {
      expect(playbookScopeDir('made-up' as PlaybookScope, projectCwd)).toBeUndefined();
    });
  });

  describe('resolvePlaybookInScope', () => {
    it('resolves a file present in the project tier', () => {
      expect(resolvePlaybookInScope('proj.md', 'project', projectCwd)).toEqual({
        filePath: join(projectCwd, '.kookr', 'playbooks', 'proj.md'),
      });
    });

    it('resolves a file present in the user tier', () => {
      expect(resolvePlaybookInScope('usr.md', 'user', projectCwd)).toEqual({
        filePath: join(userDir, 'usr.md'),
      });
    });

    it('resolves a file present in the plugin tier', () => {
      expect(resolvePlaybookInScope('plug.md', 'plugin', projectCwd)).toEqual({
        filePath: join(pluginPlaybooksDir, 'plug.md'),
      });
    });

    it('does NOT fall back to another tier (single-scope only)', () => {
      // proj.md exists only in the project tier; asking the plugin tier misses.
      expect(resolvePlaybookInScope('proj.md', 'plugin', projectCwd)).toBeUndefined();
      // plug.md exists only in the plugin tier; asking the project tier misses.
      expect(resolvePlaybookInScope('plug.md', 'project', projectCwd)).toBeUndefined();
    });

    it('returns undefined when the file is absent in the pinned tier', () => {
      expect(resolvePlaybookInScope('missing.md', 'project', projectCwd)).toBeUndefined();
    });

    it('returns undefined when the plugin tier has no directory', () => {
      process.env.KOOKR_PLUGIN_DIR = join(root, 'does-not-exist');
      expect(resolvePlaybookInScope('plug.md', 'plugin', projectCwd)).toBeUndefined();
    });

    it('rejects a path that escapes the pinned tier directory (traversal)', () => {
      expect(resolvePlaybookInScope('../../escape.md', 'project', projectCwd)).toBeUndefined();
    });
  });

  describe('isPathInside', () => {
    it('accepts a descendant path', () => {
      expect(isPathInside(join(projectCwd, 'a', 'b.md'), projectCwd)).toBe(true);
    });

    it('accepts the directory itself', () => {
      expect(isPathInside(projectCwd, projectCwd)).toBe(true);
    });

    it('rejects a sibling escape', () => {
      expect(isPathInside(join(root, 'other.md'), projectCwd)).toBe(false);
    });
  });
});
