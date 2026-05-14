import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const sharedRoot = new URL('.', import.meta.url);
const contractsRoot = new URL('./contracts/', import.meta.url);

function readSharedFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, sharedRoot), 'utf8');
}

function readContractFiles(): Array<{ path: string; source: string }> {
  return readdirSync(contractsRoot)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({
      path: join('src/shared/contracts', name),
      source: readFileSync(new URL(name, contractsRoot), 'utf8'),
    }));
}

function coreImportMatches(source: string): string[] {
  return [...source.matchAll(/from\s+['"][^'"]*core[^'"]*['"]/g)].map((match) => match[0]);
}

describe('shared protocol boundary', () => {
  test('protocol facade exports only shared contract modules', () => {
    expect(coreImportMatches(readSharedFile('protocol.ts'))).toEqual([]);
  });

  test('shared contracts do not import core implementation modules', () => {
    const offenders = readContractFiles().flatMap(({ path, source }) =>
      coreImportMatches(source).map((match) => `${path}: ${match}`),
    );

    expect(offenders).toEqual([]);
  });
});
