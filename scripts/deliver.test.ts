import { describe, expect, test } from 'vitest';

import {
  EXIT_NEEDS_DECISION,
  EXIT_NO_VERDICT,
  EXIT_OK,
  STEP_NAMES,
  UsageError,
  deliver,
  parseArgs,
  verdictState,
  type Commands,
  type DeliverDeps,
  type RunResult,
} from './deliver.js';

const CMDS: Commands = { bash: 'bash', node: 'node', repoRoot: '/repo' };
const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const BODY = '/tmp/body.md';

function verdictComment(verdict: 'pass' | 'block', sha: string, createdAt: string) {
  return {
    body: `<!-- kookr-independent-review -->\nkookr-review-verdict: ${verdict}\nreview-head-sha: ${sha}\n`,
    createdAt,
  };
}

function prView(comments: Array<{ body: string; createdAt: string }>, head = HEAD): string {
  return JSON.stringify({ comments, commits: [{ oid: OLD_HEAD }, { oid: head }] });
}

/** Short label for a recorded call, used to assert the step order. */
function label(cmd: string, args: string[]): string {
  if (cmd === 'bash') return args[0].split('/').pop()!;
  if (cmd === 'node') return `kookr ${args.slice(1, 3).join(' ')}`.trim();
  return `${cmd} ${args.slice(0, 2).join(' ')}`;
}

interface FakeOptions {
  /** Exit code per call label; default 0. */
  codes?: Record<string, number>;
  /** Successive `gh pr view` outputs; the last one repeats. */
  views?: string[];
  existingPr?: string;
  bodyExists?: boolean;
}

function fakeDeps(o: FakeOptions = {}) {
  const calls: string[] = [];
  const writes: string[] = [];
  const logs: string[] = [];
  const files = new Set<string>(o.bodyExists ? [BODY] : []);
  let clock = 0;
  let viewIndex = 0;
  let created = false;
  const deps: DeliverDeps = {
    run(cmd, args): RunResult {
      const l = label(cmd, args);
      calls.push(l);
      const code = o.codes?.[l] ?? 0;
      let stdout = '';
      if (l === 'git rev-parse --abbrev-ref') stdout = 'feat/x\n';
      else if (l === 'git log -1') stdout = 'feat(x): do it\n';
      else if (l === 'gh pr list') stdout = o.existingPr ?? (created ? '42\n' : '');
      else if (l === 'gh pr create') created = true;
      else if (l === 'gh pr view') {
        const views = o.views ?? [prView([verdictComment('pass', HEAD, '2026-11-18T01:00:00Z')])];
        stdout = views[Math.min(viewIndex++, views.length - 1)];
      } else if (l === 'kookr pr-checklist scaffold') stdout = '## Summary\n';
      return { code, stdout };
    },
    writeFile(path) {
      writes.push(path);
      files.add(path);
    },
    fileExists: (path) => files.has(path),
    async sleep(ms) {
      clock += ms;
    },
    now: () => clock,
    log: (line) => logs.push(line),
  };
  return { deps, calls, writes, logs };
}

function opts(...argv: string[]) {
  return parseArgs(['--specialists', 'independent-review', '--body-file', BODY, '--poll-interval', '10', ...argv]);
}

/** The step-defining calls, without the lookups (branch, title, PR number). */
const STEP_CALLS = [
  'write-review-state-marker.sh',
  'write-pr-gate-marker.sh',
  'kookr pr-checklist scaffold',
  'kookr pr-checklist verify',
  'git push --set-upstream',
  'gh pr create',
  'gh pr view',
  'kookr merge 42',
];
const isStepCall = (c: string) => STEP_CALLS.includes(c) || c === 'gh pr edit';

