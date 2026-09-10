import { describe, expect, test } from 'vitest';
import { GhUmbrellaChainClient } from './github-umbrella-chain-client.js';

/** One recorded subprocess invocation, as `[file, ...args]`. */
type Invocation = readonly string[];

/**
 * Build a `GhUmbrellaChainClient` over a scripted `execFile` stand-in.
 *
 * `handlers` are matched in order against the flattened `[file, ...args]`; the
 * first predicate that matches supplies the result (stdout) or throws (a
 * non-zero exit / spawn failure). Every invocation is recorded so tests can
 * assert exactly which `gh`/`git` command ran, and with which arguments.
 */
function makeClient(handlers: Array<{
  when: (call: Invocation) => boolean;
  stdout?: string;
  throws?: Error;
}>) {
  const calls: Invocation[] = [];
  // The real dependency is promisify(execFile); the client consumes only stdout.
  const exec = async (file: string, args?: readonly string[]) => {
    const call = [file, ...(args ?? [])];
    calls.push(call);
    const handler = handlers.find((candidate) => candidate.when(call));
    if (!handler) throw new Error(`unscripted invocation: ${call.join(' ')}`);
    if (handler.throws) throw handler.throws;
    return { stdout: handler.stdout ?? '', stderr: '' };
  };
  const client = new GhUmbrellaChainClient({ exec: exec as never });
  return { client, calls };
}

function has(call: Invocation, ...tokens: string[]): boolean {
  return tokens.every((token) => call.includes(token));
}

