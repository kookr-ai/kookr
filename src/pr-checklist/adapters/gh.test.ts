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

  it('marks a --body with a non-heredoc command substitution as unverifiable', () => {
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

  describe('heredoc command-substitution body', () => {
    const inlineText = (cmd: string) => {
      const r = extractFromGhCommand(cmd);
      return r?.bodySource.kind === 'inline' ? r.bodySource.text : r?.bodySource;
    };

    it("resolves --body \"$(cat <<'EOF' … EOF)\" to the literal text", () => {
      const cmd = `gh pr create --title T --body "$(cat <<'EOF'\n## Summary\n- [ ] <!-- kookr:check:tests --> t\nEOF\n)"`;
      expect(inlineText(cmd)).toBe('## Summary\n- [ ] <!-- kookr:check:tests --> t');
    });

    it('resolves an unquoted delimiter (<<EOF)', () => {
      expect(inlineText(`gh pr create --body "$(cat <<EOF\nhello\nEOF\n)"`)).toBe('hello');
    });

    it('resolves a double-quoted delimiter (<<"EOF")', () => {
      expect(inlineText(`gh pr create --body "$(cat <<"EOF"\nhello\nEOF\n)"`)).toBe('hello');
    });

    it('resolves <<-EOF with a tab-indented terminator', () => {
      expect(inlineText(`gh pr create --body "$(cat <<-EOF\n\thello\n\tEOF\n)"`)).toBe('\thello');
    });

    it('requires the terminator at column 0 for plain <<EOF (shell semantics)', () => {
      const r = extractFromGhCommand(`gh pr create --body "$(cat <<EOF\nhello\n  EOF\n)"`);
      expect(r?.bodySource.kind).toBe('unverifiable');
    });

    it('resolves the unquoted-substitution form (no surrounding double quotes)', () => {
      expect(inlineText(`gh pr create --body $(cat <<'EOF'\nhello\nEOF\n)`)).toBe('hello');
    });

    it('resolves the -b short form and the --body= form', () => {
      expect(inlineText(`gh pr create -b "$(cat <<'EOF'\nshort\nEOF\n)"`)).toBe('short');
      expect(inlineText(`gh pr create --body="$(cat <<'EOF'\neq\nEOF\n)"`)).toBe('eq');
    });

    it('keeps double quotes and an unbalanced ) inside the body intact', () => {
      const body = 'say "hi" :)\nan unbalanced ) here\n`code` and $(not run) and ${x}';
      expect(inlineText(`gh pr create --body "$(cat <<'EOF'\n${body}\nEOF\n)"`)).toBe(body);
    });

    it('still reads flags that follow the heredoc (--base, other flags)', () => {
      const r = extractFromGhCommand(`gh pr create --body "$(cat <<'EOF'\nb\nEOF\n)" --base develop --title "T"`);
      expect(r?.base).toBe('develop');
      expect(r?.bodySource).toEqual({ kind: 'inline', text: 'b' });
    });

    it('reads flags that precede the heredoc', () => {
      const r = extractFromGhCommand(`cd /repo && gh pr create --base develop --title "T" --body "$(cat <<'EOF'\nb\nEOF\n)"`);
      expect(r?.base).toBe('develop');
      expect(r?.bodySource).toEqual({ kind: 'inline', text: 'b' });
    });

    it('resolves an empty heredoc body to empty text', () => {
      expect(inlineText(`gh pr create --body "$(cat <<'EOF'\nEOF\n)"`)).toBe('');
    });

    it('leaves a non-cat command substitution unverifiable', () => {
      const r = extractFromGhCommand(`gh pr create --body "$(printf '%s' <<'EOF'\nx\nEOF\n)"`);
      expect(r?.bodySource.kind).toBe('unverifiable');
    });

    it('leaves a cat heredoc piped through another command unverifiable', () => {
      const r = extractFromGhCommand(`gh pr create --body "$(cat <<'EOF' | sed s/a/b/\nx\nEOF\n)"`);
      expect(r?.bodySource.kind).toBe('unverifiable');
    });

    it('leaves an unterminated heredoc unverifiable', () => {
      const r = extractFromGhCommand(`gh pr create --body "$(cat <<'EOF'\nx\n)"`);
      expect(r?.bodySource.kind).toBe('unverifiable');
    });

    it('does not resolve a heredoc belonging to an earlier, non-gh command', () => {
      const cmd = `cat > /tmp/x <<'EOF'\n-b "$(cat <<'EOF2'\nfake\nEOF2\n)"\nEOF\ngh pr create --title T`;
      const r = extractFromGhCommand(cmd);
      expect(r?.bodySource.kind).toBe('unverifiable');
    });
  });

  describe('templateRequired (bodies gh builds itself)', () => {
    it('--fill is unverifiable AND requires the template', () => {
      expect(extractFromGhCommand('gh pr create --fill')?.bodySource).toMatchObject({
        kind: 'unverifiable',
        templateRequired: true,
      });
      expect(extractFromGhCommand('gh pr create --fill-first')?.bodySource).toMatchObject({ templateRequired: true });
    });

    it('a command with no body flag requires the template', () => {
      expect(extractFromGhCommand('gh pr create --title T')?.bodySource).toMatchObject({
        kind: 'unverifiable',
        templateRequired: true,
      });
    });

    it('--body-file - (stdin), other expansions, and --web stay degraded (not required)', () => {
      for (const cmd of [
        'gh pr create --body-file -',
        'gh pr create --body "$(cat notes.md)"',
        'gh pr create --body-file "$(mktemp)"',
        'gh pr create --web',
      ]) {
        const src = extractFromGhCommand(cmd)?.bodySource;
        expect(src?.kind).toBe('unverifiable');
        expect(src).not.toHaveProperty('templateRequired', true);
      }
    });

    it('an explicit body beats --fill (gh uses the supplied body)', () => {
      expect(extractFromGhCommand('gh pr create --fill --body-file b.md')?.bodySource).toEqual({ kind: 'file', path: 'b.md' });
      expect(extractFromGhCommand('gh pr create --fill --body "x"')?.bodySource).toEqual({ kind: 'inline', text: 'x' });
    });
  });
});