describe('pnpm deliver --dry-run', () => {
  test('prints every step in order with its arguments and makes no call or write', async () => {
    const forbidden = () => {
      throw new Error('dry-run must not touch git, gh or the file system');
    };
    const logs: string[] = [];
    const deps: DeliverDeps = {
      run: forbidden,
      writeFile: forbidden,
      fileExists: forbidden,
      sleep: forbidden,
      now: forbidden,
      log: (line) => logs.push(line),
    };
    const code = await deliver(parseArgs(['--', '--dry-run', '--specialists', 'independent-review']), deps, CMDS);
    expect(code).toBe(EXIT_OK);

    const stepLines = logs.filter((l) => /^\d+\. /.test(l));
    expect(stepLines).toEqual(STEP_NAMES.map((name, i) => `${i + 1}. ${name}`));
    const text = logs.join('\n');
    expect(text).toContain('bash /repo/scripts/write-review-state-marker.sh --status approved --specialists independent-review');
    expect(text).toContain('bash /repo/scripts/write-pr-gate-marker.sh');
    expect(text).toContain('node /repo/bin/kookr.js pr-checklist scaffold --base main');
    expect(text).toContain('git push --set-upstream origin <current-branch>');
    expect(text).toContain('gh pr create --base main --head <current-branch>');
    expect(text).toContain('node /repo/bin/kookr.js merge <pr>');
  });

  test('honours --from/--to in the printed plan', async () => {
    const logs: string[] = [];
    const { deps } = fakeDeps();
    deps.log = (l) => logs.push(l);
    await deliver(parseArgs(['--dry-run', '--from', 'push', '--to', 'wait-verdict', '--pr', '7']), deps, CMDS);
    expect(logs.filter((l) => /^\d+\. /.test(l))).toEqual(['1. push', '2. pr', '3. wait-verdict']);
    expect(logs.join('\n')).toContain('gh pr view 7 --json comments,commits');
  });
});

