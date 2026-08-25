import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { runMaintenanceCli, resolveKookrDataDir, autoPortAmbiguous } from './kookr-maintenance.js';

const execFileAsync = promisify(execFile);

function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    out: {
      log: (msg?: unknown) => logs.push(String(msg ?? '')),
      error: (msg?: unknown) => errors.push(String(msg ?? '')),
    },
    logs,
    errors,
  };
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(() => true).catch(() => false);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('resolveKookrDataDir', () => {
  test('defaults to ~/.kookr with no port', () => {
    expect(resolveKookrDataDir({ HOME: '/home/u' })).toBe('/home/u/.kookr');
  });
  test('default port 4800 still maps to ~/.kookr', () => {
    expect(resolveKookrDataDir({ HOME: '/home/u', KOOKR_PORT: '4800' })).toBe('/home/u/.kookr');
  });
  test('non-default port maps to ~/.kookr-<port>', () => {
    expect(resolveKookrDataDir({ HOME: '/home/u', KOOKR_PORT: '4801' })).toBe('/home/u/.kookr-4801');
  });
  test('non-numeric port (auto) falls back to ~/.kookr', () => {
    expect(resolveKookrDataDir({ HOME: '/home/u', KOOKR_PORT: 'auto' })).toBe('/home/u/.kookr');
  });
  test('autoPortAmbiguous is true only for KOOKR_PORT=auto', () => {
    expect(autoPortAmbiguous({ KOOKR_PORT: 'auto' })).toBe(true);
    expect(autoPortAmbiguous({ KOOKR_PORT: '4801' })).toBe(false);
    expect(autoPortAmbiguous({})).toBe(false);
  });
});

