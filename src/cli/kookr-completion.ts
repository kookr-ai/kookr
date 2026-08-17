export const COMPLETION_SHELLS = ['bash', 'zsh'] as const;
const ROOT_FLAGS = ['-h', '--help', '-v', '--version'] as const;
const MAINTENANCE_PRUNE_FLAGS = ['--dry-run', '--max-age-days', '--dir', '--json'] as const;
const MAINTENANCE_BACKUP_FLAGS = ['--dir', '--out', '--json'] as const;
const LESSON_STATUS_FLAGS = ['--json', '--dir', '-h', '--help'] as const;
const LESSON_DRAIN_FLAGS = ['--json', '--dir', '--dry-run', '-h', '--help'] as const;
const LESSON_REMEMBER_FLAGS = [
  '--title',
  '--kb',
  '--stdin',
  '--yes',
  '--dir',
  '--json',
  '-h',
  '--help',
] as const;
// #2311: yield flags mirror `kookr lesson yield` in src/cli/kookr-lesson.ts.
const LESSON_YIELD_FLAGS = ['--json', '--days', '--kookr-dir', '-h', '--help'] as const;
const STATUS_FAIL_ON_VALUES = ['critical', 'warning', 'info', 'none'] as const;
// #1858 / #1518: known model base ids for spawn --model tab-completion.
// Keep in sync with ALL_MODEL_IDS / CLAUDE_CODE_MODEL_IDS in
// src/shared/contracts/agent-types.ts and MODEL_IDS in bin/kookr-spawn.js.
// Inlined (not imported) so `kookr completion` still loads from source without
// a prior build — this file is imported by bin/kookr.js via strip-types.
const SPAWN_MODEL_IDS = [
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
] as const;

export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

interface CommandCompletion {
  name: string;
  subcommands?: readonly string[];
  flags?: readonly string[];
  flagValues?: Readonly<Record<string, readonly string[]>>;
  positionalValues?: readonly string[];
}

