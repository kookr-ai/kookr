import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';

describe('production server systemd unit', () => {
  it('ships a user unit template for the production server', () => {
    const unit = readFileSync('deploy/server/kookr.service', 'utf8');

    expect(unit).toContain('Description=Kookr production server');
    expect(unit).toContain('Type=simple');
    expect(unit).toContain('WorkingDirectory=%h/git/kookr-prod');
    expect(unit).toContain('EnvironmentFile=-%h/.config/kookr/kookr.env');
    expect(unit).toContain('ExecStart=/usr/bin/env node dist/server/start.js');
    // glibc allocator tuning for the RSS sawtooth / arena fragmentation (#1753).
    expect(unit).toContain('Environment=MALLOC_ARENA_MAX=2');
    expect(unit).toContain('Environment=MALLOC_TRIM_THRESHOLD_=131072');
    // Env knobs must precede EnvironmentFile so ~/.config/kookr/kookr.env can
    // still override them per-host.
    expect(unit.indexOf('Environment=MALLOC_ARENA_MAX=2')).toBeLessThan(
      unit.indexOf('EnvironmentFile=-%h/.config/kookr/kookr.env'),
    );
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).not.toMatch(/^User=/m);
    expect(unit).not.toMatch(/^Group=/m);
  });
});

describe('prod-restart script-managed fallback launch (issue #1753)', () => {
  // The pid-file fallback path exports the glibc allocator knobs before
  // `exec node`, mirroring the systemd unit's Environment= lines. The unit-file
  // assertions above cannot cover this second delivery mechanism, and the launch
  // string has fragile nested quoting (`export VAR="${VAR:-default}"` embedded in
  // a double-quoted `local launch=...` handed to `sh -c "$launch"`). These tests
  // execute `start_server` for real with stubbed `setsid`/`node` and assert the
  // node process actually observes the intended MALLOC_* values.
  function runStartServer(overrideEnv: Record<string, string>): {
    arena: string;
    trim: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-prod-fallback-'));
    try {
      const binDir = join(dir, 'bin');
      const kookrDir = join(dir, '.kookr');
      mkdirSync(binDir);
      mkdirSync(kookrDir, { recursive: true });
      const recordFile = join(dir, 'malloc-env.txt');
      const pidFile = join(dir, 'server.pid');
      const logFile = join(kookrDir, 'server.log');

      // setsid stub: run the launch synchronously (drop the `-f` detach flag)
      // so the record file is written before start_server returns.
      writeFileSync(
        join(binDir, 'setsid'),
        `#!/usr/bin/env bash
[[ "$1" == "-f" ]] && shift
exec "$@"
`,
      );
      // node stub: record the allocator env the launch exported, then exit.
      // Writes to a fixed record file (not stdout, which the launch redirects
      // to the log file) so the values survive.
      writeFileSync(
        join(binDir, 'node'),
        `#!/usr/bin/env bash
printf 'ARENA=%s\\nTRIM=%s\\n' "\${MALLOC_ARENA_MAX-}" "\${MALLOC_TRIM_THRESHOLD_-}" > ${JSON.stringify(recordFile)}
exit 0
`,
      );
      chmodSync(join(binDir, 'setsid'), 0o755);
      chmodSync(join(binDir, 'node'), 0o755);

      const result = spawnSync(
        'bash',
        ['-c', [
          `KOOKR_PROD_RESTART_TEST_ONLY=1 source ${JSON.stringify(join(process.cwd(), 'scripts/prod-restart.sh'))}`,
          `PID_FILE=${JSON.stringify(pidFile)}`,
          `LOG_FILE=${JSON.stringify(logFile)}`,
          `KOOKR_DIR=${JSON.stringify(kookrDir)}`,
          'start_server',
        ].join('; ')],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
            ...overrideEnv,
          },
          encoding: 'utf8',
        },
      );
      expect(result.status).toBe(0);
      const recorded = readFileSync(recordFile, 'utf8');
      const arena = /ARENA=(.*)/.exec(recorded)?.[1] ?? '';
      const trim = /TRIM=(.*)/.exec(recorded)?.[1] ?? '';
      return { arena, trim };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('exports the default MALLOC_ARENA_MAX/TRIM_THRESHOLD to the server', () => {
    const { arena, trim } = runStartServer({});
    expect(arena).toBe('2');
    expect(trim).toBe('131072');
  });

  it('honors a pre-set MALLOC_ARENA_MAX from the launching shell', () => {
    const { arena, trim } = runStartServer({ MALLOC_ARENA_MAX: '8' });
    expect(arena).toBe('8');
    // The unset knob still falls back to its default.
    expect(trim).toBe('131072');
  });
});

