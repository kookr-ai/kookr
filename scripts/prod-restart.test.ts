import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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
      expect(readFileSync(curlLog, 'utf8')).toContain('-sf http://127.0.0.1:4999/api/health');
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
