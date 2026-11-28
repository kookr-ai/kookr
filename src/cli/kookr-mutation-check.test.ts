import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MUTATION_CHECK_SETUP_EXIT,
  resolveMutationCheckScript,
  runMutationCheckCli,
  type SignalSource,
} from './kookr-mutation-check.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const kookrBin = join(repoRoot, 'bin', 'kookr');

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * The environment of a reviewer's shell in a Kookr task: no CLAUDE_PLUGIN_ROOT,
 * no KOOKR_PLUGIN_DIR, and none of the GIT_* variables a pre-push hook exports
 * (they would point git at the kookr checkout instead of the scratch repository).
 */
function taskShellEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('GIT_') || key === 'CLAUDE_PLUGIN_ROOT' || key === 'KOOKR_PLUGIN_DIR') continue;
    env[key] = value;
  }
  return {
    ...env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

/** A repository that is not kookr: `limit.js` and a node test that checks its bound. */
function makeScratchRepo(env: NodeJS.ProcessEnv): string {
  const repo = tempDir('kookr-mutation-check-repo-');
  writeFileSync(join(repo, 'limit.js'), 'exports.underLimit = (n) => n < 3;\n');
  writeFileSync(
    join(repo, 'limit.test.js'),
    [
      "const assert = require('node:assert');",
      "const { underLimit } = require('./limit.js');",
      'assert.strictEqual(underLimit(2), true);',
      'assert.strictEqual(underLimit(3), false);',
      '',
    ].join('\n'),
  );
  git(repo, env, 'init', '-q');
  git(repo, env, 'add', '.');
  git(repo, env, 'commit', '-q', '-m', 'init');
  return repo;
}

describe('resolveMutationCheckScript', () => {
  it('finds the script in the plugin of the kookr checkout that runs the command', () => {
    const resolved = resolveMutationCheckScript({ env: {}, kookrRoot: repoRoot });
    expect(resolved.script).toBe(join(repoRoot, 'plugin', 'scripts', 'mutation-check.sh'));
  });

  it('prefers KOOKR_PLUGIN_DIR when it holds the script', () => {
    const pluginDir = tempDir('kookr-mutation-check-plugin-');
    mkdirSync(join(pluginDir, 'scripts'));
    writeFileSync(join(pluginDir, 'scripts', 'mutation-check.sh'), '#!/bin/sh\n');
    const resolved = resolveMutationCheckScript({ env: { KOOKR_PLUGIN_DIR: pluginDir }, kookrRoot: repoRoot });
    expect(resolved.script).toBe(join(pluginDir, 'scripts', 'mutation-check.sh'));
  });

  it('falls back to the checkout when KOOKR_PLUGIN_DIR has no script', () => {
    const pluginDir = tempDir('kookr-mutation-check-plugin-');
    const resolved = resolveMutationCheckScript({ env: { KOOKR_PLUGIN_DIR: pluginDir }, kookrRoot: repoRoot });
    expect(resolved.script).toBe(join(repoRoot, 'plugin', 'scripts', 'mutation-check.sh'));
  });

  it('ignores CLAUDE_PLUGIN_ROOT, which can name an older plugin without the script', () => {
    const pluginRoot = tempDir('kookr-mutation-check-claude-root-');
    mkdirSync(join(pluginRoot, 'scripts'));
    writeFileSync(join(pluginRoot, 'scripts', 'mutation-check.sh'), '#!/bin/sh\n');
    const kookrRoot = tempDir('kookr-mutation-check-npm-install-');
    const resolved = resolveMutationCheckScript({ env: { CLAUDE_PLUGIN_ROOT: pluginRoot }, kookrRoot });
    expect(resolved.script).toBeUndefined();
    expect(resolved.tried).toEqual([join(kookrRoot, 'plugin', 'scripts', 'mutation-check.sh')]);
  });
});

describe('runMutationCheckCli', () => {
  it('exits 4 (setup), not 1 (survived), when the script cannot be found', async () => {
    const errors: string[] = [];
    const kookrRoot = tempDir('kookr-mutation-check-npm-install-');
    const code = await runMutationCheckCli(['--help'], {
      env: {},
      err: { error: (line: string) => errors.push(line) },
      kookrRoot,
      spawn: () => {
        throw new Error('must not spawn without a script');
      },
    });
    expect(code).toBe(MUTATION_CHECK_SETUP_EXIT);
    expect(errors.join('\n')).toContain(join(kookrRoot, 'plugin', 'scripts', 'mutation-check.sh'));
  });

  /** A fake child the test drives: `emit('exit', code, signal)` or `emit('error', e)`. */
  function fakeChild() {
    const child = new EventEmitter() as EventEmitter & { kills: string[]; kill: (signal?: string) => boolean };
    child.kills = [];
    child.kill = (signal?: string) => {
      child.kills.push(signal ?? 'SIGTERM');
      return true;
    };
    return child;
  }

  function fakeSignals(): SignalSource & EventEmitter {
    return new EventEmitter() as SignalSource & EventEmitter;
  }

  it('passes every argument to the script unparsed and returns its exit code', async () => {
    const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
    const child = fakeChild();
    const running = runMutationCheckCli(['--file', 'a.ts', '--', 'node', '--help'], {
      env: {},
      err: { error: () => {} },
      kookrRoot: repoRoot,
      signals: fakeSignals(),
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return child as never;
      },
    });
    child.emit('exit', 6, null);
    expect(await running).toBe(6);
    expect(calls).toEqual([
      {
        command: 'bash',
        args: [join(repoRoot, 'plugin', 'scripts', 'mutation-check.sh'), '--file', 'a.ts', '--', 'node', '--help'],
        options: expect.objectContaining({ stdio: 'inherit', detached: true }),
      },
    ]);
  });

  it('exits 4 (setup), not 1 (survived), when bash cannot be started', async () => {
    const child = fakeChild();
    const errors: string[] = [];
    const running = runMutationCheckCli([], {
      env: {},
      err: { error: (line: string) => errors.push(line) },
      kookrRoot: repoRoot,
      signals: fakeSignals(),
      spawn: () => child as never,
    });
    child.emit('error', new Error('spawn bash ENOENT'));
    expect(await running).toBe(MUTATION_CHECK_SETUP_EXIT);
    expect(errors.join('\n')).toContain('spawn bash ENOENT');
  });

  it('reports a script killed by a signal as 128 + the signal number', async () => {
    const child = fakeChild();
    const running = runMutationCheckCli([], {
      env: {},
      err: { error: () => {} },
      kookrRoot: repoRoot,
      signals: fakeSignals(),
      spawn: () => child as never,
    });
    child.emit('exit', null, 'SIGTERM');
    expect(await running).toBe(143);
  });

  it('forwards the first signal to the script once, under the same name, and then stops listening', async () => {
    const child = fakeChild();
    const signals = fakeSignals();
    const running = runMutationCheckCli([], {
      env: {},
      err: { error: () => {} },
      kookrRoot: repoRoot,
      signals,
      spawn: () => child as never,
    });
    signals.emit('SIGINT', 'SIGINT');
    signals.emit('SIGTERM', 'SIGTERM');
    signals.emit('SIGINT', 'SIGINT');
    expect(child.kills).toEqual(['SIGINT']);
    child.emit('exit', 130, null);
    expect(await running).toBe(130);
    expect(signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM') + signals.listenerCount('SIGHUP')).toBe(0);
  });
});

// Acceptance (issue #4137): from a repository other than kookr, in a shell with
// CLAUDE_PLUGIN_ROOT unset, `kookr mutation-check` runs the helper and reports
// killed or survived.
describe('kookr mutation-check from another repository', () => {
  function runKookr(repo: string, env: NodeJS.ProcessEnv, ...args: string[]) {
    return spawnSync(kookrBin, ['mutation-check', ...args], { cwd: repo, env, encoding: 'utf8', timeout: 60_000 });
  }

  it('reports killed (exit 0) when the test catches the change', () => {
    const env = taskShellEnv();
    const repo = makeScratchRepo(env);
    const result = runKookr(repo, env, '--file', 'limit.js', '--line', '1', '--from', 'n < 3', '--to', 'n <= 3', '--', 'node', 'limit.test.js');
    expect(result.stdout).toMatch(/^killed\b/m);
    expect(result.status).toBe(0);
  });

  it('reports survived (exit 1) when the test does not catch the change', () => {
    const env = taskShellEnv();
    const repo = makeScratchRepo(env);
    // The change only alters the result for n > 100, which the test never passes in.
    const result = runKookr(repo, env, '--file', 'limit.js', '--line', '1', '--from', 'n < 3', '--to', 'n < 3 || n > 100', '--', 'node', 'limit.test.js');
    expect(result.stdout).toMatch(/^survived\b/m);
    expect(result.status).toBe(1);
  });

  // A terminal Ctrl-C, or an aborted tool call, signals the whole process
  // group. The script must get one signal, finish its cleanup and leave no
  // worktree behind in the repository under review.
  for (const [signal, expectedCode] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    it(`removes its worktree when the process group gets ${signal} mid-run (exit ${expectedCode})`, async () => {
      const env = taskShellEnv();
      const repo = makeScratchRepo(env);
      const child = spawn(kookrBin, ['mutation-check', '--file', 'limit.js', '--line', '1', '--from', 'n < 3', '--to', 'n <= 3', '--', 'sleep', '30'], {
        cwd: repo,
        env,
        detached: true, // its own process group, so the test can signal the whole group
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stdout.resume();
      const exited = new Promise<number | null>((resolveExit) => child.on('exit', (code) => resolveExit(code)));
      await new Promise<void>((resolveBaseline, rejectBaseline) => {
        const timer = setTimeout(() => rejectBaseline(new Error(`baseline never started: ${stderr}`)), 30_000);
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
          if (stderr.includes('baseline:')) {
            clearTimeout(timer);
            resolveBaseline();
          }
        });
      });
      process.kill(-child.pid!, signal);
      expect(await exited).toBe(expectedCode);
      const worktrees = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, env, encoding: 'utf8' });
      expect(worktrees.stdout.match(/^worktree /gm)).toHaveLength(1);
    }, 60_000);
  }
});