describe('prod-restart post-restart checks', () => {
  function writeSuccessfulPostRestartCheckStubs(binDir: string): void {
    writeFileSync(
      join(binDir, 'codex'),
      `#!/usr/bin/env bash
if [[ "$1" == "--help" ]]; then
  echo "Usage: codex --plugin-dir <dir>"
  exit 0
fi
exit 1
`,
    );
    writeFileSync(
      join(binDir, 'curl'),
      `#!/usr/bin/env bash
# Minimal curl stub: succeed for -sf nags and for the readiness-gate probe
# shape curl -o BODY -w '%{http_code}' (issue #1721).
out=""
fmt=""
while [[ \$# -gt 0 ]]; do
  case "\$1" in
    -o) out="\$2"; shift 2 ;;
    -w) fmt="\$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ -n "\$out" ]]; then
  printf '%s\\n' '{"ready":true,"checks":{}}' > "\$out"
fi
if [[ "\$fmt" == '%{http_code}' ]]; then
  printf '200'
fi
exit 0
`,
    );
    chmodSync(join(binDir, 'codex'), 0o755);
    chmodSync(join(binDir, 'curl'), 0o755);
  }

  function writeDriftedRelayState(kookrDir: string, appDir: string): void {
    // The script computes APP_DIR via `pwd -P`, which resolves symlinks. On
    // macOS the tmpdir (/tmp) is a symlink to /private/tmp, so the raw mkdtemp
    // path written here would not equal the script's resolved APP_DIR and the
    // relay-drift node check (which compares resolve(state.cwd) === APP_DIR)
    // would silently report no drift. Resolve the path here so state.cwd matches
    // what `pwd -P` produces on both Linux and macOS.
    const resolvedAppDir = realpathSync(appDir);
    writeFileSync(
      join(kookrDir, 'relay.state.json'),
      `${JSON.stringify({
        schemaVersion: 'relay-lifecycle-state.v1',
        mode: 'detached',
        pid: 123,
        command: ['node', 'dist/relay/server.js'],
        cwd: resolvedAppDir,
        bindHost: '127.0.0.1',
        port: 8080,
        relayUrl: 'http://127.0.0.1:8080',
        stateDbPath: join(kookrDir, 'relay.sqlite'),
        logPath: join(kookrDir, 'relay.log'),
        startedAt: '2000-01-01T00:00:00.000Z',
      }, null, 2)}\n`,
    );
  }

  it('warns when a tracked relay predates the current build', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-prod-restart-'));
    try {
      const appDir = join(dir, 'app');
      const binDir = join(dir, 'bin');
      const kookrDir = join(dir, '.kookr');
      mkdirSync(join(appDir, 'dist', 'relay'), { recursive: true });
      mkdirSync(binDir);
      mkdirSync(kookrDir, { recursive: true });
      writeFileSync(join(appDir, 'dist', 'relay', 'server.js'), 'console.log("relay");\n');
      writeFileSync(join(appDir, 'dist', 'build-info.json'), '{}\n');
      writeSuccessfulPostRestartCheckStubs(binDir);
      writeDriftedRelayState(kookrDir, appDir);

      const result = spawnSync(
        'bash',
        [
          '-c',
          `KOOKR_PROD_RESTART_TEST_ONLY=1 source ${JSON.stringify(join(process.cwd(), 'scripts/prod-restart.sh'))}; run_post_restart_checks`,
        ],
        {
          cwd: appDir,
          env: {
            ...process.env,
            HOME: dir,
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
            KOOKR_RESTART_RELAY: '',
          },
          encoding: 'utf8',
        },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toContain('WARN: relay process predates the current build');
      expect(result.stderr).toContain('http://127.0.0.1:8080');
      expect(result.stderr).toContain('KOOKR_RESTART_RELAY=1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restarts the relay when automatic relay restart is enabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-prod-restart-'));
    try {
      const appDir = join(dir, 'app');
      const binDir = join(dir, 'bin');
      const kookrDir = join(dir, '.kookr');
      const pnpmLog = join(dir, 'pnpm.log');
      mkdirSync(join(appDir, 'dist', 'relay'), { recursive: true });
      mkdirSync(binDir);
      mkdirSync(kookrDir, { recursive: true });
      writeFileSync(join(appDir, 'dist', 'relay', 'server.js'), 'console.log("relay");\n');
      writeFileSync(join(appDir, 'dist', 'build-info.json'), '{}\n');
      writeSuccessfulPostRestartCheckStubs(binDir);
      writeFileSync(
        join(binDir, 'pnpm'),
        `#!/usr/bin/env bash
printf 'args=%s\\n' "$*" > "${pnpmLog}"
printf 'KOOKR_DIR=%s\\n' "$KOOKR_DIR" >> "${pnpmLog}"
echo "Relay restarted by test stub"
exit 0
`,
      );
      chmodSync(join(binDir, 'pnpm'), 0o755);
      writeDriftedRelayState(kookrDir, appDir);

      const result = spawnSync(
        'bash',
        [
          '-c',
          `KOOKR_PROD_RESTART_TEST_ONLY=1 source ${JSON.stringify(join(process.cwd(), 'scripts/prod-restart.sh'))}; run_post_restart_checks`,
        ],
        {
          cwd: appDir,
          env: {
            ...process.env,
            HOME: dir,
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
            KOOKR_RESTART_RELAY: '1',
          },
          encoding: 'utf8',
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Relay predates the current build; KOOKR_RESTART_RELAY=1 so restarting relay...');
      expect(result.stdout).toContain('Relay restarted by test stub');
      expect(result.stderr).not.toContain('may be serving stale code');
      expect(readFileSync(pnpmLog, 'utf8')).toContain('args=relay:restart');
      expect(readFileSync(pnpmLog, 'utf8')).toContain(`KOOKR_DIR=${kookrDir}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps restart successful when automatic relay restart fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-prod-restart-'));
    try {
      const appDir = join(dir, 'app');
      const binDir = join(dir, 'bin');
      const kookrDir = join(dir, '.kookr');
      mkdirSync(join(appDir, 'dist', 'relay'), { recursive: true });
      mkdirSync(binDir);
      mkdirSync(kookrDir, { recursive: true });
      writeFileSync(join(appDir, 'dist', 'relay', 'server.js'), 'console.log("relay");\n');
      writeFileSync(join(appDir, 'dist', 'build-info.json'), '{}\n');
      writeSuccessfulPostRestartCheckStubs(binDir);
      writeFileSync(
        join(binDir, 'pnpm'),
        `#!/usr/bin/env bash
echo "relay restart failed in test stub" >&2
exit 1
`,
      );
      chmodSync(join(binDir, 'pnpm'), 0o755);
      writeDriftedRelayState(kookrDir, appDir);

      const result = spawnSync(
        'bash',
        [
          '-c',
          `KOOKR_PROD_RESTART_TEST_ONLY=1 source ${JSON.stringify(join(process.cwd(), 'scripts/prod-restart.sh'))}; run_post_restart_checks`,
        ],
        {
          cwd: appDir,
          env: {
            ...process.env,
            HOME: dir,
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
            KOOKR_RESTART_RELAY: '1',
          },
          encoding: 'utf8',
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Relay predates the current build; KOOKR_RESTART_RELAY=1 so restarting relay...');
      expect(result.stderr).toContain('relay restart failed in test stub');
      expect(result.stderr).toContain('WARN: relay restart failed after deploy');
      expect(result.stderr).toContain('the relay may still be serving stale code');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the top-level restart successful when automatic relay restart fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-prod-restart-'));
    try {
      const appDir = join(dir, 'app');
      const binDir = join(dir, 'bin');
      const kookrDir = join(dir, '.kookr-4999');
      mkdirSync(join(appDir, 'dist', 'relay'), { recursive: true });
      mkdirSync(binDir);
      mkdirSync(kookrDir, { recursive: true });
      writeFileSync(join(appDir, 'dist', 'relay', 'server.js'), 'console.log("relay");\n');
      writeFileSync(join(appDir, 'dist', 'build-info.json'), '{}\n');
      writeSuccessfulPostRestartCheckStubs(binDir);
      writeFileSync(
        join(binDir, 'systemctl'),
        `#!/usr/bin/env bash
if [[ "$1" == "--user" && "$2" == "is-active" && "$3" == "--quiet" && "$4" == "kookr.service" ]]; then
  exit 0
fi
if [[ "$1" == "--user" && "$2" == "restart" && "$3" == "kookr.service" ]]; then
  exit 0
fi
exit 1
`,
      );
      writeFileSync(
        join(binDir, 'pnpm'),
        `#!/usr/bin/env bash
echo "relay restart failed in top-level test stub" >&2
exit 1
`,
      );
      chmodSync(join(binDir, 'systemctl'), 0o755);
      chmodSync(join(binDir, 'pnpm'), 0o755);
      writeDriftedRelayState(kookrDir, appDir);

      const result = spawnSync('bash', [join(process.cwd(), 'scripts/prod-restart.sh')], {
        cwd: appDir,
        env: {
          ...process.env,
          HOME: dir,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          KOOKR_PORT: '4999',
          KOOKR_RESTART_RELAY: '1',
          KOOKR_STARTUP_TIMEOUT_SECONDS: '2',
          KOOKR_STARTUP_CHECK_INTERVAL_SECONDS: '0',
          // This test exercises the relay-restart branch, not the post-deploy
          // smoke suite (issue #1592), which would fail against a stub server.
          KOOKR_POST_DEPLOY_SMOKE: '0',
        },
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Kookr systemd service restarted successfully');
      expect(result.stdout).toContain('Relay predates the current build; KOOKR_RESTART_RELAY=1 so restarting relay...');
      expect(result.stderr).toContain('relay restart failed in top-level test stub');
      expect(result.stderr).toContain('WARN: relay restart failed after deploy');
      expect(result.stderr).toContain('the relay may still be serving stale code');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('prod-restart wait_for_health bounded readiness gate (issue #1553 / #1721)', () => {
  it('fails at the deadline instead of wedging when /api/ready hangs', async () => {
    // A TCP server that accepts connections and never responds — the exact
    // shape of the hung probe that wedged deploys on 2026-07-26. The
    // deadline check only runs between curls, so without --max-time one
    // hanging curl defeats STARTUP_TIMEOUT_SECONDS entirely.
    const sockets: Socket[] = [];
    const server = createNetServer((socket) => { sockets.push(socket); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const dir = mkdtempSync(join(tmpdir(), 'kookr-prod-restart-'));
    try {
      const pidFile = join(dir, 'server.pid');
      const startedMs = Date.now();
      const result = spawnSync(
        'bash',
        ['-c', [
          `KOOKR_PROD_RESTART_TEST_ONLY=1 source ${JSON.stringify(join(process.cwd(), 'scripts/prod-restart.sh'))}`,
          `PID_FILE=${JSON.stringify(pidFile)}`,
          'LOG_FILE=/dev/null',
          'echo $$ > "$PID_FILE"',
          'wait_for_health',
        ].join('; ')],
        {
          env: {
            ...process.env,
            KOOKR_READY_URL: `http://127.0.0.1:${port}/api/ready`,
            // Point M1 health at the same hung listener so the test does not
            // probe a live prod port and so RESTART_T0 timing stays hermetic.
            KOOKR_HEALTH_URL: `http://127.0.0.1:${port}/api/health`,
            KOOKR_STARTUP_TIMEOUT_SECONDS: '3',
            KOOKR_STARTUP_CHECK_INTERVAL_SECONDS: '0',
            KOOKR_HEALTH_CURL_MAX_TIME_SECONDS: '1',
          },
          encoding: 'utf8',
          // Without the per-curl bound the gate hangs forever; this kill
          // deadline is what would fail the test in that regression.
          timeout: 20_000,
        },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('Health check failed after 3s');
      expect(Date.now() - startedMs).toBeLessThan(15_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it('waits through startup-in-progress 503 then succeeds on ready 200 (issue #1721)', async () => {
    // Simulates listen-early boot: first probes return 503 with
    // startup-in-progress, then 200 once deferred recovery finishes.
    // Must use async spawn (not spawnSync): a sync child blocks the Node
    // event loop, so this HTTP stub cannot answer curl and the probe times out.
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      if (hits < 3) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ready: false,
          checks: {
            startup: {
              critical: true,
              ready: false,
              status: 'recovering',
              reason: 'startup-in-progress',
              detail: 'session reattach',
            },
          },
        }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ready: true, checks: { startup: { critical: true, ready: true, status: 'ready' } } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const dir = mkdtempSync(join(tmpdir(), 'kookr-prod-restart-'));
    try {
      const pidFile = join(dir, 'server.pid');
      const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(
          'bash',
          ['-c', [
            `KOOKR_PROD_RESTART_TEST_ONLY=1 source ${JSON.stringify(join(process.cwd(), 'scripts/prod-restart.sh'))}`,
            `PID_FILE=${JSON.stringify(pidFile)}`,
            'LOG_FILE=/dev/null',
            'echo $$ > "$PID_FILE"',
            'wait_for_health',
          ].join('; ')],
          {
            env: {
              ...process.env,
              KOOKR_READY_URL: `http://127.0.0.1:${port}/api/ready`,
              // Same stub answers health+ready so M1 does not hit live prod.
              KOOKR_HEALTH_URL: `http://127.0.0.1:${port}/api/health`,
              KOOKR_STARTUP_TIMEOUT_SECONDS: '10',
              KOOKR_STARTUP_CHECK_INTERVAL_SECONDS: '0',
              KOOKR_HEALTH_CURL_MAX_TIME_SECONDS: '2',
            },
          },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('wait_for_health test timed out'));
        }, 15_000);
        child.on('close', (status) => {
          clearTimeout(timer);
          resolve({ status, stdout, stderr });
        });
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Kookr prod restarted successfully');
      // Health + ready probes share the stub; require enough hits for 503→200.
      expect(hits).toBeGreaterThanOrEqual(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  it('defaults KOOKR_STARTUP_TIMEOUT_SECONDS to 1800 (issue #1721)', () => {
    const result = spawnSync(
      'bash',
      ['-c', [
        'unset KOOKR_STARTUP_TIMEOUT_SECONDS',
        `KOOKR_PROD_RESTART_TEST_ONLY=1 source ${JSON.stringify(join(process.cwd(), 'scripts/prod-restart.sh'))}`,
        'printf "%s\\n" "$STARTUP_TIMEOUT_SECONDS"',
      ].join('; ')],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('1800');
  });
});

describe('prod-restart systemd delegation', () => {
  it('delegates to systemctl when the user unit is active', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-prod-restart-'));
    try {
      const binDir = join(dir, 'bin');
      const configDir = join(dir, '.config', 'kookr');
      const systemctlLog = join(dir, 'systemctl.log');
      const curlLog = join(dir, 'curl.log');
      mkdirSync(binDir);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'kookr.env'), 'KOOKR_PORT=4999\n');

      writeFileSync(
        join(binDir, 'systemctl'),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${systemctlLog}"
if [[ "$1" == "--user" && "$2" == "is-active" && "$3" == "--quiet" && "$4" == "kookr.service" ]]; then
  exit 0
fi
if [[ "$1" == "--user" && "$2" == "restart" && "$3" == "kookr.service" ]]; then
  exit 0
fi
exit 1
`,
      );
      writeFileSync(
        join(binDir, 'curl'),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${curlLog}"
# Support the readiness-gate probe shape (issue #1721): curl -o BODY -w '%{http_code}'.
out=""
fmt=""
while [[ \$# -gt 0 ]]; do
  case "\$1" in
    -o) out="\$2"; shift 2 ;;
    -w) fmt="\$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ -n "\$out" ]]; then
  printf '%s\\n' '{"ready":true,"checks":{}}' > "\$out"
fi
if [[ "\$fmt" == '%{http_code}' ]]; then
  printf '200'
fi
exit 0
`,
      );
      chmodSync(join(binDir, 'systemctl'), 0o755);
      chmodSync(join(binDir, 'curl'), 0o755);

      const result = spawnSync('bash', ['scripts/prod-restart.sh'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: dir,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          KOOKR_STARTUP_TIMEOUT_SECONDS: '2',
          KOOKR_STARTUP_CHECK_INTERVAL_SECONDS: '0',
          // Isolate the systemd-delegation assertions from the post-deploy smoke
          // suite (issue #1592), which has its own dedicated coverage below.
          KOOKR_POST_DEPLOY_SMOKE: '0',
        },
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        'systemd user unit kookr.service is active; delegating restart to systemctl --user restart kookr.service',
      );
      expect(result.stdout).toContain('Kookr systemd service restarted successfully');
      expect(readFileSync(systemctlLog, 'utf8')).toContain('--user is-active --quiet kookr.service');
      expect(readFileSync(systemctlLog, 'utf8')).toContain('--user restart kookr.service');
      // Deploy gate probes /api/ready (issue #1721); post-restart nag also hits ready.
      expect(readFileSync(curlLog, 'utf8')).toContain('http://127.0.0.1:4999/api/ready');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats an inactive user unit as script-managed fallback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-prod-restart-'));
    try {
      const binDir = join(dir, 'bin');
      const systemctlLog = join(dir, 'systemctl.log');
      mkdirSync(binDir);

      writeFileSync(
        join(binDir, 'systemctl'),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${systemctlLog}"
if [[ "$1" == "--user" && "$2" == "is-active" && "$3" == "--quiet" && "$4" == "kookr.service" ]]; then
  exit 3
fi
if [[ "$1" == "--user" && "$2" == "restart" ]]; then
  exit 9
fi
exit 1
`,
      );
      chmodSync(join(binDir, 'systemctl'), 0o755);

      const result = spawnSync(
        'bash',
        ['-c', 'KOOKR_PROD_RESTART_TEST_ONLY=1 source scripts/prod-restart.sh; if systemd_unit_active; then echo active; else echo inactive; fi'],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: dir,
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
          },
          encoding: 'utf8',
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('inactive');
      expect(readFileSync(systemctlLog, 'utf8')).toContain('--user is-active --quiet kookr.service');
      expect(readFileSync(systemctlLog, 'utf8')).not.toContain('--user restart kookr.service');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('prod-restart phase timings (fast-prod-restart P1)', () => {
  it('documents listen-early rather than listen-only-after-full-recovery', () => {
    const script = readFileSync('scripts/prod-restart.sh', 'utf8');
    expect(script).toMatch(/Listen-early already landed/i);
    expect(script).not.toMatch(/binds its listener only after\s*\n\s*# full recovery/i);
    // Early poll default ≤ 200ms (R4).
    expect(script).toMatch(/KOOKR_STARTUP_CHECK_INTERVAL_SECONDS:-0\.2/);
  });

  it('print_restart_phase_timings reports phases and dominant line', () => {
    const result = spawnSync(
      'bash',
      [
        '-c',
        [
          'KOOKR_PROD_RESTART_TEST_ONLY=1 source scripts/prod-restart.sh',
          // port_free=2, m1=5, m2=40, smoke=45, total=45 → dominant M2-ready (35s)
          'print_restart_phase_timings 2 5 40 45 45',
        ].join('; '),
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Restart phase timings:/);
    expect(result.stdout).toMatch(/M1 first \/api\/health/);
    expect(result.stdout).toMatch(/M2 deploy-ready/);
    expect(result.stdout).toMatch(/dominant phase: M2-ready/);
  });

  it('print_restart_phase_timings reports apiBlackoutSeconds and WARN when >5s (issue #1972)', () => {
    // port_free=1, m1=10 → blackout 9.0s > 5s SLO
    const result = spawnSync(
      'bash',
      [
        '-c',
        [
          'KOOKR_PROD_RESTART_TEST_ONLY=1 source scripts/prod-restart.sh',
          'print_restart_phase_timings 1 10 12 13 13',
        ].join('; '),
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/apiBlackoutSeconds:\s+9\.0s/);
    expect(result.stderr).toMatch(/WARN: API blackout 9\.0s exceeds 5s SLO/);
  });

  it('print_restart_phase_timings does not WARN when blackout ≤5s (issue #1972)', () => {
    // port_free=2, m1=5 → blackout 3.0s
    const result = spawnSync(
      'bash',
      [
        '-c',
        [
          'KOOKR_PROD_RESTART_TEST_ONLY=1 source scripts/prod-restart.sh',
          'print_restart_phase_timings 2 5 40 45 45',
        ].join('; '),
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/apiBlackoutSeconds:\s+3\.0s/);
    expect(result.stderr).not.toMatch(/WARN: API blackout/);
  });

  it('write_last_restart_metrics writes last-restart-metrics.json (issue #1973)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-restart-metrics-'));
    try {
      const result = spawnSync(
        'bash',
        [
          '-c',
          [
            'KOOKR_PROD_RESTART_TEST_ONLY=1 source scripts/prod-restart.sh',
            `KOOKR_DIR=${JSON.stringify(dir)}`,
            'PORT=4800',
            'write_last_restart_metrics 2 5 40 45 45 script',
          ].join('; '),
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      );
      expect(result.status).toBe(0);
      const metricsPath = join(dir, 'last-restart-metrics.json');
      const metrics = JSON.parse(readFileSync(metricsPath, 'utf8')) as {
        apiBlackoutSeconds: number;
        m1Seconds: number;
        m2Seconds: number;
        dominantPhase: string;
        path: string;
      };
      expect(metrics.apiBlackoutSeconds).toBe(3);
      expect(metrics.m1Seconds).toBe(5);
      expect(metrics.m2Seconds).toBe(40);
      expect(metrics.dominantPhase).toBe('M2-ready');
      expect(metrics.path).toBe('script');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('prod-restart pre-stop drain (issue #1971)', () => {
  it('main flow calls enter_drain_before_stop before stop_existing_server', () => {
    const script = readFileSync('scripts/prod-restart.sh', 'utf8');
    expect(script).toMatch(/enter_drain_before_stop/);
    expect(script).toMatch(/KOOKR_RESTART_SKIP_DRAIN/);
    // Ordering: drain before stop on the script path (not only a comment).
    const drainIdx = script.lastIndexOf('enter_drain_before_stop');
    const stopIdx = script.lastIndexOf('stop_existing_server');
    expect(drainIdx).toBeGreaterThan(-1);
    expect(stopIdx).toBeGreaterThan(-1);
    expect(drainIdx).toBeLessThan(stopIdx);
  });

  it('enter_drain_before_stop POSTs /api/admin/drain before continuing (mocked curl)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-drain-order-'));
    try {
      const binDir = join(dir, 'bin');
      const kookrDir = join(dir, 'kookr-state');
      mkdirSync(binDir);
      mkdirSync(kookrDir);
      const curlLog = join(dir, 'curl.log');
      // curl stub: record argv, print 200 so drain reports success.
      writeFileSync(
        join(binDir, 'curl'),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(curlLog)}
# emit http_code for -w '%{http_code}'
printf '200'
`,
      );
      chmodSync(join(binDir, 'curl'), 0o755);

      const result = spawnSync(
        'bash',
        [
          '-c',
          [
            'KOOKR_PROD_RESTART_TEST_ONLY=1 source scripts/prod-restart.sh',
            'PORT=4800',
            `KOOKR_DIR=${JSON.stringify(kookrDir)}`,
            'enter_drain_before_stop',
          ].join('; '),
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
          },
          encoding: 'utf8',
        },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/Drain mode ON \(HTTP 200\)/);
      expect(result.stdout).toMatch(/Wrote server-restarting marker/);
      const log = readFileSync(curlLog, 'utf8');
      expect(log).toMatch(/-X POST/);
      expect(log).toMatch(/http:\/\/127\.0\.0\.1:4800\/api\/admin\/drain/);
      expect(log).toMatch(/--max-time/);
      // Issue #1983: marker must land before/with drain so schedule UI can
      // surface server_restarting distinct from generic operator drain.
      const marker = JSON.parse(readFileSync(join(kookrDir, 'server-restarting.json'), 'utf8')) as {
        schemaVersion: string;
        reason: string;
        source?: string;
      };
      expect(marker.schemaVersion).toBe('server-restarting.v1');
      expect(marker.reason).toBe('server_restarting');
      expect(marker.source).toBe('prod-restart');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enter_drain_before_stop is a no-op when KOOKR_RESTART_SKIP_DRAIN=1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-drain-skip-'));
    try {
      const binDir = join(dir, 'bin');
      mkdirSync(binDir);
      const curlLog = join(dir, 'curl.log');
      writeFileSync(
        join(binDir, 'curl'),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(curlLog)}
printf '200'
`,
      );
      chmodSync(join(binDir, 'curl'), 0o755);

      const result = spawnSync(
        'bash',
        [
          '-c',
          [
            'KOOKR_PROD_RESTART_TEST_ONLY=1 source scripts/prod-restart.sh',
            'KOOKR_RESTART_SKIP_DRAIN=1 enter_drain_before_stop',
          ].join('; '),
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
            KOOKR_RESTART_SKIP_DRAIN: '1',
          },
          encoding: 'utf8',
        },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/Skipping pre-stop drain/);
      expect(() => readFileSync(curlLog, 'utf8')).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enter_drain_before_stop continues restart when curl fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-drain-fail-'));
    try {
      const binDir = join(dir, 'bin');
      const kookrDir = join(dir, 'kookr-state');
      mkdirSync(binDir);
      mkdirSync(kookrDir);
      writeFileSync(
        join(binDir, 'curl'),
        `#!/usr/bin/env bash
exit 7
`,
      );
      chmodSync(join(binDir, 'curl'), 0o755);

      const result = spawnSync(
        'bash',
        [
          '-c',
          [
            'KOOKR_PROD_RESTART_TEST_ONLY=1 source scripts/prod-restart.sh',
            'PORT=4800',
            `KOOKR_DIR=${JSON.stringify(kookrDir)}`,
            'enter_drain_before_stop',
            'echo CONTINUE_OK',
          ].join('; '),
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
          },
          encoding: 'utf8',
        },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/Pre-stop drain skipped\/failed/);
      expect(result.stdout).toMatch(/CONTINUE_OK/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

