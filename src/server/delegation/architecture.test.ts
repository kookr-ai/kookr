import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * Structural rules for `src/server/delegation/` (RFC section 1). The repo's
 * `scripts/check-architecture-boundaries.ts` only inspects `src/core`, so the rules that
 * matter for this directory are pinned here as a test:
 *
 * 1. `a2a-client.ts` is the ONLY file that knows A2A vocabulary.
 * 2. Nothing dispatches with `message/stream` (a dropped stream fails the task on Hermes).
 * 3. Delegation code does not import "upward" (routes assembly, server entry, bootstrap),
 *    and only a short list of files outside the directory imports delegation code.
 */

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(here, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__fixtures__' ? [] : sourceFiles(full);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
  });
}

/** Source with block and line comments removed, so prose cannot trip the vocabulary scan. */
function code(file: string): string {
  return readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const delegationFiles = sourceFiles(here);

describe('delegation module boundaries', () => {
  test('A2A vocabulary appears only in a2a-client.ts', () => {
    const vocabulary = [/TASK_STATE_/, /ROLE_USER/, /-3200\d|-3205\d/, /jsonrpc/i, /['"`]message\/send['"`]/, /['"`]tasks\/(list|get|subscribe|cancel)['"`]/];
    const offenders = delegationFiles
      .filter((f) => !f.endsWith('a2a-client.ts'))
      .filter((f) => vocabulary.some((re) => re.test(code(f))))
      .map((f) => relative(here, f));
    expect(offenders).toEqual([]);
  });

  test('no file dispatches with message/stream', () => {
    const offenders = delegationFiles.filter((f) => /['"`]message\/stream['"`]|SendStreamingMessage/.test(code(f))).map((f) => relative(here, f));
    expect(offenders).toEqual([]);
  });

  test('delegation code does not import upward', () => {
    const upward = /from\s+['"]\.\.\/(routes|routes\/[^'"]*|index|bootstrap\/[^'"]*|start)(\.js)?['"]/;
    const offenders = delegationFiles.filter((f) => upward.test(code(f))).map((f) => relative(here, f));
    expect(offenders).toEqual([]);
  });

  test('only bootstrap, route assembly and the shared route deps import delegation code', () => {
    const allowed = new Set(['bootstrap/create-delegation-runtime.ts', 'routes.ts', 'routes/shared.ts']);
    const importers = sourceFiles(serverRoot)
      .filter((f) => !f.startsWith(here))
      .filter((f) => /['"`](\.\.?\/)+(delegation\/|server\/delegation\/)/.test(code(f)) || /import\('\.\.\/delegation\//.test(code(f)))
      .map((f) => relative(serverRoot, f));
    expect(importers.filter((f) => !allowed.has(f))).toEqual([]);
    expect(importers.length).toBeGreaterThan(0);
  });
});
