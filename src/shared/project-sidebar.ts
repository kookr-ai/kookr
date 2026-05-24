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

export interface ProjectPriorityInput {
  project: string;
}

/**
 * Derive a stable project-priority rank from persisted sidebar state.
 *
 * Hidden projects are intentionally skipped. Ordered visible projects are the
 * only ranked projects; unordered projects remain unranked so priority
 * consumers do not inherit dynamic "findings first" server summary order as an
 * implicit priority signal.
 */
export function deriveProjectPriorityRanks(
  projects: readonly ProjectPriorityInput[],
  prefs: Pick<ProjectSidebarPrefs, 'ordered' | 'pinned' | 'hidden'> = DEFAULT_PROJECT_SIDEBAR_PREFS,
): Map<string, number> {
  const live = new Map(projects.map((project) => [project.project, project]));
  const hidden = new Set(prefs.hidden);
  const pinned = new Set(prefs.pinned);
  const rankedIds: string[] = [];
  const seen = new Set<string>();
  const orderedVisibleIds: string[] = [];

  for (const projectId of prefs.ordered) {
    if (!live.has(projectId) || hidden.has(projectId) || seen.has(projectId)) continue;
    seen.add(projectId);
    orderedVisibleIds.push(projectId);
  }

  rankedIds.push(
    ...orderedVisibleIds.filter((projectId) => pinned.has(projectId)),
    ...orderedVisibleIds.filter((projectId) => !pinned.has(projectId)),
  );

  return new Map(rankedIds.map((projectId, index) => [projectId, index]));
}
