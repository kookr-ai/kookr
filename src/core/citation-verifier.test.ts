import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

  it('checks quoted Markdown evidence against the cited line range', () => {
    const root = createSourceRoot({
      'notes/example.md': [
        'The first line is unrelated.',
        'The cited quote appears only on the second line.',
      ].join('\n'),
    });

    const result = verifyCitationClaims(parseMarkdownCitationClaims([
      'Evidence: **notes/example.md#L1**',
      '> The cited quote appears only on the second line.',
    ].join('\n')), root);

    expect(result.verdict).toBe('unverifiable');
    expect(result.failures).toEqual([
      expect.objectContaining({
        path: 'notes/example.md',
        reason: 'quote_not_found',
      }),
    ]);
  });

  it('rejects fabricated reviewer-distillation judge evidence citations', () => {
    const root = createSourceRoot({
      'reviews/pr-123.md': [
        'Comment 1: Please add tracking after submit.',
        'Comment 2: What happens if the folder already exists?',
      ].join('\n'),
    });
    const judgeOutput = [
      'The review evidence shows a rollback concern.',
      '',
      'Evidence: **reviews/pr-123.md#L1-L2**',
      '> If one of the steps fails, there is no opportunity to roll back.',
    ].join('\n');

    const claims = parseMarkdownCitationClaims(judgeOutput).map((claim) => ({
      ...claim,
      id: 'reviewer-judge-fabrication',
      label: 'labeled-fabrication',
    }));
    const result = verifyCitationClaims(claims, root);

    expect(result.verdict).toBe('unverifiable');
    expect(result.failures).toEqual([
      expect.objectContaining({
        claimId: 'reviewer-judge-fabrication',
        label: 'labeled-fabrication',
        path: 'reviews/pr-123.md',
        reason: 'quote_not_found',
      }),
    ]);
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

  it('ships a plugin-local verifier for reviewer-distillation judge gates', () => {
    const root = createSourceRoot({
      'reviews/pr-123.md': [
        'Comment 1: Please add tracking after submit.',
        'Comment 2: What happens if the folder already exists?',
      ].join('\n'),
    });
    const input = join(root, 'scores/pr-123-judge.md');
    mkdirSync(join(root, 'scores'), { recursive: true });
    writeFileSync(input, [
      'The review evidence shows a rollback concern.',
      '',
      'Evidence: **reviews/pr-123.md#L1-L2**',
      '> If one of the steps fails, there is no opportunity to roll back.',
    ].join('\n'));

    const result = spawnSync(process.execPath, [
      join(process.cwd(), 'plugin/skills/reviewer-distillation-judge/scripts/verify-citations.mjs'),
      '--input',
      input,
      '--source-root',
      root,
      '--format',
      'markdown',
      '--allow-prefix',
      'context/pr-123.md',
      '--allow-prefix',
      'predictions/pr-123.md',
      '--allow-prefix',
      'reviews/pr-123.md',
    ], { cwd: process.cwd(), encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      verdict: 'unverifiable',
      failures: [
        expect.objectContaining({
          path: 'reviews/pr-123.md',
          reason: 'quote_not_found',
        }),
      ],
    });
  });

  it('accepts grounded reviewer-distillation judge citations in the plugin-local verifier', () => {
    const root = createSourceRoot({
      'reviews/pr-123.md': [
        'Comment 1: Please add tracking after submit.',
        'Comment 2: What happens if the folder already exists?',
      ].join('\n'),
    });
    const input = join(root, 'scores/pr-123-judge.md');
    mkdirSync(join(root, 'scores'), { recursive: true });
    writeFileSync(input, [
      'The review evidence asks about duplicate folder names.',
      '',
      'Evidence: **reviews/pr-123.md#L2**',
      '> Comment 2: What happens if the folder already exists?',
    ].join('\n'));

    const result = spawnSync(process.execPath, [
      join(process.cwd(), 'plugin/skills/reviewer-distillation-judge/scripts/verify-citations.mjs'),
      '--input',
      input,
      '--source-root',
      root,
      '--format',
      'markdown',
      '--allow-prefix',
      'context/pr-123.md',
      '--allow-prefix',
      'predictions/pr-123.md',
      '--allow-prefix',
      'reviews/pr-123.md',
    ], { cwd: process.cwd(), encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ verdict: 'grounded', failures: [] });
  });

  it('rejects wrong-line reviewer-distillation judge citations in the plugin-local verifier', () => {
    const root = createSourceRoot({
      'reviews/pr-123.md': [
        'Comment 1: Please add tracking after submit.',
        'Comment 2: What happens if the folder already exists?',
      ].join('\n'),
    });
    const input = join(root, 'scores/pr-123-judge.md');
    mkdirSync(join(root, 'scores'), { recursive: true });
    writeFileSync(input, [
      'The review evidence asks about duplicate folder names.',
      '',
      'Evidence: **reviews/pr-123.md#L1**',
      '> Comment 2: What happens if the folder already exists?',
    ].join('\n'));

    const result = spawnSync(process.execPath, [
      join(process.cwd(), 'plugin/skills/reviewer-distillation-judge/scripts/verify-citations.mjs'),
      '--input',
      input,
      '--source-root',
      root,
      '--format',
      'markdown',
      '--allow-prefix',
      'context/pr-123.md',
      '--allow-prefix',
      'predictions/pr-123.md',
      '--allow-prefix',
      'reviews/pr-123.md',
    ], { cwd: process.cwd(), encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      verdict: 'unverifiable',
      failures: [
        expect.objectContaining({
          path: 'reviews/pr-123.md',
          reason: 'quote_not_found',
        }),
      ],
    });
  });

  it('rejects reviewer-distillation judge self-citations outside allowed source prefixes', () => {
    const root = createSourceRoot({});
    mkdirSync(join(root, 'scores'), { recursive: true });
    const input = join(root, 'scores/pr-123-judge.md');
    writeFileSync(input, [
      'The fabricated point appears only in the judge output.',
      '',
      'Evidence: **scores/pr-123-judge.md#L1**',
      '> The fabricated point appears only in the judge output.',
    ].join('\n'));

    const result = spawnSync(process.execPath, [
      join(process.cwd(), 'plugin/skills/reviewer-distillation-judge/scripts/verify-citations.mjs'),
      '--input',
      input,
      '--source-root',
      root,
      '--format',
      'markdown',
      '--allow-prefix',
      'context/pr-123.md',
      '--allow-prefix',
      'predictions/pr-123.md',
      '--allow-prefix',
      'reviews/pr-123.md',
    ], { cwd: process.cwd(), encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      verdict: 'unverifiable',
      failures: [
        expect.objectContaining({
          path: 'scores/pr-123-judge.md',
          reason: 'path_not_allowed',
        }),
      ],
    });
  });

  it('rejects reviewer-distillation judge citations without quoted evidence', () => {
    const root = createSourceRoot({
      'reviews/pr-123.md': 'Comment 1: Please add tracking after submit.\n',
    });
    const input = join(root, 'scores/pr-123-judge.md');
    mkdirSync(join(root, 'scores'), { recursive: true });
    writeFileSync(input, 'Evidence: **reviews/pr-123.md#L1**\n');

    const result = spawnSync(process.execPath, [
      join(process.cwd(), 'plugin/skills/reviewer-distillation-judge/scripts/verify-citations.mjs'),
      '--input',
      input,
      '--source-root',
      root,
      '--format',
      'markdown',
      '--allow-prefix',
      'context/pr-123.md',
      '--allow-prefix',
      'predictions/pr-123.md',
      '--allow-prefix',
      'reviews/pr-123.md',
    ], { cwd: process.cwd(), encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      verdict: 'unverifiable',
      failures: [
        expect.objectContaining({
          path: 'reviews/pr-123.md',
          reason: 'quote_required',
        }),
      ],
    });
  });

  it('rejects reviewer-distillation judge citations to other PR files', () => {
    const root = createSourceRoot({
      'reviews/pr-124.md': 'Comment from another PR.\n',
    });
    const input = join(root, 'scores/pr-123-judge.md');
    mkdirSync(join(root, 'scores'), { recursive: true });
    writeFileSync(input, [
      'Evidence: **reviews/pr-124.md#L1**',
      '> Comment from another PR.',
    ].join('\n'));

    const result = spawnSync(process.execPath, [
      join(process.cwd(), 'plugin/skills/reviewer-distillation-judge/scripts/verify-citations.mjs'),
      '--input',
      input,
      '--source-root',
      root,
      '--format',
      'markdown',
      '--allow-prefix',
      'context/pr-123.md',
      '--allow-prefix',
      'predictions/pr-123.md',
      '--allow-prefix',
      'reviews/pr-123.md',
    ], { cwd: process.cwd(), encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      verdict: 'unverifiable',
      failures: [
        expect.objectContaining({
          path: 'reviews/pr-124.md',
          reason: 'path_not_allowed',
        }),
      ],
    });
  });

  it('rejects reviewer-distillation judge path traversal through allowed prefixes', () => {
    const root = createSourceRoot({});
    mkdirSync(join(root, 'scores'), { recursive: true });
    const input = join(root, 'scores/pr-123-judge.md');
    writeFileSync(input, [
      'Self-cited fabricated evidence.',
      '',
      'Evidence: **reviews/pr-123.md/../../scores/pr-123-judge.md#L1**',
      '> Self-cited fabricated evidence.',
    ].join('\n'));

    const result = spawnSync(process.execPath, [
      join(process.cwd(), 'plugin/skills/reviewer-distillation-judge/scripts/verify-citations.mjs'),
      '--input',
      input,
      '--source-root',
      root,
      '--format',
      'markdown',
      '--allow-prefix',
      'context/pr-123.md',
      '--allow-prefix',
      'predictions/pr-123.md',
      '--allow-prefix',
      'reviews/pr-123.md',
    ], { cwd: process.cwd(), encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      verdict: 'unverifiable',
      failures: [
        expect.objectContaining({
          path: 'reviews/pr-123.md/../../scores/pr-123-judge.md',
          reason: 'path_not_allowed',
        }),
      ],
    });
  });

  it('rejects reviewer-distillation judge symlink self-citations', () => {
    const root = createSourceRoot({});
    mkdirSync(join(root, 'reviews'), { recursive: true });
    mkdirSync(join(root, 'scores'), { recursive: true });
    const input = join(root, 'scores/pr-123-judge.md');
    writeFileSync(input, [
      'Self-cited fabricated evidence.',
      '',
      'Evidence: **reviews/pr-123.md#L1**',
      '> Self-cited fabricated evidence.',
    ].join('\n'));
    symlinkSync('../scores/pr-123-judge.md', join(root, 'reviews/pr-123.md'));

    const result = spawnSync(process.execPath, [
      join(process.cwd(), 'plugin/skills/reviewer-distillation-judge/scripts/verify-citations.mjs'),
      '--input',
      input,
      '--source-root',
      root,
      '--format',
      'markdown',
      '--allow-prefix',
      'context/pr-123.md',
      '--allow-prefix',
      'predictions/pr-123.md',
      '--allow-prefix',
      'reviews/pr-123.md',
    ], { cwd: process.cwd(), encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      verdict: 'unverifiable',
      failures: [
        expect.objectContaining({
          path: 'reviews/pr-123.md',
          reason: 'symlink_not_allowed',
        }),
      ],
    });
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
