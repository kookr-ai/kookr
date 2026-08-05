import { describe, it, expect, vi } from 'vitest';
// The CLI ships as a plain ESM .js file in bin/ (same pattern as bin/kookr.js)
// so it runs without a build step. Types come from bin/kookr-drain.d.ts.
import { runDrainCli, formatStatus } from '../../bin/kookr-drain.js';

function mkOut() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    out: { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) },
    logs,
    errors,
  };
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// An explicit KOOKR_PORT short-circuits port auto-detection so resolvePort never
// touches the network (see bin/kookr-status.js resolvePort).
const ENV = { KOOKR_PORT: '4800' } as Record<string, string | undefined>;

describe('runDrainCli', () => {
  it('drain → POST /api/admin/drain and prints DRAINING state', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { accepting: false, draining: true, since: '2026-05-29T12:00:00.000Z', runningTasks: 3, changed: true }),
    );
    const { out, logs } = mkOut();
    const code = await runDrainCli(['drain'], { env: ENV, out, fetchImpl: fetchImpl as never });

    expect(code).toBe(0);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4800/api/admin/drain');
    expect(init.method).toBe('POST');
    expect(logs.join('\n')).toContain('DRAINING');
    expect(logs.join('\n')).toContain('Running tasks:  3');
  });

  it('resume → POST /api/admin/resume', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { accepting: true, draining: false, changed: true }));
    const { out, logs } = mkOut();
    const code = await runDrainCli(['resume'], { env: ENV, out, fetchImpl: fetchImpl as never });

    expect(code).toBe(0);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4800/api/admin/resume');
    expect(init.method).toBe('POST');
    expect(logs.join('\n')).toContain('ACCEPTING');
  });

  it('drain status → GET /api/admin/drain', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { accepting: true, draining: false, runningTasks: 0 }));
    const { out } = mkOut();
    const code = await runDrainCli(['drain', 'status'], { env: ENV, out, fetchImpl: fetchImpl as never });

    expect(code).toBe(0);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4800/api/admin/drain');
    expect(init.method).toBe('GET');
  });

  it('forwards KOOKR_ADMIN_TOKEN via the x-kookr-admin-token header', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { accepting: false, draining: true, changed: true }));
    const { out } = mkOut();
    await runDrainCli(['drain'], { env: { ...ENV, KOOKR_ADMIN_TOKEN: 'secret' }, out, fetchImpl: fetchImpl as never });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers['x-kookr-admin-token']).toBe('secret');
  });

  it('omits the token header when KOOKR_ADMIN_TOKEN is unset', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { accepting: false, draining: true, changed: true }));
    const { out } = mkOut();
    await runDrainCli(['drain'], { env: ENV, out, fetchImpl: fetchImpl as never });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers['x-kookr-admin-token']).toBeUndefined();
  });

  it('reports "Already draining." when the server says nothing changed', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { accepting: false, draining: true, changed: false }));
    const { out, logs } = mkOut();
    await runDrainCli(['drain'], { env: ENV, out, fetchImpl: fetchImpl as never });
    expect(logs.join('\n')).toContain('Already draining.');
  });

  it('returns exit code 1 with a clear message on 403', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(403, { error: 'admin-forbidden' }));
    const { out, errors } = mkOut();
    const code = await runDrainCli(['drain'], { env: ENV, out, fetchImpl: fetchImpl as never });
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('admin auth required');
  });

  it('returns exit code 1 when the server is unreachable', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const { out, errors } = mkOut();
    const code = await runDrainCli(['drain'], { env: ENV, out, fetchImpl: fetchImpl as never });
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('Failed to reach Kookr');
  });

  it('rejects an unknown verb with usage and exit code 2', async () => {
    const { out, errors } = mkOut();
    const code = await runDrainCli(['frobnicate'], { env: ENV, out });
    expect(code).toBe(2);
    // Exact banner is locked: issue #2114 asks the usage banner to advertise the
    // new [--json] flag, while the operational status output stays unchanged.
    expect(errors).toEqual(['Usage: kookr <drain|resume|drain status> [--json]']);
  });

  it('drain --json → prints a single JSON envelope instead of human text', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { accepting: false, draining: true, since: '2026-05-29T12:00:00.000Z', runningTasks: 3, changed: true }),
    );
    const { out, logs } = mkOut();
    const code = await runDrainCli(['drain', '--json'], { env: ENV, out, fetchImpl: fetchImpl as never });

    expect(code).toBe(0);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4800/api/admin/drain');
    expect(init.method).toBe('POST');
    // Exactly one line, parseable as JSON, no human text ("DRAINING", "Already …").
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toEqual({
      ok: true,
      draining: true,
      since: '2026-05-29T12:00:00.000Z',
      runningTasks: 3,
      changed: true,
    });
  });

  it('resume --json → POST /api/admin/resume and a JSON envelope with draining false', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { accepting: true, draining: false, changed: true }));
    const { out, logs } = mkOut();
    const code = await runDrainCli(['resume', '--json'], { env: ENV, out, fetchImpl: fetchImpl as never });

    expect(code).toBe(0);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4800/api/admin/resume');
    expect(init.method).toBe('POST');
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toEqual({ ok: true, draining: false, since: null, runningTasks: null, changed: true });
  });

  it('drain status --json → resolves the read-only GET and emits JSON (flag stripped before action)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { accepting: true, draining: false, runningTasks: 0 }));
    const { out, logs } = mkOut();
    const code = await runDrainCli(['drain', 'status', '--json'], { env: ENV, out, fetchImpl: fetchImpl as never });

    expect(code).toBe(0);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4800/api/admin/drain');
    expect(init.method).toBe('GET');
    expect(logs).toHaveLength(1);
    // GET status has no `changed`; envelope defaults it to null for a stable shape.
    expect(JSON.parse(logs[0])).toEqual({ ok: true, draining: false, since: null, runningTasks: 0, changed: null });
  });

  it('drain --json status → resolves the status action with --json in a non-trailing position', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { accepting: true, draining: false, runningTasks: 0 }));
    const { out, logs } = mkOut();
    const code = await runDrainCli(['drain', '--json', 'status'], { env: ENV, out, fetchImpl: fetchImpl as never });

    expect(code).toBe(0);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4800/api/admin/drain');
    expect(init.method).toBe('GET');
    expect(JSON.parse(logs[0])).toEqual({ ok: true, draining: false, since: null, runningTasks: 0, changed: null });
  });

  it('drain --json on 403 → emits an { ok:false } error envelope and exits 1', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(403, { error: 'admin-forbidden' }));
    const { out, logs, errors } = mkOut();
    const code = await runDrainCli(['drain', '--json'], { env: ENV, out, fetchImpl: fetchImpl as never });

    expect(code).toBe(1);
    // Error surfaces as a single JSON line on stdout (not stderr text) so scripts can branch on `ok`.
    expect(errors).toHaveLength(0);
    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('FORBIDDEN');
    expect(parsed.message).toContain('admin auth required');
  });

  it('drain --json when the server is unreachable → { ok:false, code:UNREACHABLE } and exit 1', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const { out, logs, errors } = mkOut();
    const code = await runDrainCli(['drain', '--json'], { env: ENV, out, fetchImpl: fetchImpl as never });

    expect(code).toBe(1);
    expect(errors).toHaveLength(0);
    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('UNREACHABLE');
  });
});

describe('formatStatus', () => {
  it('renders accepting state', () => {
    expect(formatStatus({ accepting: true, draining: false, runningTasks: 2 })).toContain('ACCEPTING');
  });
  it('renders draining state with since', () => {
    const s = formatStatus({ accepting: false, draining: true, since: '2026-05-29T12:00:00.000Z', runningTasks: 1 });
    expect(s).toContain('DRAINING');
    expect(s).toContain('Draining since: 2026-05-29T12:00:00.000Z');
  });
});
