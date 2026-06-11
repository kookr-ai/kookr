// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createKookrStore } from '../useStore.js';

describe('discovery + track actions', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('fetchDiscoveryStatus stores snapshot from server', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        projects: ['github.com/a/b'],
        warnings: ['foo-recon: bad'],
        scannedAt: '2026-04-05T10:00:00.000Z',
      }),
    });
    const store = createKookrStore();
    await store.getState().fetchDiscoveryStatus();
    const status = store.getState().discoveryStatus;
    expect(status?.projects).toEqual(['github.com/a/b']);
    expect(status?.warnings).toEqual(['foo-recon: bad']);
  });

  test('fetchDiscoveryStatus on HTTP error records lastError', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    const store = createKookrStore();
    await store.getState().fetchDiscoveryStatus();
    expect(store.getState().discoveryStatus?.lastError).toContain('500');
  });

  test('fetchDiscoveryStatus on network error records lastError', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const store = createKookrStore();
    await store.getState().fetchDiscoveryStatus();
    expect(store.getState().discoveryStatus?.lastError).toBe('offline');
  });

  test('rescanSkills posts and updates snapshot', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ projects: ['github.com/x/y'], warnings: [] }),
    });
    const store = createKookrStore();
    await store.getState().rescanSkills();
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/rescan-skills', { method: 'POST' });
    expect(store.getState().discoveryStatus?.projects).toEqual(['github.com/x/y']);
    expect(store.getState().discoveryBusy).toBe(false);
  });

  test('rescanSkills on server error preserves busy=false and records lastError', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    const store = createKookrStore();
    await store.getState().rescanSkills();
    expect(store.getState().discoveryStatus?.lastError).toContain('503');
    expect(store.getState().discoveryBusy).toBe(false);
  });

  test('hydrateProjectSidebarFromServer applies persisted sidebar state', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        version: 1,
        ordered: ['github.com/a/repo', 'github.com/b/repo'],
        pinned: ['github.com/b/repo'],
        hidden: ['github.com/a/repo'],
        catalog: {
          'github.com/b/repo': {
            project: 'github.com/b/repo',
            displayName: 'b/repo',
            color: 2,
            lastSeenAt: '2026-05-09T00:00:00.000Z',
          },
        },
      }),
    });
    const store = createKookrStore();
    store.getState().handleProjectSummaries([
      {
        project: 'github.com/a/repo',
        displayName: 'a/repo',
        color: 1,
        activeAgents: 0,
        findingCount: 0,
        todayPrCount: 0,
        weekPrCount: 0,
        openContributionAttempts: 0,
        recentTasks: [],
      },
      {
        project: 'github.com/b/repo',
        displayName: 'b/repo',
        color: 2,
        activeAgents: 0,
        findingCount: 0,
        todayPrCount: 0,
        weekPrCount: 0,
        openContributionAttempts: 0,
        recentTasks: [],
      },
    ]);

    await store.getState().hydrateProjectSidebarFromServer();

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/sidebar');
    expect(store.getState().projectSidebarServerHydrated).toBe(true);
    expect(store.getState().projectSidebarPrefs.pinned).toEqual(['github.com/b/repo']);
    expect(store.getState().visibleProjectSummaries.map((project) => project.project)).toEqual([
      'github.com/b/repo',
    ]);
  });

  test('hydrateProjectSidebarFromServer migrates local prefs when server is empty', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          version: 1,
          ordered: [],
          pinned: [],
          hidden: [],
          catalog: {},
        }),
      })
      .mockResolvedValueOnce({ ok: true });
    const store = createKookrStore();
    store.getState().handleProjectSummaries([
      {
        project: 'github.com/a/repo',
        displayName: 'a/repo',
        color: 1,
        activeAgents: 0,
        findingCount: 0,
        todayPrCount: 0,
        weekPrCount: 0,
        openContributionAttempts: 0,
        recentTasks: [],
      },
    ]);
    store.getState().pinProjectToTop('github.com/a/repo');

    await store.getState().hydrateProjectSidebarFromServer();

    const put = fetchMock.mock.calls.find((call) => call[0] === '/api/projects/sidebar' && call[1]?.method === 'PUT');
    expect(put).toBeDefined();
    expect(JSON.parse(put![1].body)).toEqual(expect.objectContaining({
      ordered: ['github.com/a/repo'],
      pinned: ['github.com/a/repo'],
    }));
  });

  test('pinProjectToTop writes to server after hydration', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          version: 1,
          ordered: [],
          pinned: [],
          hidden: [],
          catalog: {},
        }),
      })
      .mockResolvedValue({ ok: true });
    const store = createKookrStore();
    store.getState().handleProjectSummaries([
      {
        project: 'github.com/a/repo',
        displayName: 'a/repo',
        color: 1,
        activeAgents: 0,
        findingCount: 0,
        todayPrCount: 0,
        weekPrCount: 0,
        openContributionAttempts: 0,
        recentTasks: [],
      },
    ]);
    await store.getState().hydrateProjectSidebarFromServer();
    fetchMock.mockClear();

    store.getState().pinProjectToTop('github.com/a/repo');

    const put = fetchMock.mock.calls.find((call) => call[0] === '/api/projects/sidebar' && call[1]?.method === 'PUT');
    expect(put).toBeDefined();
    expect(JSON.parse(put![1].body)).toEqual(expect.objectContaining({
      pinned: ['github.com/a/repo'],
    }));
  });

  test('trackOssProject rejects malformed input without calling fetch', async () => {
    const store = createKookrStore();
    const res = await store.getState().trackOssProject('not-valid');
    expect(res).toEqual({
      ok: false,
      error: 'Enter a valid owner/repo (e.g. "grafana/grafana")',
    });
    expect(store.getState().trackOssError).toBe('Enter a valid owner/repo (e.g. "grafana/grafana")');
    expect(store.getState().trackOssBusy).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('trackOssProject posts normalized slug and clears error on success', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ project: 'github.com/a/b' }),
    });
    const store = createKookrStore();
    const res = await store.getState().trackOssProject('A/B');
    expect(res.ok).toBe(true);
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe('/api/projects/track');
    const body = JSON.parse(call[1].body);
    expect(body.repo).toBe('a/b');
    expect(store.getState().trackOssError).toBeNull();
    expect(store.getState().trackOssBusy).toBe(false);
  });

  test('trackOssProject surfaces server error body', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'repo must be in owner/repo format' }),
    });
    const store = createKookrStore();
    const res = await store.getState().trackOssProject('grafana/grafana');
    expect(res).toEqual({ ok: false, error: 'repo must be in owner/repo format' });
    expect(store.getState().trackOssError).toBe('repo must be in owner/repo format');
    expect(store.getState().trackOssBusy).toBe(false);
  });

  test('trackOssProject falls back to HTTP <status> when body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => { throw new Error('not json'); },
    });
    const store = createKookrStore();
    const res = await store.getState().trackOssProject('grafana/grafana');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('502');
    expect(store.getState().trackOssBusy).toBe(false);
  });

  test('trackOssProject records network errors and resets busy', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const store = createKookrStore();
    const res = await store.getState().trackOssProject('grafana/grafana');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('offline');
    expect(store.getState().trackOssError).toBe('offline');
    expect(store.getState().trackOssBusy).toBe(false);
  });

  test('untrackOssProject rejects malformed input without calling fetch', async () => {
    const store = createKookrStore();
    const res = await store.getState().untrackOssProject('not-valid');
    expect(res).toEqual({
      ok: false,
      error: 'Enter a valid owner/repo (e.g. "grafana/grafana")',
    });
    expect(store.getState().untrackOssError).toBe('Enter a valid owner/repo (e.g. "grafana/grafana")');
    expect(store.getState().untrackOssBusy).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('untrackOssProject posts normalized slug and clears error on success', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ project: 'github.com/grafana/grafana', removed: true, config: null }),
    });
    const store = createKookrStore();
    const res = await store.getState().untrackOssProject('Grafana/Grafana');
    expect(res.ok).toBe(true);
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe('/api/projects/untrack');
    const body = JSON.parse(call[1].body);
    expect(body.repo).toBe('grafana/grafana');
    expect(store.getState().untrackOssError).toBeNull();
    expect(store.getState().untrackOssBusy).toBe(false);
  });

  test('untrackOssProject clears selected project when untracking the selected row', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ project: 'github.com/grafana/grafana', removed: true, config: null }),
    });
    const store = createKookrStore();
    store.getState().handleProjectSummaries([
      {
        project: 'github.com/grafana/grafana',
        displayName: 'grafana/grafana',
        color: 1,
        activeAgents: 0,
        findingCount: 0,
        todayPrCount: 0,
        weekPrCount: 0,
        openContributionAttempts: 0,
        recentTasks: [],
        tracked: true,
      },
    ]);
    store.getState().selectProject('github.com/grafana/grafana');
    expect(store.getState().selectedProject).toBe('github.com/grafana/grafana');

    const res = await store.getState().untrackOssProject('grafana/grafana');
    expect(res.ok).toBe(true);
    expect(store.getState().selectedProject).toBeNull();
  });

  test('untrackOssProject forgets project from sidebar prefs + catalog on success', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ project: 'github.com/grafana/grafana', removed: true, config: null }),
    });
    const store = createKookrStore();
    // Seed the project as a live summary so forgetting has something to clean.
    store.getState().handleProjectSummaries([
      {
        project: 'github.com/grafana/grafana',
        displayName: 'grafana/grafana',
        color: 1,
        activeAgents: 0,
        findingCount: 0,
        todayPrCount: 0,
        weekPrCount: 0,
        openContributionAttempts: 0,
        recentTasks: [],
        tracked: true,
      },
    ]);
    store.getState().pinProjectToTop('github.com/grafana/grafana');
    expect(store.getState().projectSidebarCatalog['github.com/grafana/grafana']).toBeDefined();
    expect(store.getState().projectSidebarPrefs.pinned).toContain('github.com/grafana/grafana');

    const res = await store.getState().untrackOssProject('grafana/grafana');
    expect(res.ok).toBe(true);

    expect(store.getState().projectSidebarCatalog['github.com/grafana/grafana']).toBeUndefined();
    expect(store.getState().projectSidebarPrefs.pinned).not.toContain('github.com/grafana/grafana');
    expect(store.getState().projectSidebarPrefs.ordered).not.toContain('github.com/grafana/grafana');
    expect(store.getState().projectSummaries).toHaveLength(0);
    expect(store.getState().visibleProjectSummaries).toHaveLength(0);
  });

  test('untrackOssProject surfaces server error body and leaves state unchanged', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'repo must be in owner/repo format' }),
    });
    const store = createKookrStore();
    store.getState().handleProjectSummaries([
      {
        project: 'github.com/grafana/grafana',
        displayName: 'grafana/grafana',
        color: 1,
        activeAgents: 0,
        findingCount: 0,
        todayPrCount: 0,
        weekPrCount: 0,
        openContributionAttempts: 0,
        recentTasks: [],
        tracked: true,
      },
    ]);
    const res = await store.getState().untrackOssProject('grafana/grafana');
    expect(res).toEqual({ ok: false, error: 'repo must be in owner/repo format' });
    expect(store.getState().untrackOssError).toBe('repo must be in owner/repo format');
    expect(store.getState().untrackOssBusy).toBe(false);
    // State should not be mutated when the server rejects.
    expect(store.getState().projectSummaries).toHaveLength(1);
    expect(store.getState().projectSidebarCatalog['github.com/grafana/grafana']).toBeDefined();
  });

  test('untrackOssProject records network errors and resets busy', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const store = createKookrStore();
    const res = await store.getState().untrackOssProject('grafana/grafana');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('offline');
    expect(store.getState().untrackOssError).toBe('offline');
    expect(store.getState().untrackOssBusy).toBe(false);
  });

  test('clearUntrackOssError resets the error', () => {
    const store = createKookrStore();
    store.setState({ untrackOssError: 'something broke' });
    store.getState().clearUntrackOssError();
    expect(store.getState().untrackOssError).toBeNull();
  });
});
