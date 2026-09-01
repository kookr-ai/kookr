import { describe, expect, test } from 'vitest';
import { buildSpawnCommand } from './spawn-command.js';

const CWD = '/home/user/proj';
// The prompt-file fallback writes to a freshly mktemp'd file (not a fixed path)
// so a pasted command cannot follow a planted symlink or clobber a concurrent copy.
const MKTEMP_PREFIX = 'prompt_file="$(mktemp)"';
const PROMPT_FILE_FLAG = '--prompt-file "$prompt_file"';

/** Assemble the exact expected prompt-file form for a given delimiter/body. */
function promptFileForm(opts: {
  delimiter: string;
  body: string;
  flags: string;
}): string {
  return (
    `${MKTEMP_PREFIX}\ncat > "$prompt_file" <<'${opts.delimiter}'\n` +
    `${opts.body}\n` +
    `${opts.delimiter}\n` +
    `kookr spawn ${opts.flags}`
  );
}

describe('buildSpawnCommand — argv (quoted one-liner) path', () => {
  test('simple prompt yields a runnable quoted one-liner', () => {
    const built = buildSpawnCommand({
      prompt: 'review the diff since origin/main',
      cwd: CWD,
      agentType: 'claude-code',
    });
    expect(built.usedPromptFile).toBe(false);
    expect(built.command).toBe(
      'kookr spawn -C /home/user/proj -a claude-code "review the diff since origin/main"',
    );
  });

  test('criteria is appended as a quoted --criteria flag', () => {
    const built = buildSpawnCommand({
      prompt: 'fix the auth bug',
      cwd: CWD,
      agentType: 'codex-cli',
      criteria: 'tests pass and PR created',
    });
    expect(built.usedPromptFile).toBe(false);
    expect(built.command).toBe(
      "kookr spawn -C /home/user/proj -a codex-cli --criteria 'tests pass and PR created' \"fix the auth bug\"",
    );
  });

  test('a cwd with spaces is single-quoted', () => {
    const built = buildSpawnCommand({
      prompt: 'do the thing',
      cwd: '/home/user/my project',
      agentType: 'claude-code',
    });
    expect(built.command).toBe(
      "kookr spawn -C '/home/user/my project' -a claude-code \"do the thing\"",
    );
  });

  test('a cwd containing a single quote uses the POSIX \\x27\\\\\\x27\\x27 idiom', () => {
    const built = buildSpawnCommand({
      prompt: 'do the thing',
      cwd: "/home/o'brien/proj",
      agentType: 'claude-code',
    });
    expect(built.usedPromptFile).toBe(false);
    expect(built.command).toBe(
      "kookr spawn -C '/home/o'\\''brien/proj' -a claude-code \"do the thing\"",
    );
  });

  test('a single quote in the prompt stays on the quoted one-liner path', () => {
    // A single quote is safe inside double quotes and is NOT hook-sensitive, so
    // it must not trip the prompt-file fallback.
    const built = buildSpawnCommand({
      prompt: "it's working now",
      cwd: CWD,
      agentType: 'claude-code',
    });
    expect(built.usedPromptFile).toBe(false);
    expect(built.command).toBe('kookr spawn -C /home/user/proj -a claude-code "it\'s working now"');
  });

  test('a bang in criteria is single-quoted so history expansion cannot fire', () => {
    // `!` cannot be neutralized inside bash double quotes; single quotes make it
    // literal. criteria has no --prompt-file escape hatch, so quoting must be safe.
    const built = buildSpawnCommand({
      prompt: 'do the thing',
      cwd: CWD,
      agentType: 'claude-code',
      criteria: 'must be !important',
    });
    expect(built.usedPromptFile).toBe(false);
    expect(built.command).toBe(
      "kookr spawn -C /home/user/proj -a claude-code --criteria 'must be !important' \"do the thing\"",
    );
  });

  test('a single quote in criteria is emitted with the escaped-quote idiom', () => {
    const built = buildSpawnCommand({
      prompt: 'do the thing',
      cwd: CWD,
      agentType: 'claude-code',
      criteria: "don't break prod",
    });
    expect(built.usedPromptFile).toBe(false);
    expect(built.command).toBe(
      "kookr spawn -C /home/user/proj -a claude-code --criteria 'don'\\''t break prod' \"do the thing\"",
    );
  });

  test('round-robin omits -a so the server default applies', () => {
    const built = buildSpawnCommand({
      prompt: 'do the thing',
      cwd: CWD,
      agentType: 'round-robin',
    });
    expect(built.command).toBe('kookr spawn -C /home/user/proj "do the thing"');
  });

  test('leading and trailing whitespace in prompt and cwd is trimmed', () => {
    const built = buildSpawnCommand({
      prompt: '  do the thing  ',
      cwd: `  ${CWD}  `,
      agentType: 'claude-code',
    });
    expect(built.command).toBe('kookr spawn -C /home/user/proj -a claude-code "do the thing"');
  });

  test('a Unicode prompt with no shell metacharacters stays on the argv path verbatim', () => {
    const built = buildSpawnCommand({
      prompt: 'café ☕ déjà vu — 日本語 🚀',
      cwd: CWD,
      agentType: 'claude-code',
    });
    expect(built.usedPromptFile).toBe(false);
    expect(built.command).toBe(
      'kookr spawn -C /home/user/proj -a claude-code "café ☕ déjà vu — 日本語 🚀"',
    );
  });

  test('a lone heredoc-delimiter-shaped single-line prompt stays on the argv path', () => {
    // No quotes/metacharacters/newlines, so the fallback never triggers; the
    // string is emitted as an ordinary double-quoted positional.
    const built = buildSpawnCommand({
      prompt: 'SPAWN_PROMPT_EOF',
      cwd: CWD,
      agentType: 'claude-code',
    });
    expect(built.usedPromptFile).toBe(false);
    expect(built.command).toBe('kookr spawn -C /home/user/proj -a claude-code "SPAWN_PROMPT_EOF"');
  });

  test('a tab in the prompt does not trip the fallback and is emitted literally', () => {
    const built = buildSpawnCommand({
      prompt: 'left\tright',
      cwd: CWD,
      agentType: 'claude-code',
    });
    expect(built.usedPromptFile).toBe(false);
    expect(built.command).toBe('kookr spawn -C /home/user/proj -a claude-code "left\tright"');
  });

  test('a blank working directory drops the -C flag entirely', () => {
    const built = buildSpawnCommand({
      prompt: 'do the thing',
      cwd: '   ',
      agentType: 'claude-code',
    });
    expect(built.usedPromptFile).toBe(false);
    expect(built.command).toBe('kookr spawn -a claude-code "do the thing"');
  });

  test('a prompt that trims to empty stays on the argv path as an empty positional', () => {
    // trim() runs before the PROMPT_ARGV_UNSAFE test, so a whitespace-only prompt
    // (including one made of newlines) becomes "" and never trips the fallback.
    const built = buildSpawnCommand({
      prompt: '\n\n  \n',
      cwd: CWD,
      agentType: 'claude-code',
    });
    expect(built.usedPromptFile).toBe(false);
    expect(built.command).toBe('kookr spawn -C /home/user/proj -a claude-code ""');
  });
});

