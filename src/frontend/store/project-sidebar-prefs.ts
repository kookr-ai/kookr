import type { ProjectSummary } from '../../shared/protocol.js';
import {
  DEFAULT_PROJECT_SIDEBAR_PREFS,
  type ProjectSidebarCatalogEntry,
  type ProjectSidebarPrefs,
  type ProjectSidebarState,
} from '../../shared/project-sidebar.js';

export type { ProjectSidebarCatalogEntry, ProjectSidebarPrefs };

export const PROJECT_SIDEBAR_PREFS_KEY = 'kookr:projectSidebarPrefs';
export const PROJECT_SIDEBAR_CATALOG_KEY = 'kookr:projectSidebarCatalog';

interface ProjectSidebarPrefsV1 {
  version?: 1;
  ordered?: unknown;
  hidden?: unknown;
}

interface ProjectSidebarPrefsV2Raw {
  version?: 2;
  ordered?: unknown;
  pinned?: unknown;
  hidden?: unknown;
}

export interface ProjectSidebarRow {
  project: string;
  displayName: string;
  color: number;
  hidden: boolean;
  offline: boolean;
  pinned: boolean;
  summary: ProjectSummary | null;
}

export interface ProjectSidebarDerivedState {
  visibleProjects: ProjectSummary[];
  managerRows: ProjectSidebarRow[];
  hasRecoveryShell: boolean;
}

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem'>;
type DropPosition = 'before' | 'after';

function getStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    if (seen.has(item)) continue;
    seen.add(item);
    normalized.push(item);
  }
  return normalized;
}

function normalizePrefs(raw: ProjectSidebarPrefsV1 | ProjectSidebarPrefsV2Raw | null | undefined): ProjectSidebarPrefs {
  return {
    version: 2,
    ordered: normalizeIds(raw?.ordered),
    pinned: normalizeIds((raw as ProjectSidebarPrefsV2Raw | undefined)?.pinned),
    hidden: normalizeIds(raw?.hidden),
  };
}

function orderMembership(ids: string[], membership: Iterable<string>): string[] {
  const membershipSet = new Set(membership);
  return ids.filter((id) => membershipSet.has(id));
}

function liveIdSet(projects: ProjectSummary[]): Set<string> {
  return new Set(projects.map((project) => project.project));
}

function buildOrderedIds(
  projects: ProjectSummary[],
  prefs: ProjectSidebarPrefs,
  catalog: Record<string, ProjectSidebarCatalogEntry>,
): string[] {
  const liveIds = projects.map((project) => project.project);
  const knownIds = Object.keys(catalog);
  return normalizeIds([...prefs.ordered, ...liveIds, ...knownIds]);
}

function buildVisibleSectionIds(
  orderedIds: string[],
  projects: ProjectSummary[],
  hiddenIds: Iterable<string>,
  pinnedIds: Iterable<string>,
) {
  const live = liveIdSet(projects);
  const hidden = new Set(hiddenIds);
  const pinned = new Set(pinnedIds);
  const visibleIds = orderedIds.filter((id) => live.has(id) && !hidden.has(id));
  return {
    pinnedVisibleIds: visibleIds.filter((id) => pinned.has(id)),
    unpinnedVisibleIds: visibleIds.filter((id) => !pinned.has(id)),
  };
}

function replaceVisibleOrder(orderedIds: string[], visibleIds: string[], nextVisibleIds: string[]): string[] {
  const visibleSet = new Set(visibleIds);
  const iterator = nextVisibleIds[Symbol.iterator]();
  const replaced = orderedIds.map((id) => {
    if (!visibleSet.has(id)) return id;
    return iterator.next().value as string;
  });
  const remaining = nextVisibleIds.filter((id) => !replaced.includes(id));
  return normalizeIds([...replaced, ...remaining]);
}

function upsertProjectInOrder(
  orderedIds: string[],
  project: string,
): string[] {
  return orderedIds.includes(project) ? orderedIds : [...orderedIds, project];
}

function togglePinnedMembership(
  orderedIds: string[],
  pinnedIds: string[],
  project: string,
  shouldPin: boolean,
): string[] {
  const nextSet = new Set(pinnedIds);
  if (shouldPin) nextSet.add(project);
  else nextSet.delete(project);
  return orderMembership(orderedIds, nextSet);
}