export const KOOKR_COMPLETION_COMMANDS: readonly CommandCompletion[] = [
  {
    name: 'spawn',
    flags: [
      '-C',
      '--cwd',
      '-a',
      '--agent',
      '--effort',
      '--criteria',
      '--dedupe',
      '--parent-task-id',
      '--no-parent-task',
      '-f',
      '--prompt-file',
      // #1858: surface saturation/dry-run flags agents need under tab-completion.
      // Keep in sync with bin/kookr-spawn.js help + parseArgs.
      '--model',
      '--wait',
      '--idempotency-key',
      '--dry-run',
      '--json',
      '-h',
      '--help',
    ],
    flagValues: {
      '--agent': ['claude-code', 'codex-cli', 'grok-build'],
      '--effort': ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      '--dedupe': ['warn', 'block', 'skip'],
      // Cross-agent allowlist (CLI fast-fail). Shared with bin/kookr-spawn.js MODEL_IDS.
      '--model': SPAWN_MODEL_IDS,
    },
  },
  {
    name: 'signal',
    positionalValues: ['completion-ready'],
    flags: ['--note', '--task-id', '--json', '-h', '--help'],
  },
  {
    name: 'issue',
    subcommands: ['list', 'claim', 'release', 'owner'],
    flags: ['--repo', '--force', '--task-id', '--json', '-h', '--help'],
  },
  {
    name: 'doctor',
    flags: ['--json', '--strict', '-h', '--help'],
  },
  {
    name: 'status',
    flags: ['--json', '--fail-on', '-h', '--help'],
    flagValues: {
      '--fail-on': STATUS_FAIL_ON_VALUES,
    },
  },
  {
    name: 'ops',
    subcommands: ['digest'],
    // Flags live on `ops`, not `digest`, so `--json` and `--offline` complete
    // the same way (`kookr ops <TAB>` and `kookr ops digest <TAB>`).
    flags: ['--json', '--offline', '-h', '--help'],
  },
  {
    name: 'github',
    subcommands: ['status'],
    flags: ['--json', '-h', '--help'],
  },
  {
    name: 'logs',
    flags: ['-n', '--lines', '--json', '--dir', '-h', '--help'],
  },
  {
    name: 'command',
    subcommands: ['outcome'],
  },
  {
    name: 'ralph',
    subcommands: ['status', 'pause', 'resume', 'cancel'],
    flags: ['--json', '-h', '--help'],
  },
  {
    name: 'schedule',
    subcommands: ['list', 'run', 'enable', 'disable'],
    flags: ['--held-by', '--json', '-h', '--help'],
  },
  {
    name: 'drain',
    subcommands: ['status'],
  },
  {
    name: 'resume',
  },
  {
    // Cross-agent task migration. Keep in sync with bin/kookr-migrate.js help.
    name: 'migrate',
    flags: [
      '--to',
      '--from',
      '--all',
      '--include-cancelled',
      '--set-default',
      '--only-isolated',
      '--effort',
      '--dry-run',
      '--yes',
    ],
  },
  {
    name: 'maintenance',
    subcommands: ['prune', 'backup'],
    flags: [...MAINTENANCE_PRUNE_FLAGS, ...MAINTENANCE_BACKUP_FLAGS],
  },
  {
    name: 'lesson',
    subcommands: ['status', 'drain', 'remember', 'yield'],
    flags: [
      ...LESSON_STATUS_FLAGS,
      ...LESSON_DRAIN_FLAGS,
      ...LESSON_REMEMBER_FLAGS,
      ...LESSON_YIELD_FLAGS,
    ],
  },
  {
    name: 'effort-split',
    flags: [
      '--repo',
      '--window-hours',
      '--primary',
      '--secondary',
      '--kookr-dir',
      '--path',
      '--no-persist',
      '--min-share',
      '--max-share',
      '--date',
      '--json',
      '-h',
      '--help',
    ],
  },
  {
    name: 'emission',
    subcommands: ['plan', 'dedupe', 'metrics', 'defer', 'version'],
    flags: [
      '--repo',
      '--requested',
      '--title',
      '--source',
      '--reason',
      '--threshold',
      '--constrained',
      '--drain-window',
      '--drain-ratio',
      '--drain-floor',
      '--no-drain-coupling',
      '--retro-verify-threshold',
      '--no-retro-verify-coupling',
      '--retro-verify-dir',
      '--body-preview',
      '--kookr-dir',
      '--repo-dir',
      '--json',
      '-h',
      '--help',
    ],
  },
  {
    name: 'value-density',
    subcommands: ['classify', 'admit', 'composition', 'decline'],
    flags: [
      '--title',
      '--labels',
      '--body',
      '--drift-score-delta',
      '--refactor-count',
      '--max-refactor',
      '--min-drift-delta',
      '--repo',
      '--window-hours',
      '--value-target',
      '--source',
      '--reason',
      '--reason-code',
      '--work-class',
      '--kookr-dir',
      '--no-persist',
      '--json',
      '-h',
      '--help',
    ],
  },
  {
    name: 'queue-feeder',
    subcommands: ['plan', 'leaves'],
    flags: [
      '--input',
      '--free',
      '--pending',
      '--free-threshold',
      '--umbrella',
      '--emit',
      '--kookr-dir',
      '--no-persist',
      '--json',
      '-h',
      '--help',
    ],
  },
  {
    name: 'retro-verify',
    subcommands: ['status', 'drain', 'enqueue'],
    flags: [
      '--dir',
      '--sha',
      '--repo',
      '--pr',
      '--reason',
      '--limit',
      '--dry-run',
      '--repo-dir',
      '--verify-cmd',
      '--json',
      '-h',
      '--help',
    ],
  },
  {
    name: 'reflect',
    subcommands: ['outcomes', 'ideas'],
    flags: ['--window', '--log', '--runs', '--json', '-h', '--help'],
    flagValues: {
      '--window': ['24h', '7d', '30d', 'all'],
    },
  },
  {
    name: 'pr-checklist',
    subcommands: ['verify', 'doctor'],
    flags: [
      '--pr-body',
      '--from-command',
      '--run-commands',
      '--base',
      '--json',
      '--explain',
      '-h',
      '--help',
    ],
    flagValues: {
      '--run-commands': ['none', 'ci'],
    },
  },
  {
    name: 'context-pack',
    flags: [
      '--spec',
      '--out',
      '--review-out',
      '--plugin-dir',
      '--cache-dir',
      '--json',
      '-h',
      '--help',
    ],
  },
  {
    name: 'signal-emit',
    subcommands: ['transition', 'liveness'],
    flags: ['--source', '--status', '--detail', '--registry', '--now', '--dir', '-h', '--help'],
    flagValues: {
      '--status': ['ok', 'alert', 'unknown'],
    },
  },
  {
    name: 'push',
    subcommands: ['test'],
  },
  {
    name: 'completion',
    subcommands: COMPLETION_SHELLS,
    flags: ['-h', '--help'],
  },
];

