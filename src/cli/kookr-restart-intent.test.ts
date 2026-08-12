import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Import the plain-ESM bin helper directly (no build step). Types come from
// bin/kookr-restart-intent.d.ts.
import {
  RESTART_INTENT_SCHEMA_VERSION,
  RESTART_INTENT_STALE_MS,
  RESTART_INTENT_EXPIRY_MS,
  resolveKookrDir,
  restartIntentPath,
  writeRestartIntent,
  clearRestartIntent,
  readRestartIntent,
  classifyRestartIntent,
  formatAge,
  describeRestartIntent,
  describeUnreachableCause,
  restartIntentJson,
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

  it('leaves no leftover .tmp file after an atomic write', async () => {
    const dir = await makeDir();
    writeRestartIntent({ kookrDir: dir, reason: 'prod:update' });
    const leftovers = (await readdir(dir)).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
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

  it('persists and reads back the staleAfterMs deadline', async () => {
    const dir = await makeDir();
    writeRestartIntent({ kookrDir: dir, reason: 'prod:update', staleAfterMs: 1_800_000 });
    expect(readRestartIntent(dir)?.staleAfterMs).toBe(1_800_000);
  });
});

describe('ownership-checked clear', () => {
  it('only clears when expectStartedAt matches the on-disk marker', async () => {
    const dir = await makeDir();
    const started = 1_700_000_000_000;
    writeRestartIntent({ kookrDir: dir, reason: 'prod:update', now: started });
    const startedAt = new Date(started).toISOString();

    // Mismatch (a different restart owns the marker now) → left in place.
    clearRestartIntent(dir, { expectStartedAt: new Date(started + 1).toISOString() });
    expect(readRestartIntent(dir)).not.toBeNull();

    // Match → removed.
    clearRestartIntent(dir, { expectStartedAt: startedAt });
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

  it('honours the per-marker staleAfterMs deadline over the default', async () => {
    const dir = await makeDir();
    const started = 1_700_000_000_000;
    // A generous 30-minute deploy budget: still in-progress well past the
    // default 10-minute constant (regression guard for issue #1721 slow deploys).
    writeRestartIntent({ kookrDir: dir, reason: 'prod:update', now: started, staleAfterMs: 1_800_000 });
    const intent = readRestartIntent(dir);

    expect(classifyRestartIntent(intent, started + RESTART_INTENT_STALE_MS + 60_000).state).toBe('in-progress');
    expect(classifyRestartIntent(intent, started + 1_800_000 + 1).state).toBe('stale');
  });

  it('treats a marker past the absolute expiry ceiling as none (orphan)', async () => {
    const dir = await makeDir();
    const started = 1_700_000_000_000;
    writeRestartIntent({ kookrDir: dir, reason: 'prod:update', now: started });
    const intent = readRestartIntent(dir);
    expect(classifyRestartIntent(intent, started + RESTART_INTENT_EXPIRY_MS + 1).state).toBe('none');
    expect(describeRestartIntent(intent, started + RESTART_INTENT_EXPIRY_MS + 1)).toBeNull();
  });
});

describe('restartIntentJson', () => {
  it('emits a uniform shape with nulls when no marker', () => {
    expect(restartIntentJson(null)).toEqual({ state: 'none', ageMs: 0, reason: null, startedAt: null });
  });

  it('carries reason + startedAt for a live marker', async () => {
    const dir = await makeDir();
    const started = 1_700_000_000_000;
    writeRestartIntent({ kookrDir: dir, reason: 'prod:update', now: started });
    const json = restartIntentJson(readRestartIntent(dir), started + 4_000);
    expect(json).toEqual({ state: 'in-progress', ageMs: 4_000, reason: 'prod:update', startedAt: new Date(started).toISOString() });
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

describe('classifyRestartIntent boundary equality', () => {
  it('age exactly at staleAfterMs stays in-progress; exactly at expiry stays stale', async () => {
    const dir = await makeDir();
    const started = 1_700_000_000_000;
    writeRestartIntent({ kookrDir: dir, reason: 'prod:update', now: started, staleAfterMs: 60_000 });
    const intent = readRestartIntent(dir);
    // strict `>` boundaries: equal-to is NOT past the threshold.
    expect(classifyRestartIntent(intent, started + 60_000).state).toBe('in-progress');
    expect(classifyRestartIntent(intent, started + 60_001).state).toBe('stale');
    expect(classifyRestartIntent(intent, started + RESTART_INTENT_EXPIRY_MS).state).toBe('stale');
    expect(classifyRestartIntent(intent, started + RESTART_INTENT_EXPIRY_MS + 1).state).toBe('none');
  });
});

describe('restartIntentJson stale state', () => {
  it('carries reason + startedAt for a stale marker', async () => {
    const dir = await makeDir();
    const started = 1_700_000_000_000;
    writeRestartIntent({ kookrDir: dir, reason: 'prod:update', now: started, staleAfterMs: 60_000 });
    const json = restartIntentJson(readRestartIntent(dir), started + 120_000);
    expect(json.state).toBe('stale');
    expect(json.reason).toBe('prod:update');
    expect(json.startedAt).toBe(new Date(started).toISOString());
  });
});

describe('readUnreachableCause / firstRestartIntentAcrossPorts', () => {
  // These exercise the port→dir→marker path the CLI actually uses, so they
  // write under a real (but unlikely-to-exist) port dir and clean it up.
  const TEST_PORT = 45999;
  const portDir = resolveKookrDir({ port: TEST_PORT });
  afterEach(async () => {
    await rm(portDir, { recursive: true, force: true });
  });

  it('resolves the marker from an explicit dir and classifies it', async () => {
    const dir = await makeDir();
    const started = 1_700_000_000_000;
    writeRestartIntent({ kookrDir: dir, reason: 'prod:restart', now: started });
    const result = readUnreachableCause({ dir, now: started + 3_000 });
    expect(result.intent?.reason).toBe('prod:restart');
    expect(result.classification.state).toBe('in-progress');
    expect(result.message).toContain('prod:restart');
  });

  it('readUnreachableCause resolves the marker via port (the CLI call shape)', () => {
    writeRestartIntent({ kookrDir: portDir, reason: 'prod:update' });
    const result = readUnreachableCause({ port: TEST_PORT });
    expect(result.kookrDir).toBe(portDir);
    expect(result.intent?.reason).toBe('prod:update');
    expect(result.message).toContain('prod:update');
  });

  it('firstRestartIntentAcrossPorts finds a marker by port and returns its port', () => {
    writeRestartIntent({ kookrDir: portDir, reason: 'prod:update' });
    const found = firstRestartIntentAcrossPorts([TEST_PORT]);
    expect(found?.port).toBe(TEST_PORT);
    expect(found?.intent.reason).toBe('prod:update');
  });

  it('firstRestartIntentAcrossPorts skips an expired-orphan marker (returns null)', () => {
    // A marker far past the expiry ceiling classifies as `none` → must be skipped.
    writeRestartIntent({ kookrDir: portDir, reason: 'prod:update', now: 1_000 });
    expect(firstRestartIntentAcrossPorts([TEST_PORT], { now: 1_000 + RESTART_INTENT_EXPIRY_MS + 1 })).toBeNull();
  });

  it('firstRestartIntentAcrossPorts returns null when no port has a marker', () => {
    expect(firstRestartIntentAcrossPorts([59998, 59999])).toBeNull();
  });
});

describe('main() CLI', () => {
  it('write prints startedAt and stamps staleAfterMs; clear --expect-started-at is ownership-checked', async () => {
    const dir = await makeDir();
    const lines: string[] = [];
    const out = { write: (s: string) => lines.push(s) };
    const err = { write: () => {} };

    const writeCode = await main(
      ['write', '--dir', dir, '--reason', 'prod:update', '--stale-after-ms', '1800000', '--pid', '4242'],
      { out, err },
    );
    expect(writeCode).toBe(0);
    expect(existsSync(restartIntentPath(dir))).toBe(true);
    const intent = readRestartIntent(dir);
    expect(intent?.reason).toBe('prod:update');
    expect(intent?.staleAfterMs).toBe(1_800_000);
    expect(intent?.pid).toBe(4242);
    // stdout carries the startedAt so the caller can pass it back to clear.
    const printed = lines.join('').trim();
    expect(printed).toBe(intent?.startedAt);

    // A non-matching startedAt must NOT delete the marker.
    const noClear = await main(['clear', '--dir', dir, '--expect-started-at', '1999-01-01T00:00:00.000Z'], { out, err });
    expect(noClear).toBe(0);
    expect(existsSync(restartIntentPath(dir))).toBe(true);

    // The matching startedAt clears it.
    const clearCode = await main(['clear', '--dir', dir, '--expect-started-at', printed], { out, err });
    expect(clearCode).toBe(0);
    expect(existsSync(restartIntentPath(dir))).toBe(false);
  });

  it('show prints the current marker JSON (operator inspect command)', async () => {
    const dir = await makeDir();
    const lines: string[] = [];
    const out = { write: (s: string) => lines.push(s) };
    const err = { write: () => {} };

    // No marker → prints null.
    expect(await main(['show', '--dir', dir], { out, err })).toBe(0);
    expect(lines.join('').trim()).toBe('null');

    lines.length = 0;
    writeRestartIntent({ kookrDir: dir, reason: 'prod:update' });
    expect(await main(['show', '--dir', dir], { out, err })).toBe(0);
    expect(JSON.parse(lines.join('')).reason).toBe('prod:update');
  });

  it('returns exit code 2 with usage on an unknown command', async () => {
    const errs: string[] = [];
    const code = await main(['bogus'], { out: { write: () => {} }, err: { write: (s: string) => errs.push(s) } });
    expect(code).toBe(2);
    expect(errs.join('')).toContain('usage:');
  });
});
