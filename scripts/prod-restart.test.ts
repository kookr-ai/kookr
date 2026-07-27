import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';

describe('production server systemd unit', () => {
  it('ships a user unit template for the production server', () => {
    const unit = readFileSync('deploy/server/kookr.service', 'utf8');

    expect(unit).toContain('Description=Kookr production server');
    expect(unit).toContain('Type=simple');
    expect(unit).toContain('WorkingDirectory=%h/git/kookr-prod');
    expect(unit).toContain('EnvironmentFile=-%h/.config/kookr/kookr.env');
    expect(unit).toContain('ExecStart=/usr/bin/env node dist/server/start.js');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).not.toMatch(/^User=/m);
    expect(unit).not.toMatch(/^Group=/m);
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

describe('prod-restart wait_for_health bounded liveness gate (issue #1553)', () => {
  it('fails at the deadline instead of wedging when /api/health hangs', async () => {
    // A TCP server that accepts connections and never responds — the exact
    // shape of the hung /api/health that wedged deploys on 2026-07-26. The
    // deadline check only runs between curls, so without --max-time one
    // hanging curl defeats STARTUP_TIMEOUT_SECONDS entirely.
    const sockets: Socket[] = [];
    const server = createServer((socket) => { sockets.push(socket); });
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
      expect(readFileSync(curlLog, 'utf8')).toContain('-sf --max-time 10 http://127.0.0.1:4999/api/health');
      expect(readFileSync(curlLog, 'utf8')).toContain('-sf --max-time 5 http://127.0.0.1:4999/api/ready');
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
