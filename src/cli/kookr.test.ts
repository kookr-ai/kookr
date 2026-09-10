import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { HELP_TEXT, main } from '../../bin/kookr.js';
import { HELP_TEXT as RALPH_HELP_TEXT } from '../../bin/kookr-ralph.js';
import { HELP_TEXT as SPAWN_HELP_TEXT } from '../../bin/kookr-spawn.js';
import { HELP_TEXT as STATUS_HELP_TEXT } from '../../bin/kookr-status.js';

const execFileAsync = promisify(execFile);

function makeDeps() {
  const logs: string[] = [];
  const errors: string[] = [];
  const codes: number[] = [];
  return {
    out: {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => errors.push(msg),
    },
    err: { error: (msg: string) => errors.push(msg) },
    exit: ((code: number) => {
      codes.push(code);
    }) as (code: number) => never,
    logs,
    errors,
    codes,
  };
}

describe('kookr dispatcher', () => {
  it('prints root help', async () => {
    const deps = makeDeps();
    await main({ argv: ['--help'], env: {}, out: deps.out, err: deps.err, exit: deps.exit });
    expect(deps.codes).toEqual([0]);
    expect(deps.logs).toEqual([HELP_TEXT]);
  });

  it('dispatches spawn help through the main binary', async () => {
    const deps = makeDeps();
    await main({ argv: ['spawn', '--help'], env: {}, out: deps.out, err: deps.err, exit: deps.exit });
    expect(deps.codes).toEqual([0]);
    expect(deps.logs).toEqual([SPAWN_HELP_TEXT]);
    expect(deps.errors).toEqual([]);
  });

  it('dispatches status help through the main binary', async () => {
    const deps = makeDeps();
    await main({ argv: ['status', '--help'], env: {}, out: deps.out, err: deps.err, exit: deps.exit });
    expect(deps.codes).toEqual([0]);
    expect(deps.logs).toEqual([STATUS_HELP_TEXT]);
    expect(deps.errors).toEqual([]);
  });

  it('dispatches Ralph help through the main binary', async () => {
    const deps = makeDeps();
    await main({ argv: ['ralph', '--help'], env: {}, out: deps.out, err: deps.err, exit: deps.exit });
    expect(deps.codes).toEqual([0]);
    expect(deps.logs).toEqual([RALPH_HELP_TEXT]);
    expect(deps.errors).toEqual([]);
  });

  it('dispatches playbook without forcing process.exit (so large --json output drains)', async () => {
    // The playbook command sets process.exitCode and returns instead of calling
    // the injected exit; process.exit truncates buffered stdout mid-write, which
    // would corrupt a large `--json` listing piped to a slow consumer.
    const savedExitCode = process.exitCode;
    const deps = makeDeps();
    try {
      await main({ argv: ['playbook', '--help'], env: {}, out: deps.out, err: deps.err, exit: deps.exit });
      expect(deps.codes).toEqual([]); // natural exit path — injected exit not called
      expect(deps.logs.join('\n')).toContain('kookr playbook list');
      expect(deps.errors).toEqual([]);
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('rejects unknown subcommands instead of starting the server', async () => {
    const deps = makeDeps();
    await main({ argv: ['wat'], env: {}, out: deps.out, err: deps.err, exit: deps.exit });
    expect(deps.codes).toEqual([2]);
    expect(deps.errors.join('\n')).toContain('Unknown command: wat');
  });

  it('dispatches doctor help through the main binary', async () => {
    const deps = makeDeps();
    await main({ argv: ['doctor', '--help'], env: {}, out: deps.out, err: deps.err, exit: deps.exit });
    expect(deps.codes).toEqual([0]);
    expect(deps.logs.join('\n')).toContain('kookr doctor');
    expect(deps.errors).toEqual([]);
  });

  it.each([
    [['--help'], 'kookr - local AI agent supervisor'],
    [['spawn', '--help'], 'kookr spawn'],
    [['status', '--help'], 'kookr status'],
    [['doctor', '--help'], 'kookr doctor'],
    [['ralph', '--help'], 'kookr ralph'],
    [['completion', 'bash'], 'complete -F _kookr kookr'],
  ])('prints command output through bin/kookr.js %s', async (argv, helpNeedle) => {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['bin/kookr.js', ...argv], {
      cwd: process.cwd(),
    });
    expect(stderr).toBe('');
    expect(stdout).toContain(helpNeedle);
  });

  // Guards issue #3048: the root help once advertised --json for only 7 commands
  // while ~22 subcommands had gained the flag. This derives the authoritative set
  // of --json-capable commands straight from source and checks it against the help
  // sentence in both directions, so the sentence cannot silently drift out of date
  // again (a new --json command that goes unlisted, or a listed command that loses
  // the flag).
  it('advertises --json for every command that implements the envelope', () => {
    // Command implementations that actually parse a --json flag live in two
    // places: TypeScript under src/cli/kookr-*.ts and the hand-written
    // JS entry points under bin/kookr-*.js. Real envelope commands parse the
    // flag one of three ways: `x === '--json'`, `case '--json'`, or
    // `argv.includes('--json')` (either quote style). Files that only list
    // '--json' in a flag registry (completion) or a comment are not matched.
    // A command that parsed the flag some fourth way (e.g. `argv.indexOf`) would
    // escape this scan; the three idioms below are the only ones in use today.
    const JSON_PARSE = /(===|case|includes\()\s*['"]--json['"]/;
    const sources: Array<{ dir: string; ext: string }> = [
      { dir: 'src/cli', ext: '.ts' },
      { dir: 'bin', ext: '.js' },
    ];

    const commandWords = new Set<string>();
    for (const { dir, ext } of sources) {
      const abs = join(process.cwd(), dir);
      for (const name of readdirSync(abs)) {
        if (!name.startsWith('kookr-') || !name.endsWith(ext)) continue;
        if (name.endsWith(`.test${ext}`) || name.endsWith('.d.ts')) continue;
        const body = readFileSync(join(abs, name), 'utf8');
        if (!JSON_PARSE.test(body)) continue;
        // kookr-ops-digest.ts backs both `ops digest` and `ops timers`; the
        // help lists them under the shared `ops` word.
        const word = name.slice('kookr-'.length, -ext.length).replace(/^ops-digest$/, 'ops');
        commandWords.add(word);
      }
    }

    // The --json capability sentence spans from "Use --json" to its first period.
    // The command list has no internal period, so this captures the whole list.
    const sentence = HELP_TEXT.match(/Use --json[\s\S]*?\./)?.[0] ?? '';
    expect(sentence).not.toBe('');

    // Everything after the colon is the comma-separated command list. Tokenise on
    // word boundaries (splitting `ops digest` and `drain/resume` into their parts)
    // so matching is exact rather than a loose substring test.
    const listPart = sentence.split(':').slice(1).join(':');
    const advertised = new Set(
      listPart
        .toLowerCase()
        .split(/[\s,./]+/)
        .filter((token) => token && token !== 'and'),
    );

    // Sub-forms/aliases of a detected command that appear as their own words in
    // the list (`ops digest`/`ops timers` → ops, `resume` → drain). Consulted only
    // by the reverse check, so a new unregistered sub-form fails loudly.
    const EXPANSIONS = new Set<string>(['digest', 'timers', 'resume']);

    // Floor guard: catches a scan that silently finds nothing (wrong dir, broken
    // regex), which would otherwise make both checks below pass vacuously.
    expect(commandWords.size).toBeGreaterThan(15);

    // Forward: every --json-capable command is advertised.
    const missing = [...commandWords].filter((word) => !advertised.has(word)).sort();
    expect(missing).toEqual([]);

    // Reverse: every advertised command word maps to a real --json command (or a
    // known sub-form of one), so a stale entry cannot linger after a command drops
    // the flag or is renamed.
    const stale = [...advertised]
      .filter((word) => !commandWords.has(word) && !EXPANSIONS.has(word))
      .sort();
    expect(stale).toEqual([]);
  });

  it('dispatches subcommand JSON help through the main binary', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['bin/kookr.js', 'status', '--json', '--help'], {
      cwd: process.cwd(),
    });
    const envelope = JSON.parse(stdout);
    expect(stderr).toBe('');
    expect(envelope).toMatchObject({
      ok: true,
      code: 'OK',
      message: 'Help',
    });
    expect(envelope.details.help).toContain('kookr status');
  });
});

describe('deprecated standalone aliases', () => {
  it.each([
    ['bin/kookr-spawn.js', '`kookr-spawn` is deprecated; use `kookr spawn`.', 'kookr spawn'],
    ['bin/kookr-status.js', '`kookr-status` is deprecated; use `kookr status`.', 'kookr status'],
    ['bin/kookr-ralph.js', '`kookr-ralph` is deprecated; use `kookr ralph`.', 'kookr ralph'],
  ])('%s warns and still prints help', async (script, warning, helpNeedle) => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, '--help'], {
      cwd: process.cwd(),
    });
    expect(stderr).toContain(warning);
    expect(stdout).toContain(helpNeedle);
  });

  it.each([
    ['bin/kookr-spawn.js', 'kookr spawn'],
    ['bin/kookr-status.js', 'kookr status'],
    ['bin/kookr-ralph.js', 'kookr ralph'],
  ])('%s suppresses the deprecation warning in JSON mode', async (script, helpNeedle) => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, '--json', '--help'], {
      cwd: process.cwd(),
    });
    const envelope = JSON.parse(stdout);
    expect(stderr).toBe('');
    expect(envelope).toMatchObject({ ok: true, code: 'OK' });
    expect(envelope.details.help).toContain(helpNeedle);
  });
});
