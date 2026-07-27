import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildAlertArtifact,
  checkAdapterVersionSanity,
  evaluateLogContinuity,
  isValidAdapterVersion,
  isWithinLatencyBound,
  parseAdapterVersionsFromLog,
  type CheckResult,
} from './prod-smoke.js';

// ---------------------------------------------------------------------------
// Pure check logic.
// ---------------------------------------------------------------------------

describe('isValidAdapterVersion', () => {
  it('accepts semver-shaped versions', () => {
    expect(isValidAdapterVersion('1.2.3')).toBe(true);
    expect(isValidAdapterVersion('0.145.0-alpha.4')).toBe(true);
    expect(isValidAdapterVersion('2.1.220')).toBe(true);
    expect(isValidAdapterVersion('1.0')).toBe(true);
  });

  it('accepts the explicit "unknown" sentinel', () => {
    expect(isValidAdapterVersion('unknown')).toBe(true);
    expect(isValidAdapterVersion('  unknown  ')).toBe(true);
  });

  it('rejects --help usage text and other non-version strings', () => {
    expect(isValidAdapterVersion('Usage: claude [options] [command] [prompt]')).toBe(false);
    expect(isValidAdapterVersion('')).toBe(false);
    expect(isValidAdapterVersion('claude version 1.2.3')).toBe(false);
    expect(isValidAdapterVersion('v1.2.3')).toBe(false);
  });
});

describe('parseAdapterVersionsFromLog', () => {
  it('extracts adapter/version pairs from [startup] lines', () => {
    const log = [
      '[auth] Loopback bind; browser session cookie exchange not required.',
      '[startup] adapter=claude-code binary=/usr/local/bin/claude version=2.1.220',
      '[startup] adapter=codex-cli binary=/usr/local/bin/codex version=0.145.0-alpha.4',
      '[terminal] backend=dtach',
    ].join('\n');
    expect(parseAdapterVersionsFromLog(log)).toEqual([
      { agentType: 'claude-code', version: '2.1.220' },
      { agentType: 'codex-cli', version: '0.145.0-alpha.4' },
    ]);
  });

  it('captures --help usage text leaked into a version field', () => {
    const log = '[startup] adapter=claude-code binary=/usr/bin/claude version=Usage: claude [options] [command] [prompt]';
    expect(parseAdapterVersionsFromLog(log)).toEqual([
      { agentType: 'claude-code', version: 'Usage: claude [options] [command] [prompt]' },
    ]);
  });

  it('keeps the last occurrence per adapter (systemd restart loop)', () => {
    const log = [
      '[startup] adapter=claude-code binary=/usr/bin/claude version=2.1.0',
      '[startup] adapter=claude-code binary=/usr/bin/claude version=2.1.220',
    ].join('\n');
    expect(parseAdapterVersionsFromLog(log)).toEqual([{ agentType: 'claude-code', version: '2.1.220' }]);
  });
});

