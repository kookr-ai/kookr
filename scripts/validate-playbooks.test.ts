import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { validatePlaybooks } from './validate-playbooks';

const repoRoot = process.cwd();
const scriptPath = join(repoRoot, 'scripts/validate-playbooks.ts');
const tsxLoader = import.meta.resolve('tsx');

const GOOD_PLAYBOOK = `---
name: Good Playbook
description: A playbook that parses cleanly.
checklist:
  - Step one
  - Step two
---

# Good Playbook

Body content.
`;

// Missing the required \`name\` field — parsePlaybook throws PlaybookParseError.
const BROKEN_PLAYBOOK = `---
description: A playbook with no name.
---

# Broken Playbook
`;

// A typo'd \`checkist:\` that the parser silently ignores — the class of bug
// this gate is meant to surface.
const TYPO_KEY_PLAYBOOK = `---
name: Typo Playbook
description: Has an unrecognized frontmatter key.
checkist:
  - This checklist silently vanishes.
---

# Typo Playbook
`;

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'kookr-validate-playbooks-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const abs = join(root, relativePath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return root;
}

describe('validate-playbooks', () => {
  it('passes on the real shipped playbook set', () => {
    const { errors } = validatePlaybooks(repoRoot);
    expect(errors, errors.map((e) => `${e.file}: ${e.message}`).join('\n')).toEqual([]);
  });

  it('reports a parse error for a broken bundled playbook', () => {
    const root = makeRepo({ 'plugin/playbooks/broken.md': BROKEN_PLAYBOOK });
    try {
      const { errors, warnings } = validatePlaybooks(root);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toMatch(/missing required field: name/);
      expect(warnings).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('warns on unrecognized frontmatter keys without erroring', () => {
    const root = makeRepo({ 'plugin/playbooks/typo.md': TYPO_KEY_PLAYBOOK });
    try {
      const { errors, warnings } = validatePlaybooks(root);
      expect(errors).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toContain('checkist');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores the dev-tree .claude/playbooks location', () => {
    // Discovery never loads .claude/playbooks; the gate scopes to plugin/playbooks.
    const root = makeRepo({ '.claude/playbooks/broken.md': BROKEN_PLAYBOOK });
    try {
      const { errors, warnings } = validatePlaybooks(root);
      expect(errors).toEqual([]);
      expect(warnings).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('CLI exits 0 on a clean playbook set', () => {
    const root = makeRepo({ 'plugin/playbooks/good.md': GOOD_PLAYBOOK });
    try {
      const result = spawnSync(process.execPath, ['--import', tsxLoader, scriptPath, root], {
        encoding: 'utf8',
        env: { ...process.env, TSX_DISABLE_CACHE: '1' },
      });
      expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('Playbook validation passed.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('CLI passes (exit 0) when only unknown-key warnings are present', () => {
    // The default, non-strict contract: a shipped-playbook typo warns on stderr
    // but must not block a push. Guards against a regression that flips the
    // strict default and fails warning-only runs.
    const root = makeRepo({ 'plugin/playbooks/typo.md': TYPO_KEY_PLAYBOOK });
    try {
      const result = spawnSync(process.execPath, ['--import', tsxLoader, scriptPath, root], {
        encoding: 'utf8',
        env: { ...process.env, TSX_DISABLE_CACHE: '1' },
      });
      expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('Playbook validation passed.');
      expect(result.stderr).toContain('checkist');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accumulates errors across multiple broken playbooks', () => {
    const root = makeRepo({
      'plugin/playbooks/broken-a.md': BROKEN_PLAYBOOK,
      'plugin/playbooks/broken-b.md': BROKEN_PLAYBOOK,
    });
    try {
      const { errors } = validatePlaybooks(root);
      expect(errors).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('CLI exits 1 on a broken playbook', () => {
    const root = makeRepo({ 'plugin/playbooks/broken.md': BROKEN_PLAYBOOK });
    try {
      const result = spawnSync(process.execPath, ['--import', tsxLoader, scriptPath, root], {
        encoding: 'utf8',
        env: { ...process.env, TSX_DISABLE_CACHE: '1' },
      });
      expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(1);
      expect(result.stderr).toContain('Playbook validation failed:');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('CLI exits 2 on an unknown flag', () => {
    const result = spawnSync(process.execPath, ['--import', tsxLoader, scriptPath, '--bogus'], {
      encoding: 'utf8',
      env: { ...process.env, TSX_DISABLE_CACHE: '1' },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Unknown flag(s): --bogus');
  });

  it('CLI --strict escalates unknown-key warnings to failure', () => {
    const root = makeRepo({ 'plugin/playbooks/typo.md': TYPO_KEY_PLAYBOOK });
    try {
      const result = spawnSync(process.execPath, ['--import', tsxLoader, scriptPath, '--strict', root], {
        encoding: 'utf8',
        env: { ...process.env, TSX_DISABLE_CACHE: '1' },
      });
      expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(1);
      expect(result.stderr).toContain('failing due to --strict');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