describe('GhUmbrellaChainClient.refreshBase', () => {
  test('fetches the base with --prune so stale local refs cannot satisfy a phase', async () => {
    const { client, calls } = makeClient([
      { when: (call) => has(call, 'git', 'fetch'), stdout: '' },
    ]);
    await client.refreshBase('/repo', 'main');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['git', '-C', '/repo', 'fetch', '--prune', 'origin', 'main']);
  });

  test('retries a ref-lock fetch failure then succeeds instead of surfacing a skip (#3111)', async () => {
    // A ref-update race (or stale `.lock`) makes `git fetch` emit `cannot lock
    // ref …` on stderr. The advancer turns any rejection here into a whole-
    // project skip, so a recoverable ref-lock error must be retried in-tick.
    const sleeps: number[] = [];
    let n = 0;
    const exec = async () => {
      n += 1;
      if (n === 1) {
        throw Object.assign(
          new Error("Command failed: git -C /repo fetch --prune origin main\nerror: cannot lock ref 'refs/remotes/origin/main'"),
          { code: 128, stderr: "error: cannot lock ref 'refs/remotes/origin/main': is at 0000000 but expected 1111111" },
        );
      }
      return { stdout: '', stderr: '' };
    };
    const client = new GhUmbrellaChainClient({
      exec: exec as never,
      retryOptions: { sleep: async (ms) => { sleeps.push(ms); } },
    });
    await client.refreshBase('/repo', 'main');
    expect(n).toBe(2); // first (ref-lock) + retried success
    expect(sleeps).toEqual([1_000]); // one bounded back-off, no real delay incurred
  });

  test('retries a stale-lock "File exists" fetch failure (#3111)', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const exec = async () => {
      n += 1;
      if (n === 1) {
        throw Object.assign(new Error('git fetch failed'), {
          code: 128,
          stderr: "fatal: Unable to create '/repo/.git/refs/remotes/origin/main.lock': File exists.",
        });
      }
      return { stdout: '', stderr: '' };
    };
    const client = new GhUmbrellaChainClient({
      exec: exec as never,
      retryOptions: { sleep: async (ms) => { sleeps.push(ms); } },
    });
    await client.refreshBase('/repo', 'main');
    expect(n).toBe(2);
    expect(sleeps).toEqual([1_000]);
  });

  test('bounds a persistent lock-contention fetch failure at the attempt cap, then rethrows so the project is skipped (#3111)', async () => {
    // A genuinely wedged lock must still be bounded by the same cap as any other
    // transient class — retried up to maxAttempts, then rethrown so the advancer
    // records a project-scan skip rather than looping forever.
    const sleeps: number[] = [];
    let n = 0;
    const exec = async () => {
      n += 1;
      throw Object.assign(
        new Error('Command failed: git ... fetch\nfatal: another git process seems to be running in this repository'),
        { code: 128, stderr: 'fatal: another git process seems to be running in this repository' },
      );
    };
    const client = new GhUmbrellaChainClient({
      exec: exec as never,
      retryOptions: { sleep: async (ms) => { sleeps.push(ms); } },
    });
    await expect(client.refreshBase('/repo', 'main')).rejects.toThrow(/another git process/);
    expect(n).toBe(3); // default maxAttempts — no unbounded loop
    expect(sleeps).toEqual([1_000, 3_000]);
  });

  test('does not retry a non-ref-lock, non-network fetch failure — it surfaces after one attempt (#3111)', async () => {
    // A genuine fetch error (e.g. an unknown revision) is not a recoverable
    // contention fault; it must reach the advancer as a project-scan-error skip
    // unchanged, without burning the retry budget.
    const sleeps: number[] = [];
    let n = 0;
    const exec = async () => {
      n += 1;
      throw Object.assign(
        new Error("Command failed: git ... fetch\nfatal: couldn't find remote ref nonexistent-branch"),
        { code: 128, stderr: "fatal: couldn't find remote ref nonexistent-branch" },
      );
    };
    const client = new GhUmbrellaChainClient({
      exec: exec as never,
      retryOptions: { sleep: async (ms) => { sleeps.push(ms); } },
    });
    await expect(client.refreshBase('/repo', 'main')).rejects.toThrow(/couldn't find remote ref/);
    expect(n).toBe(1); // no retry for a non-transient fetch error
    expect(sleeps).toEqual([]); // never slept
  });

  test('classifies on stderr, not the command line — a ref-lock phrase only in the message is not retried (#3111)', async () => {
    // promisify(execFile) rejects with message `Command failed: git -C <path>
    // fetch …` — the repoPath is embedded in the message. A benign failure whose
    // stderr carries no ref-lock text must NOT be retried even if the repoPath
    // happens to contain a trigger phrase; only git's own stderr decides.
    const sleeps: number[] = [];
    let n = 0;
    const exec = async () => {
      n += 1;
      throw Object.assign(
        new Error("Command failed: git -C /repo/cannot lock ref fetch --prune origin main\nfatal: not a git repository"),
        { code: 128, stderr: 'fatal: not a git repository' },
      );
    };
    const client = new GhUmbrellaChainClient({
      exec: exec as never,
      retryOptions: { sleep: async (ms) => { sleeps.push(ms); } },
    });
    await expect(client.refreshBase('/repo/cannot lock ref', 'main')).rejects.toThrow(/not a git repository/);
    expect(n).toBe(1); // the "cannot lock ref" in the message/path must not trigger a retry
    expect(sleeps).toEqual([]); // never slept
  });
});

describe('GhUmbrellaChainClient.updateIssueBody', () => {
  test('PATCHes the exact issue endpoint with the new body — the write the single-writer guard protects', async () => {
    const { client, calls } = makeClient([
      { when: (call) => has(call, 'gh', 'api'), stdout: '{}' },
    ]);
    await client.updateIssueBody('o/r', 10, '# New body');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      'gh', 'api', 'repos/o/r/issues/10', '-X', 'PATCH', '-f', 'body=# New body',
    ]);
  });
});

