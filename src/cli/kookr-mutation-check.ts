// `kookr mutation-check` (issue #4137): run the kookr-toolkit mutation-check
// helper (`plugin/scripts/mutation-check.sh`, #4105) by one fixed name from any
// working directory.
//
// Reviewers were told two paths for the script: `plugin/scripts/...` inside the
// kookr repository and `${CLAUDE_PLUGIN_ROOT}/scripts/...` in an installed
// plugin. In a Kookr task shell that variable is unset and the plugin is loaded
// with `--plugin-dir`, not from the plugin cache, so a reviewer working in
// another repository could not find the script. `kookr` itself is on PATH in
// every task (bin/ is prepended to the agent PATH), so the script is found next
// to the `kookr` that runs: `<kookr checkout>/plugin/scripts/mutation-check.sh`.
//
// This wrapper parses nothing. Every argument, `--help` and `--` included, goes
// to the script, which runs with the caller's working directory, so `--repo`
// defaults to the repository the caller is in. The script's exit codes (0
// killed, 1 survived, 2 refused, 3 red, 4 setup, 5 timeout, 6 killed (timeout))
// pass through unchanged. The wrapper's own failures exit 4 (setup), never 1,
// because 1 means `survived`.

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { join, resolve } from 'node:path';

export const MUTATION_CHECK_SCRIPT_REL = join('scripts', 'mutation-check.sh');

/** Exit code for a wrapper failure; the script uses the same code for setup errors. */
export const MUTATION_CHECK_SETUP_EXIT = 4;

export interface ResolveMutationCheckScriptOptions {
  env?: NodeJS.ProcessEnv;
  /** Root of the kookr install that runs this command (the parent of its `bin/`). */
  kookrRoot: string;
}

export interface ResolvedMutationCheckScript {
  /** The script to run, or undefined when no candidate exists. */
  script: string | undefined;
  /** Every path that was checked, in order. */
  tried: string[];
}

/**
 * Find `mutation-check.sh`. Order:
 *   1. `$KOOKR_PLUGIN_DIR/scripts/mutation-check.sh`, when that variable is set
 *      (the same override the agent adapters use for `--plugin-dir`);
 *   2. `<kookrRoot>/plugin/scripts/mutation-check.sh`, the plugin that ships
 *      in the same checkout as the running `kookr`.
 * `CLAUDE_PLUGIN_ROOT` and the plugin cache are deliberately not consulted: the
 * first is unset in a task shell, and the cache can hold an older plugin that
 * predates the script.
 */
export function resolveMutationCheckScript(
  options: ResolveMutationCheckScriptOptions,
): ResolvedMutationCheckScript {
  const env = options.env ?? process.env;
  const candidates: string[] = [];
  const fromEnv = env.KOOKR_PLUGIN_DIR;
  if (fromEnv) candidates.push(resolve(fromEnv, MUTATION_CHECK_SCRIPT_REL));
  candidates.push(resolve(options.kookrRoot, 'plugin', MUTATION_CHECK_SCRIPT_REL));
  const script = candidates.find((candidate) => existsSync(candidate));
  return { script, tried: candidates };
}

interface ChildLike {
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

type SpawnLike = (command: string, args: string[], options: { stdio: 'inherit'; env: NodeJS.ProcessEnv }) => ChildLike;

export interface RunMutationCheckOptions {
  env?: NodeJS.ProcessEnv;
  err?: Pick<Console, 'error'>;
  kookrRoot: string;
  spawn?: SpawnLike;
}

/** Run the script with `argv`; resolves to the exit code to pass on. */
export function runMutationCheckCli(argv: string[], options: RunMutationCheckOptions): Promise<number> {
  const env = options.env ?? process.env;
  const err = options.err ?? console;
  const { script, tried } = resolveMutationCheckScript({ env, kookrRoot: options.kookrRoot });
  if (!script) {
    err.error('[kookr] mutation-check: script not found. Looked at:');
    for (const path of tried) err.error(`[kookr]   ${path}`);
    err.error('[kookr] `kookr mutation-check` needs a Kookr source checkout (the npm package does not ship plugin/);');
    err.error('[kookr] run it from that checkout\'s bin/kookr, or set KOOKR_PLUGIN_DIR to a kookr-toolkit plugin directory.');
    return Promise.resolve(MUTATION_CHECK_SETUP_EXIT);
  }
  const spawn: SpawnLike = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions));
  // Forward a signal aimed at this node process alone, so the script's
  // cleanup trap removes its worktree instead of leaving it behind.
  return new Promise((resolvePromise) => {
    const child = spawn('bash', [script, ...argv], { stdio: 'inherit', env });
    const forwarded: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const forward = () => {
      try { child.kill('SIGTERM'); } catch { /* child already gone */ }
    };
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      for (const signal of forwarded) process.off(signal, forward);
      resolvePromise(code);
    };
    for (const signal of forwarded) process.on(signal, forward);
    child.on('error', (error) => {
      err.error(`[kookr] could not run mutation-check: ${error.message}`);
      finish(MUTATION_CHECK_SETUP_EXIT);
    });
    child.on('exit', (code, signal) => {
      if (code !== null) return finish(code);
      finish(signal ? 128 + (osConstants.signals[signal] ?? 0) : MUTATION_CHECK_SETUP_EXIT);
    });
  });
}
