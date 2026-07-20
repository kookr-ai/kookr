import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkRemoteImportBoundaries } from './check-remote-import-boundaries';

const repoRoot = process.cwd();
const scriptPath = join(repoRoot, 'scripts/check-remote-import-boundaries.ts');
const tsxLoader = import.meta.resolve('tsx');
const require = createRequire(import.meta.url);

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

  it('reports runtime re-exports and disallowed dynamic imports from src/remote', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kookr-import-boundary-'));
    try {
      mkdirSync(join(root, 'src/core'), { recursive: true });
      mkdirSync(join(root, 'src/adapters'), { recursive: true });
      mkdirSync(join(root, 'src/remote'), { recursive: true });
      writeFileSync(join(root, 'src/remote/session.ts'), 'export const value = 1;\n', 'utf8');
      writeFileSync(join(root, 'src/core/reexport.ts'), "export { value } from '../remote/session';\n", 'utf8');
      writeFileSync(
        join(root, 'src/adapters/dynamic.ts'),
        "export async function load() { return import('../remote/session'); }\n",
        'utf8',
      );

      const result = await checkRemoteImportBoundaries(root);
      const messages = result.violations.map((v) => `${relative(result.root, v.file)} ${v.message}`).sort();

      expect(messages).toEqual([
        'src/adapters/dynamic.ts dynamic import from ../remote/session outside src/server/index.ts',
        'src/core/reexport.ts runtime export from ../remote/session',
      ]);
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
      expect(result.stderr).not.toMatch(/Cannot read properties of undefined/);
      expect(result.stderr).not.toMatch(/TypeError/);
      expect(result.stderr).toContain('Remote import boundary violations:');
      expect(result.stderr).toContain('src/server/bad.ts:1 runtime import from ../remote/session');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Regression for #1438: TypeScript 7 package reshape made the root export
  // version-only, so `ts.ScriptTarget.Latest` / `createSourceFile` throw under CI.
  it('uses TypeScript 7 unstable parse APIs instead of the version-only package root', async () => {
    const source = readFileSync(scriptPath, 'utf8');
    expect(source).toMatch(/from ['"]typescript\/unstable\/ast['"]/);
    expect(source).toMatch(/from ['"]typescript\/unstable\/sync['"]/);
    // Only flag real imports of the version-only package root — comments may mention it.
    expect(source).not.toMatch(/^\s*import\s+.*from\s+['"]typescript['"]/m);
    expect(source).not.toMatch(/createSourceFile\s*\(/);
    expect(source).not.toMatch(/ScriptTarget\.Latest/);

    // Runtime proof of the package reshape that broke CI:
    // the root entry must not expose ScriptTarget / createSourceFile.
    const rootPackage = require('typescript') as {
      ScriptTarget?: unknown;
      createSourceFile?: unknown;
      version?: string;
    };
    expect(rootPackage.ScriptTarget).toBeUndefined();
    expect(rootPackage.createSourceFile).toBeUndefined();
    expect(typeof rootPackage.version).toBe('string');

    const { ScriptTarget } = await import('typescript/unstable/ast');
    expect(ScriptTarget?.Latest).toBeDefined();

    // Empty fixture must parse cleanly (no TypeError) via the unstable API path.
    const root = mkdtempSync(join(tmpdir(), 'kookr-import-boundary-empty-'));
    try {
      mkdirSync(join(root, 'src/server'), { recursive: true });
      writeFileSync(join(root, 'src/server/ok.ts'), 'export const ok = true;\n', 'utf8');
      const result = await checkRemoteImportBoundaries(root);
      expect(result.fileCount).toBe(1);
      expect(result.violations).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
