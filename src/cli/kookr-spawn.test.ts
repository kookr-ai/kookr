import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createServer, type Server } from 'node:http';
import {
  EXIT_NO_SERVER,
  EXIT_DUPLICATE_BLOCKED,
  EXIT_OK,
  EXIT_SERVER_ERROR,
  EXIT_USER_ERROR,
  EXIT_WAIT_TIMEOUT,
  UsageError,
  classifyWaitState,
  deriveAutoIdempotencyKey,
  formatBackpressure429,
  formatDedup,
  formatSuccess,
  formatWaitOutcome,
  isTruthyEnv,
  main,
  parseArgs,
  parseMaxBytes,
  parsePortEnv,
  parseRetries,
  parseWaitTimeoutSeconds,
  postTask,
  postTaskWithReconcile,
  parseRetryAfterMs,
  reconcileDelayMs,
  reconcileViaTaskProbe,
  taskMatchesSpawn,
  cwdEquivalent,
  formatReconcileRecovered,
  isReconcilableStatus,
  DEFAULT_REDEPLOY_WAIT_MS,
  defaultProbeBudgetMs,
  parseRedeployWaitMs,
  probeDeployStatus,
  probeHealth,
  selectProbeWaitBudget,
  resolveBaseUrl,
  resolveCwd,
  resolveParentTaskId,
  resolvePrompt,
  waitForTaskReady,
} from '../../bin/kookr-spawn.js';

type StdinLike = NodeJS.ReadableStream & { isTTY?: boolean };

function pipedStdin(text: string): StdinLike {
  const stream = Readable.from(Buffer.from(text, 'utf-8')) as StdinLike;
  stream.isTTY = false;
  return stream;
}

function ttyStdin(): StdinLike {
  const stream = Readable.from(Buffer.from([])) as StdinLike;
  stream.isTTY = true;
  return stream;
}

function interactiveStdin(text: string): StdinLike {
  const stream = Readable.from(Buffer.from(text, 'utf-8')) as StdinLike;
  stream.isTTY = true;
  return stream;
}

function makeConsoleCapture() {
  const logs: string[] = [];
  const errors: string[] = [];
  const io = {
    log: (msg: string) => { logs.push(String(msg)); },
    error: (msg: string) => { errors.push(String(msg)); },
  };
  return { io, logs, errors };
}

function makeExitCapture() {
  const codes: number[] = [];
  const exit = ((code: number) => {
    codes.push(code);
    // Return a non-throwing sentinel so main() can keep its early returns.
    return undefined as unknown as never;
  }) as (code: number) => never | void;
  return { codes, exit };
}

function parseSingleJsonLog(logs: string[]): any {
  expect(logs).toHaveLength(1);
  return JSON.parse(logs[0]);
}

// ---------- parseArgs ----------

describe('parseArgs', () => {
  it('parses positional prompt tokens', () => {
    const p = parseArgs(['hello', 'world']);
    expect(p.positional).toEqual(['hello', 'world']);
    expect(p.help).toBe(false);
  });

  it('parses -h and --help', () => {
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('parses -C / --cwd, -a / --agent, --criteria, -f / --prompt-file', () => {
    const p = parseArgs([
      '-C', '/tmp/x',
      '-a', 'codex-cli',
      '--criteria', 'tests pass',
      '--dedupe', 'block',
      '-f', '/tmp/p.md',
    ]);
    expect(p.cwd).toBe('/tmp/x');
    expect(p.agent).toBe('codex-cli');
    expect(p.criteria).toBe('tests pass');
    expect(p.dedupe).toBe('block');
    expect(p.promptFile).toBe('/tmp/p.md');
  });

  it('parses a prompt-wrapper playbook and its explicit scope', () => {
    const p = parseArgs([
      '--playbook', 'architecture-refactor-phase.md',
      '--playbook-scope', 'plugin',
      '--prompt-file', '/tmp/phase.md',
    ]);

    expect(p.playbook).toBe('architecture-refactor-phase.md');
    expect(p.playbookScope).toBe('plugin');
  });

  it('rejects a playbook scope without a playbook and unsupported scopes', () => {
    expect(() => parseArgs(['--playbook-scope', 'plugin', 'prompt'])).toThrow(UsageError);
    expect(() => parseArgs(['--playbook', 'phase.md', '--playbook-scope', 'remote', 'prompt']))
      .toThrow(UsageError);
  });

  it('parses --dedupe=<mode> and defaults to warn', () => {
    expect(parseArgs([]).dedupe).toBe('warn');
    expect(parseArgs(['--dedupe=skip']).dedupe).toBe('skip');
  });

  it('parses --auto-idempotency / --no-auto-idempotency (default null defers to env)', () => {
    expect(parseArgs([]).autoIdempotency).toBeNull();
    expect(parseArgs(['--auto-idempotency']).autoIdempotency).toBe(true);
    expect(parseArgs(['--no-auto-idempotency']).autoIdempotency).toBe(false);
  });

  it('parses --dry-run (default false) (#1768)', () => {
    expect(parseArgs([]).dryRun).toBe(false);
    expect(parseArgs(['--dry-run']).dryRun).toBe(true);
    expect(parseArgs(['--dry-run', '--json', 'hello']).dryRun).toBe(true);
  });

  it('parses --wait with an optional timeout in seconds', () => {
    expect(parseArgs([]).wait).toBe(false);
    expect(parseArgs(['--wait', 'hello']).wait).toBe(true);
    expect(parseArgs(['--wait', 'hello']).waitTimeoutSeconds).toBeNull();
    expect(parseArgs(['--wait=30', 'hello']).wait).toBe(true);
    expect(parseArgs(['--wait=30', 'hello']).waitTimeoutSeconds).toBe(30);
    expect(parseArgs(['--wait=0.25', 'hello']).waitTimeoutSeconds).toBe(0.25);
  });

  it('rejects invalid --wait timeout values', () => {
    expect(() => parseArgs(['--wait=', 'hello'])).toThrow(UsageError);
    expect(() => parseArgs(['--wait=0', 'hello'])).toThrow(UsageError);
    expect(() => parseArgs(['--wait=-1', 'hello'])).toThrow(UsageError);
    expect(() => parseArgs(['--wait=abc', 'hello'])).toThrow(UsageError);
  });

  it('rejects unknown options', () => {
    expect(() => parseArgs(['--nope'])).toThrow(UsageError);
    expect(() => parseArgs(['-z'])).toThrow(UsageError);
  });

  it('rejects invalid --agent value', () => {
    expect(() => parseArgs(['--agent', 'gpt-4'])).toThrow(UsageError);
  });

  it('accepts claude-code, codex-cli, and grok-build as --agent values', () => {
    expect(parseArgs(['--agent', 'claude-code']).agent).toBe('claude-code');
    expect(parseArgs(['-a', 'codex-cli']).agent).toBe('codex-cli');
    expect(parseArgs(['--agent', 'grok-build']).agent).toBe('grok-build');
    expect(parseArgs(['-a', 'grok-build']).agent).toBe('grok-build');
  });

  it('parses --effort and --effort=<level>, defaulting to null (#681)', () => {
    expect(parseArgs([]).effort).toBeNull();
    expect(parseArgs(['--effort', 'high']).effort).toBe('high');
    expect(parseArgs(['--effort=max']).effort).toBe('max');
    // codex-only levels parse fine at the CLI (server does agent-specific check).
    expect(parseArgs(['--effort', 'minimal']).effort).toBe('minimal');
  });

  it('accepts Codex ultra and rejects values outside the cross-agent union (#681)', () => {
    expect(parseArgs(['--effort', 'ultra']).effort).toBe('ultra');
    expect(() => parseArgs(['--effort', 'supermax'])).toThrow(UsageError);
    expect(() => parseArgs(['--effort', ''])).toThrow(UsageError);
  });

  it('parses --model and --model=<id>, defaulting to null (#1518)', () => {
    expect(parseArgs([]).model).toBeNull();
    expect(parseArgs(['--model', 'claude-fable-5']).model).toBe('claude-fable-5');
    expect(parseArgs(['--model=claude-opus-4-8']).model).toBe('claude-opus-4-8');
    expect(parseArgs(['--model', 'claude-haiku-4-5-20251001']).model).toBe('claude-haiku-4-5-20251001');
  });

  it('rejects unknown --model values at the CLI (#1518)', () => {
    expect(() => parseArgs(['--model', 'gpt-5.6-sol'])).toThrow(UsageError);
    expect(() => parseArgs(['--model', ''])).toThrow(UsageError);
    expect(() => parseArgs(['--model', 'not-a-model'])).toThrow(UsageError);
  });

  it('parses portable small model intent and rejects ambiguous raw pins', () => {
    expect(parseArgs([]).modelTier).toBeNull();
    expect(parseArgs(['--model-tier', 'small']).modelTier).toBe('small');
    expect(parseArgs(['--model-tier=small']).modelTier).toBe('small');
    expect(() => parseArgs(['--model-tier', 'flagship'])).toThrow(UsageError);
    expect(() => parseArgs(['--model-tier', 'small', '--model', 'claude-haiku-4-5'])).toThrow(UsageError);
    expect(() => parseArgs(['--model-tier', 'small', '--effort', 'high'])).toThrow(UsageError);
  });

  it('rejects invalid --dedupe value', () => {
    expect(() => parseArgs(['--dedupe', 'maybe'])).toThrow(UsageError);
  });

  it('treats tokens after -- as positional even if they look like flags', () => {
    const p = parseArgs(['--', '--prompt-file', 'not-a-flag']);
    expect(p.positional).toEqual(['--prompt-file', 'not-a-flag']);
    expect(p.promptFile).toBeNull();
  });

  it('throws when an option value is missing', () => {
    expect(() => parseArgs(['-C'])).toThrow(UsageError);
    expect(() => parseArgs(['--cwd'])).toThrow(UsageError);
  });

  it('parses --parent-task-id and --no-parent-task', () => {
    expect(parseArgs(['--parent-task-id', 'abc']).parentTaskId).toBe('abc');
    expect(parseArgs(['--parent-task-id=def']).parentTaskId).toBe('def');
    expect(parseArgs([]).parentTaskId).toBeNull();
    expect(parseArgs([]).noParentTask).toBe(false);
    expect(parseArgs(['--no-parent-task']).noParentTask).toBe(true);
  });

  it('rejects empty --parent-task-id and conflict with --no-parent-task', () => {
    expect(() => parseArgs(['--parent-task-id', '   '])).toThrow(UsageError);
    expect(() => parseArgs(['--parent-task-id', 'abc', '--no-parent-task'])).toThrow(UsageError);
    expect(() => parseArgs(['--no-parent-task', '--parent-task-id', 'abc'])).toThrow(UsageError);
  });

  it('parses --auto-close-on-signal / --no-auto-close-on-signal as a tri-state', () => {
    expect(parseArgs([]).autoCloseOnSignal).toBeNull();
    expect(parseArgs(['--auto-close-on-signal']).autoCloseOnSignal).toBe(true);
    expect(parseArgs(['--no-auto-close-on-signal']).autoCloseOnSignal).toBe(false);
    // A repeated identical flag is redundant, not a conflict.
    expect(parseArgs(['--auto-close-on-signal', '--auto-close-on-signal']).autoCloseOnSignal).toBe(true);
  });

  it('rejects combined --auto-close-on-signal and --no-auto-close-on-signal', () => {
    expect(() => parseArgs(['--auto-close-on-signal', '--no-auto-close-on-signal'])).toThrow(UsageError);
    expect(() => parseArgs(['--no-auto-close-on-signal', '--auto-close-on-signal'])).toThrow(UsageError);
  });

  it('parses --idempotency-key and --idempotency-key=<key> (#1526)', () => {
    expect(parseArgs([]).idempotencyKey).toBeNull();
    expect(parseArgs(['--idempotency-key', 'repo#42@batch-1']).idempotencyKey).toBe('repo#42@batch-1');
    expect(parseArgs(['--idempotency-key=repo#42@batch-1']).idempotencyKey).toBe('repo#42@batch-1');
  });

  it('trims --idempotency-key whitespace', () => {
    expect(parseArgs(['--idempotency-key', '  k1  ']).idempotencyKey).toBe('k1');
  });

  it('rejects empty --idempotency-key', () => {
    expect(() => parseArgs(['--idempotency-key', '   '])).toThrow(UsageError);
  });

  it('rejects --idempotency-key over 200 characters', () => {
    expect(() => parseArgs(['--idempotency-key', 'x'.repeat(201)])).toThrow(UsageError);
    expect(parseArgs(['--idempotency-key', 'x'.repeat(200)]).idempotencyKey).toHaveLength(200);
  });
});

// ---------- auto-idempotency ----------

describe('deriveAutoIdempotencyKey', () => {
  const base = { prompt: 'implement #42', cwd: '/repo/one', criteria: 'PR open', agent: 'claude-code' };

  it('is deterministic for the same identity and carries no time component', () => {
    const a = deriveAutoIdempotencyKey({ ...base });
    const b = deriveAutoIdempotencyKey({ ...base });
    expect(a).toBe(b);
    // No calendar component — the server's rolling 24h TTL bounds replay.
    expect(a).toMatch(/^auto-[0-9a-f]{16}$/);
  });

  it('differs when any identity component differs', () => {
    const ref = deriveAutoIdempotencyKey({ ...base });
    for (const patch of [
      { prompt: 'implement #43' },
      { cwd: '/repo/two' },
      { criteria: 'other' },
      { agent: 'codex-cli' },
      { effort: 'high' },
      { model: 'claude-haiku-4-5' },
      { modelTier: 'small' },
    ]) {
      expect(deriveAutoIdempotencyKey({ ...base, ...patch })).not.toBe(ref);
    }
  });

  it('preserves the pre-tier key when no model policy is supplied', () => {
    expect(deriveAutoIdempotencyKey({ ...base })).toBe('auto-f5986d30903fe868');
  });

  it('distinguishes playbook wrappers and their effective scopes', () => {
    const ref = deriveAutoIdempotencyKey({
      ...base,
      playbook: 'architecture-refactor-phase.md',
      playbookScope: 'plugin',
    });
    expect(deriveAutoIdempotencyKey({
      ...base,
      playbook: 'other-phase.md',
      playbookScope: 'plugin',
    })).not.toBe(ref);
    expect(deriveAutoIdempotencyKey({
      ...base,
      playbook: 'architecture-refactor-phase.md',
      playbookScope: 'project',
    })).not.toBe(ref);
  });

  it('is insensitive to field-boundary reshuffling (JSON-delimited identity)', () => {
    // Without unambiguous delimiting, ["ab","c"] and ["a","bc"] would collide.
    const a = deriveAutoIdempotencyKey({ prompt: 'ab', cwd: 'c', criteria: null, agent: null });
    const b = deriveAutoIdempotencyKey({ prompt: 'a', cwd: 'bc', criteria: null, agent: null });
    expect(a).not.toBe(b);
  });

  it('output length is independent of input size and well under the 200-char cap', () => {
    const short = deriveAutoIdempotencyKey({ prompt: 'x', cwd: '/tmp' });
    const huge = deriveAutoIdempotencyKey({ prompt: 'x'.repeat(100_000), cwd: '/tmp' });
    expect(short.length).toBe(huge.length);
    expect(huge.length).toBe('auto-'.length + 16); // fixed 21 chars
    expect(huge.length).toBeLessThanOrEqual(200);
  });
});

describe('isTruthyEnv', () => {
  it('accepts common truthy spellings (case-insensitive, trimmed)', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'On', '  true  ']) expect(isTruthyEnv(v)).toBe(true);
  });
  it('rejects everything else', () => {
    for (const v of ['', '0', 'false', 'no', 'off', undefined, null, '2']) expect(isTruthyEnv(v as string)).toBe(false);
  });
});

