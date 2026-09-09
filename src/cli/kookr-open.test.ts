import { describe, expect, it } from 'vitest';

import {
  buildOpenUrl,
  commandExistsOnPath,
  HELP_TEXT,
  isLoopbackHost,
  parseOpenArgs,
  runOpenCli,
} from './kookr-open.js';

function captureIo() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    out: { log: (m: unknown) => logs.push(String(m)) },
    err: { error: (m: unknown) => errors.push(String(m)) },
  };
}

/** A fetch that answers `/api/health` (ok) only for the given ports. */
function fetchServing(...ports: number[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const match = url.match(/127\.0\.0\.1:(\d+)/);
    const port = match ? Number(match[1]) : NaN;
    if (ports.includes(port)) return { ok: true } as Response;
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
}

function recordingOpener() {
  const calls: Array<{ command: string; url: string }> = [];
  return {
    calls,
    openUrl: (command: string, url: string) => {
      calls.push({ command, url });
    },
  };
}

// Env has no PATH in these unit tests, so force the opener to "exist" for the
// launch cases; the missing-binary path is tested explicitly via the seam.
const HAS_OPENER = { commandExists: () => true } as const;

describe('buildOpenUrl', () => {
  it('returns the base dashboard URL with no task id', () => {
    expect(buildOpenUrl('http://127.0.0.1:4800', undefined)).toBe('http://127.0.0.1:4800');
  });

  it('deep-links via the canonical /?task= contract the SPA consumes', () => {
    expect(buildOpenUrl('http://127.0.0.1:4800', 'abc123')).toBe('http://127.0.0.1:4800/?task=abc123');
  });

  it('url-encodes the task id', () => {
    expect(buildOpenUrl('http://127.0.0.1:4800', 'a b/c')).toBe('http://127.0.0.1:4800/?task=a%20b%2Fc');
  });
});

describe('parseOpenArgs', () => {
  it('reads a task id, --json, and --help in any order', () => {
    expect(parseOpenArgs(['--json', 't1'])).toEqual({ json: true, help: false, taskId: 't1' });
    expect(parseOpenArgs(['t1', '--help'])).toMatchObject({ help: true, taskId: 't1' });
  });

  it('flags an unknown option', () => {
    expect(parseOpenArgs(['--bogus']).error).toContain('unknown option');
  });
});

describe('isLoopbackHost', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.0.0.2', true],
    ['localhost', true],
    ['::1', true],
    ['0:0:0:0:0:0:0:1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:7f00:1', true], // canonical hex form new URL() produces
    ['::ffff:7f00:2', true], // 127.0.0.2 mapped
    ['::ffff:0a00:5', false], // 10.0.0.5 mapped — not loopback
    ['[::1]', true],
    ['10.0.0.5', false],
    ['example.com', false],
    ['', false],
    [undefined, false],
    [null, false],
  ])('classifies %s as loopback=%s', (host, expected) => {
    expect(isLoopbackHost(host as string | undefined | null)).toBe(expected);
  });
});

describe('commandExistsOnPath', () => {
  it('finds an executable on PATH', () => {
    // node is executing this test, so its dir is on PATH.
    expect(commandExistsOnPath('node', process.env)).toBe(true);
  });

  it('returns false for a bare name not on PATH', () => {
    expect(commandExistsOnPath('definitely-not-a-real-opener-xyz', { PATH: '/nonexistent-dir' })).toBe(false);
  });

  it('returns false when PATH is empty', () => {
    expect(commandExistsOnPath('xdg-open', {})).toBe(false);
  });
});

