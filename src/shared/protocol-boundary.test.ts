import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const sharedRoot = new URL('.', import.meta.url);
const contractsRoot = new URL('./contracts/', import.meta.url);
const frontendRoot = new URL('../frontend/', import.meta.url);

function readSharedFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, sharedRoot), 'utf8');
}

function readSourceFiles(root: URL, displayRoot: string): Array<{ path: string; source: string }> {
  function walk(dir: URL, relativeDir = ''): Array<{ path: string; source: string }> {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const relativePath = relativeDir ? join(relativeDir, entry.name) : entry.name;
      const entryUrl = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
      if (entry.isDirectory()) return walk(entryUrl, relativePath);
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) return [];
      return [{
        path: join(displayRoot, relativePath),
        source: readFileSync(entryUrl, 'utf8'),
      }];
    });
  }

  return walk(root);
}

function importSpecifiers(source: string): string[] {
  const importSpecifierPattern =
    /\bfrom\s+['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  return [...source.matchAll(importSpecifierPattern)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? '');
}

function coreImportMatches(source: string): string[] {
  return importSpecifiers(source)
    .filter((specifier) => specifier.split('/').includes('core'));
}

function contractBoundaryImportMatches(source: string): string[] {
  return importSpecifiers(source)
    .filter((specifier) => {
      if (specifier.startsWith('..')) return true;
      return specifier.split('/').some((part) => (
        part === 'adapters'
        || part === 'core'
        || part === 'frontend'
        || part === 'remote'
        || part === 'server'
      ));
    });
}

describe('shared protocol boundary', () => {
  test('protocol facade exports only shared contract modules', () => {
    expect(coreImportMatches(readSharedFile('protocol.ts'))).toEqual([]);
  });

  test('shared contracts do not import runtime or non-contract shared modules', () => {
    const offenders = readSourceFiles(contractsRoot, 'src/shared/contracts').flatMap(({ path, source }) =>
      contractBoundaryImportMatches(source).map((specifier) => `${path}: ${specifier}`),
    );

    expect(offenders).toEqual([]);
  });

  test('frontend imports shared contracts instead of core modules', () => {
    const offenders = readSourceFiles(frontendRoot, 'src/frontend').flatMap(({ path, source }) =>
      coreImportMatches(source).map((match) => `${path}: ${match}`),
    );

    expect(offenders).toEqual([]);
  });
});