describe('GhUmbrellaChainClient.isPullRequestReachable', () => {
  test('evaluates only the recorded PR number and confirms its merge commit is an ancestor', async () => {
    const { client, calls } = makeClient([
      {
        when: (call) => has(call, 'gh', 'pr', 'view', '10'),
        stdout: JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'abc123' } }),
      },
      { when: (call) => has(call, 'git', 'merge-base', '--is-ancestor'), stdout: '' },
    ]);
    const reachable = await client.isPullRequestReachable('/repo', 'main', 10, 'o/r');
    expect(reachable).toBe(true);
    // The PR is queried by its exact recorded number, never by branch or file.
    expect(calls.some((call) => has(call, 'gh', 'pr', 'view', '10'))).toBe(true);
    expect(calls.some((call) => call.join(' ')
      === 'git -C /repo merge-base --is-ancestor abc123 origin/main')).toBe(true);
  });

  test('returns false for a stale local ref whose merge commit is not yet an ancestor of the fetched base', async () => {
    // `merge-base --is-ancestor` exits non-zero when the merge commit is absent
    // from origin/<base> — a stale local ref must not count as merged.
    const { client } = makeClient([
      {
        when: (call) => has(call, 'gh', 'pr', 'view', '10'),
        stdout: JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'abc123' } }),
      },
      {
        when: (call) => has(call, 'git', 'merge-base', '--is-ancestor'),
        throws: new Error('not an ancestor'),
      },
    ]);
    expect(await client.isPullRequestReachable('/repo', 'main', 10, 'o/r')).toBe(false);
  });

  test('rejects an unmerged PR by its recorded state alone, never consulting a branch or file', async () => {
    // This is why an unrelated PR that merely shares a branch or a file with the
    // phase cannot satisfy it: reachability queries only the recorded PR number
    // and its own merge state — it never inspects branch names or paths.
    const { client, calls } = makeClient([
      {
        when: (call) => has(call, 'gh', 'pr', 'view', '10'),
        stdout: JSON.stringify({ state: 'OPEN', mergeCommit: null }),
      },
    ]);
    expect(await client.isPullRequestReachable('/repo', 'main', 10, 'o/r')).toBe(false);
    // An unmerged PR is rejected before any ancestry check runs.
    expect(calls.some((call) => has(call, 'git', 'merge-base'))).toBe(false);
  });

  test('returns false when the PR is merged but carries no merge commit oid', async () => {
    const { client } = makeClient([
      {
        when: (call) => has(call, 'gh', 'pr', 'view', '10'),
        stdout: JSON.stringify({ state: 'MERGED', mergeCommit: {} }),
      },
    ]);
    expect(await client.isPullRequestReachable('/repo', 'main', 10, 'o/r')).toBe(false);
  });

  test('returns false when the gh query itself fails', async () => {
    const { client } = makeClient([
      { when: (call) => has(call, 'gh', 'pr', 'view', '10'), throws: new Error('gh exploded') },
    ]);
    expect(await client.isPullRequestReachable('/repo', 'main', 10, 'o/r')).toBe(false);
  });
});

describe('GhUmbrellaChainClient.getPullRequestMergedAt', () => {
  test('returns the merge timestamp for the recorded PR', async () => {
    const { client } = makeClient([
      {
        when: (call) => has(call, 'gh', 'pr', 'view', '10'),
        stdout: JSON.stringify({ mergedAt: '2026-08-22T00:00:00.000Z' }),
      },
    ]);
    expect(await client.getPullRequestMergedAt('o/r', 10)).toBe('2026-08-22T00:00:00.000Z');
  });

  test('returns null for a missing or invalid merge timestamp', async () => {
    const { client } = makeClient([
      { when: (call) => has(call, 'gh', 'pr', 'view', '10'), stdout: JSON.stringify({ mergedAt: null }) },
      { when: (call) => has(call, 'gh', 'pr', 'view', '11'), stdout: JSON.stringify({ mergedAt: '2026-02-30T00:00:00.000Z' }) },
    ]);
    expect(await client.getPullRequestMergedAt('o/r', 10)).toBeNull();
    expect(await client.getPullRequestMergedAt('o/r', 11)).toBeNull();
  });
});

