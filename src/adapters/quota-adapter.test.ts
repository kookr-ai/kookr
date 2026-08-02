import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { QuotaAdapter } from './quota-adapter.js';

// Mock fetch and fs
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  stat: vi.fn(),
}));

import { readFile, stat } from 'node:fs/promises';
const mockReadFile = vi.mocked(readFile);
const mockStat = vi.mocked(stat);

describe('QuotaAdapter', () => {
  let adapter: QuotaAdapter;

  beforeEach(() => {
    adapter = new QuotaAdapter(120_000);
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mockStat.mockResolvedValue({ mtimeMs: 1 } as Awaited<ReturnType<typeof stat>>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('initial state is idle with no data', () => {
    expect(adapter.getState()).toBe('idle');
    expect(adapter.getLatest()).toBeNull();
    expect(adapter.getLastError()).toBeNull();
  });

  test('poll succeeds with valid response', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({
      claudeAiOauth: { accessToken: 'test-token' },
    }));

    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        five_hour: { utilization: 67.0, resets_at: '2026-03-30T22:59:59+00:00' },
        seven_day: { utilization: 8.0, resets_at: '2026-04-06T19:00:00+00:00' },
      }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const changed = await adapter.poll();

    expect(changed).toBe(true);
    expect(adapter.getState()).toBe('healthy');

    const quota = adapter.getLatest();
    expect(quota).not.toBeNull();
    expect(quota!.fiveHour).toEqual({ utilization: 67.0, resetsAt: '2026-03-30T22:59:59+00:00' });
    expect(quota!.sevenDay).toEqual({ utilization: 8.0, resetsAt: '2026-04-06T19:00:00+00:00' });
    expect(quota!.updatedAt).toBeGreaterThan(0);
  });

  test('poll handles 429 with backoff', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({
      claudeAiOauth: { accessToken: 'test-token' },
    }));

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers(),
    }));

    const changed = await adapter.poll();

    expect(changed).toBe(false);
    expect(adapter.getState()).toBe('backoff');
    expect(adapter.getCurrentIntervalMs()).toBe(240_000); // doubled from 120s
    expect(adapter.getLastError()).toContain('Rate limited');
  });

  test('poll handles 401 as auth_failed', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({
      claudeAiOauth: { accessToken: 'expired-token' },
    }));

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    }));

    const changed = await adapter.poll();

    expect(changed).toBe(false);
    expect(adapter.getState()).toBe('auth_failed');
  });

  test('poll handles missing credentials file', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    const changed = await adapter.poll();

    expect(changed).toBe(false);
    expect(adapter.getState()).toBe('disabled');
    expect(adapter.getLastError()).toContain('Cannot read credentials');
  });

  test('poll handles missing access token', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ claudeAiOauth: {} }));

    const changed = await adapter.poll();

    expect(changed).toBe(false);
    expect(adapter.getState()).toBe('disabled');
    expect(adapter.getLastError()).toContain('No OAuth access token');
  });

  test('poll handles invalid JSON response', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({
      claudeAiOauth: { accessToken: 'test-token' },
    }));

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('bad json'); },
    }));

    const changed = await adapter.poll();

    expect(changed).toBe(false);
    expect(adapter.getState()).toBe('backoff');
    expect(adapter.getLastError()).toBe('Invalid JSON response');
  });

  test('poll handles null quota windows gracefully', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({
      claudeAiOauth: { accessToken: 'test-token' },
    }));

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        five_hour: null,
        seven_day: null,
      }),
    }));

    const changed = await adapter.poll();

    expect(changed).toBe(true);
    expect(adapter.getState()).toBe('healthy');
    expect(adapter.getLastError()).toBeNull();
    const quota = adapter.getLatest();
    expect(quota!.fiveHour).toBeNull();
    expect(quota!.sevenDay).toBeNull();
    expect(quota!.updatedAt).toBeGreaterThan(0);
  });

  test('poll respects retry-after header on 429', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({
      claudeAiOauth: { accessToken: 'test-token' },
    }));

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': '900' }),
    }));

    await adapter.poll();

    expect(adapter.getState()).toBe('backoff');
    expect(adapter.getCurrentIntervalMs()).toBe(900_000); // 900s from header
  });

  test('auth_failed recovers after the credentials token changes', async () => {
    // First: put into auth_failed state
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify({ claudeAiOauth: { accessToken: 'expired' } }))
      .mockResolvedValueOnce(JSON.stringify({ claudeAiOauth: { accessToken: 'expired' } }))
      .mockResolvedValueOnce(JSON.stringify({ claudeAiOauth: { accessToken: 'fresh' } }));
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: { utilization: 25, resets_at: '2026-07-19T18:00:00Z' },
        }),
      });
    vi.stubGlobal('fetch', mockFetch);
    await adapter.poll();
    expect(adapter.getState()).toBe('auth_failed');

    mockStat.mockResolvedValue({ mtimeMs: 2 } as Awaited<ReturnType<typeof stat>>);
    const changed = await adapter.poll();

    expect(changed).toBe(true);
    expect(adapter.getState()).toBe('healthy');
    expect(adapter.getLatest()?.fiveHour?.utilization).toBe(25);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(2, expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer fresh' }),
    }));
  });

  test('auth_failed does not retry an unchanged invalid credential', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({
      claudeAiOauth: { accessToken: 'expired' },
    }));
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal('fetch', mockFetch);

    await adapter.poll();
    expect(adapter.getState()).toBe('auth_failed');
    expect(adapter.getCurrentIntervalMs()).toBe(240_000);

    await adapter.poll();

    expect(mockStat).toHaveBeenCalledTimes(3);
    expect(mockReadFile).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('auth_failed backs off again when a changed credential is still invalid', async () => {
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify({ claudeAiOauth: { accessToken: 'expired' } }))
      .mockResolvedValueOnce(JSON.stringify({ claudeAiOauth: { accessToken: 'expired' } }))
      .mockResolvedValueOnce(JSON.stringify({ claudeAiOauth: { accessToken: 'also-invalid' } }))
      .mockResolvedValueOnce(JSON.stringify({ claudeAiOauth: { accessToken: 'also-invalid' } }));
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal('fetch', mockFetch);

    await adapter.poll();
    mockStat.mockResolvedValue({ mtimeMs: 2 } as Awaited<ReturnType<typeof stat>>);
    await adapter.poll();

    expect(adapter.getState()).toBe('auth_failed');
    expect(adapter.getCurrentIntervalMs()).toBe(480_000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('disabled recovers when the credentials file appears', async () => {
    mockStat
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValue({ mtimeMs: 1 } as Awaited<ReturnType<typeof stat>>);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ seven_day: { utilization: 10, resets_at: '2026-07-26T00:00:00Z' } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    expect(await adapter.poll()).toBe(false);
    expect(adapter.getState()).toBe('disabled');
    expect(await adapter.poll()).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();

    mockReadFile.mockResolvedValue(JSON.stringify({
      claudeAiOauth: { accessToken: 'new-token' },
    }));
    expect(await adapter.poll()).toBe(true);
    expect(adapter.getState()).toBe('healthy');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer new-token' }),
    }));
  });

  test('backoff decays after 3 consecutive successes', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({
      claudeAiOauth: { accessToken: 'test-token' },
    }));

    // First: trigger backoff with 429
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, headers: new Headers() }));
    await adapter.poll();
    expect(adapter.getCurrentIntervalMs()).toBe(240_000);

    // Then: 3 consecutive successes
    const successResponse = {
      ok: true,
      status: 200,
      json: async () => ({ five_hour: { utilization: 50, resets_at: '2026-01-01T00:00:00Z' } }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successResponse));

    await adapter.poll(); // success 1
    await adapter.poll(); // success 2
    await adapter.poll(); // success 3 — triggers decay

    expect(adapter.getCurrentIntervalMs()).toBe(120_000); // back to base
  });

  test('401 with token refresh retry — both attempts fail', async () => {
    // First readAccessToken returns 'old-token', then 'new-token' on re-read
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify({ claudeAiOauth: { accessToken: 'old-token' } }))
      .mockResolvedValueOnce(JSON.stringify({ claudeAiOauth: { accessToken: 'new-token' } }));

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401 })  // first fetch: 401
      .mockResolvedValueOnce({ ok: false, status: 401 }); // retry with new token: also 401
    vi.stubGlobal('fetch', mockFetch);

    const changed = await adapter.poll();

    expect(changed).toBe(false);
    expect(adapter.getState()).toBe('auth_failed');
    expect(adapter.getLastError()).toContain('re-read failed');
    // Verify both tokens were used
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('401 with token refresh that succeeds on retry', async () => {
    // First readAccessToken returns 'expired-token', then 'fresh-token' on re-read
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify({ claudeAiOauth: { accessToken: 'expired-token' } }))
      .mockResolvedValueOnce(JSON.stringify({ claudeAiOauth: { accessToken: 'fresh-token' } }));

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401 })  // first fetch: 401
      .mockResolvedValueOnce({                             // retry with fresh token: 200
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: { utilization: 42.0, resets_at: '2026-03-31T10:00:00+00:00' },
          seven_day: { utilization: 5.0, resets_at: '2026-04-06T00:00:00+00:00' },
        }),
      });
    vi.stubGlobal('fetch', mockFetch);

    const changed = await adapter.poll();

    expect(changed).toBe(true);
    expect(adapter.getState()).toBe('healthy');
    const quota = adapter.getLatest();
    expect(quota).not.toBeNull();
    expect(quota!.fiveHour).toEqual({ utilization: 42.0, resetsAt: '2026-03-31T10:00:00+00:00' });
    expect(quota!.sevenDay).toEqual({ utilization: 5.0, resetsAt: '2026-04-06T00:00:00+00:00' });
  });

  test('network error (fetch rejection) triggers backoff', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({
      claudeAiOauth: { accessToken: 'test-token' },
    }));

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const changed = await adapter.poll();

    expect(changed).toBe(false);
    expect(adapter.getState()).toBe('backoff');
    expect(adapter.getLastError()).toContain('ECONNREFUSED');
    expect(adapter.getLastError()).toContain('Network error');
    // Interval should have doubled from the base 120s
    expect(adapter.getCurrentIntervalMs()).toBe(240_000);
  });

  test('non-429/401 HTTP error (503) triggers backoff via handleResponse', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({
      claudeAiOauth: { accessToken: 'test-token' },
    }));

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    }));

    const changed = await adapter.poll();

    expect(changed).toBe(false);
    expect(adapter.getState()).toBe('backoff');
    expect(adapter.getLastError()).toContain('503');
  });

  describe('getLiveHeadroom (issue #1894)', () => {
    test('returns the fresh snapshot when the live poll succeeds', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        claudeAiOauth: { accessToken: 'test-token' },
      }));
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: { utilization: 12, resets_at: '2026-08-02T18:00:00Z' },
          seven_day: { utilization: 3, resets_at: '2026-08-09T00:00:00Z' },
        }),
      }));

      const live = await adapter.getLiveHeadroom();

      expect(live).not.toBeNull();
      expect(live!.fiveHour).toEqual({ utilization: 12, resetsAt: '2026-08-02T18:00:00Z' });
      expect(live!.sevenDay).toEqual({ utilization: 3, resetsAt: '2026-08-09T00:00:00Z' });
      // Same object reference as getLatest after a successful live poll.
      expect(live).toBe(adapter.getLatest());
    });

    test('returns null on poll failure — never a stale getLatest() snapshot', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        claudeAiOauth: { accessToken: 'test-token' },
      }));
      // Seed a successful poll so getLatest() is non-null (stale snapshot).
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: { utilization: 50, resets_at: '2026-08-02T12:00:00Z' },
          seven_day: null,
        }),
      }));
      expect(await adapter.poll()).toBe(true);
      expect(adapter.getLatest()).not.toBeNull();

      // Live poll fails (network) — admission must not see the stale 50%.
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
      const live = await adapter.getLiveHeadroom();

      expect(live).toBeNull();
      // Stale display snapshot remains available for the dashboard.
      expect(adapter.getLatest()?.fiveHour?.utilization).toBe(50);
    });
  });
});
