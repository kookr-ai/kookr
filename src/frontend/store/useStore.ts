import { create } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { createAchievementsSystemSlice } from './slices/achievements-system-slice.js';
import { createProjectSidebarSlice } from './slices/project-sidebar-slice.js';
import { createTransportSessionSlice } from './slices/transport-session-slice.js';
import { createTriageNavigationSlice } from './slices/triage-navigation-slice.js';
import { createWorkspaceSlice } from './slices/workspace-slice.js';
import { createOssAttemptsSlice } from './slices/oss-attempts-slice.js';
import { createSystemStatusSlice } from './slices/system-status-slice.js';
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
  TaskGitHub,
} from './store-types.js';

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

function createKookrStoreState(
  set: (fn: Partial<KookrStore> | ((s: KookrStore) => Partial<KookrStore>)) => void,
  get: () => KookrStore,
): KookrStore {
  return {
    ...createTransportSessionSlice(set),
    ...createTriageNavigationSlice(set, get),
    ...createProjectSidebarSlice(set, get),
    ...createAchievementsSystemSlice(set, get),
    ...createWorkspaceSlice(set, get),
    ...createOssAttemptsSlice(set, get),
    ...createSystemStatusSlice(set),
  };
}

/** Vanilla store factory — used in tests */
export function createKookrStore() {
  return createStore<KookrStore>(createKookrStoreState);
}

/** React hook — used in components */
export const useKookrStore = create<KookrStore>(createKookrStoreState);
