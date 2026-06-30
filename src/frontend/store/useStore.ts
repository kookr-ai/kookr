import { create } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { createAchievementsSystemSlice } from './slices/achievements-system-slice.js';
import { createProjectSidebarSlice } from './slices/project-sidebar-slice.js';
import { createTransportSessionSlice } from './slices/transport-session-slice.js';
import { createTriageNavigationSlice } from './slices/triage-navigation-slice.js';
import { createWorkspaceSlice } from './slices/workspace-slice.js';
import { createOssAttemptsSlice } from './slices/oss-attempts-slice.js';
import { createSystemStatusSlice } from './slices/system-status-slice.js';
import { createAutoAdvanceSlice, attachAutoAdvanceSubscribers } from './slices/auto-advance-slice.js';
import { clearSelectedTask, saveSelectedTask } from './selected-task-storage.js';
import { recordSelectionTransitionFromStore } from '../selection-transition-recorder.js';
import type {
  AchievementToast,
  Alert,
  AlertSeverity,
  LeftPane,
  NarrowTab,
  FocusZone,
  KookrStore,
  RelaunchTask,
  ResponseSuggestion,
  SentOverlay,
  StoreSet,
  TaskGitHub,
} from './store-types.js';
import { isDebugTimelineEnabled, recordStoreMutationDebugEvent } from '../debug-timeline.js';

export type {
  AchievementToast,
  Alert,
  AlertSeverity,
  LeftPane,
  NarrowTab,
  FocusZone,
  KookrStore,
  RelaunchTask,
  ResponseSuggestion,
  SentOverlay,
  TaskGitHub,
};

function persistSelectedTaskChange(before: KookrStore, after: KookrStore): void {
  if (
    before.selectedAgentId === after.selectedAgentId
    && before.selectedTaskId === after.selectedTaskId
  ) {
    return;
  }

  if (!after.selectedAgentId) {
    clearSelectedTask();
    return;
  }

  saveSelectedTask(after.selectedTaskId, after.selectedAgentId);
}

function createKookrStoreState(
  set: (fn: Partial<KookrStore> | ((s: KookrStore) => Partial<KookrStore>)) => void,
  get: () => KookrStore,
): KookrStore {
  const tracedSet: StoreSet = (partial) => {
    const before = get();
    let resolved: Partial<KookrStore> | undefined;

    if (typeof partial === 'function') {
      set((state) => {
        resolved = partial(state);
        return resolved;
      });
    } else {
      resolved = partial;
      set(partial);
    }

    const after = get();
    persistSelectedTaskChange(before, after);

    const changedKeys = Object.keys(resolved ?? {});
    recordSelectionTransitionFromStore(before, after, changedKeys);

    if (!isDebugTimelineEnabled()) return;

    if (changedKeys.length === 0) return;
    recordStoreMutationDebugEvent(before.agents, after.agents, changedKeys, resolved as Record<string, unknown>);
  };

  return {
    ...createTransportSessionSlice(tracedSet, get),
    ...createTriageNavigationSlice(tracedSet, get),
    ...createProjectSidebarSlice(tracedSet, get),
    ...createAchievementsSystemSlice(tracedSet, get),
    ...createWorkspaceSlice(tracedSet, get),
    ...createOssAttemptsSlice(tracedSet, get),
    ...createSystemStatusSlice(tracedSet),
    ...createAutoAdvanceSlice(tracedSet, get),
  };
}

/** Vanilla store factory — used in tests */
export function createKookrStore() {
  return createStore<KookrStore>(createKookrStoreState);
}

/** React hook — used in components */
export const useKookrStore = create<KookrStore>(createKookrStoreState);

// Wire up the auto-advance subscriber to the singleton store. Tests using
// `createKookrStore()` get an isolated store with no subscriber; they
// exercise `evaluateAutoAdvance` directly. The singleton attach is guarded
// inside `attachAutoAdvanceSubscribers` so SSR / Node imports are safe.
attachAutoAdvanceSubscribers(useKookrStore);
