import type { OssAttemptsSlice, StoreGet, StoreSet } from '../store-types.js';

interface RefreshResponse {
  ok: boolean;
  reposProcessed: number;
  reposTotal: number;
  errors: Array<{ repo: string; message: string }>;
  truncated: string[];
  partial: boolean;
}

export function createOssAttemptsSlice(set: StoreSet, get: StoreGet): OssAttemptsSlice {
  return {
    ossAttempts: [],
    ossLastRefreshAt: null,
    ossShowView: false,
    ossRefreshLoading: false,
    ossRefreshError: null,
    ossTruncatedRepos: [],
    ossLastRefreshIssueCheckErrors: [],

    handleOssAttempts: (snapshot) => {
      set({
        ossAttempts: snapshot.attempts,
        ossLastRefreshAt: snapshot.lastRefreshAt,
        ossLastRefreshIssueCheckErrors: snapshot.lastRefreshIssueCheckErrors ?? [],
      });
    },

    toggleOssView: () => {
      const showing = !get().ossShowView;
      set({ ossShowView: showing });
      if (showing) {
        // Fetch fresh snapshot on open — cheap GET, no gh calls
        void get().fetchOssAttempts();
      }
    },

    closeOssView: () => {
      set({ ossShowView: false });
    },

    fetchOssAttempts: async () => {
      try {
        const res = await fetch('/api/oss-attempts');
        if (!res.ok) throw new Error(`GET /api/oss-attempts → ${res.status}`);
        const snapshot = (await res.json()) as OssAttemptsSnapshot;
        get().handleOssAttempts(snapshot);
      } catch (e) {
        set({ ossRefreshError: (e as Error).message });
      }
    },

    refreshOssAttempts: async () => {
      set({ ossRefreshLoading: true, ossRefreshError: null });
      try {
        const res = await fetch('/api/oss-attempts/refresh', { method: 'POST' });
        if (!res.ok) {
          throw new Error(`POST /api/oss-attempts/refresh → ${res.status}`);
        }
        const result = (await res.json()) as RefreshResponse;
        set({
          ossTruncatedRepos: result.truncated ?? [],
          ossRefreshError: result.errors.length > 0
            ? `${result.errors.length} repo(s) errored${result.partial ? ' (partial refresh)' : ''}`
            : null,
        });
        // Server broadcasts ossAttempts after the refresh — the WS handler
        // will call handleOssAttempts. Also fetch as a safety net in case
        // the browser missed the WS message.
        await get().fetchOssAttempts();
      } catch (e) {
        set({ ossRefreshError: (e as Error).message });
      } finally {
        set({ ossRefreshLoading: false });
      }
    },
  };
}
