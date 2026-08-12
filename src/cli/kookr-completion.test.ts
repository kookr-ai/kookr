import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json' with { type: 'json' };
import { HELP_TEXT, main } from '../../bin/kookr.js';
import {
  COMPLETION_SHELLS,
  getRootCompletionCommands,
  KOOKR_COMPLETION_COMMANDS,
  renderCompletion,
  runCompletionCli,
} from './kookr-completion.js';

const execFileAsync = promisify(execFile);

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  for (const match of HELP_TEXT.matchAll(/^\s+kookr\s+([a-z|-]+)/gm)) {
    for (const command of match[1].split('|')) {
      if (command !== '') commands.add(command);
    }
  }
  return [...commands].sort();
}

function publicSubcommandsFromHelp(): Map<string, string[]> {
  const subcommands = new Map<string, Set<string>>();
  for (const match of HELP_TEXT.matchAll(/^\s+kookr\s+([a-z-]+)\s+([a-z|]+)/gm)) {
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
    expect(script).toContain('spawn signal issue doctor status ops github logs command ralph schedule drain resume maintenance lesson effort-split emission value-density queue-feeder retro-verify reflect pr-checklist context-pack signal-emit push completion');
    expect(script).toContain('compgen -W "spawn signal issue doctor status ops github logs command ralph schedule drain resume maintenance lesson effort-split emission value-density queue-feeder retro-verify reflect pr-checklist context-pack signal-emit push completion -h --help -v --version"');
    expect(script).toContain('compgen -W "status --json -h --help"');
    expect(script).toContain('compgen -W "outcome"');
    expect(script).toContain('status pause resume cancel');
    expect(script).toContain('list claim release owner');
    expect(script).toContain('verify doctor');
    expect(script).toContain('status drain remember yield');
    expect(script).toContain('compgen -W "--json --days --kookr-dir -h --help"');
    expect(script).toContain('--from-command');
    expect(script).toContain('--run-commands');
    expect(script).toContain('compgen -W "--spec --out --review-out --plugin-dir --cache-dir --json -h --help"');
    expect(script).toContain('--prompt-file');
    expect(script).toContain('compgen -W "claude-code codex-cli grok-build"');
    expect(script).toContain('compgen -W "none minimal low medium high xhigh max ultra"');
    expect(script).toContain('compgen -W "warn block skip"');
    expect(script).toContain('--dedupe=warn');
    expect(script).toContain('--fail-on=critical');
    expect(script).toContain('--dry-run');
    expect(script).toContain('completion-ready');
    expect(script).toContain('bash zsh');
    expect(script).not.toContain('compgen -W "status -h --help"');
  });

  it('renders a zsh completion with root commands, subcommands, and flags', () => {
    const script = renderCompletion('zsh');
    expect(script).toContain('#compdef kookr');
    expect(script).toContain('root_commands=(spawn signal issue doctor status ops github logs command ralph schedule drain resume maintenance lesson effort-split emission value-density queue-feeder retro-verify reflect pr-checklist context-pack signal-emit push completion)');
    expect(script).toContain('compadd -- status --json -h --help');
    expect(script).toContain('compadd -- $root_commands -h --help -v --version');
    expect(script).toContain('compadd outcome');
    expect(script).toContain('compadd -- status pause resume cancel');
    expect(script).toContain('compadd -- list claim release owner');
    expect(script).toContain('compadd -- verify doctor');
    expect(script).toContain('status drain remember yield');
    expect(script).toContain('compadd -- --json --days --kookr-dir -h --help');
    expect(script).toContain('--from-command');
    expect(script).toContain('--run-commands');
    expect(script).toContain('compadd -- --spec --out --review-out --plugin-dir --cache-dir --json -h --help');
    expect(script).toContain('compadd claude-code codex-cli grok-build');
    expect(script).toContain('compadd none minimal low medium high xhigh max ultra');
    expect(script).toContain('compadd warn block skip');
    expect(script).toContain('compadd -- --dedupe=warn --dedupe=block --dedupe=skip');
    expect(script).toContain('compadd -- --fail-on=critical --fail-on=warning --fail-on=info --fail-on=none');
    expect(script).toContain('--json');
    expect(script).toContain('--task-id');
    expect(script).toContain('--max-age-days');
    expect(script).toContain('compadd -- $completion_shells');
  });

  it.each(COMPLETION_SHELLS)(
    'embeds a case branch and declared subcommands for every verb (%s)',
    (shell) => {
      const script = renderCompletion(shell);
      for (const command of KOOKR_COMPLETION_COMMANDS) {
        // Each metadata verb must have a case arm so declared flags/subcommands are reachable.
        expect(script, `missing case arm for ${command.name} in ${shell}`).toMatch(
          new RegExp(`^\\s+${escapeRegExp(command.name)}\\)`, 'm'),
        );
        if (command.subcommands !== undefined && command.subcommands.length > 0) {
          expect(
            script,
            `declared subcommands for ${command.name} not embedded in ${shell}`,
          ).toContain(command.subcommands.join(' '));
        }
      }
    },
  );
});