// ---------- resolveParentTaskId ----------

describe('resolveParentTaskId', () => {
  it('returns env KOOKR_TASK_ID by default (auto-link path)', () => {
    const args = parseArgs([]);
    expect(resolveParentTaskId({ args, env: { KOOKR_TASK_ID: 'env-parent' } })).toBe('env-parent');
  });

  it('trims surrounding whitespace from env value', () => {
    const args = parseArgs([]);
    expect(resolveParentTaskId({ args, env: { KOOKR_TASK_ID: '  env-parent  ' } })).toBe('env-parent');
  });

  it('returns null when env is unset, empty, or whitespace (outside Kookr)', () => {
    const args = parseArgs([]);
    expect(resolveParentTaskId({ args, env: {} })).toBeNull();
    expect(resolveParentTaskId({ args, env: { KOOKR_TASK_ID: '' } })).toBeNull();
    expect(resolveParentTaskId({ args, env: { KOOKR_TASK_ID: '   ' } })).toBeNull();
  });

  it('--parent-task-id overrides env', () => {
    const args = parseArgs(['--parent-task-id', 'explicit']);
    expect(resolveParentTaskId({ args, env: { KOOKR_TASK_ID: 'env-parent' } })).toBe('explicit');
  });

  it('--no-parent-task wins over env', () => {
    const args = parseArgs(['--no-parent-task']);
    expect(resolveParentTaskId({ args, env: { KOOKR_TASK_ID: 'env-parent' } })).toBeNull();
  });
});

// ---------- parsePortEnv / parseRetries / parseMaxBytes ----------

describe('parsePortEnv', () => {
  it('returns unset for undefined / empty', () => {
    expect(parsePortEnv(undefined)).toEqual({ kind: 'unset' });
    expect(parsePortEnv('')).toEqual({ kind: 'unset' });
  });

  it('returns valid for in-range integers', () => {
    expect(parsePortEnv('4801')).toEqual({ kind: 'valid', port: 4801 });
  });

  it('returns invalid for non-integer or out-of-range', () => {
    expect(parsePortEnv('abc').kind).toBe('invalid');
    expect(parsePortEnv('0').kind).toBe('invalid');
    expect(parsePortEnv('65536').kind).toBe('invalid');
  });
});

describe('parseRetries', () => {
  it('defaults to 3 when unset', () => {
    expect(parseRetries(undefined)).toBe(3);
    expect(parseRetries('')).toBe(3);
  });

  it('accepts integers in 1..10', () => {
    expect(parseRetries('1')).toBe(1);
    expect(parseRetries('10')).toBe(10);
  });

  it('rejects invalid values', () => {
    expect(() => parseRetries('0')).toThrow(UsageError);
    expect(() => parseRetries('11')).toThrow(UsageError);
    expect(() => parseRetries('abc')).toThrow(UsageError);
  });
});

describe('parseMaxBytes', () => {
  it('defaults to 1 MiB when unset', () => {
    expect(parseMaxBytes(undefined)).toBe(1024 * 1024);
    expect(parseMaxBytes('')).toBe(1024 * 1024);
  });

  it('accepts positive integers', () => {
    expect(parseMaxBytes('1024')).toBe(1024);
  });

  it('rejects zero and non-integers', () => {
    expect(() => parseMaxBytes('0')).toThrow(UsageError);
    expect(() => parseMaxBytes('abc')).toThrow(UsageError);
  });
});

describe('parseWaitTimeoutSeconds', () => {
  it('accepts positive finite seconds', () => {
    expect(parseWaitTimeoutSeconds('1')).toBe(1);
    expect(parseWaitTimeoutSeconds('0.5')).toBe(0.5);
  });

  it('rejects empty, zero, negative, and non-numeric values', () => {
    expect(() => parseWaitTimeoutSeconds('')).toThrow(UsageError);
    expect(() => parseWaitTimeoutSeconds('0')).toThrow(UsageError);
    expect(() => parseWaitTimeoutSeconds('-1')).toThrow(UsageError);
    expect(() => parseWaitTimeoutSeconds('nope')).toThrow(UsageError);
  });
});

// ---------- resolvePrompt ----------

describe('resolvePrompt', () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'kookr-spawn-prompt-'));
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('uses positional argv when provided', async () => {
    const args = parseArgs(['hello', 'world']);
    const prompt = await resolvePrompt({ args, stdin: ttyStdin(), env: {} });
    expect(prompt).toBe('hello world');
  });

  it('reads piped stdin when no positional', async () => {
    const args = parseArgs([]);
    const prompt = await resolvePrompt({ args, stdin: pipedStdin('from stdin'), env: {} });
    expect(prompt).toBe('from stdin');
  });

  it('reads --prompt-file', async () => {
    const path = join(tmpRoot, 'p.md');
    await writeFile(path, 'from file\n');
    const args = parseArgs(['--prompt-file', path]);
    const prompt = await resolvePrompt({ args, stdin: ttyStdin(), env: {} });
    expect(prompt).toBe('from file');
  });

  it('prefers --prompt-file over positional and stdin', async () => {
    const path = join(tmpRoot, 'p.md');
    await writeFile(path, 'WIN');
    const args = parseArgs(['--prompt-file', path, 'LOSE']);
    const prompt = await resolvePrompt({
      args,
      stdin: pipedStdin('ALSO-LOSE'),
      env: {},
    });
    expect(prompt).toBe('WIN');
  });

  it('errors clearly when no prompt and TTY stdin', async () => {
    const args = parseArgs([]);
    await expect(
      resolvePrompt({ args, stdin: ttyStdin(), env: {} }),
    ).rejects.toThrow(/no prompt/);
  });

  it('rejects empty prompt', async () => {
    const args = parseArgs([]);
    await expect(
      resolvePrompt({ args, stdin: pipedStdin('   \n\n'), env: {} }),
    ).rejects.toThrow(/empty/);
  });

  it('rejects NUL byte in prompt', async () => {
    const args = parseArgs(['hello' + String.fromCharCode(0) + 'world']);
    await expect(
      resolvePrompt({ args, stdin: ttyStdin(), env: {} }),
    ).rejects.toThrow(/NUL/);
  });

  it('rejects stdin larger than max bytes', async () => {
    const args = parseArgs([]);
    await expect(
      resolvePrompt({
        args,
        stdin: pipedStdin('x'.repeat(10_000)),
        env: { KOOKR_SPAWN_MAX_PROMPT_BYTES: '100' },
      }),
    ).rejects.toThrow(/exceeds/);
  });

  it('rejects --prompt-file larger than max bytes', async () => {
    const path = join(tmpRoot, 'p.md');
    await writeFile(path, 'x'.repeat(10_000));
    const args = parseArgs(['--prompt-file', path]);
    await expect(
      resolvePrompt({
        args,
        stdin: ttyStdin(),
        env: { KOOKR_SPAWN_MAX_PROMPT_BYTES: '100' },
      }),
    ).rejects.toThrow(/too large/);
  });

  it('errors on missing --prompt-file path', async () => {
    const args = parseArgs(['--prompt-file', '/nonexistent/xyz.md']);
    await expect(
      resolvePrompt({ args, stdin: ttyStdin(), env: {} }),
    ).rejects.toThrow(/could not read/);
  });
});

// ---------- resolveCwd ----------

describe('resolveCwd', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kookr-spawn-cwd-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns process.cwd() when no override and cwd exists', () => {
    expect(resolveCwd(null, dir)).toBe(dir);
  });

  it('resolves relative --cwd against pwd', async () => {
    const sub = join(dir, 'sub');
    await writeFile(join(dir, '.keep'), '');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(sub);
    expect(resolveCwd('sub', dir)).toBe(sub);
  });

  it('errors when cwd does not exist', () => {
    expect(() => resolveCwd('/nonexistent/kookr-spawn-test-path', dir)).toThrow(UsageError);
  });

  it('errors when cwd is a file, not a directory', async () => {
    const file = join(dir, 'not-a-dir');
    await writeFile(file, 'hi');
    expect(() => resolveCwd(file, dir)).toThrow(UsageError);
  });
});

// ---------- selectProbeWaitBudget (#1975) ----------

describe('defaultProbeBudgetMs', () => {
  it('is (retries-1)*delay for the standard connect-retry loop', () => {
    expect(defaultProbeBudgetMs(3, 3000)).toBe(6000);
    expect(defaultProbeBudgetMs(1, 3000)).toBe(0);
    expect(defaultProbeBudgetMs(0, 3000)).toBe(0);
  });
});

describe('parseRedeployWaitMs', () => {
  it('returns null for unset/invalid and accepts the env range', () => {
    expect(parseRedeployWaitMs(undefined)).toBeNull();
    expect(parseRedeployWaitMs('')).toBeNull();
    expect(parseRedeployWaitMs('nope')).toBeNull();
    expect(parseRedeployWaitMs('-1')).toBeNull();
    expect(parseRedeployWaitMs('300001')).toBeNull();
    expect(parseRedeployWaitMs('0')).toBe(0);
    expect(parseRedeployWaitMs('45000')).toBe(45000);
  });
});

describe('selectProbeWaitBudget', () => {
  const base = { defaultBudgetMs: 6000 };

  it('keeps the default budget when not deploying', () => {
    expect(selectProbeWaitBudget({ ...base, deploying: false })).toEqual({
      budgetMs: 6000,
      reason: 'default',
    });
  });

  it('extends past default when status says deploying', () => {
    const r = selectProbeWaitBudget({ ...base, deploying: true });
    expect(r.reason).toBe('deploying');
    expect(r.budgetMs).toBe(DEFAULT_REDEPLOY_WAIT_MS);
    expect(r.budgetMs).toBeGreaterThan(base.defaultBudgetMs);
  });

  it('extends when lastRestart is within the recent window', () => {
    const nowMs = Date.parse('2026-08-03T12:00:30.000Z');
    const r = selectProbeWaitBudget({
      ...base,
      deploying: false,
      lastRestartAt: '2026-08-03T12:00:00.000Z',
      nowMs,
    });
    expect(r).toEqual({ budgetMs: DEFAULT_REDEPLOY_WAIT_MS, reason: 'recent_restart' });
  });

  it('does not extend for a stale lastRestart', () => {
    const nowMs = Date.parse('2026-08-03T12:05:00.000Z');
    const r = selectProbeWaitBudget({
      ...base,
      deploying: false,
      lastRestartAt: '2026-08-03T12:00:00.000Z',
      nowMs,
      recentRestartWindowMs: 60_000,
    });
    expect(r).toEqual({ budgetMs: 6000, reason: 'default' });
  });

  it('when status is down, only extends if KOOKR_SPAWN_REDEPLOY_WAIT_MS is set', () => {
    expect(selectProbeWaitBudget({ ...base, deploying: null })).toEqual({
      budgetMs: 6000,
      reason: 'default',
    });
    expect(
      selectProbeWaitBudget({
        ...base,
        deploying: null,
        redeployWaitMsEnv: '20000',
      }),
    ).toEqual({ budgetMs: 20000, reason: 'env_fallback' });
  });

  it('never shrinks below the default budget', () => {
    expect(
      selectProbeWaitBudget({
        defaultBudgetMs: 90_000,
        deploying: true,
        redeployBudgetMs: 45_000,
      }),
    ).toEqual({ budgetMs: 90_000, reason: 'deploying' });
  });
});

// ---------- resolveBaseUrl ----------