describe('buildSpawnCommand — cwd/criteria have no --prompt-file escape hatch', () => {
  // cwd and criteria are ALWAYS single-quoted (never diverted to a file), so
  // their quoting is the only thing standing between a hostile value and shell
  // execution on paste. These pin that injection-shaped payloads stay inert.
  test.each([
    ['command substitution', '/tmp/$(rm -rf /)', "'/tmp/$(rm -rf /)'"],
    ['backtick substitution', '/tmp/`id`', "'/tmp/`id`'"],
    ['statement separator', '/tmp/x; rm -rf /', "'/tmp/x; rm -rf /'"],
    ['logical-and chain', '/tmp && curl evil', "'/tmp && curl evil'"],
    ['variable expansion', '/tmp/$HOME', "'/tmp/$HOME'"],
    ['embedded newline', '/tmp/a\nrm -rf /', "'/tmp/a\nrm -rf /'"],
  ])('a %s payload in cwd is single-quoted, not interpolated', (_label, cwd, quoted) => {
    const built = buildSpawnCommand({ prompt: 'do the thing', cwd, agentType: 'claude-code' });
    expect(built.usedPromptFile).toBe(false);
    expect(built.command).toBe(`kookr spawn -C ${quoted} -a claude-code "do the thing"`);
  });

  test.each([
    ['command substitution', 'ok $(rm -rf /)', "'ok $(rm -rf /)'"],
    ['backtick substitution', 'ok `id`', "'ok `id`'"],
    ['statement separator', 'ok; rm -rf /', "'ok; rm -rf /'"],
    ['logical-and chain', 'ok && curl evil', "'ok && curl evil'"],
    ['embedded newline', 'line one\nrm -rf /', "'line one\nrm -rf /'"],
  ])('a %s payload in criteria is single-quoted, not interpolated', (_label, criteria, quoted) => {
    const built = buildSpawnCommand({
      prompt: 'do the thing',
      cwd: CWD,
      agentType: 'claude-code',
      criteria,
    });
    expect(built.usedPromptFile).toBe(false);
    expect(built.command).toBe(
      `kookr spawn -C /home/user/proj -a claude-code --criteria ${quoted} "do the thing"`,
    );
  });

  test('a hostile cwd rides along even when the prompt takes the heredoc path', () => {
    const built = buildSpawnCommand({
      prompt: 'run `ls`',
      cwd: '/tmp/$(id)',
      agentType: 'claude-code',
      criteria: 'ok; echo done',
    });
    expect(built.usedPromptFile).toBe(true);
    expect(built.command).toBe(promptFileForm({
      delimiter: 'SPAWN_PROMPT_EOF',
      body: 'run `ls`',
      flags: `-C '/tmp/$(id)' -a claude-code ${PROMPT_FILE_FLAG} --criteria 'ok; echo done'`,
    }));
  });
});

