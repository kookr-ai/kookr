import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...listSourceFiles(path));
      continue;
    }
    if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && statSync(path).size > 0) {
      files.push(path);
    }
  }
  return files;
}

describe('KOOKR_RELAY_TRUSTED boundary', () => {
  it('is read only by src/remote modules', () => {
    const offenders = listSourceFiles(join(root, 'src'))
      .filter((file) => readFileSync(file, 'utf8').includes('KOOKR_RELAY_TRUSTED'))
      .map((file) => relative(root, file))
      .filter((file) => !file.startsWith('src/remote/'));

    expect(offenders).toEqual([]);
  });
});