describe('resolveBaseUrl', () => {
  it('uses KOOKR_API_BASE_URL verbatim when set', async () => {
    const r = await resolveBaseUrl({
      env: { KOOKR_API_BASE_URL: 'http://somewhere.invalid:1234/' },
    });
    expect(r).toEqual({ kind: 'explicit', baseUrl: 'http://somewhere.invalid:1234' });
  });

  it('uses KOOKR_PORT when set and valid', async () => {
    const r = await resolveBaseUrl({ env: { KOOKR_PORT: '4821' } });
    expect(r).toEqual({ kind: 'explicit', baseUrl: 'http://127.0.0.1:4821' });
  });

  it('reports invalid_port for non-integer KOOKR_PORT', async () => {
    const r = await resolveBaseUrl({ env: { KOOKR_PORT: 'not-a-port' } });
    expect(r.kind).toBe('invalid_port');
  });

  it('auto-detects when only one instance responds', async () => {
    // Start a fake Kookr on an ephemeral port, pass it as KOOKR_API_BASE_URL.
    // (Full auto-sweep on 4800/4801 would conflict with a real server; this
    // tests the single-responder happy path against any reachable base.)
    const { server, baseUrl } = await startFakeHealth({ serverStartedAt: new Date().toISOString() });
    try {
      const r = await resolveBaseUrl({ env: { KOOKR_API_BASE_URL: baseUrl } });
      expect(r).toEqual({ kind: 'explicit', baseUrl });
    } finally {
      await closeServer(server);
    }
  });

  it('when not deploying, keeps the default retry budget (#1975)', async () => {
    let healthHits = 0;
    let deployHits = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/deploy/status')) {
        deployHits += 1;
        return {
          ok: true,
          json: async () => ({ deploying: false }),
        } as Response;
      }
      if (url.includes('/api/health')) {
        healthHits += 1;
        throw new Error('ECONNREFUSED');
      }
      throw new Error(`unexpected url ${url}`);
    });
    const sleeps: number[] = [];
    const logs: string[] = [];
    try {
      const r = await resolveBaseUrl({
        env: { KOOKR_SPAWN_CONNECT_RETRIES: '2' },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        log: (msg) => logs.push(msg),
      });
      expect(r.kind).toBe('none');
      // 2 health sweeps × 2 ports; deploy re-probed each sweep while budget is default
      expect(healthHits).toBe(4);
      expect(deployHits).toBe(4);
      expect(sleeps).toEqual([3000]);
      expect(logs).toEqual([]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('when deploying, waits past the default budget with a redeploy message (#1975)', async () => {
    let healthSweeps = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/deploy/status')) {
        // Only 4800 answers during the pre-restart window.
        if (url.includes(':4800/')) {
          return {
            ok: true,
            json: async () => ({ deploying: true }),
          } as Response;
        }
        throw new Error('ECONNREFUSED');
      }
      if (url.includes('/api/health')) {
        // Count complete sweeps: each attempt hits both ports; recover on 4800 only.
        if (url.includes(':4800/')) {
          healthSweeps += 1;
          // Default budget with retries=2 allows only 2 sweeps (1 sleep). Recover on 4th.
          if (healthSweeps >= 4) {
            return {
              ok: true,
              json: async () => ({ serverStartedAt: '2026-08-03T12:00:00.000Z' }),
            } as Response;
          }
        }
        throw new Error('ECONNREFUSED');
      }
      throw new Error(`unexpected url ${url}`);
    });

    let clock = 0;
    const logs: string[] = [];
    const sleeps: number[] = [];
    try {
      const r = await resolveBaseUrl({
        // default budget = (2-1)*3000 = 3000ms; redeploy budget = 45000ms
        env: { KOOKR_SPAWN_CONNECT_RETRIES: '2' },
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
        now: () => clock,
        log: (msg) => logs.push(msg),
      });
      expect(r.kind).toBe('auto');
      expect(r).toMatchObject({ port: 4800 });
      // Default budget alone would have stopped after 2 attempts / 1 sleep.
      // Extended redeploy budget keeps probing until health recovers.
      expect(sleeps.length).toBe(3);
      expect(healthSweeps).toBe(4);
      expect(logs).toEqual([
        expect.stringMatching(/waiting for redeploy \(deploying; budget 45000ms\)/),
      ]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('when deploying and health stays down, exits after the extended budget (#1975)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/deploy/status') && url.includes(':4800/')) {
        return {
          ok: true,
          json: async () => ({ deploying: true }),
        } as Response;
      }
      throw new Error('ECONNREFUSED');
    });
    let clock = 0;
    const sleeps: number[] = [];
    try {
      const r = await resolveBaseUrl({
        env: { KOOKR_SPAWN_CONNECT_RETRIES: '2' },
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
        now: () => clock,
        log: () => {},
      });
      expect(r.kind).toBe('none');
      // Extended budget is 45000ms with 3000ms sleeps → 15 sleeps after first fail.
      // Loop continues while elapsed < 45000; after sleep that reaches 45000, next
      // check stops. attempts start at 1; sleeps while under budget.
      expect(sleeps.length).toBe(15);
      expect(clock).toBe(45_000);
      if (r.kind === 'none') {
        expect(r.attempts).toBe(16);
      }
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('when status is down without env, does not extend past default retries (#1975)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const sleeps: number[] = [];
    const logs: string[] = [];
    try {
      const r = await resolveBaseUrl({
        env: { KOOKR_SPAWN_CONNECT_RETRIES: '2' },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        log: (msg) => logs.push(msg),
      });
      expect(r.kind).toBe('none');
      expect(sleeps).toEqual([3000]);
      expect(logs).toEqual([]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('when status is down with KOOKR_SPAWN_REDEPLOY_WAIT_MS, extends budget (#1975)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    let clock = 0;
    const logs: string[] = [];
    const sleeps: number[] = [];
    try {
      const r = await resolveBaseUrl({
        env: {
          KOOKR_SPAWN_CONNECT_RETRIES: '1',
          KOOKR_SPAWN_REDEPLOY_WAIT_MS: '9000',
        },
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
        now: () => clock,
        log: (msg) => logs.push(msg),
      });
      expect(r.kind).toBe('none');
      // retries=1 default budget is 0 sleeps; env extends to 9000 → 3 sleeps.
      expect(sleeps).toEqual([3000, 3000, 3000]);
      expect(logs.some((l) => /env_fallback/.test(l))).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ---------- probeHealth ----------

describe('probeHealth', () => {
  it('returns true when /api/health has a non-empty serverStartedAt', async () => {
    const { server, baseUrl } = await startFakeHealth({ serverStartedAt: new Date().toISOString() });
    try {
      expect(await probeHealth(baseUrl, 1500)).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it('returns false when /api/health lacks serverStartedAt (not a Kookr server)', async () => {
    const { server, baseUrl } = await startFakeHealth({ something: 'else' });
    try {
      expect(await probeHealth(baseUrl, 1500)).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it('returns false on connection refused', async () => {
    // Port 1 is reserved tcp-mux; connection will fail fast.
    expect(await probeHealth('http://127.0.0.1:1', 500)).toBe(false);
  });
});

describe('probeDeployStatus', () => {
  it('parses deploying from /api/deploy/status', async () => {
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/deploy/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ deploying: true, lastRestart: '2026-08-03T12:00:00.000Z' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr !== 'object') throw new Error('no address');
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    try {
      await expect(probeDeployStatus(baseUrl, 1500)).resolves.toEqual({
        deploying: true,
        lastRestartAt: '2026-08-03T12:00:00.000Z',
      });
    } finally {
      await closeServer(server);
    }
  });

  it('returns null when body omits deploying (error-shaped status)', async () => {
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/deploy/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ configured: true, error: 'git fetch failed' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr !== 'object') throw new Error('no address');
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    try {
      await expect(probeDeployStatus(baseUrl, 1500)).resolves.toBeNull();
    } finally {
      await closeServer(server);
    }
  });

  it('returns null when unreachable', async () => {
    await expect(probeDeployStatus('http://127.0.0.1:1', 200)).resolves.toBeNull();
  });
});

// ---------- postTask ----------

describe('postTask', () => {
  it('sends a prompt-wrapper playbook without turning delivery mode into a client toggle', async () => {
    let bodySeen: any = null;
    const { server, baseUrl } = await startFakeApi((_req, bodyText) => {
      bodySeen = JSON.parse(bodyText);
      return { status: 201, body: JSON.stringify({ id: 'phase-task' }) };
    });
    try {
      await postTask({
        baseUrl,
        prompt: 'Implement P1',
        cwd: '/tmp/x',
        agent: null,
        criteria: null,
        playbook: 'architecture-refactor-phase.md',
        playbookScope: 'plugin',
      });

      expect(bodySeen.playbook).toEqual({
        path: 'architecture-refactor-phase.md',
        scope: 'plugin',
      });
      expect(bodySeen).not.toHaveProperty('deliveryMode');
      expect(bodySeen).not.toHaveProperty('deliveryPolicy');
    } finally {
      await closeServer(server);
    }
  });

  it('sends X-Kookr-Launch-Source: cli and receives the created task', async () => {
    let headerSeen: string | null = null;
    let bodySeen: any = null;
    const { server, baseUrl } = await startFakeApi((req, bodyText) => {
      headerSeen = req.headers['x-kookr-launch-source'] as string | null;
      bodySeen = JSON.parse(bodyText);
      return { status: 201, body: JSON.stringify({ id: 'task-1', cwd: bodySeen.cwd, agentType: 'claude-code' }) };
    });
    try {
      const result = await postTask({
        baseUrl,
        prompt: 'hi',
        cwd: '/tmp/x',
        agent: null,
        criteria: null,
      });
      expect(headerSeen).toBe('cli');
      expect(bodySeen.prompt).toBe('hi');
      expect(bodySeen.cwd).toBe('/tmp/x');
      expect(result.kind).toBe('created');
      if (result.kind === 'created') {
        expect(result.task.id).toBe('task-1');
      }
    } finally {
      await closeServer(server);
    }
  });

  it('sends Authorization: Bearer when KOOKR_API_TOKEN is set (issue #708)', async () => {
    let authSeen: string | undefined;
    const { server, baseUrl } = await startFakeApi((req) => {
      authSeen = req.headers['authorization'] as string | undefined;
      return { status: 201, body: JSON.stringify({ id: 'task-1' }) };
    });
    const prev = process.env.KOOKR_API_TOKEN;
    process.env.KOOKR_API_TOKEN = 'lan-secret';
    try {
      await postTask({ baseUrl, prompt: 'hi', cwd: '/tmp/x', agent: null, criteria: null });
      expect(authSeen).toBe('Bearer lan-secret');
    } finally {
      if (prev === undefined) delete process.env.KOOKR_API_TOKEN;
      else process.env.KOOKR_API_TOKEN = prev;
      await closeServer(server);
    }
  });

  it('omits Authorization when KOOKR_API_TOKEN is unset (loopback flow)', async () => {
    let authSeen: string | undefined = 'unset-sentinel';
    const { server, baseUrl } = await startFakeApi((req) => {
      authSeen = req.headers['authorization'] as string | undefined;
      return { status: 201, body: JSON.stringify({ id: 'task-1' }) };
    });
    const prev = process.env.KOOKR_API_TOKEN;
    delete process.env.KOOKR_API_TOKEN;
    try {
      await postTask({ baseUrl, prompt: 'hi', cwd: '/tmp/x', agent: null, criteria: null });
      expect(authSeen).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.KOOKR_API_TOKEN = prev;
      await closeServer(server);
    }
  });

  it('returns kind=duplicate when server signals dedup', async () => {
    const { server, baseUrl } = await startFakeApi(() => ({
      status: 200,
      body: JSON.stringify({ duplicate: true, task: { id: 'task-dup' } }),
    }));
    try {
      const result = await postTask({
        baseUrl,
        prompt: 'hi',
        cwd: '/tmp/x',
        agent: null,
        criteria: null,
      });
      expect(result.kind).toBe('duplicate');
      if (result.kind === 'duplicate') {
        expect(result.task.id).toBe('task-dup');
      }
    } finally {
      await closeServer(server);
    }
  });

  it('returns kind=server_error for 4xx with a message', async () => {
    const { server, baseUrl } = await startFakeApi(() => ({
      status: 400,
      body: JSON.stringify({ error: 'prompt too long' }),
    }));
    try {
      const result = await postTask({
        baseUrl,
        prompt: 'hi',
        cwd: '/tmp/x',
        agent: null,
        criteria: null,
      });
      expect(result.kind).toBe('server_error');
      if (result.kind === 'server_error') {
        expect(result.status).toBe(400);
        expect(result.message).toContain('prompt too long');
      }
    } finally {
      await closeServer(server);
    }
  });

  it('keeps the parsed 429 backpressure body on server_error (issue #1526 C3)', async () => {
    const backpressureBody = {
      error: 'Pending queue is full (24/24 queued, 10/10 active) — launch rejected.',
      code: 'pending_queue_full',
      capacity: {
        maxActiveTasks: 10,
        active: 10,
        free: 0,
        byClass: { working: 2, finishedAwaitingAck: 7, hungSuspect: 1, launching: 0 },
        pendingQueueDepth: 24,
        oldestPendingAgeMs: 120000,
        oldestFinishedAwaitingAckAgeMs: 360000,
      },
      maxPendingTasks: 24,
    };
    const { server, baseUrl } = await startFakeApi(() => ({
      status: 429,
      body: JSON.stringify(backpressureBody),
    }));
    try {
      const result = await postTask({ baseUrl, prompt: 'hi', cwd: '/tmp/x', agent: null, criteria: null });
      expect(result.kind).toBe('server_error');
      if (result.kind === 'server_error') {
        expect(result.status).toBe(429);
        expect(result.body).toMatchObject({ code: 'pending_queue_full' });
      }
    } finally {
      await closeServer(server);
    }
  });

  it('includes agent and criteria when provided', async () => {
    let bodySeen: any = null;
    const { server, baseUrl } = await startFakeApi((_req, bodyText) => {
      bodySeen = JSON.parse(bodyText);
      return { status: 201, body: JSON.stringify({ id: 't' }) };
    });
    try {
      await postTask({
        baseUrl,
        prompt: 'hi',
        cwd: '/tmp',
        agent: 'codex-cli',
        criteria: 'pass',
      });
      expect(bodySeen.agentType).toBe('codex-cli');
      expect(bodySeen.criteria).toBe('pass');
    } finally {
      await closeServer(server);
    }
  });

  it('includes effort when provided and omits it otherwise (#681)', async () => {
    const bodies: any[] = [];
    const { server, baseUrl } = await startFakeApi((_req, bodyText) => {
      bodies.push(JSON.parse(bodyText));
      return { status: 201, body: JSON.stringify({ id: 't' }) };
    });
    try {
      await postTask({ baseUrl, prompt: 'hi', cwd: '/tmp', agent: null, effort: 'max', criteria: null });
      await postTask({ baseUrl, prompt: 'hi2', cwd: '/tmp', agent: null, criteria: null });
      expect(bodies[0].effort).toBe('max');
      expect(bodies[1]).not.toHaveProperty('effort');
    } finally {
      await closeServer(server);
    }
  });

  it('includes model when provided and omits it otherwise (#1518)', async () => {
    const bodies: any[] = [];
    const { server, baseUrl } = await startFakeApi((_req, bodyText) => {
      bodies.push(JSON.parse(bodyText));
      return { status: 201, body: JSON.stringify({ id: 't' }) };
    });
    try {
      await postTask({
        baseUrl,
        prompt: 'hi',
        cwd: '/tmp',
        agent: null,
        model: 'claude-fable-5',
        criteria: null,
      });
      await postTask({ baseUrl, prompt: 'hi2', cwd: '/tmp', agent: null, criteria: null });
      expect(bodies[0].model).toBe('claude-fable-5');
      expect(bodies[1]).not.toHaveProperty('model');
    } finally {
      await closeServer(server);
    }
  });

  it('includes portable model tier when provided and omits it otherwise', async () => {
    const bodies: any[] = [];
    const { server, baseUrl } = await startFakeApi((_req, bodyText) => {
      bodies.push(JSON.parse(bodyText));
      return { status: 201, body: JSON.stringify({ id: 't' }) };
    });
    try {
      await postTask({
        baseUrl,
        prompt: 'small',
        cwd: '/tmp',
        agent: null,
        modelTier: 'small',
        criteria: null,
      });
      await postTask({ baseUrl, prompt: 'default', cwd: '/tmp', agent: null, criteria: null });
      expect(bodies[0].modelTier).toBe('small');
      expect(bodies[0]).not.toHaveProperty('agentType');
      expect(bodies[1]).not.toHaveProperty('modelTier');
    } finally {
      await closeServer(server);
    }
  });

  it('includes parentTaskId when provided and omits it otherwise', async () => {
    const bodies: any[] = [];
    const { server, baseUrl } = await startFakeApi((_req, bodyText) => {
      bodies.push(JSON.parse(bodyText));
      return { status: 201, body: JSON.stringify({ id: 't' }) };
    });
    try {
      await postTask({
        baseUrl,
        prompt: 'hi',
        cwd: '/tmp',
        agent: null,
        criteria: null,
        parentTaskId: 'parent-uuid',
      });
      await postTask({
        baseUrl,
        prompt: 'hi',
        cwd: '/tmp',
        agent: null,
        criteria: null,
      });
      expect(bodies[0].parentTaskId).toBe('parent-uuid');
      expect(bodies[1].parentTaskId).toBeUndefined();
    } finally {
      await closeServer(server);
    }
  });

  it('sends autoCloseOnSignal only when explicitly set (null lets the server inherit)', async () => {
    const bodies: any[] = [];
    const { server, baseUrl } = await startFakeApi((_req, bodyText) => {
      bodies.push(JSON.parse(bodyText));
      return { status: 201, body: JSON.stringify({ id: 't' }) };
    });
    try {
      await postTask({ baseUrl, prompt: 'a', cwd: '/tmp', agent: null, criteria: null, autoCloseOnSignal: true });
      await postTask({ baseUrl, prompt: 'b', cwd: '/tmp', agent: null, criteria: null, autoCloseOnSignal: false });
      await postTask({ baseUrl, prompt: 'c', cwd: '/tmp', agent: null, criteria: null, autoCloseOnSignal: null });
      await postTask({ baseUrl, prompt: 'd', cwd: '/tmp', agent: null, criteria: null });
      expect(bodies[0].autoCloseOnSignal).toBe(true);
      expect(bodies[1].autoCloseOnSignal).toBe(false);
      expect(bodies[2].autoCloseOnSignal).toBeUndefined();
      expect(bodies[3].autoCloseOnSignal).toBeUndefined();
    } finally {
      await closeServer(server);
    }
  });

  it('includes explicit duplicate intent when requested', async () => {
    let bodySeen: any = null;
    const { server, baseUrl } = await startFakeApi((_req, bodyText) => {
      bodySeen = JSON.parse(bodyText);
      return { status: 201, body: JSON.stringify({ id: 't' }) };
    });
    try {
      await postTask({
        baseUrl,
        prompt: 'hi',
        cwd: '/tmp',
        agent: null,
        criteria: null,
        disableDedup: true,
        metadataIntent: 'keep_as_duplicate',
      });
      expect(bodySeen.disableDedup).toBe(true);
      expect(bodySeen.metadata).toEqual({ intent: 'keep_as_duplicate' });
    } finally {
      await closeServer(server);
    }
  });

  it('includes idempotencyKey when provided and omits it otherwise (#1526)', async () => {
    const bodies: any[] = [];
    const { server, baseUrl } = await startFakeApi((_req, bodyText) => {
      bodies.push(JSON.parse(bodyText));
      return { status: 201, body: JSON.stringify({ id: 't' }) };
    });
    try {
      await postTask({
        baseUrl,
        prompt: 'hi',
        cwd: '/tmp',
        agent: null,
        criteria: null,
        idempotencyKey: 'repo#42@batch-1',
      });
      await postTask({ baseUrl, prompt: 'hi2', cwd: '/tmp', agent: null, criteria: null });
      expect(bodies[0].idempotencyKey).toBe('repo#42@batch-1');
      expect(bodies[1]).not.toHaveProperty('idempotencyKey');
    } finally {
      await closeServer(server);
    }
  });

  it('surfaces an idempotent replay as kind=created with task.idempotentReplay set (#1526)', async () => {
    const { server, baseUrl } = await startFakeApi(() => ({
      status: 200,
      body: JSON.stringify({ id: 'task-1', cwd: '/tmp', agentType: 'claude-code', idempotentReplay: true }),
    }));
    try {
      const result = await postTask({
        baseUrl,
        prompt: 'hi',
        cwd: '/tmp',
        agent: null,
        criteria: null,
        idempotencyKey: 'repo#42@batch-1',
      });
      // A flattened 200 (no top-level `duplicate`) falls through to the same
      // "created" branch a 201 does — the CLI distinguishes replay via the
      // `idempotentReplay` field on the task itself, not a new result kind.
      expect(result.kind).toBe('created');
      if (result.kind === 'created') {
        expect(result.task.id).toBe('task-1');
        expect(result.task.idempotentReplay).toBe(true);
      }
    } finally {
      await closeServer(server);
    }
  });
});

// ---------- ambiguous-outcome reconciliation (#1591) ----------

describe('parseRetryAfterMs (#1591)', () => {
  it('prefers the body retryAfterMs field', () => {
    expect(parseRetryAfterMs('99', { retryAfterMs: 1500 })).toBe(1500);
  });
  it('falls back to body retryAfterSeconds (503 saturation shape)', () => {
    expect(parseRetryAfterMs(null, { retryAfterSeconds: 2 })).toBe(2000);
  });
  it('reads the numeric Retry-After header (seconds) when no body hint', () => {
    expect(parseRetryAfterMs('3', {})).toBe(3000);
    expect(parseRetryAfterMs('0', {})).toBe(0);
  });
  it('returns null when no usable hint is present', () => {
    expect(parseRetryAfterMs(null, {})).toBeNull();
    expect(parseRetryAfterMs('not-a-number', null)).toBeNull();
    expect(parseRetryAfterMs('', { retryAfterMs: 0 })).toBeNull();
  });
});

describe('reconcileDelayMs (#1591)', () => {
  it('honors a Retry-After hint, capped at the max', () => {
    expect(reconcileDelayMs(0, 1500)).toBe(1500);
    expect(reconcileDelayMs(0, 999999)).toBe(8000);
  });
  it('uses exponential backoff (capped) when no hint is given', () => {
    expect(reconcileDelayMs(0, null)).toBe(500);
    expect(reconcileDelayMs(1, null)).toBe(1000);
    expect(reconcileDelayMs(2, null)).toBe(2000);
    expect(reconcileDelayMs(10, null)).toBe(8000);
  });
});

describe('isReconcilableStatus (#1591)', () => {
  it('treats 5xx as reconcilable and 4xx/429/2xx as definitive', () => {
    expect(isReconcilableStatus(500)).toBe(true);
    expect(isReconcilableStatus(503)).toBe(true);
    expect(isReconcilableStatus(429)).toBe(false);
    expect(isReconcilableStatus(400)).toBe(false);
    expect(isReconcilableStatus(200)).toBe(false);
  });
});

describe('postTaskWithReconcile (#1591)', () => {
  function basePostArgs(baseUrl: string, idempotencyKey: string | null = null) {
    return { baseUrl, prompt: 'hi', cwd: '/tmp/x', agent: null, criteria: null, idempotencyKey };
  }

  it('re-POSTs with the same key after a 5xx and returns the idempotent replay', async () => {
    let calls = 0;
    const seenKeys: unknown[] = [];
    const seenTiers: unknown[] = [];
    const { server, baseUrl } = await startFakeApi((_req, body) => {
      calls += 1;
      const parsed = JSON.parse(body);
      seenKeys.push(parsed.idempotencyKey);
      seenTiers.push(parsed.modelTier);
      if (calls === 1) return { status: 500, body: JSON.stringify({ error: 'boom' }) };
      return { status: 200, body: JSON.stringify({ id: 't-recon', idempotentReplay: true }) };
    });
    try {
      const result = await postTaskWithReconcile({
        postArgs: { ...basePostArgs(baseUrl, 'recon-key'), modelTier: 'small' },
        idempotencyKey: 'recon-key',
        sleep: async () => {},
      });
      expect(calls).toBe(2);
      expect(seenKeys).toEqual(['recon-key', 'recon-key']);
      expect(seenTiers).toEqual(['small', 'small']);
      expect(result.kind).toBe('created');
      if (result.kind === 'created') expect(result.task.idempotentReplay).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it('honors a 503 Retry-After hint before re-POSTing', async () => {
    let calls = 0;
    const delays: number[] = [];
    const { server, baseUrl } = await startFakeApi(() => {
      calls += 1;
      if (calls === 1) {
        return {
          status: 503,
          headers: { 'Retry-After': '2' },
          body: JSON.stringify({ code: 'event_loop_saturated', retryAfterSeconds: 2 }),
        };
      }
      return { status: 201, body: JSON.stringify({ id: 't-503' }) };
    });
    try {
      const result = await postTaskWithReconcile({
        postArgs: basePostArgs(baseUrl, 'k'),
        idempotencyKey: 'k',
        sleep: async (ms: number) => { delays.push(ms); },
      });
      expect(result.kind).toBe('created');
      expect(delays).toEqual([2000]);
    } finally {
      await closeServer(server);
    }
  });

  it('does NOT reconcile a 5xx when no idempotency key is available', async () => {
    let calls = 0;
    const { server, baseUrl } = await startFakeApi(() => {
      calls += 1;
      return { status: 500, body: JSON.stringify({ error: 'boom' }) };
    });
    try {
      const result = await postTaskWithReconcile({
        postArgs: basePostArgs(baseUrl, null),
        idempotencyKey: null,
        sleep: async () => {},
      });
      expect(calls).toBe(1);
      expect(result.kind).toBe('server_error');
    } finally {
      await closeServer(server);
    }
  });

  it('does NOT reconcile a 429 backpressure rejection (definitive, task not created)', async () => {
    let calls = 0;
    const { server, baseUrl } = await startFakeApi(() => {
      calls += 1;
      return { status: 429, body: JSON.stringify({ code: 'pending_queue_full', error: 'full' }) };
    });
    try {
      const result = await postTaskWithReconcile({
        postArgs: basePostArgs(baseUrl, 'k'),
        idempotencyKey: 'k',
        sleep: async () => {},
      });
      expect(calls).toBe(1);
      expect(result.kind).toBe('server_error');
      if (result.kind === 'server_error') expect(result.status).toBe(429);
    } finally {
      await closeServer(server);
    }
  });

  it('gives up after the retry budget and returns the last 5xx', async () => {
    let calls = 0;
    const onRetry = vi.fn();
    const { server, baseUrl } = await startFakeApi(() => {
      calls += 1;
      return { status: 502, body: JSON.stringify({ error: 'bad gateway' }) };
    });
    try {
      const result = await postTaskWithReconcile({
        postArgs: basePostArgs(baseUrl, 'k'),
        idempotencyKey: 'k',
        sleep: async () => {},
        retries: 2,
        onRetry,
      });
      expect(calls).toBe(3); // first attempt + 2 reconcile re-POSTs
      expect(onRetry).toHaveBeenCalledTimes(2);
      expect(result.kind).toBe('server_error');
    } finally {
      await closeServer(server);
    }
  });

  it('reconciles a network error (dropped connection) when a key is available', async () => {
    let calls = 0;
    const server = createServer((req, res) => {
      calls += 1;
      if (calls === 1) {
        req.socket.destroy(); // ambiguous: connection dropped mid-request
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 't-net', idempotentReplay: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr !== 'object') throw new Error('no address');
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    try {
      const result = await postTaskWithReconcile({
        postArgs: basePostArgs(baseUrl, 'k'),
        idempotencyKey: 'k',
        sleep: async () => {},
      });
      expect(calls).toBe(2);
      expect(result.kind).toBe('created');
    } finally {
      await closeServer(server);
    }
  });

  it('propagates a network error unchanged when no key is available', async () => {
    // Unreachable port: connection is refused, and with no key we do not retry.
    await expect(
      postTaskWithReconcile({
        postArgs: basePostArgs('http://127.0.0.1:1', null),
        idempotencyKey: null,
        sleep: async () => {},
      }),
    ).rejects.toBeTruthy();
  });
});

// ---------- formatSuccess / formatDedup ----------

describe('output formatting', () => {
  it('formatSuccess puts task_id= on the first line', () => {
    const out = formatSuccess({
      task: { id: 'abc', agentType: 'claude-code', cwd: '/tmp/x' },
      baseUrl: 'http://127.0.0.1:4800',
      queued: false,
    });
    expect(out.split('\n')[0]).toBe('task_id=abc');
    expect(out).toContain('✓ Task created');
    expect(out).toContain('http://127.0.0.1:4800/#/tasks/abc');
  });

  it('formatSuccess switches to ⌛ Task queued when queued=true', () => {
    const out = formatSuccess({
      task: { id: 'abc', agentType: 'claude-code', cwd: '/tmp' },
      baseUrl: 'http://127.0.0.1:4800',
      queued: true,
    });
    expect(out).toContain('⌛ Task queued');
    expect(out).not.toContain('✓ Task created');
  });

  it('formatSuccess reports an idempotent replay distinctly (#1526)', () => {
    const out = formatSuccess({
      task: { id: 'abc', agentType: 'claude-code', cwd: '/tmp/x', idempotentReplay: true },
      baseUrl: 'http://127.0.0.1:4800',
      queued: false,
    });
    expect(out.split('\n')[0]).toBe('task_id=abc');
    expect(out).toContain('idempotent replay');
    expect(out).not.toContain('✓ Task created');
  });

  it('formatDedup puts task_id= on the first line', () => {
    const out = formatDedup({
      task: { id: 'abc' },
      baseUrl: 'http://127.0.0.1:4800',
    });
    expect(out.split('\n')[0]).toBe('task_id=abc');
    expect(out).toContain('already exists');
  });

  it('formatSuccess includes parent_task_id when the task has a parent', () => {
    const out = formatSuccess({
      task: { id: 'abc', agentType: 'claude-code', cwd: '/tmp', parentTaskId: 'parent-1' },
      baseUrl: 'http://127.0.0.1:4800',
      queued: false,
    });
    expect(out).toContain('parent_task_id=parent-1');
    expect(out).toContain('http://127.0.0.1:4800/#/tasks/parent-1');
  });

  it('formatSuccess omits parent_task_id when the task has none', () => {
    const out = formatSuccess({
      task: { id: 'abc', agentType: 'claude-code', cwd: '/tmp' },
      baseUrl: 'http://127.0.0.1:4800',
      queued: false,
    });
    expect(out).not.toContain('parent_task_id=');
  });

  it('formatSuccess surfaces plan-quota rotation (issue #1936)', () => {
    const out = formatSuccess({
      task: {
        id: 'abc',
        agentType: 'codex-cli',
        cwd: '/tmp',
        admission: 'rotated',
        reason: 'plan_quota',
        fromAgent: 'claude-code',
        toAgent: 'codex-cli',
        resetsAt: '2026-08-04T12:00:00.000Z',
      },
      baseUrl: 'http://127.0.0.1:4800',
      queued: false,
    });
    expect(out).toContain('admission: rotated (plan_quota) claude-code → codex-cli');
    expect(out).toContain('plan quota resets: 2026-08-04T12:00:00.000Z');
  });

  it('classifies wait-ready and terminal snapshot states', () => {
    expect(classifyWaitState({
      taskId: 't1',
      taskStatus: 'inProgress',
      pendingSignal: { kind: 'completion_ready', raisedAt: 'now' },
    })).toEqual({ kind: 'completion_ready', status: 'inProgress' });
    expect(classifyWaitState({ taskId: 't1', taskStatus: 'completed' })).toEqual({
      kind: 'terminal',
      status: 'completed',
    });
    expect(classifyWaitState({ taskId: 't1', taskStatus: 'inProgress' })).toEqual({
      kind: 'pending',
      status: 'inProgress',
    });
    expect(classifyWaitState({
      id: 't1',
      status: 'inProgress',
      pendingSignal: { kind: 'completion_ready', raisedAt: 'now' },
    })).toEqual({ kind: 'completion_ready', status: 'inProgress' });
  });

  it('formats wait outcomes', () => {
    expect(formatWaitOutcome({ kind: 'completion_ready', status: 'inProgress', agent: {} })).toContain('completion-ready');
    expect(formatWaitOutcome({ kind: 'terminal', status: 'completed', agent: {} })).toContain('completed');
    expect(formatWaitOutcome({ kind: 'terminal', status: 'terminated', agent: {} })).toContain('terminated');
    expect(formatWaitOutcome({ kind: 'timeout' })).toContain('timed out');
  });
});

describe('formatBackpressure429 (issue #1526 C3)', () => {
  it('returns null for non-backpressure bodies', () => {
    expect(formatBackpressure429(null)).toBeNull();
    expect(formatBackpressure429(undefined)).toBeNull();
    expect(formatBackpressure429({ error: 'nope' })).toBeNull();
    expect(formatBackpressure429({ code: 'something_else' })).toBeNull();
  });

  it('renders the spawn-burst budget line with retry hint', () => {
    const rendered = formatBackpressure429({
      error: 'Spawn burst limit reached',
      code: 'spawn_burst_limit',
      source: 'api:actor:lucy',
      limit: 30,
      windowMs: 600000,
      retryAfterMs: 42000,
      capacity: {
        maxActiveTasks: 10,
        active: 9,
        free: 1,
        byClass: { working: 5, finishedAwaitingAck: 3, hungSuspect: 1, launching: 0 },
        pendingQueueDepth: 3,
        oldestPendingAgeMs: null,
        oldestFinishedAwaitingAckAgeMs: null,
      },
    });
    expect(rendered).toContain('launch refused (spawn_burst_limit)');
    expect(rendered).toContain('9/10 slots occupied');
    expect(rendered).toContain('30 launches per 10m for source "api:actor:lucy"');
    expect(rendered).toContain('retry in ~42s');
  });

  it('renders a queue-full body without a capacity block gracefully', () => {
    const rendered = formatBackpressure429({ error: 'full', code: 'pending_queue_full' });
    expect(rendered).toContain('launch refused (pending_queue_full)');
    expect(rendered).toContain('free a slot');
  });

  it('renders plan-quota rejection with structured admission fields (issue #1936)', () => {
    const rendered = formatBackpressure429({
      error: 'Anthropic plan quota is exhausted (utilization 100% ≥ threshold 90%) — launch rejected',
      code: 'quota_headroom_admission',
      admission: 'rejected',
      reason: 'plan_quota',
      maxUtilization: 100,
      threshold: 90,
      resetsAt: '2026-08-04T12:00:00.000Z',
    });
    expect(rendered).toContain('launch refused (quota_headroom_admission)');
    expect(rendered).toContain('admission: rejected (reason: plan_quota)');
    expect(rendered).toContain('plan utilization: 100% (threshold 90%)');
    expect(rendered).toContain('retry after binding window resets: 2026-08-04T12:00:00.000Z');
  });
});

describe('waitForTaskReady', () => {
  it('polls /api/snapshot until the task raises completion-ready', async () => {
    let snapshots = 0;
    const { server, baseUrl } = await startFakeApi(
      () => ({ status: 201, body: JSON.stringify({ id: 't1' }) }),
      () => {
        snapshots += 1;
        return {
          status: 200,
          body: JSON.stringify([
            snapshots === 1
              ? { taskId: 't1', taskStatus: 'inProgress' }
              : { taskId: 't1', taskStatus: 'inProgress', pendingSignal: { kind: 'completion_ready', raisedAt: 'now' } },
          ]),
        };
      },
      () => ({ status: 200, body: JSON.stringify([{ id: 't1', status: 'inProgress' }]) }),
    );
    try {
      const result = await waitForTaskReady({
        baseUrl,
        taskId: 't1',
        sleep: async () => {},
      });
      expect(result.kind).toBe('completion_ready');
      expect(snapshots).toBe(2);
    } finally {
      await closeServer(server);
    }
  });

  it('returns timeout when the deadline elapses before readiness', async () => {
    const { server, baseUrl } = await startFakeApi(
      () => ({ status: 201, body: JSON.stringify({ id: 't1' }) }),
      () => ({ status: 200, body: JSON.stringify([{ taskId: 't1', taskStatus: 'inProgress' }]) }),
      () => ({ status: 200, body: JSON.stringify([{ id: 't1', status: 'inProgress' }]) }),
    );
    let now = 0;
    try {
      const result = await waitForTaskReady({
        baseUrl,
        taskId: 't1',
        timeoutMs: 100,
        sleep: async (ms) => { now += ms; },
        now: () => now,
      });
      expect(result).toEqual({ kind: 'timeout' });
    } finally {
      await closeServer(server);
    }
  });

  it('falls back to /api/tasks for pending completion-ready signals', async () => {
    const { server, baseUrl } = await startFakeApi(
      () => ({ status: 201, body: JSON.stringify({ id: 't1' }) }),
      () => ({ status: 200, body: JSON.stringify([{ taskId: 't1', taskStatus: 'inProgress' }]) }),
      () => ({
        status: 200,
        body: JSON.stringify([
          { id: 't1', status: 'inProgress', pendingSignal: { kind: 'completion_ready', raisedAt: 'now' } },
        ]),
      }),
    );
    try {
      const result = await waitForTaskReady({
        baseUrl,
        taskId: 't1',
        sleep: async () => {},
      });
      expect(result.kind).toBe('completion_ready');
    } finally {
      await closeServer(server);
    }
  });

  it('returns server_error instead of throwing when a wait read fails', async () => {
    const result = await waitForTaskReady({
      baseUrl: 'http://127.0.0.1:9',
      taskId: 't1',
      timeoutMs: 100,
      sleep: async () => {},
    });
    expect(result.kind).toBe('server_error');
    if (result.kind === 'server_error') {
      expect(result.message).toBeTruthy();
    }
  });
});

// ---------- no-key reconcile probe (#1573) ----------

describe('cwdEquivalent (#1573)', () => {
  it('treats trailing-slash-only differences as equal', () => {
    expect(cwdEquivalent('/repo/x', '/repo/x/')).toBe(true);
    expect(cwdEquivalent('/repo/x///', '/repo/x')).toBe(true);
  });
  it('treats genuinely different paths as unequal', () => {
    expect(cwdEquivalent('/repo/x', '/repo/y')).toBe(false);
    expect(cwdEquivalent('/repo/x', '/repo/xy')).toBe(false);
  });
  it('is false for non-string inputs', () => {
    expect(cwdEquivalent(undefined as unknown as string, '/x')).toBe(false);
  });
});

describe('formatReconcileRecovered (#1573)', () => {
  it('renders the id and a "recovered via reconcile probe" note, not "created"', () => {
    const rendered = formatReconcileRecovered({ task: { id: 'r1' }, baseUrl: 'http://x' });
    expect(rendered).toContain('task_id=r1');
    expect(rendered).toContain('recovered via reconcile probe');
    expect(rendered).not.toContain('Task created'); // never claims a fresh creation
    expect(rendered).toContain('http://x/#/tasks/r1');
  });
});

describe('taskMatchesSpawn (#1573)', () => {
  const spawn = { prompt: 'do the thing', cwd: '/repo/x', agentType: 'claude-code' };

  it('matches an active task by userPrompt + cwd', () => {
    const task = { id: 't1', status: 'inProgress', cwd: '/repo/x', userPrompt: 'do the thing', prompt: 'INJECTED\ndo the thing' };
    expect(taskMatchesSpawn(task, spawn)).toBe(true);
  });

  it('matches via prompt-prefix when userPrompt is absent (launch-context injection)', () => {
    const task = { id: 't1', status: 'launching', cwd: '/repo/x/', prompt: 'do the thing\n\n[launch context]' };
    expect(taskMatchesSpawn(task, spawn)).toBe(true);
  });

  it('does NOT match a terminal task (already finished — not this spawn)', () => {
    const task = { id: 't1', status: 'completed', cwd: '/repo/x', userPrompt: 'do the thing' };
    expect(taskMatchesSpawn(task, spawn)).toBe(false);
  });

  it('does NOT match a different cwd', () => {
    const task = { id: 't1', status: 'inProgress', cwd: '/repo/other', userPrompt: 'do the thing' };
    expect(taskMatchesSpawn(task, spawn)).toBe(false);
  });

  it('does NOT match a different prompt', () => {
    const task = { id: 't1', status: 'inProgress', cwd: '/repo/x', userPrompt: 'something else' };
    expect(taskMatchesSpawn(task, spawn)).toBe(false);
  });

  it('filters on agentType only when the spawn pinned one', () => {
    const task = { id: 't1', status: 'inProgress', cwd: '/repo/x', userPrompt: 'do the thing', agentType: 'codex-cli' };
    expect(taskMatchesSpawn(task, spawn)).toBe(false); // pinned claude-code, task is codex-cli
    expect(taskMatchesSpawn(task, { ...spawn, agentType: null })).toBe(true); // no pin → agentType ignored
  });
});

describe('reconcileViaTaskProbe (#1573)', () => {
  const spawn = { baseUrl: 'http://x', prompt: 'p', cwd: '/repo/x', agentType: null as string | null };

  it('returns matched when an active task matches (and never re-POSTs)', async () => {
    const fetchTasksImpl = vi.fn(async () => ({
      kind: 'ok' as const,
      tasks: [{ id: 'landed', status: 'inProgress', cwd: '/repo/x', userPrompt: 'p' }],
    }));
    const result = await reconcileViaTaskProbe({ ...spawn, fetchTasksImpl, sleep: async () => {} });
    expect(result.kind).toBe('matched');
    if (result.kind === 'matched') expect(result.task.id).toBe('landed');
    expect(fetchTasksImpl).toHaveBeenCalledTimes(1);
  });

  it('returns absent when the probe succeeds but nothing matches', async () => {
    const fetchTasksImpl = vi.fn(async () => ({ kind: 'ok' as const, tasks: [] }));
    const result = await reconcileViaTaskProbe({ ...spawn, fetchTasksImpl, sleep: async () => {} });
    expect(result.kind).toBe('absent');
  });

  it('retries read failures with backoff, then returns unknown after the budget', async () => {
    const fetchTasksImpl = vi.fn(async () => ({ kind: 'error' as const, message: 'boom' }));
    const onRetry = vi.fn();
    const result = await reconcileViaTaskProbe({ ...spawn, fetchTasksImpl, sleep: async () => {}, onRetry });
    expect(result.kind).toBe('unknown');
    if (result.kind === 'unknown') expect(result.message).toBe('boom');
    // first attempt + RECONCILE_MAX_RETRIES(2) retries = 3 reads
    expect(fetchTasksImpl).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('recovers on a later probe attempt after a transient read failure', async () => {
    let n = 0;
    const fetchTasksImpl = vi.fn(async () => {
      n += 1;
      if (n === 1) return { kind: 'error' as const, message: 'transient' };
      return { kind: 'ok' as const, tasks: [{ id: 'late', status: 'inProgress', cwd: '/repo/x', userPrompt: 'p' }] };
    });
    const result = await reconcileViaTaskProbe({ ...spawn, fetchTasksImpl, sleep: async () => {} });
    expect(result.kind).toBe('matched');
    if (result.kind === 'matched') expect(result.task.id).toBe('late');
  });
});

// ---------- main (end-to-end against a fake API server) ----------

describe('main', () => {
  let tmpCwd: string;
  beforeEach(async () => {
    tmpCwd = await mkdtemp(join(tmpdir(), 'kookr-spawn-main-'));
  });
  afterEach(async () => {
    await rm(tmpCwd, { recursive: true, force: true });
  });

  it('prints help and exits 0 when --help is passed, without starting a network call', async () => {
    const { io, logs } = makeConsoleCapture();
    const errBucket = makeConsoleCapture();
    const { codes, exit } = makeExitCapture();
    await main({
      argv: ['--help'],
      env: {},
      stdin: ttyStdin(),
      cwd: tmpCwd,
      out: io,
      err: errBucket.io,
      exit,
      sleep: async () => {},
    });
    expect(codes).toEqual([EXIT_OK]);
    expect(logs.join('\n')).toContain('Usage:');
  });

  it('launches a prompt file through the requested playbook wrapper end to end', async () => {
    const promptFile = join(tmpCwd, 'phase.md');
    await writeFile(promptFile, 'Implement P1 from the merged RFC.');
    let bodySeen: any = null;
    const { server, baseUrl } = await startFakeApi((_req, bodyText) => {
      bodySeen = JSON.parse(bodyText);
      return { status: 201, body: JSON.stringify({ id: 'phase-1', cwd: tmpCwd }) };
    });
    try {
      const { io, logs } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: [
          '--json',
          '--prompt-file', promptFile,
          '--playbook', 'architecture-refactor-phase.md',
          '--playbook-scope', 'plugin',
          '--idempotency-key', 'chain:octocat/hello-world:42:phase:P1',
          '--unattended',
        ],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });

      expect(codes).toEqual([EXIT_OK]);
      expect(parseSingleJsonLog(logs)).toMatchObject({ ok: true, details: { taskId: 'phase-1' } });
      expect(bodySeen).toMatchObject({
        prompt: 'Implement P1 from the merged RFC.',
        cwd: tmpCwd,
        playbook: { path: 'architecture-refactor-phase.md', scope: 'plugin' },
        idempotencyKey: 'chain:octocat/hello-world:42:phase:P1',
        unattended: true,
      });
    } finally {
      await closeServer(server);
    }
  });

  it('fails fast when a wrapped launch has no explicit or automatic idempotency key', async () => {
    let posts = 0;
    const { server, baseUrl } = await startFakeApi(() => {
      posts += 1;
      return { status: 201, body: JSON.stringify({ id: 'must-not-launch' }) };
    });
    try {
      const { io, logs } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['--json', '--playbook', 'phase.md', 'P1'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });

      expect(codes).toEqual([EXIT_USER_ERROR]);
      expect(posts).toBe(0);
      expect(parseSingleJsonLog(logs)).toMatchObject({
        ok: false,
        message: expect.stringMatching(/playbook.*idempotency/i),
      });
    } finally {
      await closeServer(server);
    }
  });

  it('includes the playbook identity in the auto-derived launch key', async () => {
    let bodySeen: any = null;
    const { server, baseUrl } = await startFakeApi((_req, bodyText) => {
      bodySeen = JSON.parse(bodyText);
      return { status: 201, body: JSON.stringify({ id: 'wrapped-auto', cwd: tmpCwd }) };
    });
    try {
      const { io } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: [
          '--auto-idempotency',
          '--playbook', 'phase.md',
          '--playbook-scope', 'plugin',
          'P1',
        ],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });

      expect(codes).toEqual([EXIT_OK]);
      expect(bodySeen.idempotencyKey).toBe(deriveAutoIdempotencyKey({
        prompt: 'P1',
        cwd: tmpCwd,
        criteria: null,
        agent: null,
        playbook: 'phase.md',
        playbookScope: 'plugin',
      }));
    } finally {
      await closeServer(server);
    }
  });

  // ---- #1768: --dry-run preview (validate + resolve + dedupe, no POST) ----

  it('--dry-run prints the resolved payload and never POSTs (#1768)', async () => {
    let posts = 0;
    let gets = 0;
    const { server, baseUrl } = await startFakeApi(
      () => {
        posts += 1;
        return { status: 201, body: JSON.stringify({ id: 'should-not-create' }) };
      },
      undefined,
      () => {
        gets += 1;
        return { status: 200, body: JSON.stringify([]) };
      },
    );
    try {
      const { io, logs } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['--dry-run', '-a', 'codex-cli', '--criteria', 'tests pass', 'hello dry-run'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_OK]);
      expect(posts).toBe(0);
      expect(gets).toBe(1);
      const rendered = logs.join('\n');
      expect(rendered).toContain('dry-run: would create task (not launched)');
      expect(rendered).toContain(`server:        ${baseUrl}`);
      expect(rendered).toContain(`cwd:           ${tmpCwd}`);
      expect(rendered).toContain('prompt_source: argv');
      expect(rendered).toContain('match:         none');
      expect(rendered).toContain('"prompt": "hello dry-run"');
      expect(rendered).toContain('"agentType": "codex-cli"');
      expect(rendered).toContain('"criteria": "tests pass"');
    } finally {
      await closeServer(server);
    }
  });

  it('--dry-run --json returns a DRY_RUN envelope with the would-be body (#1768)', async () => {
    let posts = 0;
    const { server, baseUrl } = await startFakeApi(
      () => {
        posts += 1;
        return { status: 201, body: JSON.stringify({ id: 'nope' }) };
      },
      undefined,
      () => ({ status: 200, body: JSON.stringify([]) }),
    );
    try {
      const { io, logs } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['--dry-run', '--json', '--model-tier', 'small', 'preview me'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_OK]);
      expect(posts).toBe(0);
      expect(errBucket.errors).toEqual([]);
      const envelope = parseSingleJsonLog(logs);
      expect(envelope).toMatchObject({
        ok: true,
        code: 'DRY_RUN',
        details: {
          dryRun: true,
          baseUrl,
          cwd: tmpCwd,
          promptSource: 'argv',
          dedupe: 'warn',
          duplicate: false,
          matchingTask: null,
          body: {
            prompt: 'preview me',
            cwd: tmpCwd,
            modelTier: 'small',
          },
        },
      });
    } finally {
      await closeServer(server);
    }
  });

  it('--dry-run --dedupe=block exits 5 on active duplicate without POSTing (#1768)', async () => {
    let posts = 0;
    const { server, baseUrl } = await startFakeApi(
      () => {
        posts += 1;
        return { status: 201, body: JSON.stringify({ id: 'nope' }) };
      },
      undefined,
      () => ({
        status: 200,
        body: JSON.stringify([
          {
            id: 'dup-dry',
            status: 'inProgress',
            cwd: tmpCwd,
            userPrompt: 'hello',
            agentType: 'claude-code',
          },
        ]),
      }),
    );
    try {
      const { io, logs } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['--dry-run', '--dedupe=block', 'hello'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_DUPLICATE_BLOCKED]);
      expect(posts).toBe(0);
      expect(errBucket.errors.join('\n')).toContain('--dedupe=block');
      expect(logs.join('\n')).toContain('blocked by active duplicate');
      expect(logs.join('\n')).toContain('dup-dry');
    } finally {
      await closeServer(server);
    }
  });

  it('--dry-run --json --dedupe=block returns DUPLICATE_BLOCKED with dryRun details (#1768)', async () => {
    let posts = 0;
    const { server, baseUrl } = await startFakeApi(
      () => {
        posts += 1;
        return { status: 201, body: JSON.stringify({ id: 'nope' }) };
      },
      undefined,
      () => ({
        status: 200,
        body: JSON.stringify([
          { id: 'dup-json-dry', status: 'inProgress', cwd: tmpCwd, userPrompt: 'hello' },
        ]),
      }),
    );
    try {
      const { io, logs } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['--dry-run', '--json', '--dedupe=block', 'hello'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_DUPLICATE_BLOCKED]);
      expect(posts).toBe(0);
      const envelope = parseSingleJsonLog(logs);
      expect(envelope).toMatchObject({
        ok: false,
        code: 'DUPLICATE_BLOCKED',
        details: {
          dryRun: true,
          duplicate: true,
          matchingTask: { id: 'dup-json-dry' },
          body: { prompt: 'hello', cwd: tmpCwd },
        },
      });
    } finally {
      await closeServer(server);
    }
  });

  it('--dry-run --dedupe=skip reports a match but exits 0 and never POSTs (#1768)', async () => {
    let posts = 0;
    const { server, baseUrl } = await startFakeApi(
      () => {
        posts += 1;
        return { status: 201, body: JSON.stringify({ id: 'nope' }) };
      },
      undefined,
      () => ({
        status: 200,
        body: JSON.stringify([
          { id: 'dup-skip', status: 'inProgress', cwd: tmpCwd, userPrompt: 'hello' },
        ]),
      }),
    );
    try {
      const { io, logs } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['--dry-run', '--json', '--dedupe=skip', 'hello'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_OK]);
      expect(posts).toBe(0);
      const envelope = parseSingleJsonLog(logs);
      expect(envelope.ok).toBe(true);
      expect(envelope.code).toBe('DRY_RUN');
      expect(envelope.details.duplicate).toBe(true);
      expect(envelope.details.body.disableDedup).toBe(true);
      expect(envelope.details.body.metadata).toEqual({ intent: 'keep_as_duplicate' });
    } finally {
      await closeServer(server);
    }
  });

  it('--dry-run includes auto-derived idempotency key in the would-be body (#1768)', async () => {
    let posts = 0;
    const { server, baseUrl } = await startFakeApi(
      () => {
        posts += 1;
        return { status: 201, body: JSON.stringify({ id: 'nope' }) };
      },
      undefined,
      () => ({ status: 200, body: JSON.stringify([]) }),
    );
    try {
      const { io, logs } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['--dry-run', '--json', '--auto-idempotency', 'stable prompt'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_OK]);
      expect(posts).toBe(0);
      const envelope = parseSingleJsonLog(logs);
      const expectedKey = deriveAutoIdempotencyKey({
        prompt: 'stable prompt',
        cwd: tmpCwd,
        criteria: null,
        agent: null,
      });
      expect(envelope.details.body.idempotencyKey).toBe(expectedKey);
    } finally {
      await closeServer(server);
    }
  });

  it('HELP_TEXT documents --dry-run (#1768)', async () => {
    const { io, logs } = makeConsoleCapture();
    const errBucket = makeConsoleCapture();
    const { codes, exit } = makeExitCapture();
    await main({
      argv: ['--help'],
      env: {},
      stdin: ttyStdin(),
      cwd: tmpCwd,
      out: io,
      err: errBucket.io,
      exit,
      sleep: async () => {},
    });
    expect(codes).toEqual([EXIT_OK]);
    expect(logs.join('\n')).toContain('--dry-run');
  });

  it('exits 2 on empty prompt', async () => {
    const { io } = makeConsoleCapture();
    const errBucket = makeConsoleCapture();
    const { codes, exit } = makeExitCapture();
    await main({
      argv: [],
      env: {},
      stdin: ttyStdin(), // TTY with no positional → UsageError
      cwd: tmpCwd,
      out: io,
      err: errBucket.io,
      exit,
      sleep: async () => {},
    });
    expect(codes).toEqual([EXIT_USER_ERROR]);
    expect(errBucket.errors.join('\n')).toContain('no prompt');
  });

  it('renders the 429 backpressure breakdown and exits non-zero (issue #1526 C3)', async () => {
    const { server, baseUrl } = await startFakeApi(() => ({
      status: 429,
      body: JSON.stringify({
        error: 'Pending queue is full (24/24 queued, 10/10 active) — launch rejected.',
        code: 'pending_queue_full',
        capacity: {
          maxActiveTasks: 10,
          active: 10,
          free: 0,
          byClass: { working: 2, finishedAwaitingAck: 7, hungSuspect: 1, launching: 0 },
          pendingQueueDepth: 24,
          oldestPendingAgeMs: 120000,
          oldestFinishedAwaitingAckAgeMs: 360000,
        },
        maxPendingTasks: 24,
      }),
    }));
    try {
      const { io } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['hello'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_SERVER_ERROR]); // non-zero
      const rendered = errBucket.errors.join('\n');
      expect(rendered).toContain('launch refused (pending_queue_full)');
      expect(rendered).toContain('10/10 slots occupied');
      expect(rendered).toContain('awaiting-ack 7');
      expect(rendered).toContain('pending queue: 24/24 task(s)');
    } finally {
      await closeServer(server);
    }
  });

  it('carries the 429 backpressure body in --json details (issue #1526 C3)', async () => {
    const { server, baseUrl } = await startFakeApi(() => ({
      status: 429,
      body: JSON.stringify({
        error: 'Spawn burst limit reached for source "cli"',
        code: 'spawn_burst_limit',
        source: 'cli',
        limit: 30,
        windowMs: 600000,
        retryAfterMs: 42000,
      }),
    }));
    try {
      const { io, logs } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['hello', '--json'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_SERVER_ERROR]);
      const envelope = JSON.parse(logs.join('\n'));
      expect(envelope.ok).toBe(false);
      expect(envelope.code).toBe('SERVER_ERROR');
      expect(envelope.details.status).toBe(429);
      expect(envelope.details.backpressure).toMatchObject({ code: 'spawn_burst_limit', source: 'cli' });
    } finally {
      await closeServer(server);
    }
  });

  it('reconciles an ambiguous 5xx by re-POSTing with the same key (#1591)', async () => {
    let calls = 0;
    const seenKeys: unknown[] = [];
    const { server, baseUrl } = await startFakeApi((_req, body) => {
      calls += 1;
      seenKeys.push(JSON.parse(body).idempotencyKey);
      if (calls === 1) return { status: 500, body: JSON.stringify({ error: 'transient' }) };
      return {
        status: 200,
        body: JSON.stringify({ id: 'recon-e2e', agentType: 'claude-code', cwd: tmpCwd, idempotentReplay: true }),
      };
    });
    try {
      const { io, logs } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['hello', '--idempotency-key', 'recon-e2e-key'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_OK]);
      expect(calls).toBe(2);
      expect(seenKeys).toEqual(['recon-e2e-key', 'recon-e2e-key']);
      expect(logs.join('\n')).toContain('task_id=recon-e2e');
      expect(logs.join('\n')).toContain('idempotent replay');
      expect(errBucket.errors.join('\n')).toContain('re-POSTing with idempotency key');
    } finally {
      await closeServer(server);
    }
  });

  it('does not re-POST an ambiguous 5xx without a key — reconciles via read-only probe (#1591/#1573)', async () => {
    let posts = 0;
    // No tasksHandler → GET /api/tasks 404s, so the probe cannot confirm and
    // exhausts to "unknown". The point of this test is that the client never
    // re-POSTs (no duplicate risk) — the probe is read-only.
    const { server, baseUrl } = await startFakeApi(() => {
      posts += 1;
      return { status: 500, body: JSON.stringify({ error: 'transient' }) };
    });
    try {
      const { io } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['hello'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_SERVER_ERROR]);
      expect(posts).toBe(1); // exactly one POST — the read-only probe never creates
      const rendered = errBucket.errors.join('\n');
      expect(rendered).toContain('could not verify whether a task was created');
    } finally {
      await closeServer(server);
    }
  });

  // ---- #1573 acceptance criteria: keyless ambiguous-outcome reconcile ----

  it('AC1/AC3: 5xx-after-create reconciles via probe, exits 0 with the id, and never re-POSTs (#1573)', async () => {
    let posts = 0;
    let gets = 0;
    const { server, baseUrl } = await startFakeApi(
      () => {
        // The create "fails" from the client's view (5xx) even though the task
        // landed server-side — the incident shape.
        posts += 1;
        return { status: 500, body: JSON.stringify({ error: 'timeout after create' }) };
      },
      undefined,
      () => {
        gets += 1;
        return {
          status: 200,
          body: JSON.stringify([
            { id: 'landed-1', status: 'inProgress', cwd: tmpCwd, userPrompt: 'hello', agentType: 'claude-code' },
          ]),
        };
      },
    );
    try {
      const { io, logs } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['hello'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_OK]);
      expect(posts).toBe(1); // AC3: exactly one POST — no duplicate ever created
      expect(gets).toBeGreaterThanOrEqual(1);
      const rendered = logs.join('\n');
      expect(rendered).toContain('task_id=landed-1'); // AC1: reports the id
      expect(rendered).toContain('recovered via reconcile probe');
      // AC4: no "Check the dashboard … before re-running" bail
      expect((logs.join('\n') + errBucket.errors.join('\n'))).not.toContain('Check the dashboard');
    } finally {
      await closeServer(server);
    }
  });

  it('AC2/AC4: true failure (no task landed) exits non-zero saying no task was created, not "check the dashboard" (#1573)', async () => {
    const { server, baseUrl } = await startFakeApi(
      () => ({ status: 500, body: JSON.stringify({ error: 'down' }) }),
      undefined,
      () => ({ status: 200, body: JSON.stringify([]) }), // probe: nothing landed
    );
    try {
      const { io } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['hello'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_SERVER_ERROR]);
      const rendered = errBucket.errors.join('\n');
      expect(rendered).toContain('no task was created');
      expect(rendered).not.toContain('Check the dashboard'); // AC4
    } finally {
      await closeServer(server);
    }
  });

  it('honors --dedupe=block when the probe recovers an ambiguous match (#1573)', async () => {
    const { server, baseUrl } = await startFakeApi(
      () => ({ status: 500, body: JSON.stringify({ error: 'timeout' }) }),
      undefined,
      () => ({
        status: 200,
        body: JSON.stringify([
          { id: 'maybe-mine', status: 'inProgress', cwd: tmpCwd, userPrompt: 'hello', agentType: 'claude-code' },
        ]),
      }),
    );
    try {
      const { io } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['hello', '--dedupe=block'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_DUPLICATE_BLOCKED]);
      expect(errBucket.errors.join('\n')).toContain('blocked by --dedupe=block');
    } finally {
      await closeServer(server);
    }
  });

  it('emits a reconciled --json success envelope when the probe recovers a match (#1573)', async () => {
    const { server, baseUrl } = await startFakeApi(
      () => ({ status: 503, body: JSON.stringify({ error: 'shedding' }) }),
      undefined,
      () => ({
        status: 200,
        body: JSON.stringify([
          { id: 'json-landed', status: 'inProgress', cwd: tmpCwd, userPrompt: 'hello', agentType: 'claude-code' },
        ]),
      }),
    );
    try {
      const { io, logs } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['hello', '--json'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_OK]);
      const envelope = parseSingleJsonLog(logs);
      expect(envelope).toMatchObject({ ok: true, code: 'OK', details: { taskId: 'json-landed', reconciled: true } });
      expect(errBucket.errors).toEqual([]); // --json stays quiet on stderr
    } finally {
      await closeServer(server);
    }
  });

  it('emits a reconciled --json failure envelope when the probe confirms nothing landed (#1573)', async () => {
    const { server, baseUrl } = await startFakeApi(
      () => ({ status: 500, body: JSON.stringify({ error: 'down' }) }),
      undefined,
      () => ({ status: 200, body: JSON.stringify([]) }),
    );
    try {
      const { io, logs } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['hello', '--json'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_SERVER_ERROR]);
      const envelope = parseSingleJsonLog(logs);
      expect(envelope).toMatchObject({ ok: false, code: 'SERVER_ERROR', details: { reconciled: true } });
      expect(envelope.message).toContain('no task was created');
    } finally {
      await closeServer(server);
    }
  });

  it('AC1: matches this spawn even when the prompt names a real file the server rewrote to an absolute path (#1573)', async () => {
    // The server rewrites existing relative file tokens to absolute paths via
    // normalizePromptFileReferences before storing userPrompt. The probe must
    // apply the same transform or it would never match its own task.
    await writeFile(join(tmpCwd, 'app.ts'), 'export {}\n');
    const absPath = join(tmpCwd, 'app.ts');
    const { server, baseUrl } = await startFakeApi(
      () => ({ status: 500, body: JSON.stringify({ error: 'timeout after create' }) }),
      undefined,
      () => ({
        status: 200,
        body: JSON.stringify([
          {
            id: 'file-landed',
            status: 'inProgress',
            cwd: tmpCwd,
            // server-normalized: relative "app.ts" → absolute path
            userPrompt: `fix ${absPath}`,
            prompt: `[launch context]\nfix ${absPath}`,
            agentType: 'claude-code',
          },
        ]),
      }),
    );
    try {
      const { io, logs } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['fix app.ts'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_OK]);
      expect(logs.join('\n')).toContain('task_id=file-landed');
    } finally {
      await closeServer(server);
    }
  });

  it('AC1: reconciles the throw path (dropped connection / timeout) keylessly via the probe (#1573)', async () => {
    // The catch-block wiring is independent of the 5xx path; exercise it with a
    // POST that drops the socket mid-request while GET /api/tasks shows the task
    // landed.
    let posts = 0;
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/tasks') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([
          { id: 'throw-landed', status: 'inProgress', cwd: tmpCwd, userPrompt: 'hello', agentType: 'claude-code' },
        ]));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/tasks') {
        posts += 1;
        req.socket.destroy(); // ambiguous: connection dropped mid-request
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr !== 'object') throw new Error('no address');
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    try {
      const { io, logs } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['hello'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_OK]);
      expect(posts).toBe(1); // no re-POST on the throw path — probe is read-only
      expect(logs.join('\n')).toContain('task_id=throw-landed');
    } finally {
      await closeServer(server);
    }
  });

  it('does NOT claim success from a probe under --dedupe=skip (a match is likely a sibling) (#1573)', async () => {
    let gets = 0;
    const { server, baseUrl } = await startFakeApi(
      () => ({ status: 500, body: JSON.stringify({ error: 'timeout' }) }),
      undefined,
      () => {
        gets += 1;
        return {
          status: 200,
          body: JSON.stringify([
            { id: 'sibling', status: 'inProgress', cwd: tmpCwd, userPrompt: 'hello', agentType: 'claude-code' },
          ]),
        };
      },
    );
    try {
      const { io } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['hello', '--dedupe=skip'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_SERVER_ERROR]); // never a false success
      expect(gets).toBe(0); // skip mode does not probe (a match would be a sibling)
      const rendered = errBucket.errors.join('\n');
      expect(rendered).toContain('--idempotency-key');
      expect(rendered).not.toContain('Check the dashboard');
    } finally {
      await closeServer(server);
    }
  });

  it('still surfaces a 429 backpressure rejection without probing (definitive, task not created) (#1573)', async () => {
    let gets = 0;
    const { server, baseUrl } = await startFakeApi(
      () => ({
        status: 429,
        body: JSON.stringify({ error: 'burst', code: 'spawn_burst_limit', source: 'cli', limit: 30, windowMs: 600000, retryAfterMs: 1000 }),
      }),
      undefined,
      () => {
        gets += 1;
        return { status: 200, body: JSON.stringify([{ id: 'x', status: 'inProgress', cwd: tmpCwd, userPrompt: 'hello' }]) };
      },
    );
    try {
      const { io } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['hello'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_SERVER_ERROR]);
      expect(gets).toBe(0); // 429 is definitive → no probe
      expect(errBucket.errors.join('\n')).toContain('spawn_burst_limit');
    } finally {
      await closeServer(server);
    }
  });

  it('creates a task end-to-end against a fake API server', async () => {
    const { server, baseUrl } = await startFakeApi(() => ({
      status: 201,
      body: JSON.stringify({ id: 'mk-1', agentType: 'claude-code', cwd: tmpCwd }),
    }));
    try {
      const { io, logs } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['hello'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_OK]);
      expect(logs.join('\n')).toContain('task_id=mk-1');
      expect(logs.join('\n')).toContain('✓ Task created');
    } finally {
      await closeServer(server);
    }
  });

  it('prints a JSON envelope when a task is created with --json', async () => {
    const { server, baseUrl } = await startFakeApi(() => ({
      status: 201,
      body: JSON.stringify({
        id: 'mk-json',
        agentType: 'claude-code',
        cwd: tmpCwd,
        prompt: 'secret=do-not-echo',
        parentTaskId: 'parent-1',
      }),
    }));
    try {
      const { io, logs } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['--json', 'hello'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      const envelope = parseSingleJsonLog(logs);
      expect(codes).toEqual([EXIT_OK]);
      expect(errBucket.errors).toEqual([]);
      expect(envelope).toMatchObject({
        ok: true,
        code: 'OK',
        message: 'Task created',
        details: {
          taskId: 'mk-json',
          parentTaskId: 'parent-1',
          queued: false,
          baseUrl,
          openUrl: `${baseUrl}/#/tasks/mk-json`,
          parentUrl: `${baseUrl}/#/tasks/parent-1`,
        },
      });
      expect(envelope.details.task.id).toBe('mk-json');
      expect(envelope.details.task.prompt).toBeUndefined();
      expect(JSON.stringify(envelope)).not.toContain('secret=do-not-echo');
    } finally {
      await closeServer(server);
    }
  });

  it('waits after creating a task and exits 0 on completion-ready', async () => {
    const { server, baseUrl } = await startFakeApi(
      () => ({
        status: 201,
        body: JSON.stringify({ id: 'wait-1', agentType: 'claude-code', cwd: tmpCwd }),
      }),
      () => ({
        status: 200,
        body: JSON.stringify([
          { taskId: 'wait-1', taskStatus: 'inProgress' },
        ]),
      }),
      () => ({
        status: 200,
        body: JSON.stringify([
          {
            id: 'wait-1',
            status: 'inProgress',
            pendingSignal: { kind: 'completion_ready', raisedAt: '2026-06-27T00:00:00.000Z' },
          },
        ]),
      }),
    );
    try {
      const { io, logs } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['--wait', 'hello'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_OK]);
      expect(logs.join('\n')).toContain('task_id=wait-1');
      expect(logs.join('\n')).toContain('completion-ready');
    } finally {
      await closeServer(server);
    }
  });

  it('waits after creating a task and exits 4 on cancelled terminal state', async () => {
    const { server, baseUrl } = await startFakeApi(
      () => ({
        status: 201,
        body: JSON.stringify({ id: 'wait-1', agentType: 'claude-code', cwd: tmpCwd }),
      }),
      () => ({
        status: 200,
        body: JSON.stringify([{ taskId: 'wait-1', taskStatus: 'cancelled' }]),
      }),
      () => ({
        status: 200,
        body: JSON.stringify([{ id: 'wait-1', status: 'cancelled' }]),
      }),
    );
    try {
      const { io } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['--wait', 'hello'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_SERVER_ERROR]);
      expect(errBucket.errors.join('\n')).toContain('cancelled');
    } finally {
      await closeServer(server);
    }
  });

  it('waits after creating a task and exits 0 on completed terminal state', async () => {
    const { server, baseUrl } = await startFakeApi(
      () => ({
        status: 201,
        body: JSON.stringify({ id: 'wait-1', agentType: 'claude-code', cwd: tmpCwd }),
      }),
      () => ({
        status: 200,
        body: JSON.stringify([{ taskId: 'wait-1', taskStatus: 'completed' }]),
      }),
      () => ({
        status: 200,
        body: JSON.stringify([{ id: 'wait-1', status: 'completed' }]),
      }),
    );
    try {
      const { io, logs } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['--wait', 'hello'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_OK]);
      expect(logs.join('\n')).toContain('Task completed');
    } finally {
      await closeServer(server);
    }
  });

  it('waits on the duplicate task returned by --dedupe=skip --wait', async () => {
    const { server, baseUrl } = await startFakeApi(
      () => ({
        status: 200,
        body: JSON.stringify({ duplicate: true, task: { id: 'dup-1', status: 'inProgress', cwd: tmpCwd } }),
      }),
      () => ({
        status: 200,
        body: JSON.stringify([{ taskId: 'dup-1', taskStatus: 'completed' }]),
      }),
      () => ({
        status: 200,
        body: JSON.stringify([{ id: 'dup-1', status: 'completed' }]),
      }),
    );
    try {
      const { io, logs } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['--dedupe=skip', '--wait', 'hello'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_OK]);
      expect(logs.join('\n')).toContain('task_id=dup-1');
      expect(logs.join('\n')).toContain('Task completed');
    } finally {
      await closeServer(server);
    }
  });

  it('exits 6 when --wait times out', async () => {
    const { server, baseUrl } = await startFakeApi(
      () => ({
        status: 201,
        body: JSON.stringify({ id: 'wait-1', agentType: 'claude-code', cwd: tmpCwd }),
      }),
      () => ({
        status: 200,
        body: JSON.stringify([{ taskId: 'wait-1', taskStatus: 'inProgress' }]),
      }),
      () => ({
        status: 200,
        body: JSON.stringify([{ id: 'wait-1', status: 'inProgress' }]),
      }),
    );
    let now = 0;
    try {
      const { io } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['--wait=1', 'hello'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async (ms) => { now += ms; },
        now: () => now,
      });
      expect(codes).toEqual([EXIT_WAIT_TIMEOUT]);
      expect(errBucket.errors.join('\n')).toContain('timed out');
    } finally {
      await closeServer(server);
    }
  });

  it('blocks a duplicate active prompt in non-interactive default warn mode', async () => {
    const { server, baseUrl } = await startFakeApi(() => ({
      status: 200,
      body: JSON.stringify({ duplicate: true, task: { id: 'dup-1', status: 'inProgress', cwd: tmpCwd } }),
    }));
    try {
      const { io } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['hello'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: pipedStdin(''),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_DUPLICATE_BLOCKED]);
      expect(errBucket.errors.join('\n')).toContain('duplicate active prompt blocked');
    } finally {
      await closeServer(server);
    }
  });

  it('blocks a duplicate active prompt with --dedupe=block', async () => {
    const { server, baseUrl } = await startFakeApi(() => ({
      status: 200,
      body: JSON.stringify({ duplicate: true, task: { id: 'dup-1', status: 'inProgress', cwd: tmpCwd } }),
    }));
    try {
      const { io } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['--dedupe=block', 'hello'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_DUPLICATE_BLOCKED]);
      expect(errBucket.errors.join('\n')).toContain('--dedupe=block');
    } finally {
      await closeServer(server);
    }
  });

  it('prints a JSON envelope when a duplicate is blocked with --json', async () => {
    const { server, baseUrl } = await startFakeApi(() => ({
      status: 200,
      body: JSON.stringify({
        duplicate: true,
        task: { id: 'dup-json', status: 'inProgress', cwd: tmpCwd },
      }),
    }));
    try {
      const { io, logs } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['--json', '--dedupe=block', 'hello'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      const envelope = parseSingleJsonLog(logs);
      expect(codes).toEqual([EXIT_DUPLICATE_BLOCKED]);
      expect(errBucket.errors).toEqual([]);
      expect(envelope).toMatchObject({
        ok: false,
        code: 'DUPLICATE_BLOCKED',
        details: {
          taskId: 'dup-json',
          baseUrl,
        },
      });
    } finally {
      await closeServer(server);
    }
  });

  it('prompts in warn mode and creates an intentional duplicate after confirmation', async () => {
    const bodies: any[] = [];
    const { server, baseUrl } = await startFakeApi((_req, bodyText) => {
      const body = JSON.parse(bodyText);
      bodies.push(body);
      if (bodies.length === 1) {
        return {
          status: 200,
          body: JSON.stringify({
            duplicate: true,
            task: { id: 'dup-1', status: 'inProgress', cwd: tmpCwd, prompt: 'hello' },
          }),
        };
      }
      return {
        status: 201,
        body: JSON.stringify({ id: 'dup-2', agentType: 'claude-code', cwd: tmpCwd, metadata: body.metadata }),
      };
    });
    try {
      const { io, logs } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['hello'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: interactiveStdin('y\n'),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_OK]);
      expect(bodies).toHaveLength(2);
      expect(bodies[0].disableDedup).toBeUndefined();
      expect(bodies[1]).toMatchObject({
        disableDedup: true,
        metadata: { intent: 'keep_as_duplicate' },
      });
      expect(logs.join('\n')).toContain('task_id=dup-2');
    } finally {
      await closeServer(server);
    }
  });

  it('preserves a wrapped launch with a new retry-safe key after duplicate confirmation', async () => {
    const bodies: any[] = [];
    const { server, baseUrl } = await startFakeApi((_req, bodyText) => {
      const body = JSON.parse(bodyText);
      bodies.push(body);
      if (bodies.length === 1 || bodies.length === 4 || bodies.length === 6) {
        return {
          status: 200,
          body: JSON.stringify({
            duplicate: true,
            task: {
              id: bodies.length === 6 ? 'other-wrapper' : 'existing-wrapper',
              status: 'inProgress',
              cwd: tmpCwd,
              prompt: 'phase prompt',
            },
          }),
        };
      }
      if (bodies.length === 2) {
        return { status: 503, body: JSON.stringify({ error: 'ambiguous launch' }) };
      }
      return {
        status: 200,
        body: JSON.stringify({
          id: 'intentional-wrapper',
          agentType: 'claude-code',
          cwd: tmpCwd,
          idempotentReplay: true,
        }),
      };
    });
    try {
      const { io } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: [
          '--playbook', 'architecture-refactor-phase.md',
          '--playbook-scope', 'plugin',
          '--idempotency-key', 'phase-key',
          'phase prompt',
        ],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: interactiveStdin('y\n'),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });

      expect(codes).toEqual([EXIT_OK]);
      expect(bodies).toHaveLength(3);
      expect(bodies[0].idempotencyKey).toBe('phase-key');
      expect(bodies[1]).toMatchObject({
        disableDedup: true,
        metadata: { intent: 'keep_as_duplicate' },
        playbook: { path: 'architecture-refactor-phase.md', scope: 'plugin' },
      });
      expect(bodies[1].idempotencyKey).toMatch(/^duplicate-[0-9a-f]{16}$/);
      expect(bodies[1].idempotencyKey).not.toBe(bodies[0].idempotencyKey);
      expect(bodies[2]).toMatchObject({
        disableDedup: true,
        metadata: { intent: 'keep_as_duplicate' },
        playbook: { path: 'architecture-refactor-phase.md', scope: 'plugin' },
        idempotencyKey: bodies[1].idempotencyKey,
      });

      const secondConsole = makeConsoleCapture();
      const secondErr = makeConsoleCapture();
      const secondExit = makeExitCapture();
      await main({
        argv: [
          '--playbook', 'architecture-refactor-phase.md',
          '--playbook-scope', 'plugin',
          '--idempotency-key', 'phase-key',
          'phase prompt',
        ],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: interactiveStdin('y\n'),
        cwd: tmpCwd,
        out: secondConsole.io,
        err: secondErr.io,
        exit: secondExit.exit,
        sleep: async () => {},
      });

      expect(secondExit.codes).toEqual([EXIT_OK]);
      expect(bodies).toHaveLength(5);
      expect(bodies[3].idempotencyKey).toBe('phase-key');
      expect(bodies[4]).toMatchObject({
        disableDedup: true,
        playbook: { path: 'architecture-refactor-phase.md', scope: 'plugin' },
        idempotencyKey: bodies[1].idempotencyKey,
      });

      const thirdConsole = makeConsoleCapture();
      const thirdErr = makeConsoleCapture();
      const thirdExit = makeExitCapture();
      await main({
        argv: [
          '--playbook', 'architecture-refactor-phase.md',
          '--playbook-scope', 'plugin',
          '--idempotency-key', 'phase-key',
          'phase prompt',
        ],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: interactiveStdin('y\n'),
        cwd: tmpCwd,
        out: thirdConsole.io,
        err: thirdErr.io,
        exit: thirdExit.exit,
        sleep: async () => {},
      });

      expect(thirdExit.codes).toEqual([EXIT_OK]);
      expect(bodies).toHaveLength(7);
      expect(bodies[6].idempotencyKey).toMatch(/^duplicate-[0-9a-f]{16}$/);
      expect(bodies[6].idempotencyKey).not.toBe(bodies[1].idempotencyKey);
    } finally {
      await closeServer(server);
    }
  });

  it('prints a prompt diff and re-prompts in interactive warn mode', async () => {
    const bodies: any[] = [];
    const { server, baseUrl } = await startFakeApi((_req, bodyText) => {
      bodies.push(JSON.parse(bodyText));
      if (bodies.length === 1) {
        return {
          status: 200,
          body: JSON.stringify({
            duplicate: true,
            task: { id: 'dup-1', status: 'inProgress', cwd: tmpCwd, prompt: 'old line' },
          }),
        };
      }
      return { status: 201, body: JSON.stringify({ id: 'dup-2', agentType: 'claude-code', cwd: tmpCwd }) };
    });
    try {
      const { io, logs } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['new line'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: interactiveStdin('show diff\ny\n'),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_OK]);
      expect(logs.join('\n')).toContain('--- existing active task prompt');
      expect(logs.join('\n')).toContain('-old line');
      expect(logs.join('\n')).toContain('+new line');
    } finally {
      await closeServer(server);
    }
  });

  it('skips the duplicate interrupt and marks intent with --dedupe=skip', async () => {
    let bodySeen: any = null;
    const { server, baseUrl } = await startFakeApi((_req, bodyText) => {
      bodySeen = JSON.parse(bodyText);
      return { status: 201, body: JSON.stringify({ id: 'dup-2', agentType: 'claude-code', cwd: tmpCwd }) };
    });
    try {
      const { io, logs } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['--dedupe=skip', 'hello'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_OK]);
      expect(bodySeen).toMatchObject({
        disableDedup: true,
        metadata: { intent: 'keep_as_duplicate' },
      });
      expect(logs.join('\n')).toContain('task_id=dup-2');
    } finally {
      await closeServer(server);
    }
  });

  it('exits 4 when server returns a definitive error (4xx surfaces the message)', async () => {
    // Use a definitive 4xx: a 5xx is now reconcilable via the keyless probe
    // (#1573), so it would no longer surface the raw server message directly.
    const { server, baseUrl } = await startFakeApi(() => ({
      status: 400,
      body: JSON.stringify({ error: 'kaboom' }),
    }));
    try {
      const { io } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['hello'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_SERVER_ERROR]);
      expect(errBucket.errors.join('\n')).toContain('kaboom');
    } finally {
      await closeServer(server);
    }
  });

  it('exits 3 with "no server" message when KOOKR_PORT points at nothing', async () => {
    const { io } = makeConsoleCapture();
    const errBucket = makeConsoleCapture();
    const { codes, exit } = makeExitCapture();
    // The explicit-port path does NOT probe /api/health — it trusts the env,
    // hands the base URL to postTask, and postTask gets a network error. That
    // surfaces as EXIT_SERVER_ERROR, not EXIT_NO_SERVER. So to trigger the
    // EXIT_NO_SERVER path via env we'd need the auto-detect branch, which
    // requires both 4800 and 4801 to be unreachable on the real host. We
    // check the invalid_port branch here, which IS purely CLI-side.
    await main({
      argv: ['hello'],
      env: { KOOKR_PORT: 'abc' },
      stdin: ttyStdin(),
      cwd: tmpCwd,
      out: io,
      err: errBucket.io,
      exit,
      sleep: async () => {},
    });
    expect(codes).toEqual([EXIT_USER_ERROR]);
    expect(errBucket.errors.join('\n')).toMatch(/KOOKR_PORT/i);
  });

  it('exits 3 when auto-detect finds no reachable Kookr instance', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    try {
      const { io } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['hello'],
        env: { KOOKR_SPAWN_CONNECT_RETRIES: '1' },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });

      expect(codes).toEqual([EXIT_NO_SERVER]);
      // 2 health probes + 1 deploy/status sweep (2 ports) once health fails (#1975)
      expect(fetchSpy).toHaveBeenCalledTimes(4);
      expect(errBucket.errors.join('\n')).toContain('no Kookr server reachable');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('exits 3 when auto-detect finds both standard Kookr instances', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ serverStartedAt: '2026-06-07T00:00:00.000Z' }),
    } as Response);
    try {
      const { io } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['hello'],
        env: { KOOKR_SPAWN_CONNECT_RETRIES: '1' },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });

      expect(codes).toEqual([EXIT_NO_SERVER]);
      // Health succeeds on both ports → ambiguous path never probes deploy/status.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(errBucket.errors.join('\n')).toContain('both Kookr instances are running');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('forwards KOOKR_TASK_ID as parentTaskId by default (auto-link path)', async () => {
    let bodySeen: any = null;
    const { server, baseUrl } = await startFakeApi((_req, bodyText) => {
      bodySeen = JSON.parse(bodyText);
      return {
        status: 201,
        body: JSON.stringify({ id: 'child-1', agentType: 'claude-code', cwd: tmpCwd, parentTaskId: 'env-parent' }),
      };
    });
    try {
      const { io, logs } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['hello'],
        env: { KOOKR_API_BASE_URL: baseUrl, KOOKR_TASK_ID: 'env-parent' },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_OK]);
      expect(bodySeen.parentTaskId).toBe('env-parent');
      expect(logs.join('\n')).toContain('parent_task_id=env-parent');
    } finally {
      await closeServer(server);
    }
  });

  it('--no-parent-task drops KOOKR_TASK_ID from the request body', async () => {
    let bodySeen: any = null;
    const { server, baseUrl } = await startFakeApi((_req, bodyText) => {
      bodySeen = JSON.parse(bodyText);
      return { status: 201, body: JSON.stringify({ id: 't1', agentType: 'claude-code', cwd: tmpCwd }) };
    });
    try {
      const { io } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['--no-parent-task', 'hello'],
        env: { KOOKR_API_BASE_URL: baseUrl, KOOKR_TASK_ID: 'env-parent' },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_OK]);
      expect(bodySeen.parentTaskId).toBeUndefined();
    } finally {
      await closeServer(server);
    }
  });

  it('--parent-task-id overrides KOOKR_TASK_ID', async () => {
    let bodySeen: any = null;
    const { server, baseUrl } = await startFakeApi((_req, bodyText) => {
      bodySeen = JSON.parse(bodyText);
      return { status: 201, body: JSON.stringify({ id: 't1', agentType: 'claude-code', cwd: tmpCwd }) };
    });
    try {
      const { io } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['--parent-task-id', 'explicit-parent', 'hello'],
        env: { KOOKR_API_BASE_URL: baseUrl, KOOKR_TASK_ID: 'env-parent' },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_OK]);
      expect(bodySeen.parentTaskId).toBe('explicit-parent');
    } finally {
      await closeServer(server);
    }
  });

  it('by default (no flag, no env) sends NO idempotency key — strict no-op', async () => {
    let bodySeen: any = null;
    const { server, baseUrl } = await startFakeApi((_req, bodyText) => {
      bodySeen = JSON.parse(bodyText);
      return { status: 201, body: JSON.stringify({ id: 't1', agentType: 'claude-code', cwd: tmpCwd }) };
    });
    try {
      const { io } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['implement #42'],
        env: { KOOKR_API_BASE_URL: baseUrl }, // no --auto-idempotency, no KOOKR_SPAWN_AUTO_IDEMPOTENCY
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_OK]);
      expect(bodySeen.idempotencyKey).toBeUndefined();
    } finally {
      await closeServer(server);
    }
  });

  it('--auto-idempotency derives the EXACT key from prompt+cwd+criteria+agent', async () => {
    let bodySeen: any = null;
    const { server, baseUrl } = await startFakeApi((_req, bodyText) => {
      bodySeen = JSON.parse(bodyText);
      return { status: 201, body: JSON.stringify({ id: 't1', agentType: 'claude-code', cwd: tmpCwd }) };
    });
    try {
      const { io } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['--auto-idempotency', 'implement #42'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_OK]);
      // Exact-value assertion pins the identity fields main() actually passes
      // (prompt, resolved cwd, criteria=null, agent=null) — a wrong-field wiring
      // bug would still match the format regex but fail this. cwd is not realpath'd
      // (resolveCwd uses pathResolve), so tmpCwd is the resolved cwd here.
      const expected = deriveAutoIdempotencyKey({ prompt: 'implement #42', cwd: tmpCwd, criteria: null, agent: null });
      expect(bodySeen.idempotencyKey).toBe(expected);
      expect(bodySeen.idempotencyKey).toMatch(/^auto-[0-9a-f]{16}$/);
    } finally {
      await closeServer(server);
    }
  });

  it('KOOKR_SPAWN_AUTO_IDEMPOTENCY=1 enables it; --no-auto-idempotency overrides the env', async () => {
    const bodies: any[] = [];
    const { server, baseUrl } = await startFakeApi((_req, bodyText) => {
      bodies.push(JSON.parse(bodyText));
      return { status: 201, body: JSON.stringify({ id: 't1', agentType: 'claude-code', cwd: tmpCwd }) };
    });
    try {
      const run = async (argv: string[]) => {
        const { io } = makeConsoleCapture();
        const errBucket = makeConsoleCapture();
        const { codes, exit } = makeExitCapture();
        await main({
          argv,
          env: { KOOKR_API_BASE_URL: baseUrl, KOOKR_SPAWN_AUTO_IDEMPOTENCY: '1' },
          stdin: ttyStdin(),
          cwd: tmpCwd,
          out: io,
          err: errBucket.io,
          exit,
          sleep: async () => {},
        });
        expect(codes).toEqual([EXIT_OK]);
      };
      await run(['env-on']);
      await run(['--no-auto-idempotency', 'flag-off']);
      expect(bodies[0].idempotencyKey).toMatch(/^auto-[0-9a-f]{16}$/);
      expect(bodies[1].idempotencyKey).toBeUndefined();
    } finally {
      await closeServer(server);
    }
  });

  it('explicit --idempotency-key wins over --auto-idempotency', async () => {
    let bodySeen: any = null;
    const { server, baseUrl } = await startFakeApi((_req, bodyText) => {
      bodySeen = JSON.parse(bodyText);
      return { status: 201, body: JSON.stringify({ id: 't1', agentType: 'claude-code', cwd: tmpCwd }) };
    });
    try {
      const { io } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['--auto-idempotency', '--idempotency-key', 'explicit-key', 'hello'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_OK]);
      expect(bodySeen.idempotencyKey).toBe('explicit-key');
    } finally {
      await closeServer(server);
    }
  });

  it('--dedupe=skip suppresses auto-idempotency (intentional duplicate)', async () => {
    let bodySeen: any = null;
    const { server, baseUrl } = await startFakeApi((_req, bodyText) => {
      bodySeen = JSON.parse(bodyText);
      return { status: 201, body: JSON.stringify({ id: 't1', agentType: 'claude-code', cwd: tmpCwd }) };
    });
    try {
      const { io } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['--auto-idempotency', '--dedupe=skip', 'hello'],
        env: { KOOKR_API_BASE_URL: baseUrl },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_OK]);
      expect(bodySeen.idempotencyKey).toBeUndefined();
    } finally {
      await closeServer(server);
    }
  });

  it('omits parentTaskId entirely outside a Kookr task (no env)', async () => {
    let bodySeen: any = null;
    const { server, baseUrl } = await startFakeApi((_req, bodyText) => {
      bodySeen = JSON.parse(bodyText);
      return { status: 201, body: JSON.stringify({ id: 't1', agentType: 'claude-code', cwd: tmpCwd }) };
    });
    try {
      const { io, logs } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['hello'],
        env: { KOOKR_API_BASE_URL: baseUrl }, // KOOKR_TASK_ID intentionally absent
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_OK]);
      expect('parentTaskId' in bodySeen).toBe(false);
      expect(logs.join('\n')).not.toContain('parent_task_id=');
    } finally {
      await closeServer(server);
    }
  });

  it('forwards parentTaskId on the dedupe-retry POST after confirmation', async () => {
    const bodies: any[] = [];
    const { server, baseUrl } = await startFakeApi((_req, bodyText) => {
      const body = JSON.parse(bodyText);
      bodies.push(body);
      if (bodies.length === 1) {
        return {
          status: 200,
          body: JSON.stringify({
            duplicate: true,
            task: { id: 'dup-1', status: 'inProgress', cwd: tmpCwd, prompt: 'hello' },
          }),
        };
      }
      return {
        status: 201,
        body: JSON.stringify({ id: 'dup-2', agentType: 'claude-code', cwd: tmpCwd, parentTaskId: 'env-parent' }),
      };
    });
    try {
      const { io } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['hello'],
        env: { KOOKR_API_BASE_URL: baseUrl, KOOKR_TASK_ID: 'env-parent' },
        stdin: interactiveStdin('y\n'),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_OK]);
      expect(bodies).toHaveLength(2);
      expect(bodies[0].parentTaskId).toBe('env-parent');
      expect(bodies[1].parentTaskId).toBe('env-parent');
    } finally {
      await closeServer(server);
    }
  });

  it('surfaces the parent-404 message on the dedupe-retry path too', async () => {
    let postCount = 0;
    const { server, baseUrl } = await startFakeApi(() => {
      postCount += 1;
      if (postCount === 1) {
        return {
          status: 200,
          body: JSON.stringify({
            duplicate: true,
            task: { id: 'dup-1', status: 'inProgress', cwd: tmpCwd, prompt: 'hello' },
          }),
        };
      }
      return { status: 404, body: JSON.stringify({ error: 'Parent task not found: stale-parent' }) };
    });
    try {
      const { io } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['hello'],
        env: { KOOKR_API_BASE_URL: baseUrl, KOOKR_TASK_ID: 'stale-parent' },
        stdin: interactiveStdin('y\n'),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_SERVER_ERROR]);
      const combined = errBucket.errors.join('\n');
      expect(combined).toContain('parent task stale-parent not found');
      expect(combined).toContain('--no-parent-task');
    } finally {
      await closeServer(server);
    }
  });

  it('surfaces a clear message and exits 4 when server 404s the parent', async () => {
    const { server, baseUrl } = await startFakeApi(() => ({
      status: 404,
      body: JSON.stringify({ error: 'Parent task not found: stale-parent' }),
    }));
    try {
      const { io } = makeConsoleCapture();
      const errBucket = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();
      await main({
        argv: ['hello'],
        env: { KOOKR_API_BASE_URL: baseUrl, KOOKR_TASK_ID: 'stale-parent' },
        stdin: ttyStdin(),
        cwd: tmpCwd,
        out: io,
        err: errBucket.io,
        exit,
        sleep: async () => {},
      });
      expect(codes).toEqual([EXIT_SERVER_ERROR]);
      const combined = errBucket.errors.join('\n');
      expect(combined).toContain('parent task stale-parent not found');
      expect(combined).toContain('--no-parent-task');
    } finally {
      await closeServer(server);
    }
  });

});

