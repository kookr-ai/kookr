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

      const violations = checkCoreLlmProviderBoundary(file);
      const reasons = violations.map((violation) => violation.reason);

      expect(reasons).toEqual(expect.arrayContaining([
        expect.stringContaining('router.requesty.ai'),
        expect.stringContaining('KOOKR_REQUESTY_API_KEY'),
        expect.stringContaining('GROQ_API_KEY'),
        expect.stringContaining('RequestyLlmClient'),
        expect.stringContaining('AnthropicLlmClient'),
      ]));

      // Each violation carries a real 1-based line pointing at the exact marker
      // in the synthetic file (not just any positive number).
      const lineFor = (needle: string) =>
        violations.find((violation) => violation.reason.includes(needle))?.line;
      expect(lineFor('router.requesty.ai')).toBe(1);
      expect(lineFor('GROQ_API_KEY')).toBe(3);
      expect(lineFor('RequestyLlmClient')).toBe(4);
      expect(lineFor('AnthropicLlmClient')).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reports the first occurrence when a marker appears on several lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-llm-boundary-'));
    try {
      const file = join(dir, 'repeated-marker.ts');
      writeFileSync(file, [
        "const a = 1;",
        "const first = process.env.GROQ_API_KEY;",
        "const second = process.env.GROQ_API_KEY;",
      ].join('\n'));

      const groq = checkCoreLlmProviderBoundary(file)
        .filter((violation) => violation.reason.includes('GROQ_API_KEY'));

      // A repeated marker yields a single violation anchored to its first line (2),
      // never the later occurrence.
      expect(groq).toHaveLength(1);
      expect(groq[0].line).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
