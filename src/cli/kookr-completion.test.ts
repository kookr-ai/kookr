import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { HELP_TEXT, main } from '../../bin/kookr.js';
import {
  getRootCompletionCommands,
  KOOKR_COMPLETION_COMMANDS,
  renderCompletion,
  runCompletionCli,
} from './kookr-completion.js';

const execFileAsync = promisify(execFile);

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function completeBash(words: string[], cword = words.length - 1): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), 'kookr-completion-'));
  const scriptPath = join(dir, 'kookr-completion.bash');
  try {
    await writeFile(scriptPath, renderCompletion('bash'));
    const command = [
      `source ${shellQuote(scriptPath)}`,
      `COMP_WORDS=(${words.map(shellQuote).join(' ')})`,
      `COMP_CWORD=${cword}`,
      '_kookr',
      'printf "%s\\n" "${COMPREPLY[@]}"',
    ].join('; ');
    const { stdout } = await execFileAsync('bash', ['-lc', command]);
    return stdout.split('\n').filter(Boolean);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const hasZsh = (() => {
  try {
    execFileSync('zsh', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

async function completeZsh(words: string[], current = words.length): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), 'kookr-completion-zsh-'));
  const scriptPath = join(dir, 'kookr-completion.zsh');
  try {
    await writeFile(scriptPath, renderCompletion('zsh'));
    const command = [
      'compadd() { for arg in "$@"; do [[ "$arg" == "--" ]] && continue; print -r -- "$arg"; done }',
      `words=(${words.map(shellQuote).join(' ')})`,
      `CURRENT=${current}`,
      `source ${shellQuote(scriptPath)}`,
    ].join('; ');
    const { stdout } = await execFileAsync('zsh', ['-fc', command]);
    return stdout.split('\n').filter(Boolean);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeDeps() {
  const logs: string[] = [];
  const errors: string[] = [];
  const codes: number[] = [];
  return {
    out: { log: (msg: string) => logs.push(msg) },
    err: { error: (msg: string) => errors.push(msg) },
    exit: ((code: number) => {
      codes.push(code);
    }) as (code: number) => never,
    logs,
    errors,
    codes,
  };
}

function publicCommandsFromHelp(): string[] {
  const commands = new Set<string>();
  for (const match of HELP_TEXT.matchAll(/^\s+kookr\s+([a-z|]+)/gm)) {
    for (const command of match[1].split('|')) {
      if (command !== '') commands.add(command);
    }
  }
  return [...commands].sort();
}

function publicSubcommandsFromHelp(): Map<string, string[]> {
  const subcommands = new Map<string, Set<string>>();
  for (const match of HELP_TEXT.matchAll(/^\s+kookr\s+([a-z]+)\s+([a-z|]+)/gm)) {
    const [, command, subcommandsText] = match;
    if (command === undefined || subcommandsText === undefined) continue;
    const values = subcommands.get(command) ?? new Set<string>();
    for (const subcommand of subcommandsText.split('|')) {
      if (subcommand !== '') values.add(subcommand);
    }
    subcommands.set(command, values);
  }
  return new Map([...subcommands.entries()].map(([command, values]) => [command, [...values].sort()]));
}

describe('kookr completion metadata', () => {
  it('covers every public dispatcher command listed in root help', () => {
    expect(getRootCompletionCommands().toSorted()).toEqual(publicCommandsFromHelp());
  });

  it('covers public subcommands listed in root help', () => {
    for (const [commandName, expectedSubcommands] of publicSubcommandsFromHelp()) {
      const command = KOOKR_COMPLETION_COMMANDS.find((item) => item.name === commandName);
      expect(command?.subcommands?.toSorted()).toEqual(expectedSubcommands);
    }
  });
});

describe('renderCompletion', () => {
  it('renders a bash completion with root commands, subcommands, and flags', () => {
    const script = renderCompletion('bash');
    expect(script).toContain('complete -F _kookr kookr');
    expect(script).toContain('spawn signal doctor status command ralph drain resume maintenance push completion');
    expect(script).toContain('compgen -W "outcome"');
    expect(script).toContain('status pause resume cancel');
    expect(script).toContain('--prompt-file');
    expect(script).toContain('compgen -W "claude-code codex-cli"');
    expect(script).toContain('compgen -W "none minimal low medium high xhigh max"');
    expect(script).toContain('compgen -W "warn block skip"');
    expect(script).toContain('--dedupe=warn');
    expect(script).toContain('--dry-run');
    expect(script).toContain('completion-ready');
    expect(script).toContain('bash zsh');
    expect(script).not.toContain('compgen -W "status -h --help"');
  });

  it('renders a zsh completion with root commands, subcommands, and flags', () => {
    const script = renderCompletion('zsh');
    expect(script).toContain('#compdef kookr');
    expect(script).toContain('root_commands=(spawn signal doctor status command ralph drain resume maintenance push completion)');
    expect(script).toContain('compadd outcome');
    expect(script).toContain('compadd -- status pause resume cancel');
    expect(script).toContain('compadd claude-code codex-cli');
    expect(script).toContain('compadd none minimal low medium high xhigh max');
    expect(script).toContain('compadd warn block skip');
    expect(script).toContain('compadd -- --dedupe=warn --dedupe=block --dedupe=skip');
    expect(script).toContain('--json');
    expect(script).toContain('--task-id');
    expect(script).toContain('--max-age-days');
    expect(script).toContain('compadd -- $completion_shells');
  });
});

describe('bash completion behavior', () => {
  it('completes root commands', async () => {
    await expect(completeBash(['kookr', ''])).resolves.toEqual(
      expect.arrayContaining(['spawn', 'status', 'ralph', 'completion']),
    );
  });

  it('completes Ralph subcommands', async () => {
    await expect(completeBash(['kookr', 'ralph', ''])).resolves.toEqual(
      expect.arrayContaining(['status', 'pause', 'resume', 'cancel']),
    );
  });

  it('completes flag values after a space-form flag', async () => {
    await expect(completeBash(['kookr', 'spawn', '--agent', ''])).resolves.toEqual([
      'claude-code',
      'codex-cli',
    ]);
  });

  it('completes equals-form flag values', async () => {
    await expect(completeBash(['kookr', 'spawn', '--dedupe='])).resolves.toEqual([
      '--dedupe=warn',
      '--dedupe=block',
      '--dedupe=skip',
    ]);
  });

  it('leaves resume without subcommand completions', async () => {
    await expect(completeBash(['kookr', 'resume', ''])).resolves.toEqual([]);
  });

  it('completes signal kinds', async () => {
    await expect(completeBash(['kookr', 'signal', ''])).resolves.toEqual(
      expect.arrayContaining(['completion-ready', '--note', '--task-id', '--json']),
    );
  });

  it('completes doctor flags', async () => {
    await expect(completeBash(['kookr', 'doctor', ''])).resolves.toEqual(['--json', '-h', '--help']);
  });

  it('completes command subcommands', async () => {
    await expect(completeBash(['kookr', 'command', ''])).resolves.toEqual(['outcome']);
    await expect(completeBash(['kookr', 'command', 'outcome', ''])).resolves.toEqual([]);
  });

  it('completes maintenance subcommands', async () => {
    await expect(completeBash(['kookr', 'maintenance', ''])).resolves.toEqual(['prune', 'backup']);
  });

  it('completes maintenance flags for the selected verb', async () => {
    await expect(completeBash(['kookr', 'maintenance', 'prune', ''])).resolves.toEqual([
      '--dry-run',
      '--max-age-days',
      '--dir',
      '--json',
    ]);
    await expect(completeBash(['kookr', 'maintenance', 'backup', ''])).resolves.toEqual([
      '--dir',
      '--out',
      '--json',
    ]);
  });

  it('completes push subcommands', async () => {
    await expect(completeBash(['kookr', 'push', ''])).resolves.toEqual(['test']);
  });

  it('completes completion shells', async () => {
    await expect(completeBash(['kookr', 'completion', ''])).resolves.toEqual(['bash', 'zsh']);
  });
});

describe.skipIf(!hasZsh)('zsh completion behavior', () => {
  it('completes root commands', async () => {
    await expect(completeZsh(['kookr', ''], 2)).resolves.toEqual(
      expect.arrayContaining(['spawn', 'status', 'ralph', 'completion']),
    );
  });

  it('completes completion shells', async () => {
    await expect(completeZsh(['kookr', 'completion', ''], 3)).resolves.toEqual(['bash', 'zsh']);
  });

  it('completes doctor flags', async () => {
    await expect(completeZsh(['kookr', 'doctor', ''], 3)).resolves.toEqual(['--json', '-h', '--help']);
  });

  it('completes command subcommands', async () => {
    await expect(completeZsh(['kookr', 'command', ''], 3)).resolves.toEqual(['outcome']);
    await expect(completeZsh(['kookr', 'command', 'outcome', ''], 4)).resolves.toEqual([]);
  });

  it('completes signal kinds and flags', async () => {
    await expect(completeZsh(['kookr', 'signal', ''], 3)).resolves.toEqual(
      expect.arrayContaining(['completion-ready', '--note', '--task-id', '--json']),
    );
  });

  it('completes maintenance subcommands and verb-specific flags', async () => {
    await expect(completeZsh(['kookr', 'maintenance', ''], 3)).resolves.toEqual(['prune', 'backup']);
    await expect(completeZsh(['kookr', 'maintenance', 'prune', ''], 4)).resolves.toEqual([
      '--dry-run',
      '--max-age-days',
      '--dir',
      '--json',
    ]);
    await expect(completeZsh(['kookr', 'maintenance', 'backup', ''], 4)).resolves.toEqual([
      '--dir',
      '--out',
      '--json',
    ]);
  });

  it('completes flag values after a space-form flag', async () => {
    await expect(completeZsh(['kookr', 'spawn', '--agent', ''], 4)).resolves.toEqual([
      'claude-code',
      'codex-cli',
    ]);
  });

  it('completes equals-form flag values', async () => {
    await expect(completeZsh(['kookr', 'spawn', '--dedupe='], 3)).resolves.toEqual([
      '--dedupe=warn',
      '--dedupe=block',
      '--dedupe=skip',
    ]);
  });
});

describe('runCompletionCli', () => {
  it('prints bash completion to stdout', async () => {
    const deps = makeDeps();
    await runCompletionCli({ argv: ['bash'], out: deps.out, err: deps.err, exit: deps.exit });
    expect(deps.codes).toEqual([0]);
    expect(deps.errors).toEqual([]);
    expect(deps.logs[0]).toContain('complete -F _kookr kookr');
  });

  it('prints usage help', async () => {
    const deps = makeDeps();
    await runCompletionCli({ argv: ['--help'], out: deps.out, err: deps.err, exit: deps.exit });
    expect(deps.codes).toEqual([0]);
    expect(deps.errors).toEqual([]);
    expect(deps.logs[0]).toContain('Usage: kookr completion <bash|zsh>');
  });

  it.each([['fish'], [], ['bash', 'extra']])('rejects invalid args %j', async (argv) => {
    const deps = makeDeps();
    await runCompletionCli({ argv, out: deps.out, err: deps.err, exit: deps.exit });
    expect(deps.codes).toEqual([2]);
    expect(deps.errors.join('\n')).toContain('Usage: kookr completion <bash|zsh>');
  });
});

describe('kookr dispatcher completion command', () => {
  it('dispatches completion through the main binary', async () => {
    const deps = makeDeps();
    await main({ argv: ['completion', 'zsh'], env: {}, out: deps.out, err: deps.err, exit: deps.exit });
    expect(deps.codes).toEqual([0]);
    expect(deps.errors).toEqual([]);
    expect(deps.logs[0]).toContain('#compdef kookr');
  });

  it('prints completion through bin/kookr.js', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['bin/kookr.js', 'completion', 'bash'], {
      cwd: process.cwd(),
    });
    expect(stderr).toBe('');
    expect(stdout).toContain('complete -F _kookr kookr');
  });
});
