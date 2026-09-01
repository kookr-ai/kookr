import { ROUND_ROBIN_AGENT_TYPE, type AgentSelection } from '../../shared/contracts/agent-types.js';

/**
 * Builds the copyable `kookr spawn` one-liner shown in the Launch dialog. Shell
 * quoting, heredoc delimiter selection, and the `--prompt-file` fallback all
 * live here — extracted from the dialog component so the escaping logic (which
 * is security-sensitive: see {@link PROMPT_ARGV_UNSAFE}) can be exercised by a
 * standalone golden corpus rather than only through the React surface. See
 * issue #2819.
 */

/**
 * Heredoc delimiter for the prompt-file fallback. Quoted at the call site
 * (`<<'…'`) so the shell performs no expansion inside the body — quotes, `$`,
 * backticks, and `!` all stay literal. Deliberately not `KOOKR_`-prefixed: a
 * `KOOKR_*` string literal would be flagged as an undocumented env-var read by
 * the documented-env-var verifier (`scripts/verify-documented-env-vars.ts`).
 */
const SPAWN_PROMPT_HEREDOC = 'SPAWN_PROMPT_EOF';
/**
 * Characters that either break a naive double-quoted argv token or are read by
 * Claude Code's bash hooks (which inspect the command line, not file contents).
 * Any of these in the prompt trips the `--prompt-file` fallback (issue #2420).
 */
const PROMPT_ARGV_UNSAFE = /["`$\\!\n\r]/;
/** A bare shell token: safe to emit unquoted (plain paths, agent names, words). */
const BARE_SHELL_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Wrap a value in double quotes, escaping the chars still special inside them.
 * Used only for the prompt on the argv path, which the `--prompt-file` fallback
 * has already stripped of `!` and other hook-sensitive tokens (so double quotes
 * are safe there). Acceptance criteria pins this quoting style for the prompt.
 */
function shellDoubleQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * POSIX-safe single-quote quoting: everything inside single quotes is literal —
 * including `$`, backticks, and `!` history expansion (which cannot be escaped
 * inside bash double quotes) — and a literal single quote is emitted via the
 * `'\''` idiom. Used for `-C`/`--criteria` values, which have no
 * `--prompt-file`-style escape hatch and so must be quoted in a form that
 * survives paste into an interactive shell.
 */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Emit `value` bare when it is a plain token, else single-quoted. */
function shellArg(value: string): string {
  return BARE_SHELL_TOKEN.test(value) ? value : shellSingleQuote(value);
}

/**
 * A heredoc delimiter guaranteed not to appear as its own line in `prompt`, so
 * the quoted heredoc body cannot be terminated early by prompt content. Starts
 * from {@link SPAWN_PROMPT_HEREDOC} and extends deterministically on collision.
 */
function uniqueHeredocDelimiter(prompt: string): string {
  const lines = new Set(prompt.split(/\r?\n/));
  let delimiter = SPAWN_PROMPT_HEREDOC;
  while (lines.has(delimiter)) delimiter += '_';
  return delimiter;
}

/** Outcome of building a copyable `kookr spawn` command from the dialog state. */
export interface SpawnCommandBuild {
  /** The full shell text to place on the clipboard. */
  command: string;
  /**
   * True when the prompt held quotes, shell metacharacters, or newlines and was
   * therefore written via a heredoc + `--prompt-file` instead of a quoted argv
   * positional. Surfaced in the copy toast so the operator knows what was copied.
   */
  usedPromptFile: boolean;
}

/**
 * Build the `kookr spawn` one-liner equivalent to the current Launch form. A
 * simple prompt becomes a quoted argv positional; a prompt with quotes or
 * hook-sensitive tokens is written to a freshly `mktemp`'d file via a quoted
 * heredoc and passed with `--prompt-file` (issue #2420). `mktemp` (rather than a
 * fixed `/tmp` path) avoids a symlink-clobber attack and cross-copy collisions.
 *
 * `round-robin` has no `kookr spawn -a` value (the flag accepts only concrete
 * agents), so it is omitted and the spawned task uses the server's configured
 * default agent — the closest runnable equivalent. This does not reproduce the
 * per-launch rotation a `round-robin` selection performs in the dashboard.
 */
export function buildSpawnCommand(input: {
  prompt: string;
  cwd: string;
  agentType: AgentSelection;
  criteria?: string;
}): SpawnCommandBuild {
  const prompt = input.prompt.trim();
  const cwd = input.cwd.trim();
  const criteria = input.criteria?.trim() ?? '';

  const flags: string[] = [];
  if (cwd) flags.push(`-C ${shellArg(cwd)}`);
  if (input.agentType !== ROUND_ROBIN_AGENT_TYPE) {
    flags.push(`-a ${input.agentType}`);
  }

  if (PROMPT_ARGV_UNSAFE.test(prompt)) {
    const spawnFlags = [...flags, '--prompt-file "$prompt_file"'];
    if (criteria) spawnFlags.push(`--criteria ${shellArg(criteria)}`);
    const delimiter = uniqueHeredocDelimiter(prompt);
    // `mktemp` gives a unique, non-predictable file created with O_EXCL, so the
    // redirect cannot follow a pre-planted symlink or clobber a concurrent copy.
    const heredoc =
      'prompt_file="$(mktemp)"\n' +
      `cat > "$prompt_file" <<'${delimiter}'\n` +
      `${prompt}\n` +
      `${delimiter}`;
    return {
      command: `${heredoc}\nkookr spawn ${spawnFlags.join(' ')}`,
      usedPromptFile: true,
    };
  }

  const parts = [...flags];
  if (criteria) parts.push(`--criteria ${shellArg(criteria)}`);
  parts.push(shellDoubleQuote(prompt));
  return { command: `kookr spawn ${parts.join(' ')}`, usedPromptFile: false };
}