describe('bash completion behavior', () => {
  it('completes root commands', async () => {
    await expect(completeBash(['kookr', ''])).resolves.toEqual(
      expect.arrayContaining(['spawn', 'status', 'ralph', 'completion', '-v', '--version']),
    );
  });

  it('completes Ralph subcommands', async () => {
    await expect(completeBash(['kookr', 'ralph', ''])).resolves.toEqual(
      expect.arrayContaining(['status', 'pause', 'resume', 'cancel']),
    );
  });

  it('completes schedule subcommands and flags', async () => {
    await expect(completeBash(['kookr', 'schedule', ''])).resolves.toEqual(
      expect.arrayContaining(['list', 'run', 'enable', 'disable', '--json']),
    );
  });

  it('completes issue subcommands and flags', async () => {
    await expect(completeBash(['kookr', 'issue', ''])).resolves.toEqual(
      expect.arrayContaining(['list', 'claim', 'release', 'owner', '--repo', '--force']),
    );
    await expect(completeBash(['kookr', 'issue', 'claim', ''])).resolves.toEqual([
      '--repo',
      '--force',
      '--task-id',
      '--json',
      '-h',
      '--help',
    ]);
  });

  it('completes logs flags', async () => {
    await expect(completeBash(['kookr', 'logs', ''])).resolves.toEqual([
      '-n',
      '--lines',
      '--json',
      '--dir',
      '-h',
      '--help',
    ]);
  });

  it('completes pr-checklist subcommands and flags', async () => {
    await expect(completeBash(['kookr', 'pr-checklist', ''])).resolves.toEqual(
      expect.arrayContaining([
        'verify',
        'doctor',
        '--pr-body',
        '--from-command',
        '--run-commands',
        '--base',
        '--explain',
      ]),
    );
    await expect(completeBash(['kookr', 'pr-checklist', 'verify', ''])).resolves.toEqual([
      '--pr-body',
      '--from-command',
      '--run-commands',
      '--base',
      '--json',
      '--explain',
      '-h',
      '--help',
    ]);
    await expect(completeBash(['kookr', 'pr-checklist', 'doctor', ''])).resolves.toEqual([
      '--pr-body',
      '--from-command',
      '--run-commands',
      '--base',
      '--json',
      '--explain',
      '-h',
      '--help',
    ]);
  });

  it('completes flag values after a space-form flag', async () => {
    await expect(completeBash(['kookr', 'spawn', '--agent', ''])).resolves.toEqual([
      'claude-code',
      'codex-cli',
      'grok-build',
    ]);
  });

  it('completes equals-form flag values', async () => {
    await expect(completeBash(['kookr', 'spawn', '--dedupe='])).resolves.toEqual([
      '--dedupe=warn',
      '--dedupe=block',
      '--dedupe=skip',
    ]);
  });

  // #1858: spawn saturation / dry-run flags must be tab-completable
  it('completes spawn --model --wait --idempotency-key --dry-run flags', async () => {
    await expect(completeBash(['kookr', 'spawn', ''])).resolves.toEqual(
      expect.arrayContaining([
        '--model',
        '--wait',
        '--idempotency-key',
        '--dry-run',
      ]),
    );
  });

  it('completes --model values from the shared model allowlist', async () => {
    await expect(completeBash(['kookr', 'spawn', '--model', ''])).resolves.toEqual(
      expect.arrayContaining([
        'claude-fable-5',
        'claude-opus-4-8',
        'claude-sonnet-5',
        'claude-haiku-4-5',
      ]),
    );
    await expect(completeBash(['kookr', 'spawn', '--model='])).resolves.toEqual(
      expect.arrayContaining([
        '--model=claude-fable-5',
        '--model=claude-sonnet-5',
        '--model=claude-haiku-4-5',
      ]),
    );
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
    await expect(completeBash(['kookr', 'doctor', ''])).resolves.toEqual([
      '--json',
      '--strict',
      '-h',
      '--help',
    ]);
  });

  it('completes status flags and fail-on values', async () => {
    await expect(completeBash(['kookr', 'status', ''])).resolves.toEqual([
      '--json',
      '--fail-on',
      '-h',
      '--help',
    ]);
    await expect(completeBash(['kookr', 'status', '--fail-on', ''])).resolves.toEqual([
      'critical',
      'warning',
      'info',
      'none',
    ]);
    await expect(completeBash(['kookr', 'status', '--fail-on='])).resolves.toEqual([
      '--fail-on=critical',
      '--fail-on=warning',
      '--fail-on=info',
      '--fail-on=none',
    ]);
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

  // #2311: lesson yield is a live verb; shell completion must offer it + flags.
  it('completes lesson subcommands including yield', async () => {
    await expect(completeBash(['kookr', 'lesson', ''])).resolves.toEqual([
      'status',
      'drain',
      'remember',
      'yield',
    ]);
  });

  it('completes lesson flags for the selected verb', async () => {
    await expect(completeBash(['kookr', 'lesson', 'status', ''])).resolves.toEqual([
      '--json',
      '--dir',
      '-h',
      '--help',
    ]);
    await expect(completeBash(['kookr', 'lesson', 'drain', ''])).resolves.toEqual([
      '--json',
      '--dir',
      '--dry-run',
      '-h',
      '--help',
    ]);
    await expect(completeBash(['kookr', 'lesson', 'remember', ''])).resolves.toEqual([
      '--title',
      '--kb',
      '--stdin',
      '--yes',
      '--dir',
      '--json',
      '-h',
      '--help',
    ]);
    await expect(completeBash(['kookr', 'lesson', 'yield', ''])).resolves.toEqual([
      '--json',
      '--days',
      '--kookr-dir',
      '-h',
      '--help',
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
      expect.arrayContaining(['spawn', 'status', 'ralph', 'completion', '-v', '--version']),
    );
  });

  it('completes completion shells', async () => {
    await expect(completeZsh(['kookr', 'completion', ''], 3)).resolves.toEqual(['bash', 'zsh']);
  });

  it('completes doctor flags', async () => {
    await expect(completeZsh(['kookr', 'doctor', ''], 3)).resolves.toEqual([
      '--json',
      '--strict',
      '-h',
      '--help',
    ]);
  });

  it('completes status flags and fail-on values', async () => {
    await expect(completeZsh(['kookr', 'status', ''], 3)).resolves.toEqual([
      '--json',
      '--fail-on',
      '-h',
      '--help',
    ]);
    await expect(completeZsh(['kookr', 'status', '--fail-on', ''], 4)).resolves.toEqual([
      'critical',
      'warning',
      'info',
      'none',
    ]);
    await expect(completeZsh(['kookr', 'status', '--fail-on='], 3)).resolves.toEqual([
      '--fail-on=critical',
      '--fail-on=warning',
      '--fail-on=info',
      '--fail-on=none',
    ]);
  });

  it('completes command subcommands', async () => {
    await expect(completeZsh(['kookr', 'command', ''], 3)).resolves.toEqual(['outcome']);
    await expect(completeZsh(['kookr', 'command', 'outcome', ''], 4)).resolves.toEqual([]);
  });

  it('completes issue subcommands and flags', async () => {
    await expect(completeZsh(['kookr', 'issue', ''], 3)).resolves.toEqual(
      expect.arrayContaining(['list', 'claim', 'release', 'owner', '--repo', '--force']),
    );
    await expect(completeZsh(['kookr', 'issue', 'claim', ''], 4)).resolves.toEqual([
      '--repo',
      '--force',
      '--task-id',
      '--json',
      '-h',
      '--help',
    ]);
  });

  it('completes logs flags', async () => {
    await expect(completeZsh(['kookr', 'logs', ''], 3)).resolves.toEqual([
      '-n',
      '--lines',
      '--json',
      '--dir',
      '-h',
      '--help',
    ]);
  });

  it('completes pr-checklist subcommands and flags', async () => {
    await expect(completeZsh(['kookr', 'pr-checklist', ''], 3)).resolves.toEqual(
      expect.arrayContaining([
        'verify',
        'doctor',
        '--pr-body',
        '--from-command',
        '--run-commands',
        '--base',
        '--explain',
      ]),
    );
    await expect(completeZsh(['kookr', 'pr-checklist', 'verify', ''], 4)).resolves.toEqual([
      '--pr-body',
      '--from-command',
      '--run-commands',
      '--base',
      '--json',
      '--explain',
      '-h',
      '--help',
    ]);
    await expect(completeZsh(['kookr', 'pr-checklist', 'doctor', ''], 4)).resolves.toEqual([
      '--pr-body',
      '--from-command',
      '--run-commands',
      '--base',
      '--json',
      '--explain',
      '-h',
      '--help',
    ]);
  });

  it('completes signal kinds and flags', async () => {
    await expect(completeZsh(['kookr', 'signal', ''], 3)).resolves.toEqual(
      expect.arrayContaining(['completion-ready', '--note', '--task-id', '--json']),
    );
  });

  // #2311: lesson yield is a live verb; shell completion must offer it + flags.
  it('completes lesson subcommands including yield and verb-specific flags', async () => {
    await expect(completeZsh(['kookr', 'lesson', ''], 3)).resolves.toEqual([
      'status',
      'drain',
      'remember',
      'yield',
    ]);
    await expect(completeZsh(['kookr', 'lesson', 'status', ''], 4)).resolves.toEqual([
      '--json',
      '--dir',
      '-h',
      '--help',
    ]);
    await expect(completeZsh(['kookr', 'lesson', 'yield', ''], 4)).resolves.toEqual([
      '--json',
      '--days',
      '--kookr-dir',
      '-h',
      '--help',
    ]);
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
      'grok-build',
    ]);
  });

  it('completes equals-form flag values', async () => {
    await expect(completeZsh(['kookr', 'spawn', '--dedupe='], 3)).resolves.toEqual([
      '--dedupe=warn',
      '--dedupe=block',
      '--dedupe=skip',
    ]);
  });

  // #1858: spawn saturation / dry-run flags must be tab-completable (zsh)
  it('completes spawn --model --wait --idempotency-key --dry-run flags (zsh)', async () => {
    await expect(completeZsh(['kookr', 'spawn', ''], 3)).resolves.toEqual(
      expect.arrayContaining([
        '--model',
        '--wait',
        '--idempotency-key',
        '--dry-run',
      ]),
    );
  });

  it('completes --model values from the shared model allowlist (zsh)', async () => {
    await expect(completeZsh(['kookr', 'spawn', '--model', ''], 4)).resolves.toEqual(
      expect.arrayContaining([
        'claude-fable-5',
        'claude-opus-4-8',
        'claude-sonnet-5',
        'claude-haiku-4-5',
      ]),
    );
    await expect(completeZsh(['kookr', 'spawn', '--model='], 3)).resolves.toEqual(
      expect.arrayContaining([
        '--model=claude-fable-5',
        '--model=claude-sonnet-5',
        '--model=claude-haiku-4-5',
      ]),
    );
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

describe('kookr dispatcher root version flags', () => {
  it.each([['--version'], ['-v']])('prints package version for %s', async (flag) => {
    const deps = makeDeps();
    await main({ argv: [flag], env: {}, out: deps.out, err: deps.err, exit: deps.exit });
    expect(deps.codes).toEqual([0]);
    expect(deps.errors).toEqual([]);
    expect(deps.logs).toEqual([packageJson.version]);
  });

  it('prints package version through bin/kookr.js', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['bin/kookr.js', '--version'], {
      cwd: process.cwd(),
    });
    expect(stderr).toBe('');
    expect(stdout.trim()).toBe(packageJson.version);
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

describe('kookr dispatcher context-pack command', () => {
  it('dispatches context-pack --help through the main binary', async () => {
    const deps = makeDeps();
    await main({
      argv: ['context-pack', '--help'],
      env: {},
      out: deps.out,
      err: deps.err,
      exit: deps.exit,
    });
    expect(deps.codes).toEqual([0]);
    expect(deps.logs.join('\n')).toContain('kookr context-pack — build a spawn-time context pack');
  });

  it('prints context-pack help through bin/kookr.js', async () => {
    const { stdout } = await execFileAsync(process.execPath, ['bin/kookr.js', 'context-pack', '--help'], {
      cwd: process.cwd(),
    });
    expect(stdout).toContain('kookr context-pack — build a spawn-time context pack');
    expect(stdout).toContain('--review-out');
  });
});