export function completionUsage(): string {
  return [
    'Usage: kookr completion <bash|zsh>',
    '',
    'Print a shell completion script to stdout.',
    '',
    'Install examples:',
    '  source <(kookr completion bash)',
    '  kookr completion zsh > "${fpath[1]}/_kookr"',
  ].join('\n');
}

export function getRootCompletionCommands(): string[] {
  return KOOKR_COMPLETION_COMMANDS.map((command) => command.name);
}

export function renderCompletion(shell: CompletionShell): string {
  if (shell === 'bash') return renderBashCompletion();
  return renderZshCompletion();
}

export async function runCompletionCli({
  argv = process.argv.slice(2),
  out = console,
  err = console,
  exit = process.exit,
}: {
  argv?: string[];
  out?: Pick<Console, 'log'>;
  err?: Pick<Console, 'error'>;
  exit?: (code: number) => never;
} = {}): Promise<never | undefined> {
  const [shell, ...rest] = argv;
  if (shell === '-h' || shell === '--help') {
    out.log(completionUsage());
    return exit(0);
  }
  if (!isCompletionShell(shell) || rest.length > 0) {
    err.error(completionUsage());
    return exit(2);
  }
  out.log(renderCompletion(shell));
  return exit(0);
}

function isCompletionShell(value: string | undefined): value is CompletionShell {
  return COMPLETION_SHELLS.includes(value as CompletionShell);
}