export function loadProjectSidebarPrefs(storage: ReadStorage | null = getStorage()): ProjectSidebarPrefs {
  if (!storage) return { ...DEFAULT_PROJECT_SIDEBAR_PREFS };
  try {
    const raw = storage.getItem(PROJECT_SIDEBAR_PREFS_KEY);
    if (!raw) return { ...DEFAULT_PROJECT_SIDEBAR_PREFS };
    const parsed = JSON.parse(raw) as ProjectSidebarPrefsV1 | ProjectSidebarPrefsV2Raw;
    return normalizePrefs(parsed);
  } catch {
    return { ...DEFAULT_PROJECT_SIDEBAR_PREFS };
  }
}

export function saveProjectSidebarPrefs(
  prefs: ProjectSidebarPrefs,
  storage: WriteStorage | null = getStorage(),
): Error | null {
  if (!storage) return new Error('localStorage unavailable');
  try {
    storage.setItem(PROJECT_SIDEBAR_PREFS_KEY, JSON.stringify(normalizePrefs(prefs)));
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function isValidCatalogEntry(value: unknown): value is ProjectSidebarCatalogEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.project === 'string'
    && typeof row.displayName === 'string'
    && typeof row.color === 'number'
    && Number.isFinite(row.color)
    && typeof row.lastSeenAt === 'string';
}

export function loadProjectSidebarCatalog(
  storage: ReadStorage | null = getStorage(),
): Record<string, ProjectSidebarCatalogEntry> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(PROJECT_SIDEBAR_CATALOG_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const catalog: Record<string, ProjectSidebarCatalogEntry> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!isValidCatalogEntry(value)) continue;
      catalog[key] = value;
    }
    return catalog;
  } catch {
    return {};
  }
}

