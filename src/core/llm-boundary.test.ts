import { describe, expect, test } from 'vitest';
import { join, relative } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

  test('rejects concrete Requesty provider markers in core source files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-llm-boundary-'));
    try {
      const file = join(dir, 'leaky-requesty.ts');
      writeFileSync(file, [
        "const endpoint = 'https://router.requesty.ai/v1';",
        "const key = process.env.KOOKR_REQUESTY_API_KEY;",
        'class RequestyLlmClient {}',
      ].join('\n'));

      const reasons = checkCoreOpenRouterBoundary(file).map((violation) => violation.reason);

      expect(reasons).toEqual(expect.arrayContaining([
        expect.stringContaining('router.requesty.ai'),
        expect.stringContaining('KOOKR_REQUESTY_API_KEY'),
        expect.stringContaining('RequestyLlmClient'),
      ]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