describe('runMaintenanceCli', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'kookr-maint-cli-'));
    await mkdir(join(dataDir, 'hooks'), { recursive: true });
    const old = new Date(Date.now() - 45 * MS_PER_DAY).toISOString();
    await writeFile(
      join(dataDir, 'tasks.json'),
      JSON.stringify({
        version: 2,
        tasks: [{ id: 't-old', status: 'completed', updatedAt: old, sessions: [{ tmuxSession: 'kookr-old' }] }],
      }),
      'utf8',
    );
    await writeFile(join(dataDir, 'hooks', 'kookr-old.jsonl'), '{"e":1}\n', 'utf8');
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test('missing prune verb prints usage and returns 2', async () => {
    const c = captureConsole();
    const code = await runMaintenanceCli([], { out: c.out });
    expect(code).toBe(2);
    expect(c.errors.join('\n')).toMatch(/kookr maintenance prune/);
  });

  test('rejects an unknown flag', async () => {
    const c = captureConsole();
    const code = await runMaintenanceCli(['prune', '--nope'], { out: c.out });
    expect(code).toBe(2);
    expect(c.errors.join('\n')).toMatch(/Unknown argument/);
  });

  test('rejects a non-positive --max-age-days', async () => {
    const c = captureConsole();
    const code = await runMaintenanceCli(['prune', '--max-age-days', '0', '--dir', dataDir], { out: c.out });
    expect(code).toBe(2);
    expect(c.errors.join('\n')).toMatch(/positive/);
  });

  test('rejects backup-only and prune-only flags on the wrong verb', async () => {
    const c = captureConsole();
    const pruneCode = await runMaintenanceCli(['prune', '--out', dataDir], { out: c.out });
    expect(pruneCode).toBe(2);
    expect(c.errors.join('\n')).toMatch(/--out is only supported/);

    const c2 = captureConsole();
    const backupCode = await runMaintenanceCli(['backup', '--dry-run'], { out: c2.out });
    expect(backupCode).toBe(2);
    expect(c2.errors.join('\n')).toMatch(/--dry-run is only supported/);
  });

  test('rejects backup --out without a path', async () => {
    const c = captureConsole();
    const code = await runMaintenanceCli(['backup', '--out'], { out: c.out });
    expect(code).toBe(2);
    expect(c.errors.join('\n')).toMatch(/--out requires a path/);
  });

  test('--dry-run reports the plan and does not delete', async () => {
    const c = captureConsole();
    const code = await runMaintenanceCli(['prune', '--dry-run', '--dir', dataDir], { out: c.out });
    expect(code).toBe(0);
    expect(c.logs.join('\n')).toMatch(/dry-run/);
    expect(c.logs.join('\n')).toMatch(/kookr-old\.jsonl/);
    expect(await exists(join(dataDir, 'hooks', 'kookr-old.jsonl'))).toBe(true);
  });

  test('--dry-run reports the root atomic-temp sweep in human and JSON output', async () => {
    await rm(join(dataDir, 'hooks', 'kookr-old.jsonl'), { force: true });
    const tempPath = join(dataDir, '.tmp-123e4567-e89b-12d3-a456-426614174010');
    await writeFile(tempPath, 'orphaned temp data\n', 'utf8');
    const old = new Date(Date.now() - 20 * MS_PER_DAY);
    await utimes(tempPath, old, old);

    const human = captureConsole();
    const humanCode = await runMaintenanceCli(['prune', '--dry-run', '--dir', dataDir], { out: human.out });
    expect(humanCode).toBe(0);
    expect(human.logs.join('\n')).toMatch(/atomic-write-temp/);
    expect(human.logs.join('\n')).toMatch(/atomic temp sweep/i);
    expect(await exists(tempPath)).toBe(true);

    const json = captureConsole();
    const jsonCode = await runMaintenanceCli(['prune', '--dry-run', '--dir', dataDir, '--json'], { out: json.out });
    expect(jsonCode).toBe(0);
    const report = JSON.parse(json.logs.join('\n')) as {
      atomicWriteTempSweep: { plannedCount: number; reclaimedBytes: number };
    };
    expect(report.atomicWriteTempSweep).toMatchObject({ plannedCount: 1, reclaimedBytes: expect.any(Number) });
  });

  test('validates and forwards --atomic-temp-max-age-days', async () => {
    await rm(join(dataDir, 'hooks', 'kookr-old.jsonl'), { force: true });
    const tempPath = join(dataDir, '.tmp-123e4567-e89b-12d3-a456-426614174011');
    await writeFile(tempPath, 'orphaned temp data\n', 'utf8');
    const old = new Date(Date.now() - 5 * MS_PER_DAY);
    await utimes(tempPath, old, old);

    const retained = captureConsole();
    const retainedCode = await runMaintenanceCli(
      ['prune', '--dry-run', '--atomic-temp-max-age-days', '10', '--dir', dataDir, '--json'],
      { out: retained.out },
    );
    expect(retainedCode).toBe(0);
    expect(JSON.parse(retained.logs.join('\n')).atomicWriteTempSweep.plannedCount).toBe(0);

    const rejected = captureConsole();
    const rejectedCode = await runMaintenanceCli(
      ['prune', '--atomic-temp-max-age-days', '0', '--dir', dataDir],
      { out: rejected.out },
    );
    expect(rejectedCode).toBe(2);
    expect(rejected.errors.join('\n')).toMatch(/atomic-temp-max-age-days requires a positive/);
  });

  test('warns (without --dir) when KOOKR_PORT=auto', async () => {
    const c = captureConsole();
    const code = await runMaintenanceCli(['prune', '--dir', dataDir], { out: c.out, env: { KOOKR_PORT: 'auto' } });
    expect(code).toBe(0);
    // --dir given → no auto warning.
    expect(c.errors.join('\n')).not.toMatch(/KOOKR_PORT=auto/);

    const c2 = captureConsole();
    await runMaintenanceCli(['prune', '--max-age-days', '9999'], {
      out: c2.out,
      env: { KOOKR_PORT: 'auto', HOME: dataDir },
    });
    expect(c2.errors.join('\n')).toMatch(/KOOKR_PORT=auto/);
  });

  test('prune deletes the aged hook log and --json emits a parseable result', async () => {
    const c = captureConsole();
    const code = await runMaintenanceCli(['prune', '--dir', dataDir, '--json'], { out: c.out });
    expect(code).toBe(0);
    const parsed = JSON.parse(c.logs.join('\n'));
    expect(parsed.removed).toHaveLength(1);
    expect(parsed.removed[0].tmuxSession).toBe('kookr-old');
    expect(await exists(join(dataDir, 'hooks', 'kookr-old.jsonl'))).toBe(false);
  });

  test('live prune audits atomic-temp deletion in human and JSON output', async () => {
    await rm(join(dataDir, 'hooks', 'kookr-old.jsonl'), { force: true });
    const humanTemp = join(dataDir, '.tmp-123e4567-e89b-12d3-a456-426614174012');
    await writeFile(humanTemp, 'human orphan temp\n', 'utf8');
    const old = new Date(Date.now() - 20 * MS_PER_DAY);
    await utimes(humanTemp, old, old);
    const humanBytes = (await stat(humanTemp)).size;
    const openFileChecker = async (paths: readonly string[]) =>
      new Map(paths.map((path) => [path, 'closed'] as const));

    const human = captureConsole();
    const humanCode = await runMaintenanceCli(['prune', '--dir', dataDir], { out: human.out, openFileChecker });
    expect(humanCode).toBe(0);
    expect(human.logs.join('\n')).toMatch(/Removed 1 of 1 planned artifact/);
    expect(human.logs.join('\n')).toMatch(new RegExp(`${humanBytes} B reclaimed`));
    expect(await exists(humanTemp)).toBe(false);

    const jsonTemp = join(dataDir, '.tmp-123e4567-e89b-12d3-a456-426614174013');
    await writeFile(jsonTemp, 'json orphan temp\n', 'utf8');
    await utimes(jsonTemp, old, old);
    const json = captureConsole();
    const jsonCode = await runMaintenanceCli(
      ['prune', '--dir', dataDir, '--json'],
      { out: json.out, openFileChecker },
    );
    expect(jsonCode).toBe(0);
    const report = JSON.parse(json.logs.join('\n')) as {
      removed: Array<{ kind: string; bytes: number }>;
      reclaimedBytes: number;
      atomicWriteTempSweep: { removedCount: number; reclaimedBytes: number };
    };
    expect(report.removed).toEqual([
      expect.objectContaining({ kind: 'atomic-write-temp', bytes: 17 }),
    ]);
    expect(report.reclaimedBytes).toBe(17);
    expect(report.atomicWriteTempSweep).toMatchObject({ removedCount: 1, reclaimedBytes: 17 });
    expect(await exists(jsonTemp)).toBe(false);
  });

  test('prune removes aged orphan activity-ledger files and reports them', async () => {
    await rm(join(dataDir, 'hooks', 'kookr-old.jsonl'), { force: true });
    const activityDir = join(dataDir, 'activity');
    await mkdir(activityDir, { recursive: true });
    const orphan = join(activityDir, 'kookr-ghost.jsonl');
    await writeFile(orphan, '{"envelope":{"kookrSessionId":"kookr-ghost"}}\n', 'utf8');
    const old = new Date(Date.now() - 60 * MS_PER_DAY);
    await utimes(orphan, old, old);

    const c = captureConsole();
    const code = await runMaintenanceCli(['prune', '--dir', dataDir], { out: c.out });
    expect(code).toBe(0);
    expect(c.logs.join('\n')).toMatch(/activity\/kookr-ghost\.jsonl/);
    expect(await exists(orphan)).toBe(false);
  });

  test('prune removes aged playbook-state runs and honors --playbook-keep-last', async () => {
    await rm(join(dataDir, 'hooks', 'kookr-old.jsonl'), { force: true });
    async function seedRun(runKey: string, daysAgo: number): Promise<string> {
      const runDir = join(dataDir, 'playbook-state', 'scout', runKey);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, 'state.json'), '{}', 'utf8');
      const when = new Date(Date.now() - daysAgo * MS_PER_DAY);
      await utimes(runDir, when, when);
      return runDir;
    }
    const older = await seedRun('run-1', 90);
    const newer = await seedRun('run-2', 60);

    const c = captureConsole();
    const code = await runMaintenanceCli(['prune', '--dir', dataDir, '--playbook-keep-last', '1'], { out: c.out });
    expect(code).toBe(0);
    expect(c.logs.join('\n')).toMatch(/playbook-state\/scout\/run-1/);
    expect(await exists(older)).toBe(false);
    expect(await exists(newer)).toBe(true);
  });

  test('rejects a negative --playbook-keep-last', async () => {
    const c = captureConsole();
    const code = await runMaintenanceCli(['prune', '--dir', dataDir, '--playbook-keep-last', '-1'], { out: c.out });
    expect(code).toBe(2);
    expect(c.errors.join('\n')).toMatch(/--playbook-keep-last requires a non-negative integer/);
  });

  test('prune dry-run lists aged operator-signal files via CLI flags', async () => {
    await rm(join(dataDir, 'hooks', 'kookr-old.jsonl'), { force: true });
    const signalDir = join(dataDir, 'playbook-state', 'operator-signals');
    await mkdir(signalDir, { recursive: true });
    const createdAt = new Date(Date.now() - 14 * MS_PER_DAY).toISOString();
    const signalPath = join(signalDir, 'deploy-lag-alert.json');
    await writeFile(
      signalPath,
      JSON.stringify({
        schemaVersion: 'operator-signal.v1',
        key: 'deploy-lag:alert',
        kind: 'alert',
        source: 'deploy-lag',
        title: 'behind',
        createdAt,
      }),
      'utf8',
    );
    await writeFile(join(signalDir, '.delivered.json'), JSON.stringify({ 'deploy-lag-alert.json': createdAt }), 'utf8');
    const old = new Date(Date.now() - 14 * MS_PER_DAY);
    await utimes(signalPath, old, old);

    const c = captureConsole();
    const code = await runMaintenanceCli(
      [
        'prune',
        '--dry-run',
        '--dir',
        dataDir,
        '--operator-signal-delivered-max-age-days',
        '7',
        '--operator-signal-undelivered-max-age-days',
        '30',
        '--operator-signal-min-age-days',
        '1',
      ],
      { out: c.out },
    );
    expect(code).toBe(0);
    expect(c.logs.join('\n')).toMatch(/playbook-state\/operator-signals\/deploy-lag-alert\.json/);
    expect(c.logs.join('\n')).toMatch(/delivered/);
    expect(await exists(signalPath)).toBe(true);
  });

  test('rejects non-positive --operator-signal-*-max-age-days', async () => {
    const c = captureConsole();
    const code = await runMaintenanceCli(
      ['prune', '--dir', dataDir, '--operator-signal-delivered-max-age-days', '0'],
      { out: c.out },
    );
    expect(code).toBe(2);
    expect(c.errors.join('\n')).toMatch(/operator-signal-delivered-max-age-days requires a positive/);
  });

  test('rejects a non-positive --playbook-max-age-days', async () => {
    const c = captureConsole();
    const code = await runMaintenanceCli(['prune', '--dir', dataDir, '--playbook-max-age-days', '0'], { out: c.out });
    expect(code).toBe(2);
    expect(c.errors.join('\n')).toMatch(/--playbook-max-age-days requires a positive number/);
  });

  test('human output includes aged server.log generations', async () => {
    await rm(join(dataDir, 'hooks', 'kookr-old.jsonl'), { force: true });
    const logGeneration = join(dataDir, 'server.log.1');
    await writeFile(logGeneration, 'previous server output\n', 'utf8');
    const old = new Date(Date.now() - 45 * MS_PER_DAY);
    await utimes(logGeneration, old, old);

    const c = captureConsole();
    const code = await runMaintenanceCli(['prune', '--dir', dataDir], { out: c.out });

    expect(code).toBe(0);
    expect(c.logs.join('\n')).toMatch(/artifact\(s\)/);
    expect(c.logs.join('\n')).toMatch(/server\.log\.1/);
    expect(c.logs.join('\n')).toMatch(/server-log-generation-aged/);
    expect(c.logs.join('\n')).not.toMatch(/kookr-old\.jsonl/);
    expect(await exists(logGeneration)).toBe(false);
  });

  test('backup writes a tarball and --json emits manifest details', async () => {
    const backupDir = join(dataDir, 'backup-output');
    const c = captureConsole();
    const code = await runMaintenanceCli(['backup', '--dir', dataDir, '--out', backupDir, '--json'], { out: c.out });

    expect(code).toBe(0);
    const parsed = JSON.parse(c.logs.join('\n'));
    expect(parsed.backupPath).toMatch(/kookr-backup-\d{8}T\d{6}Z\.tar\.gz$/);
    expect(parsed.archiveBytes).toBeGreaterThan(0);
    expect(await exists(parsed.backupPath)).toBe(true);
    expect(parsed.manifest.schemaVersion).toBe('maintenance-backup.v1');
    expect(parsed.manifest.crashConsistency).toMatch(/kill -9/);
    expect(parsed.manifest.entries.map((entry: { path: string }) => entry.path)).toEqual([
      'hooks',
      'hooks/kookr-old.jsonl',
      'tasks.json',
    ]);
    expect(parsed.manifest.excluded).toEqual([{ path: 'backup-output', reason: 'backup-output-directory' }]);
  });

  test('backup human output reports archive, manifest, and consistency contract', async () => {
    const backupDir = join(dataDir, 'backup-output');
    const c = captureConsole();
    const code = await runMaintenanceCli(['backup', '--dir', dataDir, '--out', backupDir], { out: c.out });

    expect(code).toBe(0);
    const output = c.logs.join('\n');
    expect(output).toMatch(/Kookr maintenance backup/);
    expect(output).toMatch(/wrote: .*kookr-backup-\d{8}T\d{6}Z\.tar\.gz/);
    expect(output).toMatch(/manifest: 3 entries/);
    expect(output).toMatch(/consistency: .*kill -9/);
    expect(output).toMatch(/restore: stop Kookr/);
  });

  test('prod restart script rotates and enforces retained generations', async () => {
    const home = join(dataDir, 'home');
    await mkdir(home, { recursive: true });
    const script = join(process.cwd(), 'scripts', 'prod-restart.sh');

    const { stdout } = await execFileAsync(
      'bash',
      [
        '-c',
        `
set -euo pipefail
export HOME="$1"
export KOOKR_PROD_RESTART_TEST_ONLY=1
source "$2"
mkdir -p "$KOOKR_DIR"
printf 'current\\n' > "$LOG_FILE"
printf 'one\\n' > "$LOG_FILE.1"
printf 'two\\n' > "$LOG_FILE.2"
printf 'three\\n' > "$LOG_FILE.3"
printf 'four\\n' > "$LOG_FILE.4"
LOG_GENERATIONS=3
validate_log_generations
rotate_server_log >/dev/null
for f in server.log server.log.1 server.log.2 server.log.3 server.log.4; do
  if [[ -e "$KOOKR_DIR/$f" ]]; then
    printf '%s=' "$f"
    cat "$KOOKR_DIR/$f"
  else
    printf '%s=<missing>\\n' "$f"
  fi
done
LOG_GENERATIONS=0
printf 'new-current\\n' > "$LOG_FILE"
printf 'old-one\\n' > "$LOG_FILE.1"
validate_log_generations
rotate_server_log >/dev/null
[[ -e "$LOG_FILE" ]]
[[ ! -e "$LOG_FILE.1" ]]
`,
        'bash',
        home,
        script,
      ],
      { cwd: process.cwd() },
    );

    expect(stdout).toContain('server.log=<missing>');
    expect(stdout).toContain('server.log.1=current');
    expect(stdout).toContain('server.log.2=one');
    expect(stdout).toContain('server.log.3=two');
    expect(stdout).toContain('server.log.4=<missing>');
  });

  test('prod restart script rejects oversized log generation counts', async () => {
    const home = join(dataDir, 'home');
    await mkdir(home, { recursive: true });
    const script = join(process.cwd(), 'scripts', 'prod-restart.sh');

    await expect(
      execFileAsync(
        'bash',
        [
          '-c',
          `
set -euo pipefail
export HOME="$1"
export KOOKR_PROD_RESTART_TEST_ONLY=1
source "$2"
LOG_GENERATIONS=999999999999999999999999
validate_log_generations
`,
          'bash',
          home,
          script,
        ],
        { cwd: process.cwd() },
      ),
    ).rejects.toMatchObject({ code: 2 });
  });
});
