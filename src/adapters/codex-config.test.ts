import { describe, expect, test } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureCodexWorkspaceTrusted, upsertCodexTrustEntry } from './codex-config.js';

describe('ensureCodexWorkspaceTrusted', () => {
  test('does not create .codex in the workspace cwd (#234)', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'codex-config-234-'));
    const workspaceCwd = join(tempDir, 'workspace');
    const codexConfigPath = join(tempDir, 'codex-home', 'config.toml');
    await mkdir(workspaceCwd, { recursive: true });

    try {
      await ensureCodexWorkspaceTrusted(workspaceCwd, { configPath: codexConfigPath });

      // The config should be written to the explicit config path, not the workspace
      expect(existsSync(codexConfigPath)).toBe(true);
      // No .codex directory should appear in the workspace
      expect(existsSync(join(workspaceCwd, '.codex'))).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('upsertCodexTrustEntry', () => {
  test('appends a trusted workspace section when the config is empty', () => {
    expect(upsertCodexTrustEntry('', '/tmp/project')).toBe(
      '[projects."/tmp/project"]\ntrust_level = "trusted"\n',
    );
  });

  test('adds trust_level to an existing project section without one', () => {
    const input = [
      '[features]',
      'codex_hooks = true',
      '',
      '[projects."/tmp/project"]',
      'model = "gpt-5.4"',
      '',
      '[profiles.default]',
      'model = "gpt-5.4"',
      '',
    ].join('\n');

    expect(upsertCodexTrustEntry(input, '/tmp/project')).toBe([
      '[features]',
      'codex_hooks = true',
      '',
      '[projects."/tmp/project"]',
      'trust_level = "trusted"',
      'model = "gpt-5.4"',
      '',
      '[profiles.default]',
      'model = "gpt-5.4"',
      '',
    ].join('\n'));
  });

  test('leaves an existing project trust level unchanged', () => {
    const input = [
      '[projects."/tmp/project"]',
      'trust_level = "untrusted"',
      '',
    ].join('\n');

    expect(upsertCodexTrustEntry(input, '/tmp/project')).toBe(input);
  });
});
