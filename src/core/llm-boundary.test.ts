import { describe, expect, test } from 'vitest';
import { join, relative } from 'node:path';
import {
  checkCoreOpenRouterBoundary,
  listTypeScriptFiles,
} from '../../scripts/check-architecture-boundaries.js';

describe('LLM architecture boundary', () => {
  test('keeps OpenRouter transport and provider secrets out of core source files', async () => {
    const root = process.cwd();
    const files = await listTypeScriptFiles(join(root, 'src/core'));
    const offenders = files
      .flatMap(checkCoreOpenRouterBoundary)
      .map((violation) => `${relative(root, violation.file)}: ${violation.reason}`);

    expect(offenders).toEqual([]);
  });
});
