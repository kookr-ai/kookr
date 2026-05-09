export const PROJECT_SIDEBAR_STATE_VERSION = 1;

export interface ProjectSidebarPrefs {
  version: 2;
  ordered: string[];
  pinned: string[];
  hidden: string[];
}

export interface ProjectSidebarCatalogEntry {
  project: string;
  displayName: string;
  color: number;
  lastSeenAt: string;
}

export interface ProjectSidebarState {
  version: typeof PROJECT_SIDEBAR_STATE_VERSION;
  ordered: string[];
  pinned: string[];
  hidden: string[];
  catalog: Record<string, ProjectSidebarCatalogEntry>;
}

export const DEFAULT_PROJECT_SIDEBAR_PREFS: ProjectSidebarPrefs = {
  version: 2,
  ordered: [],
  pinned: [],
  hidden: [],
};

export const DEFAULT_PROJECT_SIDEBAR_STATE: ProjectSidebarState = {
  version: PROJECT_SIDEBAR_STATE_VERSION,
  ordered: [],
  pinned: [],
  hidden: [],
  catalog: {},
};