function renderBashCompletion(): string {
  const rootWords = shellWords(getRootCompletionCommands());
  const rootFlags = shellWords(ROOT_FLAGS);
  const shells = subcommandsFor('completion');
  const agentValues = flagValuesFor('spawn', '--agent');
  const dedupeValues = flagValuesFor('spawn', '--dedupe');
  const effortValues = flagValuesFor('spawn', '--effort');
  const modelValues = flagValuesFor('spawn', '--model');
  const dedupeEqualsValues = equalsFlagValues('--dedupe', dedupeValues);
  const effortEqualsValues = equalsFlagValues('--effort', effortValues);
  const modelEqualsValues = equalsFlagValues('--model', modelValues);
  const spawnFlags = flagsFor('spawn');
  const signalKinds = positionalValuesFor('signal');
  const signalFlags = flagsFor('signal');
  const doctorFlags = flagsFor('doctor');
  const statusFlags = flagsFor('status');
  const statusFailOnValues = flagValuesFor('status', '--fail-on');
  const statusFailOnEqualsValues = equalsFlagValues('--fail-on', statusFailOnValues);
  const opsSubcommands = subcommandsFor('ops');
  const opsFlags = flagsFor('ops');
  const githubSubcommands = subcommandsFor('github');
  const githubFlags = flagsFor('github');
  const issueSubcommands = subcommandsFor('issue');
  const issueFlags = flagsFor('issue');
  const logsFlags = flagsFor('logs');
  const commandSubcommands = subcommandsFor('command');
  const ralphSubcommands = subcommandsFor('ralph');
  const ralphFlags = flagsFor('ralph');
  const scheduleSubcommands = subcommandsFor('schedule');
  const scheduleFlags = flagsFor('schedule');
  const drainSubcommands = subcommandsFor('drain');
  const drainFlags = flagsFor('drain');
  const migrateFlags = flagsFor('migrate');
  const maintenanceSubcommands = subcommandsFor('maintenance');
  const maintenancePruneFlags = shellWords(MAINTENANCE_PRUNE_FLAGS);
  const maintenanceBackupFlags = shellWords(MAINTENANCE_BACKUP_FLAGS);
  const lessonSubcommands = subcommandsFor('lesson');
  const lessonStatusFlags = shellWords(LESSON_STATUS_FLAGS);
  const lessonDrainFlags = shellWords(LESSON_DRAIN_FLAGS);
  const lessonRememberFlags = shellWords(LESSON_REMEMBER_FLAGS);
  const lessonYieldFlags = shellWords(LESSON_YIELD_FLAGS);
  const effortSplitFlags = flagsFor('effort-split');
  const emissionSubcommands = subcommandsFor('emission');
  const emissionFlags = flagsFor('emission');
  const valueDensitySubcommands = subcommandsFor('value-density');
  const valueDensityFlags = flagsFor('value-density');
  const queueFeederSubcommands = subcommandsFor('queue-feeder');
  const queueFeederFlags = flagsFor('queue-feeder');
  const retroVerifySubcommands = subcommandsFor('retro-verify');
  const retroVerifyFlags = flagsFor('retro-verify');
  const reflectSubcommands = subcommandsFor('reflect');
  const reflectFlags = flagsFor('reflect');
  const prChecklistSubcommands = subcommandsFor('pr-checklist');
  const prChecklistFlags = flagsFor('pr-checklist');
  const contextPackFlags = flagsFor('context-pack');
  const signalEmitSubcommands = subcommandsFor('signal-emit');
  const signalEmitFlags = flagsFor('signal-emit');
  const pushSubcommands = subcommandsFor('push');
  const completionFlags = flagsFor('completion');

  return `# bash completion for kookr. Generated by \`kookr completion bash\`.
_kookr()
{
  local cur prev cmd
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cmd="\${COMP_WORDS[1]}"

  case "\${prev}" in
    -a|--agent)
      COMPREPLY=( $(compgen -W "${agentValues}" -- "\${cur}") )
      return 0
      ;;
    --effort)
      COMPREPLY=( $(compgen -W "${effortValues}" -- "\${cur}") )
      return 0
      ;;
    --dedupe)
      COMPREPLY=( $(compgen -W "${dedupeValues}" -- "\${cur}") )
      return 0
      ;;
    --model)
      COMPREPLY=( $(compgen -W "${modelValues}" -- "\${cur}") )
      return 0
      ;;
    --fail-on)
      if [[ "\${cmd}" == status ]]; then
        COMPREPLY=( $(compgen -W "${statusFailOnValues}" -- "\${cur}") )
        return 0
      fi
      ;;
    completion)
      COMPREPLY=( $(compgen -W "${shells}" -- "\${cur}") )
      return 0
      ;;
  esac

  if [[ "\${cur}" == --dedupe=* ]]; then
    COMPREPLY=( $(compgen -W "${dedupeEqualsValues}" -- "\${cur}") )
    return 0
  fi
  if [[ "\${cur}" == --effort=* ]]; then
    COMPREPLY=( $(compgen -W "${effortEqualsValues}" -- "\${cur}") )
    return 0
  fi
  if [[ "\${cur}" == --model=* ]]; then
    COMPREPLY=( $(compgen -W "${modelEqualsValues}" -- "\${cur}") )
    return 0
  fi
  if [[ "\${cmd}" == status && "\${cur}" == --fail-on=* ]]; then
    COMPREPLY=( $(compgen -W "${statusFailOnEqualsValues}" -- "\${cur}") )
    return 0
  fi

  case "\${COMP_CWORD}" in
    1)
      COMPREPLY=( $(compgen -W "${rootWords} ${rootFlags}" -- "\${cur}") )
      return 0
      ;;
  esac

  case "\${cmd}" in
    spawn)
      COMPREPLY=( $(compgen -W "${spawnFlags}" -- "\${cur}") )
      ;;
    signal)
      if [[ "\${COMP_CWORD}" == 2 ]]; then
        COMPREPLY=( $(compgen -W "${signalKinds} ${signalFlags}" -- "\${cur}") )
      else
        COMPREPLY=( $(compgen -W "${signalFlags}" -- "\${cur}") )
      fi
      ;;
    issue)
      if [[ "\${COMP_CWORD}" == 2 ]]; then
        COMPREPLY=( $(compgen -W "${issueSubcommands} ${issueFlags}" -- "\${cur}") )
      else
        COMPREPLY=( $(compgen -W "${issueFlags}" -- "\${cur}") )
      fi
      ;;
    status)
      COMPREPLY=( $(compgen -W "${statusFlags}" -- "\${cur}") )
      ;;
    ops)
      if [[ "\${COMP_CWORD}" == 2 ]]; then
        COMPREPLY=( $(compgen -W "${opsSubcommands} ${opsFlags}" -- "\${cur}") )
      else
        COMPREPLY=( $(compgen -W "${opsFlags}" -- "\${cur}") )
      fi
      ;;
    github)
      if [[ "\${COMP_CWORD}" == 2 ]]; then
        COMPREPLY=( $(compgen -W "${githubSubcommands} ${githubFlags}" -- "\${cur}") )
      else
        COMPREPLY=( $(compgen -W "${githubFlags}" -- "\${cur}") )
      fi
      ;;
    doctor)
      COMPREPLY=( $(compgen -W "${doctorFlags}" -- "\${cur}") )
      ;;
    logs)
      COMPREPLY=( $(compgen -W "${logsFlags}" -- "\${cur}") )
      ;;
    command)
      if [[ "\${COMP_CWORD}" == 2 ]]; then
        COMPREPLY=( $(compgen -W "${commandSubcommands}" -- "\${cur}") )
      fi
      ;;
    ralph)
      if [[ "\${COMP_CWORD}" == 2 ]]; then
        COMPREPLY=( $(compgen -W "${ralphSubcommands} ${ralphFlags}" -- "\${cur}") )
      else
        COMPREPLY=( $(compgen -W "${ralphFlags}" -- "\${cur}") )
      fi
      ;;
    schedule)
      if [[ "\${COMP_CWORD}" == 2 ]]; then
        COMPREPLY=( $(compgen -W "${scheduleSubcommands} ${scheduleFlags}" -- "\${cur}") )
      else
        COMPREPLY=( $(compgen -W "${scheduleFlags}" -- "\${cur}") )
      fi
      ;;
    drain)
      COMPREPLY=( $(compgen -W "${drainSubcommands} ${drainFlags}" -- "\${cur}") )
      ;;
    resume)
      COMPREPLY=()
      ;;
    migrate)
      COMPREPLY=( $(compgen -W "${migrateFlags}" -- "\${cur}") )
      ;;
    maintenance)
      if [[ "\${COMP_CWORD}" == 2 ]]; then
        COMPREPLY=( $(compgen -W "${maintenanceSubcommands}" -- "\${cur}") )
      else
        case "\${COMP_WORDS[2]}" in
          prune)
            COMPREPLY=( $(compgen -W "${maintenancePruneFlags}" -- "\${cur}") )
            ;;
          backup)
            COMPREPLY=( $(compgen -W "${maintenanceBackupFlags}" -- "\${cur}") )
            ;;
          *)
            COMPREPLY=()
            ;;
        esac
      fi
      ;;
    lesson)
      if [[ "\${COMP_CWORD}" == 2 ]]; then
        COMPREPLY=( $(compgen -W "${lessonSubcommands}" -- "\${cur}") )
      else
        case "\${COMP_WORDS[2]}" in
          status)
            COMPREPLY=( $(compgen -W "${lessonStatusFlags}" -- "\${cur}") )
            ;;
          drain)
            COMPREPLY=( $(compgen -W "${lessonDrainFlags}" -- "\${cur}") )
            ;;
          remember)
            COMPREPLY=( $(compgen -W "${lessonRememberFlags}" -- "\${cur}") )
            ;;
          yield)
            COMPREPLY=( $(compgen -W "${lessonYieldFlags}" -- "\${cur}") )
            ;;
          *)
            COMPREPLY=()
            ;;
        esac
      fi
      ;;
    effort-split)
      COMPREPLY=( $(compgen -W "${effortSplitFlags}" -- "\${cur}") )
      ;;
    value-density)
      if [[ "\${COMP_CWORD}" == 2 ]]; then
        COMPREPLY=( $(compgen -W "${valueDensitySubcommands} ${valueDensityFlags}" -- "\${cur}") )
      else
        COMPREPLY=( $(compgen -W "${valueDensityFlags}" -- "\${cur}") )
      fi
      ;;
    queue-feeder)
      if [[ "\${COMP_CWORD}" == 2 ]]; then
        COMPREPLY=( $(compgen -W "${queueFeederSubcommands} ${queueFeederFlags}" -- "\${cur}") )
      else
        COMPREPLY=( $(compgen -W "${queueFeederFlags}" -- "\${cur}") )
      fi
      ;;
    emission)
      if [[ "\${COMP_CWORD}" == 2 ]]; then
        COMPREPLY=( $(compgen -W "${emissionSubcommands} ${emissionFlags}" -- "\${cur}") )
      else
        COMPREPLY=( $(compgen -W "${emissionFlags}" -- "\${cur}") )
      fi
      ;;
    retro-verify)
      if [[ "\${COMP_CWORD}" == 2 ]]; then
        COMPREPLY=( $(compgen -W "${retroVerifySubcommands} ${retroVerifyFlags}" -- "\${cur}") )
      else
        COMPREPLY=( $(compgen -W "${retroVerifyFlags}" -- "\${cur}") )
      fi
      ;;
    reflect)
      if [[ "\${COMP_CWORD}" == 2 ]]; then
        COMPREPLY=( $(compgen -W "${reflectSubcommands} ${reflectFlags}" -- "\${cur}") )
      else
        COMPREPLY=( $(compgen -W "${reflectFlags}" -- "\${cur}") )
      fi
      ;;
    pr-checklist)
      if [[ "\${COMP_CWORD}" == 2 ]]; then
        COMPREPLY=( $(compgen -W "${prChecklistSubcommands} ${prChecklistFlags}" -- "\${cur}") )
      else
        COMPREPLY=( $(compgen -W "${prChecklistFlags}" -- "\${cur}") )
      fi
      ;;
    context-pack)
      COMPREPLY=( $(compgen -W "${contextPackFlags}" -- "\${cur}") )
      ;;
    signal-emit)
      if [[ "\${COMP_CWORD}" == 2 ]]; then
        COMPREPLY=( $(compgen -W "${signalEmitSubcommands} ${signalEmitFlags}" -- "\${cur}") )
      else
        COMPREPLY=( $(compgen -W "${signalEmitFlags}" -- "\${cur}") )
      fi
      ;;
    push)
      if [[ "\${COMP_CWORD}" == 2 ]]; then
        COMPREPLY=( $(compgen -W "${pushSubcommands}" -- "\${cur}") )
      fi
      ;;
    completion)
      if [[ "\${COMP_CWORD}" == 2 ]]; then
        COMPREPLY=( $(compgen -W "${shells}" -- "\${cur}") )
      else
        COMPREPLY=( $(compgen -W "${completionFlags}" -- "\${cur}") )
      fi
      ;;
  esac
}
complete -F _kookr kookr`;
}

