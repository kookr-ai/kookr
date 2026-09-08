import { describe, it, expect, vi, afterEach } from 'vitest';
// The CLI ships as a plain ESM .js file in bin/ (same pattern as bin/kookr.js /
// bin/kookr-drain.js) so it runs without a build step. Types come from
// bin/kookr-migrate.d.ts.
import {
  main,
  parseArgs,
  EXIT_OK,
  EXIT_USER_ERROR,
  EXIT_NO_SERVER,
  EXIT_SERVER_ERROR,
  EXIT_ALL_BLOCKED,
} from '../../bin/kookr-migrate.js';

// An explicit KOOKR_PORT short-circuits port auto-detection so resolvePort never
// touches the network (see bin/kookr-status.js resolvePort).
const ENV = { KOOKR_PORT: '4800' } as Record<string, string | undefined>;

function mkIo() {
  const logs: string[] = [];
  const errors: string[] = [];
  const codes: number[] = [];
  return {
    out: { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) },
    err: { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) },
    exit: (code: number) => {
      codes.push(code);
      return code;
    },
    logs,
    errors,
    codes,
  };
}

/** Minimal fetch Response stand-in matching readJsonBody()'s use of res.text(). */
function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

// A stdin that explodes if anything ever reads it — proves the --json paths
// never open the interactive confirmation prompt.
const EXPLODING_STDIN = {
  isTTY: true,
  [Symbol.asyncIterator]() {
    throw new Error('stdin must not be read under --json');
  },
} as unknown as NodeJS.ReadStream;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('kookr migrate --json', () => {
  it('--dry-run --json → GET migratable, one { ok:true, mode:"plan" } envelope, exit 0', async () => {
    const candidates = [
      { taskId: 't1', name: 'fix bug', fromAgent: 'claude-code', cwd: '/repo', status: 'running', eligible: true, worktreeShared: false },
      { taskId: 't2', eligible: false, reason: 'worktree shared', worktreeShared: true },
    ];
    const fetchImpl = vi.fn(async () => jsonResponse(200, { targetAgent: 'codex-cli', candidates }));
    vi.stubGlobal('fetch', fetchImpl);

    const io = mkIo();
    await main({ argv: ['--to', 'codex-cli', '--all', '--dry-run', '--json'], env: ENV, stdin: EXPLODING_STDIN, out: io.out, err: io.err, exit: io.exit });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/api/tasks/migratable');
    expect((init as { method?: string } | undefined)?.method).toBeUndefined(); // GET
    expect(io.codes).toEqual([EXIT_OK]);
    expect(io.errors).toHaveLength(0);
    expect(io.logs).toHaveLength(1); // exactly one JSON line, no human text
    expect(JSON.parse(io.logs[0])).toEqual({ ok: true, mode: 'plan', targetAgent: 'codex-cli', candidates, notFound: [] });
  });

  it('--dry-run --json with no eligible candidates → ok:true but exit EXIT_ALL_BLOCKED', async () => {
    const candidates = [{ taskId: 't2', eligible: false, reason: 'worktree shared', worktreeShared: true }];
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { targetAgent: 'codex-cli', candidates })));

    const io = mkIo();
    await main({ argv: ['--to', 'codex-cli', '--all', '--dry-run', '--json'], env: ENV, out: io.out, err: io.err, exit: io.exit });

    expect(io.codes).toEqual([EXIT_ALL_BLOCKED]);
    expect(JSON.parse(io.logs[0])).toEqual({ ok: true, mode: 'plan', targetAgent: 'codex-cli', candidates, notFound: [] });
  });

  it('--dry-run --json ids scope → surfaces requested ids the server did not return in notFound', async () => {
    // Only t1 comes back; t3 was named on the CLI but the server has no candidate for it.
    const candidates = [
      { taskId: 't1', name: 'fix', fromAgent: 'claude-code', cwd: '/repo', eligible: true, worktreeShared: false },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { targetAgent: 'codex-cli', candidates })));

    const io = mkIo();
    await main({ argv: ['--to', 'codex-cli', 't1', 't3', '--dry-run', '--json'], env: ENV, out: io.out, err: io.err, exit: io.exit });

    expect(io.codes).toEqual([EXIT_OK]);
    expect(JSON.parse(io.logs[0])).toEqual({ ok: true, mode: 'plan', targetAgent: 'codex-cli', candidates, notFound: ['t3'] });
  });

  it('--yes --json real run with zero eligible → ok:true, empty results, exit EXIT_ALL_BLOCKED (no POST)', async () => {
    const candidates = [{ taskId: 't2', eligible: false, reason: 'worktree shared', worktreeShared: true }];
    const fetchImpl = vi.fn(async () => jsonResponse(200, { targetAgent: 'codex-cli', candidates }));
    vi.stubGlobal('fetch', fetchImpl);

    const io = mkIo();
    await main({ argv: ['--to', 'codex-cli', '--all', '--yes', '--json'], env: ENV, stdin: EXPLODING_STDIN, out: io.out, err: io.err, exit: io.exit });

    // Never POSTs — the GET showed nothing eligible.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(io.codes).toEqual([EXIT_ALL_BLOCKED]);
    expect(io.logs).toHaveLength(1);
    expect(JSON.parse(io.logs[0])).toEqual({ ok: true, mode: 'migrate', targetAgent: 'codex-cli', defaultUpdated: false, results: [] });
  });

  it('--yes --json real run where every result is blocked → ok:true but exit EXIT_ALL_BLOCKED', async () => {
    const candidates = [
      { taskId: 't1', name: 'fix', fromAgent: 'claude-code', cwd: '/repo', eligible: true, worktreeShared: false },
    ];
    const results = [{ taskId: 't1', outcome: 'blocked', reason: 'worktree busy' }];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { targetAgent: 'codex-cli', candidates }))
      .mockResolvedValueOnce(jsonResponse(200, { targetAgent: 'codex-cli', defaultUpdated: false, results }));
    vi.stubGlobal('fetch', fetchImpl);

    const io = mkIo();
    await main({ argv: ['--to', 'codex-cli', '--all', '--yes', '--json'], env: ENV, out: io.out, err: io.err, exit: io.exit });

    // ok:true (the migrate ran) yet exit is ALL_BLOCKED because nothing succeeded.
    expect(io.codes).toEqual([EXIT_ALL_BLOCKED]);
    expect(JSON.parse(io.logs[0])).toEqual({ ok: true, mode: 'migrate', targetAgent: 'codex-cli', defaultUpdated: false, results });
  });

  it('--yes --json → GET then POST, one { ok:true, mode:"migrate" } envelope, no prompt, exit 0', async () => {
    const candidates = [
      { taskId: 't1', name: 'fix bug', fromAgent: 'claude-code', cwd: '/repo', status: 'running', eligible: true, worktreeShared: false },
    ];
    const results = [{ taskId: 't1', outcome: 'migrated', newTaskId: 'n1' }];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { targetAgent: 'codex-cli', candidates }))
      .mockResolvedValueOnce(jsonResponse(200, { targetAgent: 'codex-cli', defaultUpdated: true, results }));
    vi.stubGlobal('fetch', fetchImpl);

    const io = mkIo();
    await main({ argv: ['--to', 'codex-cli', '--all', '--yes', '--json'], env: ENV, stdin: EXPLODING_STDIN, out: io.out, err: io.err, exit: io.exit });

    // Second call is the migrate POST.
    const [, postInit] = fetchImpl.mock.calls[1];
    expect((postInit as { method?: string }).method).toBe('POST');
    expect(io.codes).toEqual([EXIT_OK]);
    expect(io.logs).toHaveLength(1);
    expect(JSON.parse(io.logs[0])).toEqual({
      ok: true,
      mode: 'migrate',
      targetAgent: 'codex-cli',
      defaultUpdated: true,
      results,
    });
  });

  it('server error under --json → { ok:false, code:"SERVER_ERROR" } on stdout, exit non-zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, { error: 'boom' })));

    const io = mkIo();
    await main({ argv: ['--to', 'codex-cli', '--all', '--dry-run', '--json'], env: ENV, out: io.out, err: io.err, exit: io.exit });

    expect(io.codes).toEqual([EXIT_SERVER_ERROR]);
    // Error surfaces as a single JSON line on stdout (not stderr) so scripts branch on `ok`.
    expect(io.errors).toHaveLength(0);
    expect(io.logs).toHaveLength(1);
    const parsed = JSON.parse(io.logs[0]);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('SERVER_ERROR');
  });

  it('POST failure after a successful GET under --json → { ok:false, code:"SERVER_ERROR" }, exit non-zero', async () => {
    const candidates = [
      { taskId: 't1', name: 'fix', fromAgent: 'claude-code', cwd: '/repo', eligible: true, worktreeShared: false },
    ];
    // GET migratable succeeds; the migrate POST then fails — a distinct branch
    // from a failed GET (message "migrate request failed: …").
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { targetAgent: 'codex-cli', candidates }))
      .mockResolvedValueOnce(jsonResponse(500, { error: 'boom' }));
    vi.stubGlobal('fetch', fetchImpl);

    const io = mkIo();
    await main({ argv: ['--to', 'codex-cli', '--all', '--yes', '--json'], env: ENV, out: io.out, err: io.err, exit: io.exit });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(io.codes).toEqual([EXIT_SERVER_ERROR]);
    expect(io.errors).toHaveLength(0);
    expect(io.logs).toHaveLength(1);
    const parsed = JSON.parse(io.logs[0]);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('SERVER_ERROR');
    expect(parsed.message).toContain('migrate request failed');
  });

  it('no server reachable under --json → { ok:false, code:"NO_SERVER" }, exit EXIT_NO_SERVER', async () => {
    // No KOOKR_PORT → resolvePort probes the default ports; make every probe fail.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));

    const io = mkIo();
    await main({ argv: ['--to', 'codex-cli', '--all', '--dry-run', '--json'], env: {}, out: io.out, err: io.err, exit: io.exit });

    expect(io.codes).toEqual([EXIT_NO_SERVER]);
    expect(io.errors).toHaveLength(0);
    expect(io.logs).toHaveLength(1);
    const parsed = JSON.parse(io.logs[0]);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('NO_SERVER');
    expect(parsed.message).toContain('not running');
  });

  it('parse error under --json → { ok:false, code:"USER_ERROR" } envelope, exit EXIT_USER_ERROR', async () => {
    const io = mkIo();
    // Missing --to; fetch is never reached, so no stub needed.
    await main({ argv: ['--all', '--json'], env: ENV, out: io.out, err: io.err, exit: io.exit });

    expect(io.codes).toEqual([EXIT_USER_ERROR]);
    expect(io.errors).toHaveLength(0);
    expect(io.logs).toHaveLength(1);
    const parsed = JSON.parse(io.logs[0]);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('USER_ERROR');
    expect(parsed.message).toContain('--to is required');
  });

  it('human dry-run output is unchanged when --json is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {
      targetAgent: 'codex-cli',
      candidates: [{ taskId: 't1', name: 'fix', fromAgent: 'claude-code', cwd: '/repo', eligible: true, worktreeShared: false }],
    })));

    const io = mkIo();
    await main({ argv: ['--to', 'codex-cli', '--all', '--dry-run'], env: ENV, out: io.out, err: io.err, exit: io.exit });

    expect(io.codes).toEqual([EXIT_OK]);
    expect(io.logs.join('\n')).toContain('Migration plan -> codex-cli');
    // No JSON envelope leaked into the human path.
    expect(io.logs.join('\n')).not.toContain('"ok"');
  });
});

describe('parseArgs --json guard', () => {
  it('accepts --json with --dry-run (no --yes needed)', () => {
    expect(() => parseArgs(['--to', 'codex-cli', '--all', '--dry-run', '--json'])).not.toThrow();
  });

  it('accepts --json with --yes for a real migration', () => {
    const args = parseArgs(['--to', 'codex-cli', '--all', '--yes', '--json']);
    expect(args.json).toBe(true);
    expect(args.yes).toBe(true);
  });

  it('rejects --json for a real migration without --yes', () => {
    expect(() => parseArgs(['--to', 'codex-cli', '--all', '--json'])).toThrowError(/--json requires --yes/);
  });
});
