import { describe, expect, test } from 'vitest';
import { join, relative } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  checkCoreLlmProviderBoundary,
  listTypeScriptFiles,
} from '../../scripts/check-architecture-boundaries.js';

describe('LLM architecture boundary', () => {
  test('keeps concrete LLM transports and provider secrets out of core source files', async () => {
    const root = process.cwd();
    const files = await listTypeScriptFiles(join(root, 'src/core'));
    const offenders = files
      .flatMap(checkCoreLlmProviderBoundary)
      .map((violation) => `${relative(root, violation.file)}: ${violation.reason}`);

    expect(offenders).toEqual([]);
  });

  test('rejects concrete provider markers in core source files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-llm-boundary-'));
    try {
      const file = join(dir, 'leaky-provider.ts');
      writeFileSync(file, [
        "const endpoint = 'https://router.requesty.ai/v1';",
        "const key = process.env.KOOKR_REQUESTY_API_KEY;",
        "const groq = process.env.GROQ_API_KEY;",
        'class RequestyLlmClient {}',
        'class AnthropicLlmClient {}',
      ].join('\n'));

      const reasons = checkCoreLlmProviderBoundary(file).map((violation) => violation.reason);

      expect(reasons).toEqual(expect.arrayContaining([
        expect.stringContaining('router.requesty.ai'),
        expect.stringContaining('KOOKR_REQUESTY_API_KEY'),
        expect.stringContaining('GROQ_API_KEY'),
        expect.stringContaining('RequestyLlmClient'),
        expect.stringContaining('AnthropicLlmClient'),
      ]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