describe('checkAdapterVersionSanity', () => {
  it('passes when every version is sane', () => {
    const result = checkAdapterVersionSanity([
      { agentType: 'claude-code', version: '1.2.3' },
      { agentType: 'codex-cli', version: 'unknown' },
    ]);
    expect(result).toEqual({ ok: true, checked: 2, invalid: [] });
  });

  it('fails and names the offender on usage text', () => {
    const result = checkAdapterVersionSanity([
      { agentType: 'claude-code', version: 'Usage: claude [options]' },
      { agentType: 'codex-cli', version: '0.5.0' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.invalid).toEqual([{ agentType: 'claude-code', version: 'Usage: claude [options]' }]);
  });
});

describe('evaluateLogContinuity', () => {
  it('passes when the pre-deploy mtime is unavailable', () => {
    expect(evaluateLogContinuity({ previousLogMtimeMs: null, bootTimeMs: 1_000, maxGapMs: 100 })).toEqual({
      ok: true,
      gapMs: null,
    });
  });

  it('passes when the gap is within the threshold', () => {
    const result = evaluateLogContinuity({ previousLogMtimeMs: 1_000, bootTimeMs: 5_000, maxGapMs: 10_000 });
    expect(result.ok).toBe(true);
    expect(result.gapMs).toBe(4_000);
  });

  it('fails on an unexplained multi-hour gap ending at boot', () => {
    const twoHoursFiftyMs = (2 * 60 + 50) * 60 * 1000;
    const bootTimeMs = 1_000_000_000_000;
    const result = evaluateLogContinuity({
      previousLogMtimeMs: bootTimeMs - twoHoursFiftyMs,
      bootTimeMs,
      maxGapMs: 2 * 60 * 60 * 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.gapMs).toBe(twoHoursFiftyMs);
    expect(result.reason).toContain('silent');
  });
});

describe('isWithinLatencyBound', () => {
  it('is inclusive of the bound', () => {
    expect(isWithinLatencyBound(3000, 3000)).toBe(true);
    expect(isWithinLatencyBound(2999, 3000)).toBe(true);
    expect(isWithinLatencyBound(3001, 3000)).toBe(false);
  });
});

describe('buildAlertArtifact', () => {
  it('marks status ok with no failing checks', () => {
    const checks: CheckResult[] = [{ name: 'health', ok: true, detail: 'ok' }];
    const artifact = buildAlertArtifact(checks, '2026-07-27T00:00:00.000Z');
    expect(artifact.status).toBe('ok');
    expect(artifact.failingChecks).toEqual([]);
  });

  it('marks status alert and lists failing checks by name', () => {
    const checks: CheckResult[] = [
      { name: 'health', ok: false, detail: 'timed out' },
      { name: 'tasks-latency', ok: false, detail: 'exceeded bound' },
      { name: 'ready', ok: true, detail: 'ok' },
    ];
    const artifact = buildAlertArtifact(checks, '2026-07-27T00:00:00.000Z');
    expect(artifact.status).toBe('alert');
    expect(artifact.failingChecks).toEqual(['health', 'tasks-latency']);
  });
});

// ---------------------------------------------------------------------------
// Integration: the runner against stub servers (acceptance criteria).
// ---------------------------------------------------------------------------

describe('prod-smoke runner (integration, issue #1592)', () => {
  const tcpServers: Server[] = [];
  const hangingServers: ReturnType<typeof createTcpServer>[] = [];
  const openSockets: Socket[] = [];
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const server of tcpServers.splice(0)) await new Promise<void>((r) => server.close(() => r()));
    for (const socket of openSockets.splice(0)) socket.destroy();
    for (const server of hangingServers.splice(0)) await new Promise<void>((r) => server.close(() => r()));
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function startHttpStub(handler: (path: string) => { status: number; delayMs?: number }): Promise<number> {
    const server = createHttpServer((req, res) => {
      const { status, delayMs } = handler(req.url ?? '/');
      const send = (): void => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end('[]');
      };
      if (delayMs && delayMs > 0) setTimeout(send, delayMs);
      else send();
    });
    tcpServers.push(server);
    return new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
  }

  function startHangingServer(): Promise<number> {
    const server = createTcpServer((socket) => openSockets.push(socket));
    hangingServers.push(server);
    return new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
  }

  function makeLogFile(contents: string): { dir: string; logFile: string; alertPath: string } {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-prod-smoke-'));
    tmpDirs.push(dir);
    const logFile = join(dir, 'server.log');
    writeFileSync(logFile, contents);
    return { dir, logFile, alertPath: join(dir, 'prod-smoke-alert.json') };
  }

  const SANE_LOG = '[startup] adapter=claude-code binary=/usr/bin/claude version=2.1.220\n';

  // Async spawn (not spawnSync): the stub HTTP server runs in THIS process, so
  // the parent event loop must stay free to serve the child's requests.
  function runSmoke(env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn('node', ['--import', 'tsx', join(process.cwd(), 'scripts/prod-smoke.ts')], {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 60_000);
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(killTimer);
        resolve({ status: code, stdout, stderr });
      });
    });
  }

  it('passes and completes under 60s when every endpoint is healthy', async () => {
    const port = await startHttpStub(() => ({ status: 200 }));
    const { logFile, alertPath } = makeLogFile(SANE_LOG);
    const base = `http://127.0.0.1:${port}`;
    const startedMs = Date.now();
    const result = await runSmoke({
      KOOKR_SMOKE_HEALTH_URL: `${base}/api/health`,
      KOOKR_SMOKE_READY_URL: `${base}/api/ready`,
      KOOKR_SMOKE_TASKS_URL: `${base}/api/tasks?limit=1`,
      KOOKR_SMOKE_LOG_FILE: logFile,
      KOOKR_SMOKE_ALERT_PATH: alertPath,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('all checks passed');
    // Bounded well under the 60s AC — a healthy suite is near-instant.
    expect(Date.now() - startedMs).toBeLessThan(30_000);
    expect(JSON.parse(readFileSync(alertPath, 'utf8')).status).toBe('ok');
  }, 70_000);

  it('fails fast (under 60s) naming "health" when /api/health hangs', async () => {
    const goodPort = await startHttpStub(() => ({ status: 200 }));
    const hangPort = await startHangingServer();
    const { logFile, alertPath } = makeLogFile(SANE_LOG);
    const good = `http://127.0.0.1:${goodPort}`;
    const startedMs = Date.now();
    const result = await runSmoke({
      KOOKR_SMOKE_HEALTH_URL: `http://127.0.0.1:${hangPort}/api/health`,
      KOOKR_SMOKE_READY_URL: `${good}/api/ready`,
      KOOKR_SMOKE_TASKS_URL: `${good}/api/tasks?limit=1`,
      KOOKR_SMOKE_LOG_FILE: logFile,
      KOOKR_SMOKE_ALERT_PATH: alertPath,
      KOOKR_SMOKE_HEALTH_MAX_TIME_SECONDS: '2',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL health');
    // Health aborts at 2s; the healthy ready/tasks stub must stay reachable, so
    // the failure set is EXACTLY health — a starved/unreachable stub (the bug
    // the async-spawn switch prevents) would add names and fail this equality.
    const artifact = JSON.parse(readFileSync(alertPath, 'utf8'));
    expect(artifact.status).toBe('alert');
    expect(artifact.failingChecks).toEqual(['health']);
    // Bounded by the 2s per-check timeout, not the 60s hard kill.
    expect(Date.now() - startedMs).toBeLessThan(10_000);
  }, 70_000);

  it('fails naming "tasks-latency" when /api/tasks exceeds the latency bound', async () => {
    const port = await startHttpStub((path) => (path.startsWith('/api/tasks') ? { status: 200, delayMs: 3_000 } : { status: 200 }));
    const { logFile, alertPath } = makeLogFile(SANE_LOG);
    const base = `http://127.0.0.1:${port}`;
    const result = await runSmoke({
      KOOKR_SMOKE_HEALTH_URL: `${base}/api/health`,
      KOOKR_SMOKE_READY_URL: `${base}/api/ready`,
      KOOKR_SMOKE_TASKS_URL: `${base}/api/tasks?limit=1`,
      KOOKR_SMOKE_LOG_FILE: logFile,
      KOOKR_SMOKE_ALERT_PATH: alertPath,
      KOOKR_SMOKE_TASKS_LATENCY_BOUND_MS: '500',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL tasks-latency');
    // Exactly tasks-latency fails; health/ready hit the same fast stub and pass.
    expect(JSON.parse(readFileSync(alertPath, 'utf8')).failingChecks).toEqual(['tasks-latency']);
  }, 70_000);

  it('fails naming "version-probe" when an adapter logged --help usage text', async () => {
    const port = await startHttpStub(() => ({ status: 200 }));
    const { logFile, alertPath } = makeLogFile(
      '[startup] adapter=claude-code binary=/usr/bin/claude version=Usage: claude [options] [command] [prompt]\n',
    );
    const base = `http://127.0.0.1:${port}`;
    const result = await runSmoke({
      KOOKR_SMOKE_HEALTH_URL: `${base}/api/health`,
      KOOKR_SMOKE_READY_URL: `${base}/api/ready`,
      KOOKR_SMOKE_TASKS_URL: `${base}/api/tasks?limit=1`,
      KOOKR_SMOKE_LOG_FILE: logFile,
      KOOKR_SMOKE_ALERT_PATH: alertPath,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL version-probe');
    // Exactly version-probe fails; every HTTP endpoint hits a healthy stub.
    expect(JSON.parse(readFileSync(alertPath, 'utf8')).failingChecks).toEqual(['version-probe']);
  }, 70_000);
});

// ---------------------------------------------------------------------------
// End-to-end: prod-restart.sh propagates a smoke failure as non-zero.
// ---------------------------------------------------------------------------

describe('prod-restart.sh gates on the post-deploy smoke suite (issue #1592)', () => {
  const hangingServers: ReturnType<typeof createTcpServer>[] = [];
  const httpServers: Server[] = [];
  const openSockets: Socket[] = [];

  afterEach(async () => {
    for (const socket of openSockets.splice(0)) socket.destroy();
    for (const server of hangingServers.splice(0)) await new Promise<void>((r) => server.close(() => r()));
    for (const server of httpServers.splice(0)) await new Promise<void>((r) => server.close(() => r()));
  });

  // Async spawn so an in-process HTTP stub the smoke suite hits stays reachable
  // (spawnSync would block this process's event loop and starve the stub).
  function runProdRestartAsync(env: Record<string, string>): Promise<{ status: number | null; output: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn('bash', [join(process.cwd(), 'scripts/prod-restart.sh')], {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
      });
      let output = '';
      child.stdout.on('data', (d) => (output += d.toString()));
      child.stderr.on('data', (d) => (output += d.toString()));
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 60_000);
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(killTimer);
        resolve({ status: code, output });
      });
    });
  }

  it('exits non-zero with the failing check named when /api/health hangs after restart', async () => {
    const server = createTcpServer((socket) => openSockets.push(socket));
    hangingServers.push(server);
    const hangPort = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });

    const dir = mkdtempSync(join(tmpdir(), 'kookr-prod-smoke-e2e-'));
    try {
      const binDir = join(dir, 'bin');
      mkdirSync(binDir, { recursive: true });
      // systemctl reports the unit active + restart success; curl (used by the
      // liveness gate + post-restart nag) exits 0 so we reach the smoke suite.
      writeFileSync(
        join(binDir, 'systemctl'),
        `#!/usr/bin/env bash
if [[ "$1" == "--user" && "$2" == "is-active" ]]; then exit 0; fi
if [[ "$1" == "--user" && "$2" == "restart" ]]; then exit 0; fi
exit 1
`,
      );
      writeFileSync(join(binDir, 'curl'), "#!/usr/bin/env bash\nexit 0\n");
      chmodSync(join(binDir, 'systemctl'), 0o755);
      chmodSync(join(binDir, 'curl'), 0o755);

      const result = spawnSync('bash', [join(process.cwd(), 'scripts/prod-restart.sh')], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: dir,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          KOOKR_PORT: '4999',
          KOOKR_HEALTH_URL: `http://127.0.0.1:${hangPort}/api/health`,
          KOOKR_STARTUP_TIMEOUT_SECONDS: '2',
          KOOKR_STARTUP_CHECK_INTERVAL_SECONDS: '0',
          KOOKR_POST_DEPLOY_SMOKE: '1',
          KOOKR_SMOKE_HEALTH_MAX_TIME_SECONDS: '2',
          KOOKR_SMOKE_READY_MAX_TIME_SECONDS: '1',
          KOOKR_SMOKE_TASKS_LATENCY_BOUND_MS: '1000',
        },
        encoding: 'utf8',
        timeout: 60_000,
      });

      expect(result.status).not.toBe(0);
      // Tie the assertion to the SMOKE step naming the check (AC #1), not the
      // health URL merely being echoed elsewhere in the restart output.
      expect(`${result.stdout}${result.stderr}`).toContain('FAIL health');
      expect(`${result.stdout}${result.stderr}`).toContain('FAILED checks');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 70_000);

  it('sources adapter versions from journald on the systemd path and fails on bad version text', async () => {
    // Healthy HTTP stub for health/ready/tasks so only version-probe can fail.
    const http = createHttpServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('[]');
    });
    httpServers.push(http);
    const port = await new Promise<number>((resolve) => {
      http.listen(0, '127.0.0.1', () => resolve((http.address() as AddressInfo).port));
    });

    const dir = mkdtempSync(join(tmpdir(), 'kookr-prod-smoke-journald-'));
    try {
      const binDir = join(dir, 'bin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        join(binDir, 'systemctl'),
        `#!/usr/bin/env bash
if [[ "$1" == "--user" && "$2" == "is-active" ]]; then exit 0; fi
if [[ "$1" == "--user" && "$2" == "restart" ]]; then exit 0; fi
exit 1
`,
      );
      writeFileSync(join(binDir, 'curl'), "#!/usr/bin/env bash\nexit 0\n");
      // journald stub: -o cat prints raw MESSAGE lines (what version-probe
      // parses); -o short-unix (used by the continuity anchor) prints an epoch.
      writeFileSync(
        join(binDir, 'journalctl'),
        `#!/usr/bin/env bash
for a in "$@"; do
  if [[ "$a" == "short-unix" ]]; then echo "1690000000.000000 host kookr[1]: boot"; exit 0; fi
done
echo "[startup] adapter=claude-code binary=/usr/bin/claude version=Usage: claude [options] [command] [prompt]"
exit 0
`,
      );
      chmodSync(join(binDir, 'systemctl'), 0o755);
      chmodSync(join(binDir, 'curl'), 0o755);
      chmodSync(join(binDir, 'journalctl'), 0o755);

      const base = `http://127.0.0.1:${port}`;
      const result = await runProdRestartAsync({
        HOME: dir,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        KOOKR_PORT: '4999',
        KOOKR_HEALTH_URL: `${base}/api/health`,
        KOOKR_READY_URL: `${base}/api/ready`,
        KOOKR_STARTUP_TIMEOUT_SECONDS: '2',
        KOOKR_STARTUP_CHECK_INTERVAL_SECONDS: '0',
        KOOKR_POST_DEPLOY_SMOKE: '1',
        KOOKR_SMOKE_HEALTH_MAX_TIME_SECONDS: '3',
        KOOKR_SMOKE_READY_MAX_TIME_SECONDS: '3',
        KOOKR_SMOKE_TASKS_LATENCY_BOUND_MS: '3000',
        // Anchor recent so the continuity check does not also fire on the
        // synthetic 2023 journald epoch above.
        KOOKR_SMOKE_MAX_LOG_GAP_SECONDS: '999999999',
      });

      expect(result.status).not.toBe(0);
      expect(result.output).toContain('FAIL version-probe');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 70_000);
});
