import { join } from 'node:path';
import { atomicWriteFile, readJsonFile } from './persistence-utils.js';
import {
  DEFAULT_PROJECT_SIDEBAR_STATE,
  PROJECT_SIDEBAR_STATE_VERSION,
  type ProjectSidebarCatalogEntry,
  type ProjectSidebarState,
} from '../shared/project-sidebar.js';

type ProjectSidebarRaw = {
  version?: unknown;
  ordered?: unknown;
  pinned?: unknown;
  hidden?: unknown;
  catalog?: unknown;
};

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

function isCatalogEntry(value: unknown): value is ProjectSidebarCatalogEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.project === 'string'
    && typeof row.displayName === 'string'
    && typeof row.color === 'number'
    && Number.isFinite(row.color)
    && typeof row.lastSeenAt === 'string';
}

function normalizeCatalog(value: unknown): Record<string, ProjectSidebarCatalogEntry> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const catalog: Record<string, ProjectSidebarCatalogEntry> = {};
  for (const [project, entry] of Object.entries(value)) {
    if (!isCatalogEntry(entry)) continue;
    catalog[project] = entry;
  }
  return catalog;
}

export function normalizeProjectSidebarState(raw: ProjectSidebarRaw | null | undefined): ProjectSidebarState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PROJECT_SIDEBAR_STATE, catalog: {} };
  const ordered = normalizeIds(raw.ordered);
  const catalog = normalizeCatalog(raw.catalog);
  return {
    version: PROJECT_SIDEBAR_STATE_VERSION,
    ordered,
    pinned: orderedMembership(ordered, normalizeIds(raw.pinned)),
    hidden: orderedMembership(ordered, normalizeIds(raw.hidden)),
    catalog,
  };
}

function orderedMembership(ordered: string[], ids: string[]): string[] {
  const orderedSet = new Set(ordered);
  const idsSet = new Set(ids);
  return [
    ...ordered.filter((id) => idsSet.has(id)),
    ...ids.filter((id) => !orderedSet.has(id)),
  ];
}

export class ProjectSidebarStore {
  private state: ProjectSidebarState = { ...DEFAULT_PROJECT_SIDEBAR_STATE, catalog: {} };
  private filePath: string;

  constructor(kookrDir: string) {
    this.filePath = join(kookrDir, 'project-sidebar.json');
  }

  async load(): Promise<void> {
    this.state = normalizeProjectSidebarState(await readJsonFile<ProjectSidebarRaw | null>(this.filePath, null));
  }

  async save(): Promise<void> {
    await atomicWriteFile(this.filePath, JSON.stringify(this.state, null, 2));
  }

  getState(): ProjectSidebarState {
    return {
      ...this.state,
      ordered: [...this.state.ordered],
      pinned: [...this.state.pinned],
      hidden: [...this.state.hidden],
      catalog: { ...this.state.catalog },
    };
  }

  setState(next: ProjectSidebarRaw): ProjectSidebarState {
    this.state = normalizeProjectSidebarState(next);
    return this.getState();
  }

  getSeedProjects(): string[] {
    return normalizeIds([
      ...this.state.ordered,
      ...this.state.pinned,
      ...this.state.hidden,
      ...Object.keys(this.state.catalog),
    ]);
  }
}
