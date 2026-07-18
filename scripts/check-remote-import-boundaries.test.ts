import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkRemoteImportBoundaries } from './check-remote-import-boundaries';

const repoRoot = process.cwd();
const scriptPath = join(repoRoot, 'scripts/check-remote-import-boundaries.ts');
const tsxLoader = import.meta.resolve('tsx');

describe('remote import boundaries', () => {
  it('keeps local runtime code from importing src/remote', async () => {
    const result = await checkRemoteImportBoundaries();

    expect(
      result.violations.map((violation) => `${relative(result.root, violation.file)}:${violation.line} ${violation.message}`),
    ).toEqual([]);
  }, 30_000);

  it('reports runtime imports from src/remote in local code', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kookr-import-boundary-'));
    try {
      const serverFile = join(root, 'src/server/bad.ts');

      mkdirSync(join(root, 'src/server'), { recursive: true });
      mkdirSync(join(root, 'src/remote'), { recursive: true });
      writeFileSync(join(root, 'src/remote/session.ts'), 'export const value = 1;\n', 'utf8');
      writeFileSync(serverFile, "import { value } from '../remote/session';\nconsole.log(value);\n", 'utf8');

      const result = await checkRemoteImportBoundaries(root);

      expect(result.violations).toEqual([
        {
          file: serverFile,
          line: 1,
          message: 'runtime import from ../remote/session',
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows type-only imports from src/remote in local code', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kookr-import-boundary-'));
    try {
      mkdirSync(join(root, 'src/server'), { recursive: true });
      mkdirSync(join(root, 'src/remote'), { recursive: true });
      writeFileSync(join(root, 'src/remote/session.ts'), 'export interface RemoteSession { id: string }\n', 'utf8');
      writeFileSync(
        join(root, 'src/server/types.ts'),
        "import type { RemoteSession } from '../remote/session';\nexport type LocalSession = RemoteSession;\n",
        'utf8',
      );

      const result = await checkRemoteImportBoundaries(root);

      expect(result.violations).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exits non-zero when the CLI entrypoint finds violations', () => {
    const root = mkdtempSync(join(tmpdir(), 'kookr-import-boundary-cli-'));
    try {
      mkdirSync(join(root, 'src/server'), { recursive: true });
      mkdirSync(join(root, 'src/remote'), { recursive: true });
      writeFileSync(join(root, 'src/remote/session.ts'), 'export const value = 1;\n', 'utf8');
      writeFileSync(join(root, 'src/server/bad.ts'), "import { value } from '../remote/session';\nconsole.log(value);\n", 'utf8');

      const result = spawnSync(process.execPath, ['--import', tsxLoader, scriptPath], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          TSX_DISABLE_CACHE: '1',
        },
      });

      expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(1);
      expect(result.stderr).toContain('Remote import boundary violations:');
      expect(result.stderr).toContain('src/server/bad.ts:1 runtime import from ../remote/session');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
