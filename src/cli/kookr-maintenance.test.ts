import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runMaintenanceCli, resolveKookrDataDir, autoPortAmbiguous } from './kookr-maintenance.js';

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
    const old = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
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
});
