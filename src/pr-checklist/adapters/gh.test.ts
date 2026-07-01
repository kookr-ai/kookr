import { describe, expect, it } from 'vitest';
import { extractFromGhCommand, tokenize } from './gh.js';

describe('tokenize', () => {
  it('splits on whitespace and honors quotes', () => {
    expect(tokenize(`gh pr create --title "a b" --body 'c d'`)).toEqual([
      'gh', 'pr', 'create', '--title', 'a b', '--body', 'c d',
    ]);
  });

  it('separates shell-control operators into their own tokens', () => {
    expect(tokenize('cd /x && gh pr create -F body.md | tee log')).toEqual([
      'cd', '/x', '&&', 'gh', 'pr', 'create', '-F', 'body.md', '|', 'tee', 'log',
    ]);
  });

  it('keeps a command substitution verbatim inside a token', () => {
    expect(tokenize('--body $(cat x)')).toEqual(['--body', '$(cat x)']);
  });
});

describe('extractFromGhCommand', () => {
  it('returns null for a non-gh-pr-create command', () => {
    expect(extractFromGhCommand('git commit -m x')).toBeNull();
    expect(extractFromGhCommand('gh pr view 5')).toBeNull();
  });

  it('extracts an inline --body and default (null) base', () => {
    const r = extractFromGhCommand(`gh pr create --title T --body "hello world"`);
    expect(r).toEqual({ base: null, bodySource: { kind: 'inline', text: 'hello world' } });
  });

  it('extracts -b short form and -B base', () => {
    const r = extractFromGhCommand(`gh pr create -B develop -b "body text"`);
    expect(r?.base).toBe('develop');
    expect(r?.bodySource).toEqual({ kind: 'inline', text: 'body text' });
  });

  it('extracts --base and --body-file path', () => {
    const r = extractFromGhCommand(`gh pr create --base main --body-file .git/PR_BODY.md`);
    expect(r?.base).toBe('main');
    expect(r?.bodySource).toEqual({ kind: 'file', path: '.git/PR_BODY.md' });
  });

  it('supports --flag=value forms', () => {
    const r = extractFromGhCommand(`gh pr create --base=release --body-file=body.md`);
    expect(r?.base).toBe('release');
    expect(r?.bodySource).toEqual({ kind: 'file', path: 'body.md' });
  });

  it('marks --fill as unverifiable', () => {
    const r = extractFromGhCommand(`gh pr create --fill`);
    expect(r?.bodySource.kind).toBe('unverifiable');
  });

  it('marks --body-file - (stdin) as unverifiable', () => {
    const r = extractFromGhCommand(`gh pr create --body-file -`);
    expect(r?.bodySource.kind).toBe('unverifiable');
  });

  it('marks a --body-file path with a shell expansion as unverifiable', () => {
    const r = extractFromGhCommand('gh pr create --body-file "$(mktemp)"');
    expect(r?.bodySource.kind).toBe('unverifiable');
  });

  it('marks a --body with command substitution as unverifiable', () => {
    const r = extractFromGhCommand('gh pr create --body "$(cat notes.md)"');
    expect(r?.bodySource.kind).toBe('unverifiable');
  });

  it('marks a body with backticks as unverifiable', () => {
    const r = extractFromGhCommand('gh pr create --body `cat notes.md`');
    expect(r?.bodySource.kind).toBe('unverifiable');
  });

  it('marks a missing body as unverifiable', () => {
    const r = extractFromGhCommand(`gh pr create --title T`);
    expect(r?.bodySource.kind).toBe('unverifiable');
  });

  it('ignores flags after a shell-control operator (does not read the next command)', () => {
    const r = extractFromGhCommand(`gh pr create --body real && echo --body fake`);
    expect(r?.bodySource).toEqual({ kind: 'inline', text: 'real' });
  });

  it('finds gh pr create after a leading cd &&', () => {
    const r = extractFromGhCommand(`cd /repo && gh pr create --base main --body hi`);
    expect(r?.base).toBe('main');
    expect(r?.bodySource).toEqual({ kind: 'inline', text: 'hi' });
  });
});
