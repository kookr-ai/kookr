import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcRoot = join(repoRoot, 'src');

const ALLOWLIST = new Set([
  'src/adapters/fake-terminal-backend.ts',
  'src/adapters/local-dtach-backend.ts',
  'src/server/terminal-input-coordinator.ts',
]);

function listTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(path));
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      files.push(path);
    }
  }
  return files;
}

describe('terminal input boundary', () => {
  it('keeps direct TerminalBackend writes inside backend implementations and TerminalInputCoordinator', () => {
    const files = listTypeScriptFiles(srcRoot);
    const offenders: string[] = [];

    for (const file of files) {
      const rel = relative(repoRoot, file);
      if (ALLOWLIST.has(rel) || rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')) continue;
      const text = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      if (/\b(?:backend|terminalBackend|this\.backend)\.write(?:Sequence)?\s*\(/.test(text)) {
        offenders.push(rel);
      }
    }

    expect(offenders).toEqual([]);
  });
});
