import { describe, expect, it } from 'vitest';

import { buildOpenUrl, HELP_TEXT, isLoopbackHost, parseOpenArgs, runOpenCli } from './kookr-open.js';

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

/** A fetch that answers `/api/health` only for the given ports. */
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

describe('buildOpenUrl', () => {
  it('returns the base dashboard URL with no task id', () => {
    expect(buildOpenUrl('http://127.0.0.1:4800', undefined)).toBe('http://127.0.0.1:4800');
  });

  it('deep-links to /#/tasks/<id> when a task id is given', () => {
    expect(buildOpenUrl('http://127.0.0.1:4800', 'abc123')).toBe('http://127.0.0.1:4800/#/tasks/abc123');
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
    });
    expect(code).toBe(0);
    expect(opener.calls).toEqual([{ command: 'xdg-open', url: 'http://127.0.0.1:4800' }]);
    expect(io.logs.join('\n')).toContain('Opening dashboard: http://127.0.0.1:4800');
  });

  it('deep-links to a given task id', async () => {
    const io = captureIo();
    const opener = recordingOpener();
    const code = await runOpenCli(['task-9'], {
      env: {},
      out: io.out,
      err: io.err,
      fetchImpl: fetchServing(4800),
      openUrl: opener.openUrl,
      platform: 'darwin',
    });
    expect(code).toBe(0);
    expect(opener.calls).toEqual([{ command: 'open', url: 'http://127.0.0.1:4800/#/tasks/task-9' }]);
  });

  it('trusts an explicit KOOKR_PORT without probing', async () => {
    const io = captureIo();
    const opener = recordingOpener();
    const code = await runOpenCli([], {
      env: { KOOKR_PORT: '5000' },
      out: io.out,
      err: io.err,
      fetchImpl: fetchServing(), // nothing serving; explicit port is trusted anyway
      openUrl: opener.openUrl,
      platform: 'linux',
    });
    expect(code).toBe(0);
    expect(opener.calls).toEqual([{ command: 'xdg-open', url: 'http://127.0.0.1:5000' }]);
  });

  it('prints the URL and exits 0 when no platform opener exists (headless)', async () => {
    const io = captureIo();
    const opener = recordingOpener();
    const code = await runOpenCli([], {
      env: {},
      out: io.out,
      err: io.err,
      fetchImpl: fetchServing(4800),
      openUrl: opener.openUrl,
      platform: 'win32', // no opener mapping → print, never spawn
    });
    expect(code).toBe(0);
    expect(opener.calls).toEqual([]);
    expect(io.logs.join('\n')).toContain('http://127.0.0.1:4800');
    // Assert the discriminating fragment, not the phrase shared with the remote path.
    expect(io.logs.join('\n')).toContain('No browser opener');
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
    });
    expect(code).toBe(0);
    expect(JSON.parse(io.logs[0])).toEqual({
      ok: true,
      code: 'OK',
      message: 'Opening dashboard: http://127.0.0.1:4800/#/tasks/t1',
      details: { url: 'http://127.0.0.1:4800/#/tasks/t1', taskId: 't1', opened: true, command: 'xdg-open' },
    });
  });

  it('emits a structured --json failure envelope for NO_SERVER', async () => {
    const io = captureIo();
    const code = await runOpenCli(['--json'], { env: {}, out: io.out, err: io.err, fetchImpl: fetchServing() });
    expect(code).toBe(3);
    expect(JSON.parse(io.logs[0])).toMatchObject({ ok: false, code: 'NO_SERVER' });
    expect(io.errors).toEqual([]);
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

  it('falls back to printing when the opener throws', async () => {
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
    });
    expect(code).toBe(0);
    // Must land on the fallback path, not a silent success — assert its message.
    expect(io.logs.join('\n')).toContain('No browser opener');
    expect(io.logs.join('\n')).toContain('http://127.0.0.1:4800');
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

  it('emits a --json USER_ERROR envelope for an unknown option', async () => {
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

  it('rejects an unknown option with exit 2', async () => {
    const io = captureIo();
    const code = await runOpenCli(['--bogus'], { env: {}, out: io.out, err: io.err, fetchImpl: fetchServing(4800) });
    expect(code).toBe(2);
    expect(io.errors.join('\n')).toContain('unknown option');
  });
});
