import { afterEach, describe, expect, test, vi } from 'vitest';
import { getCostComparison } from './panels.js';
import {
  apiBlackoutTier,
  formatBlackoutSeconds,
  getDeployStatus,
} from './deploy.js';
import { getMigratableTasks, migrateTasks, patchTaskEdges } from './tasks.js';
import { createTaskShare, getTaskShares, SHARE_CSRF_HEADER } from './sharing.js';

function stubFetch() {
  const spy = vi.fn((_path: string, _init?: RequestInit) =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getCostComparison', () => {
  test('builds the query string and omits the "all" agent filter', async () => {
    const spy = stubFetch();
    const signal = new AbortController().signal;
    await getCostComparison({ window: '7d', agent: 'all', q: 'foo bar' }, signal);
    expect(spy).toHaveBeenCalledWith('/api/cost-comparison?window=7d&q=foo+bar', { signal });
  });

  test('includes a concrete agent filter', async () => {
    const spy = stubFetch();
    await getCostComparison({ window: '24h', agent: 'claude' });
    expect(spy.mock.calls[0][0]).toBe('/api/cost-comparison?window=24h&agent=claude');
  });
});

describe('getDeployStatus', () => {
  test('returns an ok/status/body envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ configured: true }) } as Response),
    ));
    await expect(getDeployStatus()).resolves.toEqual({ ok: true, status: 200, body: { configured: true } });
  });
});

describe('apiBlackoutTier (issue #1979)', () => {
  test('green below 1s, amber under 5s, red at/above 5s', () => {
    expect(apiBlackoutTier(0)).toBe('ok');
    expect(apiBlackoutTier(0.9)).toBe('ok');
    expect(apiBlackoutTier(1)).toBe('warn');
    expect(apiBlackoutTier(3)).toBe('warn');
    expect(apiBlackoutTier(4.9)).toBe('warn');
    expect(apiBlackoutTier(5)).toBe('bad');
    expect(apiBlackoutTier(9)).toBe('bad');
  });

  test('treats non-finite values as bad', () => {
    expect(apiBlackoutTier(Number.NaN)).toBe('bad');
    expect(apiBlackoutTier(-1)).toBe('bad');
  });
});

describe('formatBlackoutSeconds', () => {
  test('renders compact second strings', () => {
    expect(formatBlackoutSeconds(0.8)).toBe('0.8s');
    expect(formatBlackoutSeconds(3)).toBe('3s');
    expect(formatBlackoutSeconds(3.0)).toBe('3s');
    expect(formatBlackoutSeconds(1.25)).toBe('1.3s');
  });
});

describe('patchTaskEdges', () => {
  test('PATCHes the edges endpoint with a JSON body', async () => {
    const spy = stubFetch();
    await patchTaskEdges('task 1', { blocks: ['a'] });
    expect(spy).toHaveBeenCalledWith('/api/tasks/task%201/edges', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks: ['a'] }),
    });
  });
});

describe('getMigratableTasks', () => {
  test('builds the query string with target/from/includeCancelled/onlyIsolated', async () => {
    const spy = stubFetch();
    const signal = new AbortController().signal;
    await getMigratableTasks(
      { targetAgent: 'codex-cli', fromAgent: 'claude-code', includeCancelled: true, onlyIsolated: true },
      signal,
    );
    expect(spy).toHaveBeenCalledWith(
      '/api/tasks/migratable?targetAgent=codex-cli&fromAgent=claude-code&includeCancelled=true&onlyIsolated=true',
      { signal },
    );
  });

  test('omits optional params when unset', async () => {
    const spy = stubFetch();
    await getMigratableTasks({ targetAgent: 'grok-build' });
    expect(spy).toHaveBeenCalledWith('/api/tasks/migratable?targetAgent=grok-build');
  });
});

describe('migrateTasks', () => {
  test('POSTs the migrate endpoint with a JSON body', async () => {
    const spy = stubFetch();
    await migrateTasks({
      targetAgent: 'codex-cli',
      scope: { kind: 'ids', taskIds: ['t1'] },
    });
    expect(spy).toHaveBeenCalledWith('/api/tasks/migrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetAgent: 'codex-cli',
        scope: { kind: 'ids', taskIds: ['t1'] },
      }),
    });
  });
});

describe('sharing', () => {
  test('getTaskShares surfaces the 409 status for the disabled path', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({}) } as Response),
    ));
    const result = await getTaskShares();
    expect(result.status).toBe(409);
    expect(result.ok).toBe(false);
  });

  test('createTaskShare sends the CSRF header and lower-cased content-type', async () => {
    const spy = stubFetch();
    await createTaskShare('tok-123', { taskId: 't1', ttlMs: 1000, displayLabel: 'Demo' });
    expect(spy).toHaveBeenCalledWith('/api/share/task', {
      method: 'POST',
      headers: { [SHARE_CSRF_HEADER]: 'tok-123', 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: 't1', ttlMs: 1000, displayLabel: 'Demo' }),
    });
  });
});
