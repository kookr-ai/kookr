import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizePromptFileReferences } from './prompt-file-paths.js';

describe('normalizePromptFileReferences', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'kookr-prompt-file-paths-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function touch(relativePath: string): string {
    const absolute = resolve(cwd, relativePath);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, 'fixture\n');
    return absolute;
  }

  it('rewrites a relative file that exists under cwd to an absolute path', () => {
    const absolute = touch('notes.md');
    expect(normalizePromptFileReferences('Please read notes.md carefully', cwd)).toBe(
      `Please read ${absolute} carefully`,
    );
  });

  it('leaves a relative path unchanged when the file does not exist', () => {
    const prompt = 'Please read missing.md carefully';
    expect(normalizePromptFileReferences(prompt, cwd)).toBe(prompt);
  });

  it('rewrites nested dir/file.ext paths that exist under cwd', () => {
    const absolute = touch('src/server/config.ts');
    expect(normalizePromptFileReferences('Open src/server/config.ts next', cwd)).toBe(
      `Open ${absolute} next`,
    );
  });

  it('leaves non-path tokens, URLs, and bare words unchanged', () => {
    const prompt = [
      'Fix the bug in README',
      'see https://example.com/docs',
      'and email user@example.com',
      'then ship it.',
    ].join(' ');
    expect(normalizePromptFileReferences(prompt, cwd)).toBe(prompt);
  });

  it('preserves prefix characters such as quotes, whitespace, and brackets', () => {
    const absolute = touch('path.ts');
    expect(normalizePromptFileReferences('see "path.ts" please', cwd)).toBe(
      `see "${absolute}" please`,
    );
    expect(normalizePromptFileReferences('see (path.ts) please', cwd)).toBe(
      `see (${absolute}) please`,
    );
    expect(normalizePromptFileReferences('see [path.ts] please', cwd)).toBe(
      `see [${absolute}] please`,
    );
    expect(normalizePromptFileReferences("see 'path.ts' please", cwd)).toBe(
      `see '${absolute}' please`,
    );
  });

  it('rewrites ./ and ../ relative forms when the resolved file exists', () => {
    const nested = touch('pkg/util.ts');
    const siblingCwd = join(cwd, 'pkg');
    expect(normalizePromptFileReferences('import ./util.ts here', siblingCwd)).toBe(
      `import ${nested} here`,
    );
    expect(normalizePromptFileReferences('import ../pkg/util.ts here', siblingCwd)).toBe(
      `import ${nested} here`,
    );
  });

  it('rewrites a path at the start of the prompt when it exists', () => {
    const absolute = touch('entry.ts');
    expect(normalizePromptFileReferences('entry.ts is the entrypoint', cwd)).toBe(
      `${absolute} is the entrypoint`,
    );
  });

  it('does not rewrite a same-looking token when only a different file exists', () => {
    touch('real.ts');
    const prompt = 'ignore other.ts please';
    expect(normalizePromptFileReferences(prompt, cwd)).toBe(prompt);
  });
});
