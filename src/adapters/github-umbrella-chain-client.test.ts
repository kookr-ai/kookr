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
