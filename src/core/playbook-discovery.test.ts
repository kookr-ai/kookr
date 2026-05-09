import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverPlaybooks, userPlaybooksDir, pluginPlaybooksDir } from './playbook-discovery.js';

async function createTempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'kookr-test-'));
}

const VALID_PLAYBOOK = `---
name: Test Playbook
description: A test playbook
---

Do the thing.
`;

const INVALID_PLAYBOOK = `No frontmatter here`;

/**
 * Set up an empty fake plugin tree at `<root>/plugin/` with a valid manifest
 * and a `playbooks/` subdir. Returns the playbooks dir path.
 */
async function makeFakePluginTree(root: string): Promise<string> {
  const pluginRoot = join(root, 'plugin');
  await mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true });
  await writeFile(
    join(pluginRoot, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'fake', version: '0.0.0' }),
  );
  const playbooksDir = join(pluginRoot, 'playbooks');
  await mkdir(playbooksDir, { recursive: true });
  return playbooksDir;
}

describe('discoverPlaybooks', () => {
  // Isolate every tier from real filesystem state.
  let isolatedUserDir: string;
  let isolatedPluginRoot: string;
  let isolatedPluginPlaybooksDir: string;
  let originalUserEnv: string | undefined;
  let originalPluginEnv: string | undefined;
  let originalRepoTagsEnv: string | undefined;

  beforeEach(async () => {
    isolatedUserDir = await mkdtemp(join(tmpdir(), 'kookr-user-'));
    isolatedPluginRoot = await mkdtemp(join(tmpdir(), 'kookr-plugin-'));
    isolatedPluginPlaybooksDir = await makeFakePluginTree(isolatedPluginRoot);

    originalUserEnv = process.env.KOOKR_USER_PLAYBOOKS_DIR;
    originalPluginEnv = process.env.KOOKR_PLUGIN_DIR;
    originalRepoTagsEnv = process.env.KOOKR_REPO_TAGS;
    process.env.KOOKR_USER_PLAYBOOKS_DIR = isolatedUserDir;
    process.env.KOOKR_PLUGIN_DIR = join(isolatedPluginRoot, 'plugin');
    // Default to "no repo tags" so the github auto-detect doesn't leak in
    // from whichever cwd the test runner happens to live in. Individual
    // tests can override.
    process.env.KOOKR_REPO_TAGS = '';
  });

  afterEach(async () => {
    if (originalUserEnv === undefined) delete process.env.KOOKR_USER_PLAYBOOKS_DIR;
    else process.env.KOOKR_USER_PLAYBOOKS_DIR = originalUserEnv;
    if (originalPluginEnv === undefined) delete process.env.KOOKR_PLUGIN_DIR;
    else process.env.KOOKR_PLUGIN_DIR = originalPluginEnv;
    if (originalRepoTagsEnv === undefined) delete process.env.KOOKR_REPO_TAGS;
    else process.env.KOOKR_REPO_TAGS = originalRepoTagsEnv;
    await rm(isolatedUserDir, { recursive: true, force: true });
    await rm(isolatedPluginRoot, { recursive: true, force: true });
  });

  test('returns empty array when no tier has any playbook', async () => {
    const dir = await createTempProject();
    try {
      const result = await discoverPlaybooks(dir);
      expect(result).toEqual([]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('discovers project-local playbooks with scope=project', async () => {
    const dir = await createTempProject();
    const pbDir = join(dir, '.kookr', 'playbooks');
    await mkdir(pbDir, { recursive: true });
    await writeFile(join(pbDir, 'alpha.md'), VALID_PLAYBOOK);
    await writeFile(join(pbDir, 'beta.md'), '---\nname: Beta\n---\nBeta body.');

    try {
      const result = await discoverPlaybooks(dir);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('alpha.md');
      expect(result[0].scope).toBe('project');
      expect(result[0].sourceCwd).toBe(dir);
      expect(result[1].id).toBe('beta.md');
      expect(result[1].scope).toBe('project');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('skips invalid playbook files', async () => {
    const dir = await createTempProject();
    const pbDir = join(dir, '.kookr', 'playbooks');
    await mkdir(pbDir, { recursive: true });
    await writeFile(join(pbDir, 'good.md'), VALID_PLAYBOOK);
    await writeFile(join(pbDir, 'bad.md'), INVALID_PLAYBOOK);

    try {
      const result = await discoverPlaybooks(dir);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Test Playbook');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('ignores non-.md files', async () => {
    const dir = await createTempProject();
    const pbDir = join(dir, '.kookr', 'playbooks');
    await mkdir(pbDir, { recursive: true });
    await writeFile(join(pbDir, 'playbook.md'), VALID_PLAYBOOK);
    await writeFile(join(pbDir, 'readme.txt'), 'not a playbook');

    try {
      const result = await discoverPlaybooks(dir);
      expect(result).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('returns sorted by id across tiers', async () => {
    const dir = await createTempProject();
    const pbDir = join(dir, '.kookr', 'playbooks');
    await mkdir(pbDir, { recursive: true });
    await writeFile(join(pbDir, 'm-project.md'), '---\nname: M\n---\nM');
    await writeFile(join(isolatedUserDir, 'a-user.md'), '---\nname: A\n---\nA');
    await writeFile(join(isolatedPluginPlaybooksDir, 'z-plugin.md'), '---\nname: Z\n---\nZ');

    try {
      const result = await discoverPlaybooks(dir);
      expect(result.map((p) => p.id)).toEqual(['a-user.md', 'm-project.md', 'z-plugin.md']);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('plugin-only playbooks surface in any project cwd', async () => {
    const dir = await createTempProject();
    await writeFile(
      join(isolatedPluginPlaybooksDir, 'oss-bug-fix.md'),
      '---\nname: OSS Bug Fix\n---\nGeneric body.',
    );

    try {
      const result = await discoverPlaybooks(dir);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('oss-bug-fix.md');
      expect(result[0].scope).toBe('plugin');
      expect(result[0].sourceCwd).toBe(isolatedPluginPlaybooksDir);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('user-tier playbooks shadow plugin-tier on id collision', async () => {
    const dir = await createTempProject();
    await writeFile(
      join(isolatedPluginPlaybooksDir, 'shared.md'),
      '---\nname: Plugin Shared\n---\nPlugin version.',
    );
    await writeFile(
      join(isolatedUserDir, 'shared.md'),
      '---\nname: User Shared\n---\nUser version.',
    );

    try {
      const result = await discoverPlaybooks(dir);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('User Shared');
      expect(result[0].scope).toBe('user');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('project shadows user which shadows plugin (3-way precedence)', async () => {
    const dir = await createTempProject();
    const pbDir = join(dir, '.kookr', 'playbooks');
    await mkdir(pbDir, { recursive: true });
    await writeFile(join(pbDir, 'shared.md'), '---\nname: Project\n---\nP');
    await writeFile(join(isolatedUserDir, 'shared.md'), '---\nname: User\n---\nU');
    await writeFile(join(isolatedPluginPlaybooksDir, 'shared.md'), '---\nname: Plugin\n---\nG');
    await writeFile(join(isolatedUserDir, 'user-only.md'), '---\nname: User Only\n---\nU');
    await writeFile(join(isolatedPluginPlaybooksDir, 'plugin-only.md'), '---\nname: Plugin Only\n---\nG');

    try {
      const result = await discoverPlaybooks(dir);
      expect(result.map((p) => `${p.id}:${p.scope}`)).toEqual([
        'plugin-only.md:plugin',
        'shared.md:project',
        'user-only.md:user',
      ]);
      const shared = result.find((p) => p.id === 'shared.md')!;
      expect(shared.name).toBe('Project');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('missing user dir is treated as empty (does not throw)', async () => {
    process.env.KOOKR_USER_PLAYBOOKS_DIR = join(isolatedUserDir, 'does-not-exist');

    const dir = await createTempProject();
    const pbDir = join(dir, '.kookr', 'playbooks');
    await mkdir(pbDir, { recursive: true });
    await writeFile(join(pbDir, 'only.md'), VALID_PLAYBOOK);

    try {
      const result = await discoverPlaybooks(dir);
      expect(result).toHaveLength(1);
      expect(result[0].scope).toBe('project');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('plugin playbook with repo-tags is hidden when project has no matching tag', async () => {
    await writeFile(
      join(isolatedPluginPlaybooksDir, 'oss-only.md'),
      '---\nname: OSS Only\nrepo-tags: [github]\n---\nbody.',
    );
    await writeFile(
      join(isolatedPluginPlaybooksDir, 'always-on.md'),
      '---\nname: Always On\n---\nbody.',
    );

    const dir = await createTempProject();
    try {
      // KOOKR_REPO_TAGS='' is set by beforeEach → no tags detected.
      const result = await discoverPlaybooks(dir);
      expect(result.map((p) => p.id)).toEqual(['always-on.md']);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('plugin playbook with repo-tags is shown when project has a matching tag', async () => {
    process.env.KOOKR_REPO_TAGS = 'github';
    await writeFile(
      join(isolatedPluginPlaybooksDir, 'oss-only.md'),
      '---\nname: OSS Only\nrepo-tags: [github]\n---\nbody.',
    );

    const dir = await createTempProject();
    try {
      const result = await discoverPlaybooks(dir);
      expect(result.map((p) => p.id)).toEqual(['oss-only.md']);
      expect(result[0].repoTags).toEqual(['github']);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('repo-tags filter does NOT apply to project or user tier', async () => {
    process.env.KOOKR_REPO_TAGS = 'rust'; // no `github` tag
    await writeFile(
      join(isolatedUserDir, 'user-tagged.md'),
      '---\nname: User Tagged\nrepo-tags: [github]\n---\nbody.',
    );
    const dir = await createTempProject();
    const pbDir = join(dir, '.kookr', 'playbooks');
    await mkdir(pbDir, { recursive: true });
    await writeFile(
      join(pbDir, 'project-tagged.md'),
      '---\nname: Project Tagged\nrepo-tags: [github]\n---\nbody.',
    );

    try {
      const result = await discoverPlaybooks(dir);
      // Both surface despite `repo-tags: [github]` because the filter only
      // applies to plugin tier — project and user files were placed deliberately.
      expect(result.map((p) => p.id).sort()).toEqual(['project-tagged.md', 'user-tagged.md']);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('missing plugin dir is treated as empty', async () => {
    // Point at a directory that has no plugin manifest
    process.env.KOOKR_PLUGIN_DIR = isolatedUserDir; // no plugin.json there

    const dir = await createTempProject();
    const pbDir = join(dir, '.kookr', 'playbooks');
    await mkdir(pbDir, { recursive: true });
    await writeFile(join(pbDir, 'only.md'), VALID_PLAYBOOK);

    try {
      const result = await discoverPlaybooks(dir);
      expect(result).toHaveLength(1);
      expect(result[0].scope).toBe('project');
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe('userPlaybooksDir', () => {
  test('honours KOOKR_USER_PLAYBOOKS_DIR override', () => {
    const original = process.env.KOOKR_USER_PLAYBOOKS_DIR;
    try {
      process.env.KOOKR_USER_PLAYBOOKS_DIR = '/tmp/custom-user-playbooks';
      expect(userPlaybooksDir()).toBe('/tmp/custom-user-playbooks');
    } finally {
      if (original === undefined) delete process.env.KOOKR_USER_PLAYBOOKS_DIR;
      else process.env.KOOKR_USER_PLAYBOOKS_DIR = original;
    }
  });

  test('falls back to ~/.kookr/playbooks when env unset', () => {
    const original = process.env.KOOKR_USER_PLAYBOOKS_DIR;
    try {
      delete process.env.KOOKR_USER_PLAYBOOKS_DIR;
      expect(userPlaybooksDir().endsWith('/.kookr/playbooks')).toBe(true);
    } finally {
      if (original !== undefined) process.env.KOOKR_USER_PLAYBOOKS_DIR = original;
    }
  });
});

describe('pluginPlaybooksDir', () => {
  test('returns <plugin>/playbooks when KOOKR_PLUGIN_DIR points at a valid plugin tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kookr-plugin-resolve-'));
    const playbooksDir = await makeFakePluginTree(root);
    const original = process.env.KOOKR_PLUGIN_DIR;
    try {
      process.env.KOOKR_PLUGIN_DIR = join(root, 'plugin');
      expect(pluginPlaybooksDir()).toBe(playbooksDir);
    } finally {
      if (original === undefined) delete process.env.KOOKR_PLUGIN_DIR;
      else process.env.KOOKR_PLUGIN_DIR = original;
      await rm(root, { recursive: true, force: true });
    }
  });

  test('returns undefined when KOOKR_PLUGIN_DIR is not a valid plugin tree', () => {
    const original = process.env.KOOKR_PLUGIN_DIR;
    try {
      process.env.KOOKR_PLUGIN_DIR = '/nonexistent/path';
      expect(pluginPlaybooksDir()).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.KOOKR_PLUGIN_DIR;
      else process.env.KOOKR_PLUGIN_DIR = original;
    }
  });
});