describe('buildSpawnCommand — prompt-file (heredoc) fallback', () => {
  test('a prompt with double quotes falls back to an exact --prompt-file heredoc', () => {
    const built = buildSpawnCommand({
      prompt: 'say "hello" to the world',
      cwd: CWD,
      agentType: 'claude-code',
    });
    expect(built.usedPromptFile).toBe(true);
    expect(built.command).toBe(promptFileForm({
      delimiter: 'SPAWN_PROMPT_EOF',
      body: 'say "hello" to the world',
      flags: `-C /home/user/proj -a claude-code ${PROMPT_FILE_FLAG}`,
    }));
  });

  test.each([
    ['backtick', 'run `whoami` now'],
    ['dollar', 'echo $HOME please'],
    ['bang', 'do it now!'],
    ['backslash', 'path C:\\temp'],
    ['newline', 'line one\nline two'],
  ])('a prompt with a %s token uses the exact prompt-file form', (_label, prompt) => {
    // These five characters are exactly what PROMPT_ARGV_UNSAFE matches, so each
    // must divert to the heredoc. Assert the full command (not just fragments)
    // so a regression that reorders flags or corrupts the mktemp/redirect line
    // cannot slip through.
    const built = buildSpawnCommand({ prompt, cwd: CWD, agentType: 'claude-code' });
    expect(built.usedPromptFile).toBe(true);
    expect(built.command).toBe(promptFileForm({
      delimiter: 'SPAWN_PROMPT_EOF',
      body: prompt,
      flags: `-C /home/user/proj -a claude-code ${PROMPT_FILE_FLAG}`,
    }));
  });

  test('a lone carriage return (no newline) still diverts to the heredoc verbatim', () => {
    // PROMPT_ARGV_UNSAFE matches \r on its own; the \r?\n line split leaves the
    // whole string as one body line, so the base delimiter is safe.
    const built = buildSpawnCommand({
      prompt: 'line one\rline two',
      cwd: CWD,
      agentType: 'claude-code',
    });
    expect(built.usedPromptFile).toBe(true);
    expect(built.command).toBe(promptFileForm({
      delimiter: 'SPAWN_PROMPT_EOF',
      body: 'line one\rline two',
      flags: `-C /home/user/proj -a claude-code ${PROMPT_FILE_FLAG}`,
    }));
  });

  test('a CRLF-terminated delimiter line is still detected and the delimiter extends', () => {
    // The \r?\n split is what lets collision detection see a CRLF-terminated
    // delimiter line; without CRLF-awareness the base delimiter would be reused
    // and the heredoc would terminate early on paste.
    const built = buildSpawnCommand({
      prompt: 'a "q"\r\nSPAWN_PROMPT_EOF\r\ntail',
      cwd: CWD,
      agentType: 'claude-code',
    });
    expect(built.usedPromptFile).toBe(true);
    expect(built.command).toBe(promptFileForm({
      delimiter: 'SPAWN_PROMPT_EOF_',
      body: 'a "q"\r\nSPAWN_PROMPT_EOF\r\ntail',
      flags: `-C /home/user/proj -a claude-code ${PROMPT_FILE_FLAG}`,
    }));
  });

  test('the prompt is trimmed before the heredoc body is written', () => {
    // Outer whitespace is stripped; an interior newline and quote (the actual
    // fallback triggers) survive. Guards against a regression that trims only on
    // the argv branch or forgets to trim before embedding the heredoc body.
    const built = buildSpawnCommand({
      prompt: '  line "one"\nline two  ',
      cwd: CWD,
      agentType: 'claude-code',
    });
    expect(built.usedPromptFile).toBe(true);
    expect(built.command).toBe(promptFileForm({
      delimiter: 'SPAWN_PROMPT_EOF',
      body: 'line "one"\nline two',
      flags: `-C /home/user/proj -a claude-code ${PROMPT_FILE_FLAG}`,
    }));
  });

  test('a CRLF prompt keeps the carriage returns in the heredoc body verbatim', () => {
    const built = buildSpawnCommand({
      prompt: 'line one\r\nline "two"',
      cwd: CWD,
      agentType: 'claude-code',
    });
    expect(built.usedPromptFile).toBe(true);
    expect(built.command).toBe(promptFileForm({
      delimiter: 'SPAWN_PROMPT_EOF',
      body: 'line one\r\nline "two"',
      flags: `-C /home/user/proj -a claude-code ${PROMPT_FILE_FLAG}`,
    }));
  });

  test('a Unicode prompt on the fallback path is written verbatim', () => {
    const built = buildSpawnCommand({
      prompt: 'ship it 🚀 — run `deploy` "now"\n日本語 déjà',
      cwd: CWD,
      agentType: 'claude-code',
    });
    expect(built.usedPromptFile).toBe(true);
    expect(built.command).toBe(promptFileForm({
      delimiter: 'SPAWN_PROMPT_EOF',
      body: 'ship it 🚀 — run `deploy` "now"\n日本語 déjà',
      flags: `-C /home/user/proj -a claude-code ${PROMPT_FILE_FLAG}`,
    }));
  });

  test('a prompt line equal to the delimiter extends the delimiter (no early terminate)', () => {
    const built = buildSpawnCommand({
      prompt: 'first line has a "quote"\nSPAWN_PROMPT_EOF\nlast line',
      cwd: CWD,
      agentType: 'claude-code',
    });
    expect(built.usedPromptFile).toBe(true);
    // The extended delimiter must not appear as a standalone line inside the body.
    expect(built.command).toBe(promptFileForm({
      delimiter: 'SPAWN_PROMPT_EOF_',
      body: 'first line has a "quote"\nSPAWN_PROMPT_EOF\nlast line',
      flags: `-C /home/user/proj -a claude-code ${PROMPT_FILE_FLAG}`,
    }));
  });

  test('delimiter extension repeats until no body line collides', () => {
    // Body already contains both SPAWN_PROMPT_EOF and SPAWN_PROMPT_EOF_ as lines,
    // so the delimiter must extend twice to SPAWN_PROMPT_EOF__.
    const built = buildSpawnCommand({
      prompt: 'has a "quote"\nSPAWN_PROMPT_EOF\nSPAWN_PROMPT_EOF_\ntail',
      cwd: CWD,
      agentType: 'claude-code',
    });
    expect(built.usedPromptFile).toBe(true);
    expect(built.command).toBe(promptFileForm({
      delimiter: 'SPAWN_PROMPT_EOF__',
      body: 'has a "quote"\nSPAWN_PROMPT_EOF\nSPAWN_PROMPT_EOF_\ntail',
      flags: `-C /home/user/proj -a claude-code ${PROMPT_FILE_FLAG}`,
    }));
  });

  test('a delimiter collision only counts a full-line match, not a substring', () => {
    // "xSPAWN_PROMPT_EOF" and "SPAWN_PROMPT_EOFx" are not standalone delimiter
    // lines, so the base delimiter is safe and must not be extended.
    const built = buildSpawnCommand({
      prompt: 'a "q"\nxSPAWN_PROMPT_EOF\nSPAWN_PROMPT_EOFx',
      cwd: CWD,
      agentType: 'claude-code',
    });
    expect(built.usedPromptFile).toBe(true);
    expect(built.command).toBe(promptFileForm({
      delimiter: 'SPAWN_PROMPT_EOF',
      body: 'a "q"\nxSPAWN_PROMPT_EOF\nSPAWN_PROMPT_EOFx',
      flags: `-C /home/user/proj -a claude-code ${PROMPT_FILE_FLAG}`,
    }));
  });

  test('the fallback still carries criteria after --prompt-file', () => {
    const built = buildSpawnCommand({
      prompt: 'say "hi"',
      cwd: CWD,
      agentType: 'claude-code',
      criteria: 'green CI',
    });
    expect(built.usedPromptFile).toBe(true);
    expect(built.command).toBe(promptFileForm({
      delimiter: 'SPAWN_PROMPT_EOF',
      body: 'say "hi"',
      flags: `-C /home/user/proj -a claude-code ${PROMPT_FILE_FLAG} --criteria 'green CI'`,
    }));
  });

  test('round-robin on the fallback path omits -a', () => {
    const built = buildSpawnCommand({
      prompt: 'run `ls`',
      cwd: CWD,
      agentType: 'round-robin',
    });
    expect(built.usedPromptFile).toBe(true);
    expect(built.command).toBe(promptFileForm({
      delimiter: 'SPAWN_PROMPT_EOF',
      body: 'run `ls`',
      flags: `-C /home/user/proj ${PROMPT_FILE_FLAG}`,
    }));
  });
});
