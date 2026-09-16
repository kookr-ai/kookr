import { describe, expect, test } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultTrustedClaudeProjectEntry,
  ensureClaudeWorkspaceTrusted,
  upsertClaudeWorkspaceTrust,
} from './claude-config.js';

describe('upsertClaudeWorkspaceTrust', () => {
  test('creates a projects map and trusted entry when the config is empty', () => {
    const { next, changed } = upsertClaudeWorkspaceTrust({}, '/tmp/project');
    expect(changed).toBe(true);
    expect(next.projects).toEqual({
      '/tmp/project': defaultTrustedClaudeProjectEntry(),
    });
  });

  test('adds a missing cwd without dropping sibling projects', () => {
    const input = {
      hasCompletedOnboarding: true,
      projects: {
        '/tmp/other': { hasTrustDialogAccepted: true, lastCost: 1 },
      },
    };
    const { next, changed } = upsertClaudeWorkspaceTrust(input, '/tmp/project');
    expect(changed).toBe(true);
    expect(next.hasCompletedOnboarding).toBe(true);
    expect((next.projects as Record<string, unknown>)['/tmp/other']).toEqual({
      hasTrustDialogAccepted: true,
      lastCost: 1,
    });
    expect((next.projects as Record<string, unknown>)['/tmp/project']).toEqual(
      defaultTrustedClaudeProjectEntry(),
    );
  });

  test('flips an existing false trust bit and keeps other fields', () => {
    const input = {
      projects: {
        '/tmp/project': {
          hasTrustDialogAccepted: false,
          allowedTools: ['Bash'],
        },
      },
    };
    const { next, changed } = upsertClaudeWorkspaceTrust(input, '/tmp/project');
    expect(changed).toBe(true);
    expect((next.projects as Record<string, { hasTrustDialogAccepted: boolean; allowedTools: string[] }>)['/tmp/project']).toEqual({
      hasTrustDialogAccepted: true,
      allowedTools: ['Bash'],
    });
  });

  test('is a no-op when the cwd is already trusted', () => {
    const input = {
      projects: {
        '/tmp/project': { hasTrustDialogAccepted: true, lastCost: 9 },
      },
    };
    const { next, changed } = upsertClaudeWorkspaceTrust(input, '/tmp/project');
    expect(changed).toBe(false);
    expect(next).toBe(input);
  });
});

describe('ensureClaudeWorkspaceTrusted', () => {
  test('writes a trusted entry and does not rewrite when already trusted', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'claude-config-'));
    const configPath = join(tempDir, '.claude.json');
    const workspaceCwd = join(tempDir, 'workspace');
    await mkdir(workspaceCwd, { recursive: true });

    try {
      expect(await ensureClaudeWorkspaceTrusted(workspaceCwd, { configPath })).toBe('updated');
      const first = JSON.parse(await readFile(configPath, 'utf-8')) as {
        projects: Record<string, { hasTrustDialogAccepted: boolean }>;
      };
      expect(first.projects[workspaceCwd]?.hasTrustDialogAccepted).toBe(true);

      const before = await readFile(configPath, 'utf-8');
      expect(await ensureClaudeWorkspaceTrusted(workspaceCwd, { configPath })).toBe('unchanged');
      expect(await readFile(configPath, 'utf-8')).toBe(before);
      expect(existsSync(join(workspaceCwd, '.claude.json'))).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('serializes concurrent first-time cwds so neither trust bit is dropped', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'claude-config-race-'));
    const configPath = join(tempDir, '.claude.json');
    await writeFile(configPath, '{"projects":{}}\n', 'utf-8');

    try {
      await Promise.all([
        ensureClaudeWorkspaceTrusted('/tmp/one', { configPath }),
        ensureClaudeWorkspaceTrusted('/tmp/two', { configPath }),
      ]);
      const parsed = JSON.parse(await readFile(configPath, 'utf-8')) as {
        projects: Record<string, { hasTrustDialogAccepted: boolean }>;
      };
      expect(parsed.projects['/tmp/one']?.hasTrustDialogAccepted).toBe(true);
      expect(parsed.projects['/tmp/two']?.hasTrustDialogAccepted).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('does not wipe a corrupt config', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'claude-config-bad-'));
    const configPath = join(tempDir, '.claude.json');
    await writeFile(configPath, '{not-json', 'utf-8');

    try {
      await expect(ensureClaudeWorkspaceTrusted('/tmp/project', { configPath })).rejects.toThrow(SyntaxError);
      expect(await readFile(configPath, 'utf-8')).toBe('{not-json');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
