import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import {
  parseCitationClaims,
  parseMarkdownCitationClaims,
  verifyCitationClaims,
} from './citation-verifier.js';

const tempRoots: string[] = [];

describe('citation verifier', () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('grounds JSON claims with exact quotes, whitespace normalization, and line ranges', () => {
    const root = createSourceRoot({
      'notes/example.md': [
        'Heading',
        'The citation verifier treats repeated whitespace as equivalent when checking quoted excerpts.',
      ].join('\n'),
    });
    const claims = parseCitationClaims('json', JSON.stringify({
      claims: [{
        id: 'json-good',
        path: 'notes/example.md#L2',
        quote: 'The citation verifier treats repeated     whitespace as equivalent when checking quoted excerpts.',
      }],
    }));

    const result = verifyCitationClaims(claims, root);

    expect(result).toEqual({ verdict: 'grounded', failures: [] });
  });

  it('fails labeled fabricated claims per JSON and Markdown parser format', () => {
    const root = createSourceRoot({
      'evidence/source.md': 'The source only says that deterministic gates should copy real quoted text.\n',
    });
    const fabricatedQuote = 'The source claims that a neural verifier approved the invented citation.';

    const jsonResult = verifyCitationClaims(parseCitationClaims('json', JSON.stringify({
      claims: [{
        id: 'json-fab',
        label: 'labeled-fabrication',
        path: 'evidence/source.md',
        quote: fabricatedQuote,
      }],
    })), root);

    const markdown = [
      '1. **evidence/source.md**',
      `> ${fabricatedQuote}`,
    ].join('\n');
    const markdownClaims = parseMarkdownCitationClaims(markdown).map((claim) => ({
      ...claim,
      id: 'markdown-fab',
      label: 'labeled-fabrication',
    }));
    const markdownResult = verifyCitationClaims(markdownClaims, root);

    expect(jsonResult.verdict).toBe('unverifiable');
    expect(jsonResult.failures).toEqual([
      expect.objectContaining({
        claimId: 'json-fab',
        label: 'labeled-fabrication',
        reason: 'quote_not_found',
      }),
    ]);
    expect(markdownResult.verdict).toBe('unverifiable');
    expect(markdownResult.failures).toEqual([
      expect.objectContaining({
        claimId: 'markdown-fab',
        label: 'labeled-fabrication',
        reason: 'quote_not_found',
      }),
    ]);
  });

  it('rejects missing files, invalid line ranges, and source-root escapes', () => {
    const root = createSourceRoot({
      'notes/two-lines.md': 'one\ntwo\n',
    });

    const result = verifyCitationClaims([
      { id: 'missing', path: 'notes/missing.md' },
      { id: 'bad-line', path: 'notes/two-lines.md:5' },
      { id: 'escape', path: '../outside.md' },
    ], root);

    expect(result.verdict).toBe('unverifiable');
    expect(result.failures.map((failure) => [failure.claimId, failure.reason])).toEqual([
      ['missing', 'file_not_found'],
      ['bad-line', 'line_unresolvable'],
      ['escape', 'path_outside_source_root'],
    ]);
  });

  it('requires every elided quote segment to appear in source order', () => {
    const root = createSourceRoot({
      'source.md': 'The source contains a real opening sentence and a real closing sentence.\n',
    });

    const grounded = verifyCitationClaims([{
      id: 'elided-good',
      path: 'source.md',
      quote: 'The source contains a real opening sentence ... a real closing sentence.',
    }], root);
    const fabricated = verifyCitationClaims([{
      id: 'elided-fabricated',
      path: 'source.md',
      quote: 'The source contains a real opening sentence ... an invented middle claim ... a real closing sentence.',
    }], root);

    expect(grounded).toEqual({ verdict: 'grounded', failures: [] });
    expect(fabricated.verdict).toBe('unverifiable');
    expect(fabricated.failures).toEqual([
      expect.objectContaining({
        claimId: 'elided-fabricated',
        reason: 'quote_not_found',
      }),
    ]);
  });

  it('parses Markdown citations with GitHub-style #L anchors', () => {
    const root = createSourceRoot({
      'notes/example.md': [
        'first',
        'The anchored Markdown citation resolves to this exact second line.',
      ].join('\n'),
    });

    const claims = parseMarkdownCitationClaims([
      '1. **notes/example.md#L2**',
      '> The anchored Markdown citation resolves to this exact second line.',
    ].join('\n'));
    const result = verifyCitationClaims(claims, root);

    expect(claims).toEqual([
      expect.objectContaining({ path: 'notes/example.md#L2' }),
    ]);
    expect(result).toEqual({ verdict: 'grounded', failures: [] });
  });

  it('prints stable CLI JSON and exits non-zero for unverifiable citations', () => {
    const root = createSourceRoot({
      'source.md': 'A real sentence about grounded citation evidence.\n',
    });
    const input = join(root, 'claims.json');
    writeFileSync(input, JSON.stringify({
      claims: [{
        id: 'cli-fab',
        label: 'labeled-fabrication',
        path: 'source.md',
        quote: 'An invented sentence that does not exist in the source.',
      }],
    }));

    const result = spawnSync(process.execPath, [
      '--import',
      'tsx',
      join(process.cwd(), 'scripts', 'verify-citations.ts'),
      '--input',
      input,
      '--source-root',
      root,
      '--format',
      'json',
    ], { cwd: process.cwd(), encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      verdict: 'unverifiable',
      failures: [
        expect.objectContaining({
          claimId: 'cli-fab',
          label: 'labeled-fabrication',
          reason: 'quote_not_found',
        }),
      ],
    });
  });

  it('infers JSONL format in the CLI and accepts blank lines between claims', () => {
    const root = createSourceRoot({
      'one.md': 'The first JSONL citation is grounded in a real source file.\n',
      'two.md': 'The second JSONL citation is also grounded in a real source file.\n',
    });
    const input = join(root, 'claims.jsonl');
    writeFileSync(input, [
      JSON.stringify({ id: 'one', path: 'one.md', quote: 'The first JSONL citation is grounded in a real source file.' }),
      '',
      JSON.stringify({ id: 'two', path: 'two.md', quote: 'The second JSONL citation is also grounded in a real source file.' }),
    ].join('\n'));

    const result = spawnSync(process.execPath, [
      '--import',
      'tsx',
      join(process.cwd(), 'scripts', 'verify-citations.ts'),
      '--input',
      input,
      '--source-root',
      root,
    ], { cwd: process.cwd(), encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ verdict: 'grounded', failures: [] });
  });
});

function createSourceRoot(files: Record<string, string>): string {
  const root = join(tmpdir(), `kookr-citation-verifier-${process.pid}-${Math.random().toString(16).slice(2)}`);
  tempRoots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}