describe('GhUmbrellaChainClient.getPullRequestHeadSha', () => {
  test('returns the lowercased last-commit oid', async () => {
    const { client } = makeClient([
      {
        when: (call) => has(call, 'gh', 'pr', 'view', '10'),
        stdout: JSON.stringify({ commits: [{ oid: 'AAA' }, { oid: 'BEEF01' }] }),
      },
    ]);
    expect(await client.getPullRequestHeadSha('o/r', 10)).toBe('beef01');
  });

  test('returns null when no commits are present', async () => {
    const { client } = makeClient([
      { when: (call) => has(call, 'gh', 'pr', 'view', '10'), stdout: JSON.stringify({ commits: [] }) },
    ]);
    expect(await client.getPullRequestHeadSha('o/r', 10)).toBeNull();
  });
});

describe('GhUmbrellaChainClient.listOpenIssues', () => {
  test('TS-CHAIN-002: discovers phase-ledger issues through the paginated REST endpoint', async () => {
    const { client, calls } = makeClient([
      {
        when: (call) => has(call, 'gh', 'api', '--paginate'),
        stdout: '3\n7\n',
      },
    ]);
    expect(await client.listOpenIssues('o/r')).toEqual([{ number: 3 }, { number: 7 }]);
    expect(calls[0]).toEqual([
      'gh',
      'api',
      '--paginate',
      'repos/o/r/issues?state=open&per_page=100',
      '--jq',
      '.[] | select((has("pull_request") | not) and (.body | type == "string") and (.body | contains("```kookr-phase-ledger"))) | .number',
    ]);
  });

  test('fails closed when the filtered REST output contains an invalid issue number', async () => {
    const { client } = makeClient([
      { when: (call) => has(call, 'gh', 'api', '--paginate'), stdout: '3\nnot-a-number\n' },
    ]);
    await expect(client.listOpenIssues('o/r')).rejects.toThrow(/invalid issue number/);
  });

  test('retries a transient HTTP 502 on the poll and succeeds without surfacing a skip', async () => {
    // The advancer treats any rejection from listOpenIssues as a whole-project
    // skip. A single transient 5xx must be retried so the scan still succeeds.
    const attempts: string[] = [];
    const sleeps: number[] = [];
    let n = 0;
    const exec = async (file: string, args?: readonly string[]) => {
      attempts.push([file, ...(args ?? [])].join(' '));
      n += 1;
      if (n === 1) throw Object.assign(new Error('gh: HTTP 502'), { stderr: 'HTTP 502' });
      return { stdout: '3\n7\n', stderr: '' };
    };
    const client = new GhUmbrellaChainClient({
      exec: exec as never,
      retryOptions: { sleep: async (ms) => { sleeps.push(ms); } },
    });
    expect(await client.listOpenIssues('o/r')).toEqual([{ number: 3 }, { number: 7 }]);
    expect(attempts).toHaveLength(2); // first (502) + retried success
    expect(sleeps).toEqual([1_000]); // one bounded back-off, no real delay incurred
  });

  test('retries a truncated paginated read (unexpected end of JSON input) then succeeds', async () => {
    // gh api --paginate --jq emits "unexpected end of JSON input" on stderr when
    // a page comes back truncated/empty. A re-read usually succeeds, so the poll
    // must retry instead of skipping the whole project for the tick (#3073).
    const sleeps: number[] = [];
    let n = 0;
    const exec = async () => {
      n += 1;
      if (n === 1) {
        throw Object.assign(new Error('gh api failed'), { stderr: 'unexpected end of JSON input' });
      }
      return { stdout: '5\n', stderr: '' };
    };
    const client = new GhUmbrellaChainClient({
      exec: exec as never,
      retryOptions: { sleep: async (ms) => { sleeps.push(ms); } },
    });
    expect(await client.listOpenIssues('o/r')).toEqual([{ number: 5 }]);
    expect(n).toBe(2); // first (truncated) + retried success
    expect(sleeps).toEqual([1_000]); // one bounded back-off
  });

  test('bounds a persistently truncated read at the cap, then surfaces it (#3073)', async () => {
    // A truncation that never clears must still be bounded by the same cap as
    // any other transient class — retried up to maxAttempts, then rethrown so
    // the advancer records a project-scan skip rather than looping forever.
    const sleeps: number[] = [];
    let n = 0;
    const exec = async () => {
      n += 1;
      // Shape promisify(execFile) raises: command line in .message, gh's own
      // output in .stderr (the field the classifier reads).
      throw Object.assign(new Error('Command failed: gh api ...\nunexpected end of JSON input'), {
        stderr: 'unexpected end of JSON input',
      });
    };
    const client = new GhUmbrellaChainClient({
      exec: exec as never,
      retryOptions: { sleep: async (ms) => { sleeps.push(ms); } },
    });
    await expect(client.listOpenIssues('o/r')).rejects.toThrow(/unexpected end of JSON input/);
    expect(n).toBe(3); // default maxAttempts — same cap as other transient classes
    expect(sleeps).toEqual([1_000, 3_000]);
  });

  test('does not retry a non-transient HTTP 404 — it throws after a single attempt', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const exec = async () => {
      n += 1;
      throw Object.assign(new Error('gh: HTTP 404'), { stderr: 'HTTP 404' });
    };
    const client = new GhUmbrellaChainClient({
      exec: exec as never,
      retryOptions: { sleep: async (ms) => { sleeps.push(ms); } },
    });
    await expect(client.listOpenIssues('o/r')).rejects.toThrow(/HTTP 404/);
    expect(n).toBe(1); // no retry for a non-transient error
    expect(sleeps).toEqual([]); // never slept
  });

  test('bounds retries at the attempt cap and rethrows a persistent transient error', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const exec = async () => {
      n += 1;
      throw Object.assign(new Error('gh: HTTP 503'), { stderr: 'HTTP 503' });
    };
    const client = new GhUmbrellaChainClient({
      exec: exec as never,
      retryOptions: { sleep: async (ms) => { sleeps.push(ms); } },
    });
    await expect(client.listOpenIssues('o/r')).rejects.toThrow(/HTTP 503/);
    expect(n).toBe(3); // default maxAttempts — no unbounded loop
    expect(sleeps).toEqual([1_000, 3_000]); // bounded back-off between attempts
  });

  test('retries a SIGTERM timeout-kill — the shape execFile raises when a hung gh call is killed', async () => {
    // Each read sets { timeout: 20_000 }; a hung call is SIGTERM-killed by
    // execFile with no "HTTP 5xx" text, so the killed/signal branch must retry.
    const sleeps: number[] = [];
    let n = 0;
    const exec = async () => {
      n += 1;
      if (n === 1) throw Object.assign(new Error('gh timed out'), { killed: true, signal: 'SIGTERM' });
      return { stdout: '5\n', stderr: '' };
    };
    const client = new GhUmbrellaChainClient({
      exec: exec as never,
      retryOptions: { sleep: async (ms) => { sleeps.push(ms); } },
    });
    expect(await client.listOpenIssues('o/r')).toEqual([{ number: 5 }]);
    expect(n).toBe(2);
    expect(sleeps).toEqual([1_000]);
  });

  test('classifies on gh stderr, not the command line — a 404 on a "network"-named repo is not retried', async () => {
    // promisify(execFile) rejects with message `Command failed: gh api
    // repos/<owner>/<repo>/...` — the slug is in the message. A genuine 404 on a
    // repo whose slug contains a transient trigger word ("network") must still
    // NOT be retried; only gh's own stderr ("HTTP 404") decides.
    const sleeps: number[] = [];
    let n = 0;
    const exec = async () => {
      n += 1;
      throw Object.assign(
        new Error('Command failed: gh api repos/acme/network-monitor/issues?state=open&per_page=100\ngh: HTTP 404'),
        { code: 1, stderr: 'gh: HTTP 404' },
      );
    };
    const client = new GhUmbrellaChainClient({
      exec: exec as never,
      retryOptions: { sleep: async (ms) => { sleeps.push(ms); } },
    });
    await expect(client.listOpenIssues('acme/network-monitor')).rejects.toThrow(/HTTP 404/);
    expect(n).toBe(1); // the "network" in the slug must not trigger a transient retry
    expect(sleeps).toEqual([]);
  });

  test('does not retry a rate limit (HTTP 429) — a throttle must not be hammered', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const exec = async () => {
      n += 1;
      throw Object.assign(new Error('gh: HTTP 429'), { stderr: 'API rate limit exceeded (HTTP 429)' });
    };
    const client = new GhUmbrellaChainClient({
      exec: exec as never,
      retryOptions: { sleep: async (ms) => { sleeps.push(ms); } },
    });
    await expect(client.listOpenIssues('o/r')).rejects.toThrow(/429/);
    expect(n).toBe(1); // 429 is not a 5xx — excluded from the transient set
    expect(sleeps).toEqual([]);
  });
});

