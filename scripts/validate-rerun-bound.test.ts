import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REQUIRED_PATTERNS, TARGET_FILES, validateRerunBound } from './validate-rerun-bound';

const repoRoot = process.cwd();
const scriptPath = join(repoRoot, 'scripts/validate-rerun-bound.ts');
const tsxLoader = import.meta.resolve('tsx');

// Build a throwaway repo that mirrors the real target files, so a test can
// mutate one copy without touching the working tree.
function makeRepoFromReal(): string {
  const root = mkdtempSync(join(tmpdir(), 'kookr-validate-rerun-bound-'));
  for (const rel of TARGET_FILES) {
    const dest = join(root, rel);
    mkdirSync(join(dest, '..'), { recursive: true });
    cpSync(join(repoRoot, rel), dest);
  }
  return root;
}

describe('validate-rerun-bound', () => {
  it('passes on the real shipped files', () => {
    const { errors } = validateRerunBound(repoRoot);
    expect(errors, errors.map((e) => `${e.file}: ${e.message}`).join('\n')).toEqual([]);
  });

  // The #1561 acceptance criterion is "fails if the bound is removed from ANY
  // of the three files", so mutate each target independently rather than only
  // the first — a per-file bug in the pattern scan must not hide behind the
  // others still passing.
  it.each(TARGET_FILES)('fails when the bound is removed from %s (mutation)', (victimRel) => {
    const root = makeRepoFromReal();
    try {
      const victim = join(root, victimRel);
      const stripped = readFileSync(victim, 'utf8')
        .replace(/max 2 CI rerun attempts/gi, 'REMOVED')
        .replace(/never loop/gi, 'REMOVED')
        .replace(/#1198/g, 'REMOVED');
      writeFileSync(victim, stripped, 'utf8');

      const { errors } = validateRerunBound(root);
      expect(errors.length).toBeGreaterThan(0);
      // Only the mutated file errors — the other two still carry the bound.
      expect(errors.every((e) => e.file === victimRel)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when only a single required pattern is dropped', () => {
    // Each pattern is load-bearing on its own — dropping just the #1198
    // cross-reference (leaving the bound text intact) must still fail the gate.
    const root = makeRepoFromReal();
    try {
      const victim = join(root, TARGET_FILES[0]);
      writeFileSync(victim, readFileSync(victim, 'utf8').replace(/#1198/g, 'REMOVED'), 'utf8');
      const { errors } = validateRerunBound(root);
      expect(errors.some((e) => e.file === TARGET_FILES[0] && /#1198/.test(e.message))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when a target file is missing entirely', () => {
    const root = makeRepoFromReal();
    try {
      rmSync(join(root, TARGET_FILES[1]));
      const { errors } = validateRerunBound(root);
      expect(errors.some((e) => e.file === TARGET_FILES[1] && /file not found/.test(e.message))).toBe(
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('locks the contract shape (3 target files, >=4 required patterns)', () => {
    // Guards against a future edit that silently drops one pattern or one file
    // from the contract. This asserts the shape only — actual per-file/per-pattern
    // matching is covered by the "passes on the real shipped files" and mutation
    // tests above.
    expect(TARGET_FILES.length).toBe(3);
    expect(REQUIRED_PATTERNS.length).toBeGreaterThanOrEqual(4);
  });

  it('CLI exits 0 on the real repo', () => {
    const result = spawnSync(process.execPath, ['--import', tsxLoader, scriptPath, repoRoot], {
      encoding: 'utf8',
      env: { ...process.env, TSX_DISABLE_CACHE: '1' },
    });
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('CI-rerun-bound validation passed.');
  });

  it('CLI exits 1 when the bound is removed', () => {
    const root = makeRepoFromReal();
    try {
      const victim = join(root, TARGET_FILES[0]);
      writeFileSync(victim, '# emptied\n', 'utf8');
      const result = spawnSync(process.execPath, ['--import', tsxLoader, scriptPath, root], {
        encoding: 'utf8',
        env: { ...process.env, TSX_DISABLE_CACHE: '1' },
      });
      expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(1);
      expect(result.stderr).toContain('CI-rerun-bound validation failed:');
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
});