export function saveProjectSidebarCatalog(
  catalog: Record<string, ProjectSidebarCatalogEntry>,
  storage: WriteStorage | null = getStorage(),
): Error | null {
  if (!storage) return new Error('localStorage unavailable');
  try {
    storage.setItem(PROJECT_SIDEBAR_CATALOG_KEY, JSON.stringify(catalog));
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

export function toProjectSidebarState(
  prefs: ProjectSidebarPrefs,
  catalog: Record<string, ProjectSidebarCatalogEntry>,
): ProjectSidebarState {
  const normalized = normalizePrefs(prefs);
  return {
    version: 1,
    ordered: normalized.ordered,
    pinned: normalized.pinned,
    hidden: normalized.hidden,
    catalog,
  };
}

export function prefsFromProjectSidebarState(state: ProjectSidebarState): ProjectSidebarPrefs {
  return normalizePrefs({
    version: 2,
    ordered: state.ordered,
    pinned: state.pinned,
    hidden: state.hidden,
  });
}

/**
 * Forget a project from catalog + preferences. Used when the user untracks a
 * repo so that it doesn't linger as an "Offline" row after the backend stops
 * sending it. If the next WS broadcast still includes the project (e.g. skill
 * discovery kept it alive), it will be re-added automatically.
 */
export function forgetProjectFromSidebar(
  prefs: ProjectSidebarPrefs,
  catalog: Record<string, ProjectSidebarCatalogEntry>,
  project: string,
): { prefs: ProjectSidebarPrefs; catalog: Record<string, ProjectSidebarCatalogEntry> } {
  const normalized = normalizePrefs(prefs);
  const nextPrefs: ProjectSidebarPrefs = {
    version: 2,
    ordered: normalized.ordered.filter((id) => id !== project),
    pinned: normalized.pinned.filter((id) => id !== project),
    hidden: normalized.hidden.filter((id) => id !== project),
  };
  let nextCatalog = catalog;
  if (project in catalog) {
    const { [project]: _removed, ...rest } = catalog;
    nextCatalog = rest;
  }
  return { prefs: nextPrefs, catalog: nextCatalog };
}

export function updateProjectSidebarCatalog(
  catalog: Record<string, ProjectSidebarCatalogEntry>,
  projects: ProjectSummary[],
  now = new Date().toISOString(),
): Record<string, ProjectSidebarCatalogEntry> {
  if (projects.length === 0) return catalog;
  let changed = false;
  const next = { ...catalog };
  for (const project of projects) {
    const existing = next[project.project];
    if (existing && existing.displayName === project.displayName && existing.color === project.color) {
      continue;
    }
    changed = true;
    next[project.project] = {
      project: project.project,
      displayName: project.displayName,
      color: project.color,
      lastSeenAt: now,
    };
  }
  return changed ? next : catalog;
}

export function deriveAllProjectIds(
  projects: ProjectSummary[],
  prefs: ProjectSidebarPrefs,
  catalog: Record<string, ProjectSidebarCatalogEntry>,
): string[] {
  return buildOrderedIds(projects, normalizePrefs(prefs), catalog);
}

export function deriveProjectSidebarState(
  projects: ProjectSummary[],
  prefs: ProjectSidebarPrefs,
  catalog: Record<string, ProjectSidebarCatalogEntry>,
): ProjectSidebarDerivedState {
  const normalized = normalizePrefs(prefs);
  const orderedIds = buildOrderedIds(projects, normalized, catalog);
  const hidden = new Set(normalized.hidden);
  const pinned = new Set(normalized.pinned);
  const liveByProject = new Map(projects.map((project) => [project.project, project]));
  const { pinnedVisibleIds, unpinnedVisibleIds } = buildVisibleSectionIds(orderedIds, projects, hidden, pinned);

  const visibleProjects = [...pinnedVisibleIds, ...unpinnedVisibleIds]
    .map((projectId) => liveByProject.get(projectId))
    .filter((project): project is ProjectSummary => project !== undefined);

  const managerRows: ProjectSidebarRow[] = [];

  for (const projectId of orderedIds) {
    const summary = liveByProject.get(projectId) ?? null;
    const cached = catalog[projectId];
    if (!summary && !cached) continue;

    managerRows.push({
      project: projectId,
      displayName: summary?.displayName ?? cached?.displayName ?? projectId,
      color: summary?.color ?? cached?.color ?? 0,
      hidden: hidden.has(projectId),
      offline: summary === null,
      pinned: pinned.has(projectId),
      summary,
    });
  }

  return {
    visibleProjects,
    managerRows,
    hasRecoveryShell: projects.length > 0 || managerRows.length > 0,
  };
}

export function pinProjectToTop(
  prefs: ProjectSidebarPrefs,
  project: string,
  projects: ProjectSummary[],
  catalog: Record<string, ProjectSidebarCatalogEntry>,
): ProjectSidebarPrefs {
  const normalized = normalizePrefs(prefs);
  const orderedIds = upsertProjectInOrder(buildOrderedIds(projects, normalized, catalog), project);
  const hidden = normalized.hidden.filter((id) => id !== project);
  const live = liveIdSet(projects);
  const hiddenSet = new Set(hidden);
  const visibleIds = orderedIds.filter((id) => live.has(id) && !hiddenSet.has(id));
  const { pinnedVisibleIds, unpinnedVisibleIds } = buildVisibleSectionIds(orderedIds, projects, hidden, normalized.pinned);
  const nextOrdered = live.has(project)
    ? replaceVisibleOrder(orderedIds, visibleIds, [
      project,
      ...pinnedVisibleIds.filter((id) => id !== project),
      ...unpinnedVisibleIds.filter((id) => id !== project),
    ])
    : orderedIds;

  return {
    version: 2,
    ordered: nextOrdered,
    pinned: togglePinnedMembership(nextOrdered, normalized.pinned, project, true),
    hidden,
  };
}

export function unpinProjectInPrefs(
  prefs: ProjectSidebarPrefs,
  project: string,
  projects: ProjectSummary[],
  catalog: Record<string, ProjectSidebarCatalogEntry>,
): ProjectSidebarPrefs {
  const normalized = normalizePrefs(prefs);
  const orderedIds = buildOrderedIds(projects, normalized, catalog);
  return {
    version: 2,
    ordered: orderedIds,
    pinned: togglePinnedMembership(orderedIds, normalized.pinned, project, false),
    hidden: [...normalized.hidden],
  };
}

export function hideProjectInPrefs(
  prefs: ProjectSidebarPrefs,
  project: string,
  projects: ProjectSummary[],
  catalog: Record<string, ProjectSidebarCatalogEntry>,
): ProjectSidebarPrefs {
  const normalized = normalizePrefs(prefs);
  const orderedIds = upsertProjectInOrder(buildOrderedIds(projects, normalized, catalog), project);
  return {
    version: 2,
    ordered: orderedIds,
    pinned: orderMembership(orderedIds, normalized.pinned),
    hidden: normalizeIds([...normalized.hidden, project]),
  };
}

export function showProjectInPrefs(
  prefs: ProjectSidebarPrefs,
  project: string,
  projects: ProjectSummary[],
  catalog: Record<string, ProjectSidebarCatalogEntry>,
): ProjectSidebarPrefs {
  const normalized = normalizePrefs(prefs);
  const orderedIds = upsertProjectInOrder(buildOrderedIds(projects, normalized, catalog), project);
  return {
    version: 2,
    ordered: orderedIds,
    pinned: orderMembership(orderedIds, normalized.pinned),
    hidden: normalized.hidden.filter((id) => id !== project),
  };
}

export function moveVisibleProjectInPrefs(
  prefs: ProjectSidebarPrefs,
  project: string,
  direction: 'up' | 'down',
  projects: ProjectSummary[],
  catalog: Record<string, ProjectSidebarCatalogEntry>,
): ProjectSidebarPrefs {
  const normalized = normalizePrefs(prefs);
  const orderedIds = buildOrderedIds(projects, normalized, catalog);
  const { pinnedVisibleIds, unpinnedVisibleIds } = buildVisibleSectionIds(orderedIds, projects, normalized.hidden, normalized.pinned);
  const pinned = new Set(normalized.pinned);
  const currentSection = pinned.has(project) ? pinnedVisibleIds : unpinnedVisibleIds;
  const currentIdx = currentSection.indexOf(project);
  if (currentIdx < 0) return normalized;

  const targetIdx = direction === 'up' ? currentIdx - 1 : currentIdx + 1;
  if (targetIdx < 0 || targetIdx >= currentSection.length) return normalized;

  const nextSection = [...currentSection];
  [nextSection[currentIdx], nextSection[targetIdx]] = [nextSection[targetIdx], nextSection[currentIdx]];
  const visibleIds = [...pinnedVisibleIds, ...unpinnedVisibleIds];
  const nextVisibleIds = pinned.has(project)
    ? [...nextSection, ...unpinnedVisibleIds]
    : [...pinnedVisibleIds, ...nextSection];
  const nextOrdered = replaceVisibleOrder(orderedIds, visibleIds, nextVisibleIds);

  return {
    version: 2,
    ordered: nextOrdered,
    pinned: orderMembership(nextOrdered, normalized.pinned),
    hidden: [...normalized.hidden],
  };
}

export function reorderVisibleProjectInPrefs(
  prefs: ProjectSidebarPrefs,
  project: string,
  targetPinned: boolean,
  targetProject: string | null,
  position: DropPosition,
  projects: ProjectSummary[],
  catalog: Record<string, ProjectSidebarCatalogEntry>,
): ProjectSidebarPrefs {
  const normalized = normalizePrefs(prefs);
  const orderedIds = buildOrderedIds(projects, normalized, catalog);
  const hidden = new Set(normalized.hidden);
  const visibleIds = orderedIds.filter((id) => liveIdSet(projects).has(id) && !hidden.has(id));
  if (!visibleIds.includes(project)) return normalized;

  const { pinnedVisibleIds, unpinnedVisibleIds } = buildVisibleSectionIds(orderedIds, projects, normalized.hidden, normalized.pinned);
  const currentPinned = [...pinnedVisibleIds];
  const currentUnpinned = [...unpinnedVisibleIds];

  const removeFrom = currentPinned.includes(project) ? currentPinned : currentUnpinned;
  removeFrom.splice(removeFrom.indexOf(project), 1);

  const targetSection = targetPinned ? currentPinned : currentUnpinned;
  const insertAt = targetProject === null
    ? targetSection.length
    : (() => {
      const targetIdx = targetSection.indexOf(targetProject);
      if (targetIdx < 0) return targetSection.length;
      return position === 'before' ? targetIdx : targetIdx + 1;
    })();

  targetSection.splice(insertAt, 0, project);

  const nextVisibleIds = [...currentPinned, ...currentUnpinned];
  const nextOrdered = replaceVisibleOrder(orderedIds, visibleIds, nextVisibleIds);
  const nextPinned = togglePinnedMembership(nextOrdered, normalized.pinned, project, targetPinned);

  return {
    version: 2,
    ordered: nextOrdered,
    pinned: nextPinned,
    hidden: [...normalized.hidden],
  };
}

export function resetProjectSidebarPrefs(): ProjectSidebarPrefs {
  return { ...DEFAULT_PROJECT_SIDEBAR_PREFS };
}