describe('runOpenCli', () => {
  it('opens the resolved dashboard via the opener seam and exits 0', async () => {
    const io = captureIo();
    const opener = recordingOpener();
    const code = await runOpenCli([], {
      env: {},
      out: io.out,
      err: io.err,
      fetchImpl: fetchServing(4800),
      openUrl: opener.openUrl,
      platform: 'linux',
      ...HAS_OPENER,
    });
    expect(code).toBe(0);
    expect(opener.calls).toEqual([{ command: 'xdg-open', url: 'http://127.0.0.1:4800' }]);
    expect(io.logs.join('\n')).toContain('Opening dashboard: http://127.0.0.1:4800');
  });

  it('deep-links to a given task id via /?task=', async () => {
    const io = captureIo();
    const opener = recordingOpener();
    const code = await runOpenCli(['task-9'], {
      env: {},
      out: io.out,
      err: io.err,
      fetchImpl: fetchServing(4800),
      openUrl: opener.openUrl,
      platform: 'darwin',
      ...HAS_OPENER,
    });
    expect(code).toBe(0);
    expect(opener.calls).toEqual([{ command: 'open', url: 'http://127.0.0.1:4800/?task=task-9' }]);
  });

  it('trusts an explicit KOOKR_PORT (probing only that port for liveness)', async () => {
    const io = captureIo();
    const opener = recordingOpener();
    const code = await runOpenCli([], {
      env: { KOOKR_PORT: '5000' },
      out: io.out,
      err: io.err,
      fetchImpl: fetchServing(5000),
      openUrl: opener.openUrl,
      platform: 'linux',
      ...HAS_OPENER,
    });
    expect(code).toBe(0);
    expect(opener.calls).toEqual([{ command: 'xdg-open', url: 'http://127.0.0.1:5000' }]);
  });

  it('reports NO_SERVER when an explicit KOOKR_PORT points at a dead loopback port', async () => {
    const io = captureIo();
    const opener = recordingOpener();
    const code = await runOpenCli([], {
      env: { KOOKR_PORT: '5000' },
      out: io.out,
      err: io.err,
      fetchImpl: fetchServing(), // nothing listening on 5000
      openUrl: opener.openUrl,
      platform: 'linux',
      ...HAS_OPENER,
    });
    expect(code).toBe(3);
    expect(opener.calls).toEqual([]);
    expect(io.errors.join('\n')).toContain('no Kookr server reachable at http://127.0.0.1:5000');
  });

  it('prints the URL and exits 0 when the platform has no opener (win32)', async () => {
    const io = captureIo();
    const opener = recordingOpener();
    const code = await runOpenCli([], {
      env: {},
      out: io.out,
      err: io.err,
      fetchImpl: fetchServing(4800),
      openUrl: opener.openUrl,
      platform: 'win32',
    });
    expect(code).toBe(0);
    expect(opener.calls).toEqual([]);
    expect(io.logs.join('\n')).toContain('http://127.0.0.1:4800');
    expect(io.logs.join('\n')).toContain('No browser opener');
  });

  it('prints the URL and exits 0 when the opener binary is absent (headless linux)', async () => {
    const io = captureIo();
    const opener = recordingOpener();
    const code = await runOpenCli([], {
      env: {},
      out: io.out,
      err: io.err,
      fetchImpl: fetchServing(4800),
      openUrl: opener.openUrl,
      platform: 'linux',
      commandExists: () => false, // xdg-open not installed
    });
    expect(code).toBe(0);
    expect(opener.calls).toEqual([]);
    expect(io.logs.join('\n')).toContain('No browser opener');
    expect(io.logs.join('\n')).toContain('http://127.0.0.1:4800');
  });

  it('treats an IPv4-mapped IPv6 loopback base as loopback (probes it → NO_SERVER when dead)', async () => {
    const io = captureIo();
    const opener = recordingOpener();
    const code = await runOpenCli([], {
      env: { KOOKR_API_BASE_URL: 'http://[::ffff:127.0.0.1]:59999' },
      out: io.out,
      err: io.err,
      fetchImpl: fetchServing(), // nothing serving
      openUrl: opener.openUrl,
      platform: 'linux',
      ...HAS_OPENER,
    });
    expect(code).toBe(3);
    expect(opener.calls).toEqual([]);
    expect(io.errors.join('\n')).toContain('no Kookr server reachable');
  });

  it('prints the URL for a remote (non-loopback) instance instead of launching a browser', async () => {
    const io = captureIo();
    const opener = recordingOpener();
    const code = await runOpenCli([], {
      env: { KOOKR_API_BASE_URL: 'http://10.0.0.5:4800' },
      out: io.out,
      err: io.err,
      fetchImpl: fetchServing(),
      openUrl: opener.openUrl,
      platform: 'linux',
      ...HAS_OPENER,
    });
    expect(code).toBe(0);
    expect(opener.calls).toEqual([]);
    expect(io.logs.join('\n')).toContain('http://10.0.0.5:4800');
    expect(io.logs.join('\n')).toContain('Remote instance');
  });

  it('fails with NO_SERVER (exit 3) when nothing is running', async () => {
    const io = captureIo();
    const code = await runOpenCli([], { env: {}, out: io.out, err: io.err, fetchImpl: fetchServing() });
    expect(code).toBe(3);
    expect(io.errors.join('\n')).toContain('no Kookr server reachable');
  });

  it('fails with AMBIGUOUS_PORT (exit 5) when two instances are live', async () => {
    const io = captureIo();
    const code = await runOpenCli([], { env: {}, out: io.out, err: io.err, fetchImpl: fetchServing(4800, 4801) });
    expect(code).toBe(5);
    expect(io.errors.join('\n')).toContain('two Kookr instances');
  });

  it('emits a structured --json success envelope', async () => {
    const io = captureIo();
    const opener = recordingOpener();
    const code = await runOpenCli(['t1', '--json'], {
      env: {},
      out: io.out,
      err: io.err,
      fetchImpl: fetchServing(4800),
      openUrl: opener.openUrl,
      platform: 'linux',
      ...HAS_OPENER,
    });
    expect(code).toBe(0);
    expect(JSON.parse(io.logs[0])).toEqual({
      ok: true,
      code: 'OK',
      message: 'Opening dashboard: http://127.0.0.1:4800/?task=t1',
      details: { url: 'http://127.0.0.1:4800/?task=t1', taskId: 't1', opened: true, command: 'xdg-open' },
    });
  });

  it('emits a structured --json failure envelope for NO_SERVER', async () => {
    const io = captureIo();
    const code = await runOpenCli(['--json'], { env: {}, out: io.out, err: io.err, fetchImpl: fetchServing() });
    expect(code).toBe(3);
    expect(JSON.parse(io.logs[0])).toMatchObject({ ok: false, code: 'NO_SERVER' });
    expect(io.errors).toEqual([]);
  });

  it('emits a --json AMBIGUOUS_PORT envelope carrying the live ports', async () => {
    const io = captureIo();
    const code = await runOpenCli(['--json'], {
      env: {},
      out: io.out,
      err: io.err,
      fetchImpl: fetchServing(4800, 4801),
    });
    expect(code).toBe(5);
    expect(JSON.parse(io.logs[0])).toMatchObject({
      ok: false,
      code: 'AMBIGUOUS_PORT',
      details: { ports: [4800, 4801] },
    });
  });

  it('rejects an invalid KOOKR_PORT with USER_ERROR (exit 2)', async () => {
    const io = captureIo();
    const code = await runOpenCli(['--json'], {
      env: { KOOKR_PORT: 'abc' },
      out: io.out,
      err: io.err,
      fetchImpl: fetchServing(),
    });
    expect(code).toBe(2);
    expect(JSON.parse(io.logs[0])).toMatchObject({ ok: false, code: 'USER_ERROR' });
  });

  it('emits a --json envelope when the opener is unavailable (still ok:true)', async () => {
    const io = captureIo();
    const code = await runOpenCli(['--json'], {
      env: {},
      out: io.out,
      err: io.err,
      fetchImpl: fetchServing(4800),
      platform: 'win32',
    });
    expect(code).toBe(0);
    expect(JSON.parse(io.logs[0])).toMatchObject({ ok: true, code: 'OK', details: { opened: false, reason: 'no-opener' } });
  });

  it('falls back to printing when the opener throws synchronously', async () => {
    const io = captureIo();
    const throwing = () => {
      throw new Error('spawn failed');
    };
    const code = await runOpenCli([], {
      env: {},
      out: io.out,
      err: io.err,
      fetchImpl: fetchServing(4800),
      openUrl: throwing,
      platform: 'linux',
      ...HAS_OPENER,
    });
    expect(code).toBe(0);
    // Must land on the fallback message, not a silent success.
    expect(io.logs.join('\n')).toContain('No browser opener');
    expect(io.logs.join('\n')).toContain('http://127.0.0.1:4800');
  });

  it('rejects an unknown option with exit 2', async () => {
    const io = captureIo();
    const code = await runOpenCli(['--bogus', '--json'], { env: {}, out: io.out, err: io.err });
    expect(code).toBe(2);
    expect(JSON.parse(io.logs[0])).toMatchObject({ ok: false, code: 'USER_ERROR' });
  });

  it('prints help and exits 0', async () => {
    const io = captureIo();
    const code = await runOpenCli(['--help'], { env: {}, out: io.out, err: io.err });
    expect(code).toBe(0);
    expect(io.logs).toEqual([HELP_TEXT]);
  });
});
