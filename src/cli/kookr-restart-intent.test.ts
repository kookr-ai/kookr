import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Import the plain-ESM bin helper directly (no build step). Types come from
// bin/kookr-restart-intent.d.ts.
import {
  RESTART_INTENT_SCHEMA_VERSION,
  RESTART_INTENT_STALE_MS,
  resolveKookrDir,
  restartIntentPath,
  writeRestartIntent,
  clearRestartIntent,
  readRestartIntent,
  classifyRestartIntent,
  formatAge,
  describeRestartIntent,
  describeUnreachableCause,
  readUnreachableCause,
  firstRestartIntentAcrossPorts,
  main,
} from '../../bin/kookr-restart-intent.js';

const tmpDirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kookr-restart-intent-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('resolveKookrDir', () => {
  it('maps port 4800 to ~/.kookr and other ports to ~/.kookr-<port>', () => {
    expect(resolveKookrDir({ port: 4800 })).toBe(join(homedir(), '.kookr'));
    expect(resolveKookrDir({ port: 4801 })).toBe(join(homedir(), '.kookr-4801'));
  });

  it('defaults to ~/.kookr when nothing resolvable is provided', () => {
    expect(resolveKookrDir({ env: {} })).toBe(join(homedir(), '.kookr'));
    expect(resolveKookrDir({ port: 'not-a-port', env: {} })).toBe(join(homedir(), '.kookr'));
  });

  it('reads KOOKR_PORT from env and honours an explicit dir override', () => {
    expect(resolveKookrDir({ env: { KOOKR_PORT: '4900' } })).toBe(join(homedir(), '.kookr-4900'));
    expect(resolveKookrDir({ dir: '/custom/dir', port: 4801 })).toBe('/custom/dir');
  });
});

describe('write/read/clear roundtrip', () => {
  it('writes a normalized marker and reads it back', async () => {
    const dir = await makeDir();
    const now = 1_700_000_000_000;
    writeRestartIntent({ kookrDir: dir, reason: 'prod:update', initiator: 'prod-update.sh', now });

    const raw = JSON.parse(await readFile(restartIntentPath(dir), 'utf8'));
    expect(raw.schemaVersion).toBe(RESTART_INTENT_SCHEMA_VERSION);
    expect(raw.reason).toBe('prod:update');
    expect(raw.initiator).toBe('prod-update.sh');
    expect(raw.startedAt).toBe(new Date(now).toISOString());

    const intent = readRestartIntent(dir);
    expect(intent).not.toBeNull();
    expect(intent?.reason).toBe('prod:update');
    expect(intent?.startedAtMs).toBe(now);
  });

  it('defaults reason/initiator when blank', async () => {
    const dir = await makeDir();
    writeRestartIntent({ kookrDir: dir, reason: '   ', initiator: '' });
    const intent = readRestartIntent(dir);
    expect(intent?.reason).toBe('restart');
  });

  it('returns null after clear', async () => {
    const dir = await makeDir();
    writeRestartIntent({ kookrDir: dir, reason: 'prod:restart' });
    expect(readRestartIntent(dir)).not.toBeNull();
    clearRestartIntent(dir);
    expect(readRestartIntent(dir)).toBeNull();
  });

  it('clear on a missing marker is a no-op (never throws)', async () => {
    const dir = await makeDir();
    expect(() => clearRestartIntent(dir)).not.toThrow();
    expect(readRestartIntent(dir)).toBeNull();
  });
});

describe('readRestartIntent defensive parsing', () => {
  it('returns null for a missing file', async () => {
    const dir = await makeDir();
    expect(readRestartIntent(dir)).toBeNull();
  });

  it('returns null for corrupt JSON', async () => {
    const dir = await makeDir();
    await writeFile(restartIntentPath(dir), 'not json{', 'utf8');
    expect(readRestartIntent(dir)).toBeNull();
  });

  it('returns null when startedAt is unparseable', async () => {
    const dir = await makeDir();
    await writeFile(restartIntentPath(dir), JSON.stringify({ reason: 'x', startedAt: 'nope' }), 'utf8');
    expect(readRestartIntent(dir)).toBeNull();
  });
});