describe('pnpm deliver run', () => {
  test('runs the seven steps in order and merges after a PASS for the PR head', async () => {
    const { deps, calls, writes } = fakeDeps();
    const code = await deliver(opts(), deps, CMDS);
    expect(code).toBe(EXIT_OK);
    expect(calls.filter(isStepCall)).toEqual(STEP_CALLS);
    expect(writes).toEqual([BODY]);
  });

  test('updates the open PR instead of creating one, and keeps an existing body file', async () => {
    const { deps, calls, writes } = fakeDeps({ existingPr: '42\n', bodyExists: true });
    const code = await deliver(opts(), deps, CMDS);
    expect(code).toBe(EXIT_OK);
    expect(calls).toContain('gh pr edit');
    expect(calls).not.toContain('gh pr create');
    expect(calls).not.toContain('kookr pr-checklist scaffold');
    expect(writes).toEqual([]);
  });

  test.each([
    ['write-pr-gate-marker.sh', 'pr-gate-marker', 1],
    ['kookr pr-checklist verify', 'pr-body', 2],
    ['git push --set-upstream', 'push', 128],
    ['gh pr create', 'pr', 1],
  ])('a failing %s stops the run at step %s with its exit code', async (call, step, exitCode) => {
    const { deps, calls, logs } = fakeDeps({ codes: { [call]: exitCode } });
    const code = await deliver(opts(), deps, CMDS);
    expect(code).toBe(exitCode);
    expect(calls.at(-1)).toBe(call);
    expect(calls).not.toContain('kookr merge 42');
    expect(logs.at(-1)).toContain(`stopped at ${step}: step ${step} failed (exit ${exitCode})`);
  });

  test('a failing merge reports the merge step and its exit code', async () => {
    const { deps, logs } = fakeDeps({ codes: { 'kookr merge 42': 4 } });
    expect(await deliver(opts(), deps, CMDS)).toBe(4);
    expect(logs.at(-1)).toContain('stopped at merge: step merge failed (exit 4)');
  });

  test('without --specialists or --bypass-reason it stops at review-marker and runs nothing', async () => {
    const { deps, calls, logs } = fakeDeps();
    const code = await deliver(parseArgs(['--body-file', BODY]), deps, CMDS);
    expect(code).toBe(EXIT_NEEDS_DECISION);
    expect(calls).toEqual([]);
    expect(logs.at(-1)).toContain('stopped at review-marker');
  });

  test('--bypass-reason writes a bypass marker', async () => {
    const calls: string[][] = [];
    const { deps } = fakeDeps();
    const run = deps.run;
    deps.run = (cmd, args, o) => {
      calls.push([cmd, ...args]);
      return run(cmd, args, o);
    };
    await deliver(parseArgs(['--bypass-reason', 'typo only', '--to', 'review-marker']), deps, CMDS);
    expect(calls).toEqual([['bash', '/repo/scripts/write-review-state-marker.sh', '--status', 'bypass', '--reason', 'typo only']]);
  });

  test('a missing verdict stops before kookr merge once the wait times out', async () => {
    const { deps, calls, logs } = fakeDeps({ views: [prView([])] });
    const code = await deliver(opts('--wait-timeout', '30'), deps, CMDS);
    expect(code).toBe(EXIT_NO_VERDICT);
    expect(calls).not.toContain('kookr merge 42');
    // Polled at t=0,10,20,30 s, then gave up.
    expect(calls.filter((c) => c === 'gh pr view')).toHaveLength(4);
    expect(logs.at(-1)).toContain('stopped at wait-verdict: step wait-verdict: no independent-review verdict');
  });

  test('a PASS bound to an older head does not count; the run waits for the current head', async () => {
    const stale = prView([verdictComment('pass', OLD_HEAD, '2026-11-18T01:00:00Z')]);
    const fresh = prView([
      verdictComment('pass', OLD_HEAD, '2026-11-18T01:00:00Z'),
      verdictComment('pass', HEAD, '2026-11-18T02:00:00Z'),
    ]);
    const { deps, calls } = fakeDeps({ views: [stale, fresh] });
    expect(await deliver(opts('--from', 'wait-verdict', '--pr', '42'), deps, CMDS)).toBe(EXIT_OK);
    expect(calls).toEqual(['gh pr view', 'gh pr view', 'kookr merge 42']);
  });

  test('a BLOCK for the current head stops before kookr merge', async () => {
    const { deps, calls } = fakeDeps({ views: [prView([verdictComment('block', HEAD, '2026-11-18T01:00:00Z')])] });
    expect(await deliver(opts('--from', 'wait-verdict', '--pr', '42'), deps, CMDS)).toBe(EXIT_NEEDS_DECISION);
    expect(calls).toEqual(['gh pr view']);
  });

  test('--from/--to run only the selected steps', async () => {
    const { deps, calls } = fakeDeps({ bodyExists: true });
    expect(await deliver(opts('--from', 'pr-gate-marker', '--to', 'push'), deps, CMDS)).toBe(EXIT_OK);
    expect(calls.filter(isStepCall)).toEqual(['write-pr-gate-marker.sh', 'kookr pr-checklist verify', 'git push --set-upstream']);
  });
});

describe('verdictState', () => {
  test('an old BLOCK followed by no verdict on the new head means wait, not stop', () => {
    expect(verdictState(prView([verdictComment('block', OLD_HEAD, '2026-11-18T01:00:00Z')])).kind).toBe('wait');
  });

  test('a PASS after a BLOCK on the same head stays blocked (sticky block)', () => {
    const view = prView([
      verdictComment('block', HEAD, '2026-11-18T01:00:00Z'),
      verdictComment('pass', HEAD, '2026-11-18T02:00:00Z'),
    ]);
    expect(verdictState(view).kind).toBe('block');
  });
});

describe('parseArgs', () => {
  test.each([
    [['--from', 'nope']],
    [['--from', 'merge', '--to', 'push']],
    [['--specialists', 'x', '--bypass-reason', 'y']],
    [['--pr', 'abc']],
    [['--wait-timeout']],
    [['--bogus']],
  ])('rejects %j', (argv) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
  });

  test('accepts --flag=value and a leading --', () => {
    const o = parseArgs(['--', '--from=push', '--pr=12', '--dry-run']);
    expect(o).toMatchObject({ from: 'push', pr: '12', dryRun: true, base: 'main' });
  });
});
