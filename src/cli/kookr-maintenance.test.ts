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
    expect(c.errors.join('\n')).toMatch(/Usage: kookr maintenance prune/);
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

  test('--dry-run reports the plan and does not delete', async () => {
    const c = captureConsole();
    const code = await runMaintenanceCli(['prune', '--dry-run', '--dir', dataDir], { out: c.out });
    expect(code).toBe(0);
    expect(c.logs.join('\n')).toMatch(/dry-run/);
    expect(c.logs.join('\n')).toMatch(/kookr-old\.jsonl/);
    expect(await exists(join(dataDir, 'hooks', 'kookr-old.jsonl'))).toBe(true);
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