describe('classifyRestartIntent', () => {
  it('reports none when no marker', () => {
    expect(classifyRestartIntent(null)).toEqual({ state: 'none', ageMs: 0 });
  });

  it('reports in-progress within the stale window and stale beyond it', async () => {
    const dir = await makeDir();
    const started = 1_700_000_000_000;
    writeRestartIntent({ kookrDir: dir, reason: 'prod:update', now: started });
    const intent = readRestartIntent(dir);

    const fresh = classifyRestartIntent(intent, started + 5_000);
    expect(fresh.state).toBe('in-progress');
    expect(fresh.ageMs).toBe(5_000);

    const stale = classifyRestartIntent(intent, started + RESTART_INTENT_STALE_MS + 1);
    expect(stale.state).toBe('stale');
  });
});

describe('formatAge', () => {
  it('formats seconds, minutes, and hours', () => {
    expect(formatAge(0)).toBe('0s');
    expect(formatAge(12_000)).toBe('12s');
    expect(formatAge(65_000)).toBe('1m 5s');
    expect(formatAge(120_000)).toBe('2m');
    expect(formatAge(3_600_000)).toBe('1h');
    expect(formatAge(3_720_000)).toBe('1h 2m');
  });
});

describe('describeRestartIntent / describeUnreachableCause', () => {
  it('describes an in-progress restart with reason + age', async () => {
    const dir = await makeDir();
    const started = 1_700_000_000_000;
    writeRestartIntent({ kookrDir: dir, reason: 'prod:update', now: started });
    const intent = readRestartIntent(dir);
    const msg = describeRestartIntent(intent, started + 12_000);
    expect(msg).toContain('prod:update');
    expect(msg).toContain('12s ago');
    expect(msg).toContain('restarting');
  });

  it('describes a stale restart as a likely failed deploy', async () => {
    const dir = await makeDir();
    const started = 1_700_000_000_000;
    writeRestartIntent({ kookrDir: dir, reason: 'prod:update', now: started });
    const intent = readRestartIntent(dir);
    const msg = describeRestartIntent(intent, started + RESTART_INTENT_STALE_MS + 60_000);
    expect(msg).toContain('failed deploy');
  });

  it('describeRestartIntent returns null with no marker, describeUnreachableCause falls back', () => {
    expect(describeRestartIntent(null)).toBeNull();
    expect(describeUnreachableCause(null)).toContain('unexpected outage');
  });
});

describe('readUnreachableCause / firstRestartIntentAcrossPorts', () => {
  it('resolves the marker from an explicit dir and classifies it', async () => {
    const dir = await makeDir();
    const started = 1_700_000_000_000;
    writeRestartIntent({ kookrDir: dir, reason: 'prod:restart', now: started });
    const result = readUnreachableCause({ dir, now: started + 3_000 });
    expect(result.intent?.reason).toBe('prod:restart');
    expect(result.classification.state).toBe('in-progress');
    expect(result.message).toContain('prod:restart');
  });

  it('firstRestartIntentAcrossPorts returns null when no port has a marker', () => {
    // Ports resolve under the real home dir where no marker exists in tests.
    expect(firstRestartIntentAcrossPorts([59998, 59999])).toBeNull();
  });
});

describe('main() CLI', () => {
  it('write then clear via the CLI surface, honouring --dir', async () => {
    const dir = await makeDir();
    const lines: string[] = [];
    const out = { write: (s: string) => lines.push(s) };
    const err = { write: () => {} };

    const writeCode = await main(['write', '--dir', dir, '--reason', 'prod:update'], { out, err });
    expect(writeCode).toBe(0);
    expect(existsSync(restartIntentPath(dir))).toBe(true);
    expect(readRestartIntent(dir)?.reason).toBe('prod:update');

    const clearCode = await main(['clear', '--dir', dir], { out, err });
    expect(clearCode).toBe(0);
    expect(existsSync(restartIntentPath(dir))).toBe(false);
  });

  it('returns exit code 2 with usage on an unknown command', async () => {
    const errs: string[] = [];
    const code = await main(['bogus'], { out: { write: () => {} }, err: { write: (s: string) => errs.push(s) } });
    expect(code).toBe(2);
    expect(errs.join('')).toContain('usage:');
  });
});
