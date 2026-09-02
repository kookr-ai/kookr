import type { CompletedHistorySlice, StoreGet, StoreSet } from '../store-types.js';
import { getArchivedTasks } from '../../api/tasks.js';
import { archivedTaskToAgentState } from '../../presentation.js';
import {
  COMPLETED_HISTORY_PAGE_LIMIT,
  MAX_EMPTY_ARCHIVE_PAGE_SKIPS,
  archiveErrorMessage,
  oldestLiveCompletedMs,
} from '../../completed-history.js';

export function createCompletedHistorySlice(set: StoreSet, get: StoreGet): CompletedHistorySlice {
  return {
    archivedAgents: [],
    archiveNextCursor: null,
    archiveBeforeMs: null,
    archiveHasMore: true,
    archiveLoading: false,
    archiveError: null,
    archiveLoadedOnce: false,
    archiveRequestId: 0,

    loadOlderHistory: async () => {
      const state = get();
      if (state.archiveLoading) return;
      if (state.archiveLoadedOnce && !state.archiveHasMore && !state.archiveError) return;

      const requestId = state.archiveRequestId + 1;
      set({
        archiveLoading: true,
        archiveError: null,
        archiveRequestId: requestId,
      });

      try {
        let cursor = get().archiveNextCursor;
        let beforeMs = get().archiveBeforeMs;
        if (beforeMs === null && cursor === null) {
          beforeMs = oldestLiveCompletedMs(get().agents);
        }

        const accumulated = [...get().archivedAgents];
        // Only skip ids already in the archive slice. Live snapshot overlap is
        // hidden at display time so a row can reappear after it ages out of
        // the bounded snapshot.
        const seen = new Set<string>(
          accumulated.flatMap((agent) => (agent.taskId ? [agent.taskId] : [])),
        );

        let nextCursor = cursor;
        let hasMore = get().archiveHasMore;
        let emptySkips = 0;

        while (true) {
          const page = await getArchivedTasks({
            limit: COMPLETED_HISTORY_PAGE_LIMIT,
            ...(cursor ? { cursor } : {}),
            ...(beforeMs !== null ? { before: beforeMs } : {}),
          });
          if (get().archiveRequestId !== requestId) return;

          let added = 0;
          for (const record of page.records) {
            const agent = archivedTaskToAgentState(record);
            if (!agent?.taskId || seen.has(agent.taskId)) continue;
            seen.add(agent.taskId);
            accumulated.push(agent);
            added += 1;
          }

          nextCursor = page.nextCursor ?? null;
          hasMore = Boolean(page.nextCursor);
          cursor = nextCursor;
          if (added > 0 || !hasMore || emptySkips >= MAX_EMPTY_ARCHIVE_PAGE_SKIPS) break;
          emptySkips += 1;
        }

        if (get().archiveRequestId !== requestId) return;
        set({
          archivedAgents: accumulated,
          archiveNextCursor: nextCursor,
          archiveBeforeMs: beforeMs,
          archiveHasMore: hasMore,
          archiveLoadedOnce: true,
          archiveLoading: false,
          archiveError: null,
        });
      } catch (err) {
        if (get().archiveRequestId !== requestId) return;
        set({
          archiveLoading: false,
          archiveError: archiveErrorMessage(err),
          archiveLoadedOnce: true,
          archiveHasMore: true,
        });
      }
    },
  };
}
