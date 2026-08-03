import { describe, it, expect, vi } from 'vitest';
// The CLI ships as a plain ESM .js file in bin/ (same pattern as bin/kookr.js)
// so it runs without a build step. Types come from bin/kookr-issue.d.ts.
import {
  parseArgs,
  resolveTaskId,
  resolveSessionId,
  parseIssueNumber,
  formatOwnerBlock,
  formatClaimLine,
  humanizeMs,
  UsageError,
  EXIT_CLAIM_HELD,
  main,
} from '../../bin/kookr-issue.js';

const EXIT_OK = 0;
const EXIT_USER_ERROR = 2;
const EXIT_NO_SERVER = 3;
const EXIT_SERVER_ERROR = 4;

function mkIO() {
  const logs: string[] = [];
  const errs: string[] = [];
  return {
    out: { log: (m?: unknown) => logs.push(String(m)) },
    err: { error: (m?: unknown) => errs.push(String(m)) },
    logs,
    errs,
  };
}

function mkExit() {
  const calls: number[] = [];
  const exit = (code: number) => {
    calls.push(code);
  };
  exit.calls = calls;
  return exit;
}

function mkSleep() {
  const calls: number[] = [];
  const sleep = async (ms: number) => {
    calls.push(ms);
  };
  sleep.calls = calls;
  return sleep;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status });
}