describe('GhUmbrellaChainClient.getIssue retry', () => {
  test('retries a transient HTTP 502 on the issue-view read then succeeds', async () => {
    // getIssue is the scan path's other transient-prone read; a bad merge that
    // dropped its retry wrapper would otherwise stay green — this guards it.
    const sleeps: number[] = [];
    let issueViewCalls = 0;
    const exec = async (file: string, args?: readonly string[]) => {
      const call = [file, ...(args ?? [])];
      if (call.includes('repos/o/r/issues/10') && !call.includes('--paginate')) {
        issueViewCalls += 1;
        if (issueViewCalls === 1) throw Object.assign(new Error('gh: HTTP 502'), { stderr: 'HTTP 502' });
        return { stdout: JSON.stringify({ body: '# Umbrella' }), stderr: '' };
      }
      if (call.includes('--paginate') && call.includes('repos/o/r/issues/10/comments?per_page=100')) {
        return { stdout: '', stderr: '' };
      }
      throw new Error(`unscripted invocation: ${call.join(' ')}`);
    };
    const client = new GhUmbrellaChainClient({
      exec: exec as never,
      retryOptions: { sleep: async (ms) => { sleeps.push(ms); } },
    });
    expect(await client.getIssue('o/r', 10)).toEqual({ number: 10, body: '# Umbrella', comments: [] });
    expect(issueViewCalls).toBe(2); // first 502 + retried success
    expect(sleeps).toEqual([1_000]);
  });
});