function renderZshCompletion(): string {
  const rootWords = shellWords(getRootCompletionCommands());
  const rootFlags = shellWords(ROOT_FLAGS);
  const shells = subcommandsFor('completion');
  const agentValues = flagValuesFor('spawn', '--agent');
  const dedupeValues = flagValuesFor('spawn', '--dedupe');
  const effortValues = flagValuesFor('spawn', '--effort');
  const modelValues = flagValuesFor('spawn', '--model');
  const dedupeEqualsValues = equalsFlagValues('--dedupe', dedupeValues);
  const effortEqualsValues = equalsFlagValues('--effort', effortValues);
  const modelEqualsValues = equalsFlagValues('--model', modelValues);
  const spawnFlags = flagsFor('spawn');
  const signalKinds = positionalValuesFor('signal');
  const signalFlags = flagsFor('signal');
  const doctorFlags = flagsFor('doctor');
  const statusFlags = flagsFor('status');
  const statusFailOnValues = flagValuesFor('status', '--fail-on');
  const statusFailOnEqualsValues = equalsFlagValues('--fail-on', statusFailOnValues);
  const opsSubcommands = subcommandsFor('ops');
  const opsFlags = flagsFor('ops');
  const githubSubcommands = subcommandsFor('github');
  const githubFlags = flagsFor('github');
  const issueSubcommands = subcommandsFor('issue');
  const issueFlags = flagsFor('issue');
  const logsFlags = flagsFor('logs');
  const commandSubcommands = subcommandsFor('command');
  const ralphSubcommands = subcommandsFor('ralph');
  const ralphFlags = flagsFor('ralph');
  const scheduleSubcommands = subcommandsFor('schedule');
  const scheduleFlags = flagsFor('schedule');
  const drainSubcommands = subcommandsFor('drain');
  const drainFlags = flagsFor('drain');
  const migrateFlags = flagsFor('migrate');
  const maintenanceSubcommands = subcommandsFor('maintenance');
  const maintenancePruneFlags = shellWords(MAINTENANCE_PRUNE_FLAGS);
  const maintenanceBackupFlags = shellWords(MAINTENANCE_BACKUP_FLAGS);
  const lessonSubcommands = subcommandsFor('lesson');
  const lessonStatusFlags = shellWords(LESSON_STATUS_FLAGS);
  const lessonDrainFlags = shellWords(LESSON_DRAIN_FLAGS);
  const lessonRememberFlags = shellWords(LESSON_REMEMBER_FLAGS);
  const lessonYieldFlags = shellWords(LESSON_YIELD_FLAGS);
  const effortSplitFlags = flagsFor('effort-split');
  const emissionSubcommands = subcommandsFor('emission');
  const emissionFlags = flagsFor('emission');
  const valueDensitySubcommands = subcommandsFor('value-density');
  const valueDensityFlags = flagsFor('value-density');
  const queueFeederSubcommands = subcommandsFor('queue-feeder');
  const queueFeederFlags = flagsFor('queue-feeder');
  const retroVerifySubcommands = subcommandsFor('retro-verify');
  const retroVerifyFlags = flagsFor('retro-verify');
  const reflectSubcommands = subcommandsFor('reflect');
  const reflectFlags = flagsFor('reflect');
  const prChecklistSubcommands = subcommandsFor('pr-checklist');
  const prChecklistFlags = flagsFor('pr-checklist');
  const contextPackFlags = flagsFor('context-pack');
  const signalEmitSubcommands = subcommandsFor('signal-emit');
  const signalEmitFlags = flagsFor('signal-emit');
  const pushSubcommands = subcommandsFor('push');
  const completionFlags = flagsFor('completion');

  return `#compdef kookr
# zsh completion for kookr. Generated by \`kookr completion zsh\`.
_kookr()
{
  local -a root_commands completion_shells
  root_commands=(${rootWords})
  completion_shells=(${shells})

  if (( CURRENT == 2 )); then
    compadd -- $root_commands ${rootFlags}
    return
  fi

  case "$words[2]" in
    spawn)
      case "$words[CURRENT]" in
        --dedupe=*) compadd -- ${dedupeEqualsValues}; return ;;
        --effort=*) compadd -- ${effortEqualsValues}; return ;;
        --model=*) compadd -- ${modelEqualsValues}; return ;;
      esac
      case "$words[CURRENT-1]" in
        -a|--agent) compadd ${agentValues}; return ;;
        --effort) compadd ${effortValues}; return ;;
        --dedupe) compadd ${dedupeValues}; return ;;
        --model) compadd ${modelValues}; return ;;
      esac
      compadd -- ${spawnFlags}
      ;;
    signal)
      if (( CURRENT == 3 )); then
        compadd -- ${signalKinds} ${signalFlags}
      else
        compadd -- ${signalFlags}
      fi
      ;;
    issue)
      if (( CURRENT == 3 )); then
        compadd -- ${issueSubcommands} ${issueFlags}
      else
        compadd -- ${issueFlags}
      fi
      ;;
    status)
      case "$words[CURRENT]" in
        --fail-on=*) compadd -- ${statusFailOnEqualsValues}; return ;;
      esac
      case "$words[CURRENT-1]" in
        --fail-on) compadd ${statusFailOnValues}; return ;;
      esac
      compadd -- ${statusFlags}
      ;;
    ops)
      if (( CURRENT == 3 )); then
        compadd -- ${opsSubcommands} ${opsFlags}
      else
        compadd -- ${opsFlags}
      fi
      ;;
    github)
      if (( CURRENT == 3 )); then
        compadd -- ${githubSubcommands} ${githubFlags}
      else
        compadd -- ${githubFlags}
      fi
      ;;
    doctor)
      compadd -- ${doctorFlags}
      ;;
    logs)
      compadd -- ${logsFlags}
      ;;
    command)
      if (( CURRENT == 3 )); then
        compadd ${commandSubcommands}
      fi
      ;;
    ralph)
      if (( CURRENT == 3 )); then
        compadd -- ${ralphSubcommands} ${ralphFlags}
      else
        compadd -- ${ralphFlags}
      fi
      ;;
    schedule)
      if (( CURRENT == 3 )); then
        compadd -- ${scheduleSubcommands} ${scheduleFlags}
      else
        compadd -- ${scheduleFlags}
      fi
      ;;
    drain)
      compadd -- ${drainSubcommands} ${drainFlags}
      ;;
    resume)
      ;;
    migrate)
      compadd -- ${migrateFlags}
      ;;
    maintenance)
      if (( CURRENT == 3 )); then
        compadd ${maintenanceSubcommands}
      else
        case "$words[3]" in
          prune) compadd -- ${maintenancePruneFlags} ;;
          backup) compadd -- ${maintenanceBackupFlags} ;;
        esac
      fi
      ;;
    lesson)
      if (( CURRENT == 3 )); then
        compadd ${lessonSubcommands}
      else
        case "$words[3]" in
          status) compadd -- ${lessonStatusFlags} ;;
          drain) compadd -- ${lessonDrainFlags} ;;
          remember) compadd -- ${lessonRememberFlags} ;;
          yield) compadd -- ${lessonYieldFlags} ;;
        esac
      fi
      ;;
    effort-split)
      compadd -- ${effortSplitFlags}
      ;;
    value-density)
      if (( CURRENT == 3 )); then
        compadd -- ${valueDensitySubcommands} ${valueDensityFlags}
      else
        compadd -- ${valueDensityFlags}
      fi
      ;;
    queue-feeder)
      if (( CURRENT == 3 )); then
        compadd -- ${queueFeederSubcommands} ${queueFeederFlags}
      else
        compadd -- ${queueFeederFlags}
      fi
      ;;
    emission)
      if (( CURRENT == 3 )); then
        compadd -- ${emissionSubcommands} ${emissionFlags}
      else
        compadd -- ${emissionFlags}
      fi
      ;;
    retro-verify)
      if (( CURRENT == 3 )); then
        compadd -- ${retroVerifySubcommands} ${retroVerifyFlags}
      else
        compadd -- ${retroVerifyFlags}
      fi
      ;;
    reflect)
      if (( CURRENT == 3 )); then
        compadd -- ${reflectSubcommands} ${reflectFlags}
      else
        compadd -- ${reflectFlags}
      fi
      ;;
    pr-checklist)
      if (( CURRENT == 3 )); then
        compadd -- ${prChecklistSubcommands} ${prChecklistFlags}
      else
        compadd -- ${prChecklistFlags}
      fi
      ;;
    context-pack)
      compadd -- ${contextPackFlags}
      ;;
    signal-emit)
      if (( CURRENT == 3 )); then
        compadd -- ${signalEmitSubcommands} ${signalEmitFlags}
      else
        compadd -- ${signalEmitFlags}
      fi
      ;;
    push)
      if (( CURRENT == 3 )); then
        compadd ${pushSubcommands}
      fi
      ;;
    completion)
      if (( CURRENT == 3 )); then
        compadd -- $completion_shells
      else
        compadd -- ${completionFlags}
      fi
      ;;
  esac
}

_kookr "$@"`;
}

function flagsFor(commandName: string): string {
  const command = KOOKR_COMPLETION_COMMANDS.find((item) => item.name === commandName);
  return shellWords(command?.flags ?? []);
}

function subcommandsFor(commandName: string): string {
  const command = KOOKR_COMPLETION_COMMANDS.find((item) => item.name === commandName);
  return shellWords(command?.subcommands ?? []);
}

function positionalValuesFor(commandName: string): string {
  const command = KOOKR_COMPLETION_COMMANDS.find((item) => item.name === commandName);
  return shellWords(command?.positionalValues ?? []);
}

function flagValuesFor(commandName: string, flag: string): string {
  const command = KOOKR_COMPLETION_COMMANDS.find((item) => item.name === commandName);
  return shellWords(command?.flagValues?.[flag] ?? []);
}

function equalsFlagValues(flag: string, values: string): string {
  return values
    .split(' ')
    .filter(Boolean)
    .map((value) => `${flag}=${value}`)
    .join(' ');
}

function shellWords(words: readonly string[]): string {
  return words.join(' ');
}