// ---------- fake HTTP helpers ----------

async function startFakeHealth(health: Record<string, unknown>): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('no address');
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

type ApiResponse = { status: number; body: string; headers?: Record<string, string> };
type ApiHandler = (req: import('node:http').IncomingMessage, bodyText: string) => ApiResponse;

async function startFakeApi(
  handler: ApiHandler,
  snapshotHandler?: (req: import('node:http').IncomingMessage) => ApiResponse,
  tasksHandler?: (req: import('node:http').IncomingMessage) => ApiResponse,
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/snapshot' && snapshotHandler) {
      const result = snapshotHandler(req);
      const headers = { 'Content-Type': 'application/json', ...(result.headers ?? {}) };
      res.writeHead(result.status, headers);
      res.end(result.body);
      return;
    }
    if (req.method === 'GET' && req.url === '/api/tasks' && tasksHandler) {
      const result = tasksHandler(req);
      const headers = { 'Content-Type': 'application/json', ...(result.headers ?? {}) };
      res.writeHead(result.status, headers);
      res.end(result.body);
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      if (req.method === 'POST' && req.url === '/api/tasks') {
        const result = handler(req, body);
        const headers = { 'Content-Type': 'application/json', ...(result.headers ?? {}) };
        res.writeHead(result.status, headers);
        res.end(result.body);
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('no address');
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
