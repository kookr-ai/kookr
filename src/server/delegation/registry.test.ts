import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  KNOWN_WEAK_TOKEN_HASHES,
  LEAK_GRACE_MS,
  checkWorkerTokens,
  computeDeadlineMs,
  hashToken,
  inFlightCount,
  isLoopbackHost,
  parseDelegationConfig,
  pickWorker,
  validateWorkerRegistry,
  type DelegationConfig,
} from './registry.js';
import { makeConfig, rec, tokenMap, worker } from './__fixtures__/builders.js';

const GOOD_TOKENS = tokenMap({ w1: 'token-one-aaaaaaaaaaaaaaaa', w2: 'token-two-bbbbbbbbbbbbbbbb' });

function issues(config: DelegationConfig, tokens = GOOD_TOKENS) {
  const r = validateWorkerRegistry(config, tokens);
  return r.ok ? [] : r.issues;
}

describe('validateWorkerRegistry', () => {
  test('accepts a valid registry', () => {
    const r = validateWorkerRegistry(makeConfig(), GOOD_TOKENS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.workers.map((w) => w.name)).toEqual(['w1', 'w2']);
  });

  test('rejects a shared token across workers (compared by hash), naming both workers', () => {
    const r = issues(makeConfig(), tokenMap({ w1: 'same-token-1234567890', w2: 'same-token-1234567890' }));
    expect(r.map((i) => i.code)).toEqual(['token_duplicate', 'token_duplicate']);
    expect(r.map((i) => i.worker).sort()).toEqual(['w1', 'w2']);
  });

  test('treats tokens differing only by a trailing newline as the same token', () => {
    const r = issues(makeConfig(), tokenMap({ w1: 'abcdefgh12345678\n', w2: 'abcdefgh12345678' }));
    expect(r.some((i) => i.code === 'token_duplicate')).toBe(true);
  });

  test('rejects a token whose hash is on the (operator-extensible) weak-token denylist', () => {
    const weak = 'weak-test-token-0123456789';
    const hash = createHash('sha256').update(weak).digest('hex');
    const r = issues(makeConfig({ weakTokenHashes: [hash] }), tokenMap({ w1: weak, w2: 'token-two-bbbbbbbbbbbb' }));
    expect(r).toEqual([expect.objectContaining({ code: 'token_default', worker: 'w1' })]);
  });

  test('the built-in denylist holds only SHA-256 hex digests (no credential value in the repository)', () => {
    expect(KNOWN_WEAK_TOKEN_HASHES.length).toBeGreaterThan(0);
    for (const h of KNOWN_WEAK_TOKEN_HASHES) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test('rejects a missing or empty token file', () => {
    const r = issues(makeConfig(), tokenMap({ w1: undefined, w2: '  \n' }));
    expect(r.map((i) => i.code)).toEqual(['token_missing', 'token_missing']);
  });

  test('no issue message ever contains a token or its hash', () => {
    const secret = 'super-secret-token-value-xyz';
    const all = issues(makeConfig(), tokenMap({ w1: secret, w2: secret }));
    const text = JSON.stringify(all);
    expect(text).not.toContain(secret);
    expect(text).not.toContain(hashToken(secret));
  });

  test('requires operatorAttestedLeaf true and workspaceMode ro', () => {
    const cfg = makeConfig({
      workers: [
        { ...worker('w1'), operatorAttestedLeaf: false },
        { ...worker('w2'), workspaceMode: 'rw' as never },
      ],
    });
    expect(issues(cfg).map((i) => i.code).sort()).toEqual(['not_attested_leaf', 'workspace_not_ro']);
  });

  test('rejects duplicate worker names', () => {
    const cfg = makeConfig({ workers: [worker('w1'), worker('w1')] });
    expect(issues(cfg, tokenMap({ w1: 'only-one-token-1234' })).map((i) => i.code)).toContain('duplicate_worker_name');
  });

  test('rejects a worker that lists an undefined project', () => {
    const cfg = makeConfig({ workers: [worker('w1', { projects: ['nope'] }), worker('w2')] });
    expect(issues(cfg).map((i) => i.code)).toEqual(['unknown_project']);
  });

  test.each([
    ['ftp://127.0.0.1/', 'invalid_url'],
    ['not a url', 'invalid_url'],
    ['http://user:pw@127.0.0.1:1/', 'invalid_url'],
    ['http://10.1.2.3:9900/', 'url_host_not_allowed'],
    ['https://example.com/', 'url_host_not_allowed'],
  ])('url %s -> %s', (url, code) => {
    const cfg = makeConfig({ workers: [worker('w1', { url }), worker('w2')] });
    expect(issues(cfg).map((i) => i.code)).toEqual([code]);
  });

  test.each(['http://127.0.0.1:9911/', 'http://localhost:9911', 'http://[::1]:9911/', 'https://127.1.2.3/'])(
    'accepts loopback url %s',
    (url) => {
      expect(issues(makeConfig({ workers: [worker('w1', { url }), worker('w2')] }))).toEqual([]);
    },
  );

  test('accepts a non-loopback host only when explicitly allow-listed', () => {
    const cfg = makeConfig({ workers: [worker('w1', { url: 'http://10.1.2.3:9900/' }), worker('w2')], allowedHosts: ['10.1.2.3'] });
    expect(issues(cfg)).toEqual([]);
  });

  test('reports every problem at once', () => {
    const cfg = makeConfig({ workers: [worker('w1', { url: 'ftp://x', operatorAttestedLeaf: false }), worker('w2')] });
    expect(issues(cfg).length).toBeGreaterThanOrEqual(2);
  });

  test('rejects an invalid project id', () => {
    const cfg = makeConfig({ projects: { '../evil': { repoDir: '/r', githubRepo: 'o/n' } }, workers: [worker('w1', { projects: ['../evil'] }), worker('w2', { projects: ['../evil'] })] });
    expect(issues(cfg).map((i) => i.code)).toContain('invalid_project_id');
  });
});

describe('checkWorkerTokens', () => {
  test('is pure and recomputed per call: a later duplicate is caught', () => {
    const names = ['w1', 'w2'];
    expect(checkWorkerTokens(names, GOOD_TOKENS)).toEqual([]);
    expect(checkWorkerTokens(names, tokenMap({ w1: 'rotated-to-same-1234', w2: 'rotated-to-same-1234' }))).toHaveLength(2);
  });
});

describe('parseDelegationConfig', () => {
  const base = {
    snapshotsRoot: '/s',
    projects: { p: { repoDir: '/r', githubRepo: 'o/n' } },
    workers: [{ name: 'w', url: 'http://127.0.0.1:1', tokenFile: '/t', projects: ['p'], operatorAttestedLeaf: true, workspaceMode: 'ro' }],
  };

  test('applies documented defaults', () => {
    const r = parseDelegationConfig(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.workers[0]!.maxInFlight).toBe(2);
      expect(r.config.workers[0]!.replyTimeoutSec).toBe(300);
      expect(r.config.containerSnapshotsPath).toBe('/opt/workspace');
      expect(r.config.maxDelegations).toBe(8);
      expect(r.config.allowedHosts).toEqual([]);
    }
  });

  test('names bad fields without echoing values', () => {
    const r = parseDelegationConfig({ ...base, workers: [{ ...base.workers[0], url: 5, replyTimeoutSec: 5 }] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const text = r.issues.map((i) => i.message).join('\n');
      expect(text).toContain('workers.0.url');
      expect(text).toContain('workers.0.replyTimeoutSec');
    }
  });

  test('rejects a missing snapshotsRoot', () => {
    const { snapshotsRoot: _omit, ...rest } = base;
    void _omit;
    expect(parseDelegationConfig(rest).ok).toBe(false);
  });
});

describe('isLoopbackHost / computeDeadlineMs', () => {
  test('loopback detection', () => {
    expect(['localhost', '127.0.0.1', '127.9.9.9', '::1', '[::1]'].every(isLoopbackHost)).toBe(true);
    expect(['10.0.0.1', '0.0.0.0', 'example.com', '::2', '128.0.0.1'].some(isLoopbackHost)).toBe(false);
  });

  test('deadline is min(kind default, replyTimeout - margin)', () => {
    expect(computeDeadlineMs(240_000, 300, 30)).toBe(240_000);
    expect(computeDeadlineMs(240_000, 120, 30)).toBe(90_000);
    expect(computeDeadlineMs(900_000, 900, 30)).toBe(870_000);
  });
});

describe('inFlightCount / pickWorker', () => {
  const workers = [worker('w1'), worker('w2')];
  const now = 1_000_000;

  test('project filter: only workers listing the project are eligible', () => {
    const ws = [worker('w1', { projects: ['other'] }), worker('w2')];
    const r = pickWorker([], ws, 'proj', { now });
    expect(r.ok && r.worker.name).toBe('w2');
    expect(pickWorker([], ws, 'unknown', { now })).toEqual({ ok: false, reason: 'pool_unavailable' });
  });

  test('picks the least in-flight worker, ties to config order', () => {
    expect(pickWorker([], workers, 'proj', { now })).toMatchObject({ ok: true, worker: { name: 'w1' } });
    const records = [rec({ workerId: 'w1' }), rec({ workerId: 'w1', state: 'dispatching' }), rec({ workerId: 'w2' })];
    expect(pickWorker(records, workers, 'proj', { now })).toMatchObject({ ok: true, worker: { name: 'w2' } });
  });

  test('honours maxInFlight; pool_busy when every eligible worker is full', () => {
    const ws = [worker('w1', { maxInFlight: 1 }), worker('w2', { maxInFlight: 1 })];
    const records = [rec({ workerId: 'w1' }), rec({ workerId: 'w2' })];
    expect(pickWorker(records, ws, 'proj', { now })).toEqual({ ok: false, reason: 'pool_busy' });
    expect(pickWorker([rec({ workerId: 'w1' })], ws, 'proj', { now })).toMatchObject({ ok: true, worker: { name: 'w2' } });
  });

  test('skips unreachable and unusable workers; all skipped is pool_unavailable', () => {
    expect(pickWorker([], workers, 'proj', { now, unreachable: new Set(['w1']) })).toMatchObject({ ok: true, worker: { name: 'w2' } });
    expect(pickWorker([], workers, 'proj', { now, unreachable: new Set(['w1']), unusable: new Set(['w2']) })).toEqual({ ok: false, reason: 'pool_unavailable' });
  });

  test('completed and non-leaking failures free their slot', () => {
    const ws = [worker('w1', { maxInFlight: 1 })];
    for (const done of [
      rec({ workerId: 'w1', state: 'completed', deadlineAt: now + 1e6 }),
      rec({ workerId: 'w1', state: 'failed', failureReason: 'rejected', deadlineAt: now + 1e6 }),
      rec({ workerId: 'w1', state: 'failed', failureReason: 'invalid_result', deadlineAt: now + 1e6 }),
      rec({ workerId: 'w1', state: 'failed', failureReason: 'worker_lost', deadlineAt: now + 1e6 }),
    ]) {
      expect(pickWorker([done], ws, 'proj', { now }).ok).toBe(true);
    }
  });

  test.each([
    ['timed_out', {}],
    ['cancelled', {}],
    ['failed', { failureReason: 'worker_failed' as const }],
  ] as const)('leaked job (%s) still counts until deadline + grace, then frees the slot', (state, extra) => {
    const ws = [worker('w1', { maxInFlight: 1 })];
    const deadlineAt = now - 1_000;
    const leaked = rec({ workerId: 'w1', state, deadlineAt, ...extra });
    expect(inFlightCount([leaked], 'w1', now)).toBe(1);
    expect(pickWorker([leaked], ws, 'proj', { now })).toEqual({ ok: false, reason: 'pool_busy' });
    const later = deadlineAt + LEAK_GRACE_MS + 1;
    expect(inFlightCount([leaked], 'w1', later)).toBe(0);
    expect(pickWorker([leaked], ws, 'proj', { now: later }).ok).toBe(true);
  });
});
