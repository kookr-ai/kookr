import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const ALLOWLIST = new Set([
  'src/adapters/fake-terminal-backend.ts',
  'src/adapters/local-dtach-backend.ts',
  'src/server/terminal-input-coordinator.ts',
]);

describe('terminal input boundary', () => {
  it('keeps direct TerminalBackend writes inside backend implementations and TerminalInputCoordinator', () => {
    const files = listSourceFiles()
      .trim()
      .split('\n')
      .filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'));
    const offenders: string[] = [];

    for (const file of files) {
      const rel = relative(repoRoot, join(repoRoot, file));
      if (ALLOWLIST.has(rel) || rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')) continue;
      const text = readFileSync(join(repoRoot, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      if (/\b(?:backend|terminalBackend|this\.backend)\.write(?:Sequence)?\s*\(/.test(text)) {
        offenders.push(rel);
      }
    }

    expect(offenders).toEqual([]);
  });
});

function listSourceFiles(): string {
  try {
    return execFileSync('rg', ['--files', 'src'], { cwd: repoRoot, encoding: 'utf8' });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
    return execFileSync('git', ['ls-files', 'src'], { cwd: repoRoot, encoding: 'utf8' });
  }
}