describe('GhUmbrellaChainClient.getIssue', () => {
  test('reads the issue and paginated comments through REST without losing embedded newlines', async () => {
    const { client, calls } = makeClient([
      {
        when: (call) => has(call, 'gh', 'api', 'repos/o/r/issues/10'),
        stdout: JSON.stringify({ body: '# Umbrella' }),
      },
      {
        when: (call) => has(call, 'gh', 'api', '--paginate', 'repos/o/r/issues/10/comments?per_page=100'),
        stdout: `${JSON.stringify('a')}\n${JSON.stringify('line 1\nline 2')}\n`,
      },
    ]);
    expect(await client.getIssue('o/r', 10)).toEqual({
      number: 10,
      body: '# Umbrella',
      comments: [{ body: 'a' }, { body: 'line 1\nline 2' }],
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('--paginate');
  });

  test('returns null when the body is missing and surfaces REST failures to the project boundary', async () => {
    const missing = makeClient([
      { when: (call) => has(call, 'gh', 'api', 'repos/o/r/issues/10'), stdout: JSON.stringify({}) },
    ]);
    expect(await missing.client.getIssue('o/r', 10)).toBeNull();

    const failing = makeClient([
      { when: (call) => has(call, 'gh', 'api', 'repos/o/r/issues/10'), throws: new Error('boom') },
    ]);
    await expect(failing.client.getIssue('o/r', 10)).rejects.toThrow('boom');
  });
});