describe('kookr issue parseArgs', () => {
  it('parses claim with number, --repo, --force, --json', () => {
    expect(parseArgs(['claim', '779', '--repo', 'o/r', '--force', '--json'])).toEqual({
      verb: 'claim',
      number: '779',
      repo: 'o/r',
      force: true,
      taskId: null,
      json: true,
      help: false,
    });
  });

  it('parses release with number and --repo=', () => {
    expect(parseArgs(['release', '42', '--repo=o/r'])).toEqual({
      verb: 'release',
      number: '42',
      repo: 'o/r',
      force: false,
      taskId: null,
      json: false,
      help: false,
    });
  });

  it('parses owner with number', () => {
    expect(parseArgs(['owner', '42'])).toEqual({
      verb: 'owner',
      number: '42',
      repo: null,
      force: false,
      taskId: null,
      json: false,
      help: false,
    });
  });

  it('parses list without a number', () => {
    expect(parseArgs(['list', '--json'])).toEqual({
      verb: 'list',
      number: null,
      repo: null,
      force: false,
      taskId: null,
      json: true,
      help: false,
    });
  });

  it('supports --task-id and --task-id=', () => {
    expect(parseArgs(['claim', '1', '--task-id', 't-1']).taskId).toBe('t-1');
    expect(parseArgs(['claim', '1', '--task-id=t-2']).taskId).toBe('t-2');
  });

  it('parses -h/--help without requiring a verb', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('throws UsageError on unknown option', () => {
    expect(() => parseArgs(['claim', '1', '--bogus'])).toThrow(UsageError);
  });

  it('throws UsageError when an option is missing its value', () => {
    expect(() => parseArgs(['claim', '1', '--repo'])).toThrow(UsageError);
    expect(() => parseArgs(['claim', '1', '--task-id'])).toThrow(UsageError);
  });

  it('throws UsageError on an unexpected extra positional', () => {
    expect(() => parseArgs(['claim', '1', '2'])).toThrow(UsageError);
  });
});

describe('kookr issue resolveTaskId / resolveSessionId / parseIssueNumber', () => {
  it('prefers --task-id over env', () => {
    expect(resolveTaskId({ args: { taskId: 't-flag' }, env: { KOOKR_TASK_ID: 't-env' } })).toBe('t-flag');
  });
  it('falls back to KOOKR_TASK_ID', () => {
    expect(resolveTaskId({ args: { taskId: null }, env: { KOOKR_TASK_ID: 't-env' } })).toBe('t-env');
  });
  it('returns null when neither is set', () => {
    expect(resolveTaskId({ args: { taskId: null }, env: {} })).toBeNull();
  });
  it('reads sessionId from KOOKR_AGENT_ID, trimmed', () => {
    expect(resolveSessionId({ KOOKR_AGENT_ID: ' kookr-abc ' })).toBe('kookr-abc');
    expect(resolveSessionId({})).toBeNull();
    expect(resolveSessionId({ KOOKR_AGENT_ID: '  ' })).toBeNull();
  });
  it('parses positive integers only', () => {
    expect(parseIssueNumber('779')).toBe(779);
    expect(parseIssueNumber('0')).toBeNull();
    expect(parseIssueNumber('-1')).toBeNull();
    expect(parseIssueNumber('abc')).toBeNull();
    expect(parseIssueNumber(null)).toBeNull();
  });
});

describe('kookr issue rendering helpers', () => {
  it('humanizes milliseconds', () => {
    expect(humanizeMs(40_000)).toBe('40s');
    expect(humanizeMs(90_000)).toBe('2m');
    expect(humanizeMs(3 * 3600_000)).toBe('3h');
    expect(humanizeMs(3 * 24 * 3600_000)).toBe('3d');
  });

  it('formats the R15 owner block with task id, worktree, doing, age, and Action line', () => {
    const block = formatOwnerBlock({
      repo: 'github.com/owner/repo',
      number: 779,
      owner: {
        taskId: 'ef486174',
        sessionId: 'kookr-05c5f8ea',
        ownerStatus: 'inProgress',
        worktreePath: '../repo-issue-779-enter-fix',
        doing: 'running control-room test suite',
        ageMs: 40_000,
      },
    });
    expect(block).toMatch(/github\.com\/owner\/repo#779/);
    expect(block).toMatch(/task ef486174 \(kookr-05c5f8ea\) · status inProgress/);
    expect(block).toMatch(/Worktree \.\.\/repo-issue-779-enter-fix/);
    expect(block).toMatch(/"running control-room test suite" \(last activity 40s ago\)/);
    expect(block).toMatch(/pick a different issue\. Operator override: kookr issue claim 779 --force/);
  });

  it('formats a list table line', () => {
    const line = formatClaimLine({
      repo: 'github.com/o/r',
      number: 5,
      taskId: 'abcdefgh1234',
      ownerStatus: 'inProgress',
      ageMs: 90_000,
      doing: 'writing tests',
    });
    expect(line).toBe('github.com/o/r#5  task abcdefgh  inProgress  2m ago  writing tests');
  });
});

describe('kookr issue main — user errors', () => {
  it('exits 2 when no verb is given', async () => {
    const { out, err } = mkIO();
    const exit = mkExit();
    await main({ argv: [], env: {}, out, err, exit });
    expect(exit.calls).toEqual([EXIT_USER_ERROR]);
  });

  it('exits 2 on an unknown verb', async () => {
    const { out, err } = mkIO();
    const exit = mkExit();
    await main({ argv: ['bogus', '1'], env: {}, out, err, exit });
    expect(exit.calls).toEqual([EXIT_USER_ERROR]);
  });

  it('exits 2 when claim is missing an issue number', async () => {
    const { out, err } = mkIO();
    const exit = mkExit();
    await main({ argv: ['claim'], env: { KOOKR_TASK_ID: 't-1' }, out, err, exit });
    expect(exit.calls).toEqual([EXIT_USER_ERROR]);
  });

  it('exits 2 when claim has no task id', async () => {
    const { out, err, errs } = mkIO();
    const exit = mkExit();
    await main({ argv: ['claim', '779'], env: {}, out, err, exit });
    expect(exit.calls).toEqual([EXIT_USER_ERROR]);
    expect(errs.join('\n')).toMatch(/no task id/);
  });

  it('prints help and exits 0', async () => {
    const { out, err, logs } = mkIO();
    const exit = mkExit();
    await main({ argv: ['--help'], env: {}, out, err, exit });
    expect(exit.calls).toEqual([EXIT_OK]);
    expect(logs.join('\n')).toMatch(/kookr issue/);
  });
});

describe('kookr issue main — claim outcomes', () => {
  it('exits 0 and prints a confirmation on 200', async () => {
    const { out, err, logs } = mkIO();
    const exit = mkExit();
    const fetchMock = vi.fn(async (url: unknown) => {
      expect(String(url)).toMatch(/\/api\/issue-claims$/);
      return jsonResponse({ owned: true, repo: 'github.com/o/r', reentrant: false }, 200);
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await main({
        argv: ['claim', '779'],
        env: { KOOKR_TASK_ID: 't-1', KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
        out,
        err,
        exit,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(exit.calls).toEqual([EXIT_OK]);
    expect(logs.join('\n')).toMatch(/✓ Claimed github\.com\/o\/r#779 for task t-1/);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ cwd: process.cwd(), number: 779, taskId: 't-1' });
  });

  it('includes --repo and sessionId (KOOKR_AGENT_ID) in the POST body', async () => {
    const { out, err } = mkIO();
    const exit = mkExit();
    const fetchMock = vi.fn(async () => jsonResponse({ owned: true }, 200));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await main({
        argv: ['claim', '779', '--repo', 'o/r', '--force'],
        env: { KOOKR_TASK_ID: 't-1', KOOKR_AGENT_ID: 'kookr-abc', KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
        out,
        err,
        exit,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      cwd: process.cwd(),
      number: 779,
      taskId: 't-1',
      repo: 'o/r',
      sessionId: 'kookr-abc',
      force: true,
    });
  });

  it('exits 6 on 409 with the owner block containing the owner task id', async () => {
    const { out, err, errs } = mkIO();
    const exit = mkExit();
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          owned: false,
          owner: { taskId: 'ef486174', sessionId: 'kookr-05c5f8ea', ownerStatus: 'inProgress', ageMs: 40_000 },
        },
        409,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await main({
        argv: ['claim', '779'],
        env: { KOOKR_TASK_ID: 't-2', KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
        out,
        err,
        exit,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(exit.calls).toEqual([EXIT_CLAIM_HELD]);
    expect(EXIT_CLAIM_HELD).toBe(6);
    expect(errs.join('\n')).toMatch(/ef486174/);
    expect(errs.join('\n')).toMatch(/kookr issue claim 779 --force/);
  });

  it('exits 2 on 400 with the server error and candidates', async () => {
    const { out, err, errs } = mkIO();
    const exit = mkExit();
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'ambiguous repo', candidates: ['a/b', 'c/d'] }, 400));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await main({
        argv: ['claim', '779'],
        env: { KOOKR_TASK_ID: 't-1', KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
        out,
        err,
        exit,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(exit.calls).toEqual([EXIT_USER_ERROR]);
    expect(errs.join('\n')).toMatch(/ambiguous repo/);
    expect(errs.join('\n')).toMatch(/a\/b, c\/d/);
  });

  it('exits 0-with-unsupported on 404 (R26 pre-lock)', async () => {
    const { out, err, errs } = mkIO();
    const exit = mkExit();
    const fetchMock = vi.fn(async () => jsonResponse(undefined, 404));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await main({
        argv: ['claim', '779'],
        env: { KOOKR_TASK_ID: 't-1', KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
        out,
        err,
        exit,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(exit.calls).toEqual([EXIT_OK]);
    expect(errs.join('\n')).toMatch(/server does not support issue claims/);
  });

  it('emits {owned:null,unsupported:true} on 404 with --json', async () => {
    const { out, err, logs } = mkIO();
    const exit = mkExit();
    const fetchMock = vi.fn(async () => jsonResponse(undefined, 404));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await main({
        argv: ['claim', '779', '--json'],
        env: { KOOKR_TASK_ID: 't-1', KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
        out,
        err,
        exit,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(exit.calls).toEqual([EXIT_OK]);
    const envelope = JSON.parse(logs[0]);
    expect(envelope.ok).toBe(true);
    expect(envelope.details).toEqual({ owned: null, unsupported: true });
  });

  it('emits a --json envelope with owner.taskId on 409', async () => {
    const { out, err, logs } = mkIO();
    const exit = mkExit();
    const fetchMock = vi.fn(async () => jsonResponse({ owned: false, owner: { taskId: 'ef486174' } }, 409));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await main({
        argv: ['claim', '779', '--json'],
        env: { KOOKR_TASK_ID: 't-1', KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
        out,
        err,
        exit,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(exit.calls).toEqual([EXIT_CLAIM_HELD]);
    const envelope = JSON.parse(logs[0]);
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe('CLAIM_HELD');
    expect(envelope.details.owner.taskId).toBe('ef486174');
  });
});

describe('kookr issue main — release outcomes', () => {
  it('exits 0 on 200', async () => {
    const { out, err, logs } = mkIO();
    const exit = mkExit();
    const fetchMock = vi.fn(async () => jsonResponse({ repo: 'o/r' }, 200));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await main({
        argv: ['release', '779'],
        env: { KOOKR_TASK_ID: 't-1', KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
        out,
        err,
        exit,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(exit.calls).toEqual([EXIT_OK]);
    expect(logs.join('\n')).toMatch(/✓ Released o\/r#779 for task t-1/);
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('exits 4 on 403 ("not the owner")', async () => {
    const { out, err, errs } = mkIO();
    const exit = mkExit();
    const fetchMock = vi.fn(async () => jsonResponse({}, 403));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await main({
        argv: ['release', '779'],
        env: { KOOKR_TASK_ID: 't-1', KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
        out,
        err,
        exit,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(exit.calls).toEqual([EXIT_SERVER_ERROR]);
    expect(errs.join('\n')).toMatch(/not the owner/);
  });

  it('exits 0-with-unsupported on 404 (R26 pre-lock)', async () => {
    const { out, err, errs } = mkIO();
    const exit = mkExit();
    const fetchMock = vi.fn(async () => jsonResponse(undefined, 404));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await main({
        argv: ['release', '779'],
        env: { KOOKR_TASK_ID: 't-1', KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
        out,
        err,
        exit,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(exit.calls).toEqual([EXIT_OK]);
    expect(errs.join('\n')).toMatch(/server does not support issue claims/);
  });

  it('exits 2 when release has no task id', async () => {
    const { out, err, errs } = mkIO();
    const exit = mkExit();
    await main({ argv: ['release', '779'], env: {}, out, err, exit });
    expect(exit.calls).toEqual([EXIT_USER_ERROR]);
    expect(errs.join('\n')).toMatch(/no task id/);
  });
});

describe('kookr issue main — owner / list outcomes', () => {
  it('owner: exits 0 and prints "no active claim" when empty', async () => {
    const { out, err, logs } = mkIO();
    const exit = mkExit();
    const fetchMock = vi.fn(async () => jsonResponse([], 200));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await main({
        argv: ['owner', '779'],
        env: { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
        out,
        err,
        exit,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(exit.calls).toEqual([EXIT_OK]);
    expect(logs.join('\n')).toMatch(/no active claim/);
  });

  it('owner: passes number and repo as query params when --repo given', async () => {
    const { out, err } = mkIO();
    const exit = mkExit();
    const fetchMock = vi.fn(async () => jsonResponse([], 200));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await main({
        argv: ['owner', '779', '--repo', 'o/r'],
        env: { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
        out,
        err,
        exit,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:4800/api/issue-claims?number=779&repo=o%2Fr');
  });

  it('list: prints a table line per active claim', async () => {
    const { out, err, logs } = mkIO();
    const exit = mkExit();
    const fetchMock = vi.fn(async () =>
      jsonResponse([{ repo: 'o/r', number: 5, taskId: 'abcdefgh1234', ownerStatus: 'inProgress', ageMs: 90_000 }], 200),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await main({ argv: ['list'], env: { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' }, out, err, exit });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(exit.calls).toEqual([EXIT_OK]);
    expect(logs[0]).toBe('o/r#5  task abcdefgh  inProgress  2m ago');
  });

  it('list: emits a --json envelope with claims', async () => {
    const { out, err, logs } = mkIO();
    const exit = mkExit();
    const fetchMock = vi.fn(async () => jsonResponse([{ repo: 'o/r', number: 5 }], 200));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await main({ argv: ['list', '--json'], env: { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' }, out, err, exit });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(exit.calls).toEqual([EXIT_OK]);
    const envelope = JSON.parse(logs[0]);
    expect(envelope.details.claims.length).toBe(1);
  });
});

describe('kookr issue main — R25 unreachable-server handling', () => {
  it('claim retries 3 times with 1s/3s/9s backoff, then exits 3', async () => {
    const { out, err, errs } = mkIO();
    const exit = mkExit();
    const sleep = mkSleep();
    const fetchMock = vi.fn(async () => jsonResponse({ status: 'down' }, 503));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await main({
        argv: ['claim', '779'],
        env: { KOOKR_TASK_ID: 't-1', KOOKR_SPAWN_CONNECT_RETRIES: '1' },
        out,
        err,
        exit,
        sleep,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(exit.calls).toEqual([EXIT_NO_SERVER]);
    expect(sleep.calls).toEqual([1000, 3000, 9000]);
    expect(errs.join('\n')).toMatch(/no Kookr server reachable after 4 attempts/);
    expect(errs.join('\n')).toMatch(/do NOT start work on this issue/);
    // 4 attempts (initial + 3 retries) * (2 health + 2 deploy/status) per resolveBaseUrl call (#1975).
    expect(fetchMock.mock.calls.length).toBe(16);
  });

  it('release retries 3 times with 1s/3s/9s backoff, then exits 3', async () => {
    const { out, err, errs } = mkIO();
    const exit = mkExit();
    const sleep = mkSleep();
    const fetchMock = vi.fn(async () => jsonResponse({ status: 'down' }, 503));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await main({
        argv: ['release', '779'],
        env: { KOOKR_TASK_ID: 't-1', KOOKR_SPAWN_CONNECT_RETRIES: '1' },
        out,
        err,
        exit,
        sleep,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(exit.calls).toEqual([EXIT_NO_SERVER]);
    expect(sleep.calls).toEqual([1000, 3000, 9000]);
  });

  it('owner exits 3 after a single try, no retry backoff', async () => {
    const { out, err, errs } = mkIO();
    const exit = mkExit();
    const sleep = mkSleep();
    const fetchMock = vi.fn(async () => jsonResponse({ status: 'down' }, 503));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await main({
        argv: ['owner', '779'],
        env: { KOOKR_SPAWN_CONNECT_RETRIES: '1' },
        out,
        err,
        exit,
        sleep,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(exit.calls).toEqual([EXIT_NO_SERVER]);
    expect(sleep.calls).toEqual([]);
    // one resolveBaseUrl attempt: 2 health + 2 deploy/status probes (#1975)
    expect(fetchMock.mock.calls.length).toBe(4);
    expect(errs.join('\n')).not.toMatch(/after 4 attempts/);
  });

  it('list exits 3 after a single try, no retry backoff', async () => {
    const { out, err, errs } = mkIO();
    const exit = mkExit();
    const sleep = mkSleep();
    const fetchMock = vi.fn(async () => jsonResponse({ status: 'down' }, 503));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await main({
        argv: ['list'],
        env: { KOOKR_SPAWN_CONNECT_RETRIES: '1' },
        out,
        err,
        exit,
        sleep,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(exit.calls).toEqual([EXIT_NO_SERVER]);
    expect(sleep.calls).toEqual([]);
  });
});
