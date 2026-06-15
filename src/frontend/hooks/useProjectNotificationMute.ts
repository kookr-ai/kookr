import { useMemo, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'kookr-project-notification-mutes';
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface ProjectNotificationMute {
  mutedUntil: number | null;
}

export type ProjectNotificationMuteState = Record<string, ProjectNotificationMute>;

const EMPTY_STATE: ProjectNotificationMuteState = {};

let state: ProjectNotificationMuteState = readFromStorage();
const listeners = new Set<() => void>();
let expirationTimer: ReturnType<typeof setTimeout> | null = null;

function safeStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function normalizeProject(project: string | null | undefined): string | null {
  const trimmed = project?.trim();
  return trimmed ? trimmed : null;
}

function parseEntry(value: unknown): ProjectNotificationMute | null {
  if (typeof value !== 'object' || value === null) return null;
  const mutedUntil = (value as { mutedUntil?: unknown }).mutedUntil;
  if (mutedUntil === null || mutedUntil === undefined) return { mutedUntil: null };
  return typeof mutedUntil === 'number' && Number.isFinite(mutedUntil) ? { mutedUntil } : null;
}

function readFromStorage(): ProjectNotificationMuteState {
  const storage = safeStorage();
  if (!storage) return EMPTY_STATE;
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return EMPTY_STATE;

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return EMPTY_STATE;

    const now = Date.now();
    const next: ProjectNotificationMuteState = {};
    let changed = false;
    for (const [project, rawEntry] of Object.entries(parsed)) {
      const normalizedProject = normalizeProject(project);
      const entry = parseEntry(rawEntry);
      if (!normalizedProject || !entry) {
        changed = true;
        continue;
      }
      if (entry.mutedUntil !== null && entry.mutedUntil <= now) {
        changed = true;
        continue;
      }
      next[normalizedProject] = entry;
    }

    if (changed) writeToStorage(next);
    return Object.keys(next).length === 0 ? EMPTY_STATE : next;
  } catch {
    return EMPTY_STATE;
  }
}

function writeToStorage(next: ProjectNotificationMuteState): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    if (Object.keys(next).length === 0) {
      storage.removeItem(STORAGE_KEY);
    } else {
      storage.setItem(STORAGE_KEY, JSON.stringify(next));
    }
  } catch {
    /* persistence failed; in-memory state still updates for this tab */
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function scheduleExpiration(): void {
  if (expirationTimer) {
    clearTimeout(expirationTimer);
    expirationTimer = null;
  }

  let nextExpiration: number | null = null;
  for (const entry of Object.values(state)) {
    if (entry.mutedUntil === null) continue;
    if (nextExpiration === null || entry.mutedUntil < nextExpiration) nextExpiration = entry.mutedUntil;
  }
  if (nextExpiration === null) return;

  const remaining = nextExpiration - Date.now();
  if (remaining <= 0) {
    pruneExpired();
    return;
  }
  expirationTimer = setTimeout(pruneExpired, Math.min(remaining, MAX_TIMEOUT_MS));
}

function applyState(next: ProjectNotificationMuteState): void {
  state = Object.keys(next).length === 0 ? EMPTY_STATE : next;
  writeToStorage(state);
  scheduleExpiration();
  emit();
}

function pruneExpired(): void {
  const now = Date.now();
  const next: ProjectNotificationMuteState = {};
  let changed = false;
  for (const [project, entry] of Object.entries(state)) {
    if (entry.mutedUntil !== null && entry.mutedUntil <= now) {
      changed = true;
      continue;
    }
    next[project] = entry;
  }
  if (changed) applyState(next);
  else scheduleExpiration();
}

function syncFromStorage(): void {
  state = readFromStorage();
  scheduleExpiration();
  emit();
}

if (typeof window !== 'undefined') {
  scheduleExpiration();
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY) syncFromStorage();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getProjectNotificationMuteState(): ProjectNotificationMuteState {
  return state;
}

export function isProjectNotificationMuted(project: string | null | undefined): boolean {
  const normalizedProject = normalizeProject(project);
  if (!normalizedProject) return false;
  const entry = state[normalizedProject];
  if (!entry) return false;
  if (entry.mutedUntil === null) return true;
  if (entry.mutedUntil > Date.now()) return true;
  pruneExpired();
  return false;
}

export function muteProjectNotifications(project: string, durationMs?: number | null): void {
  const normalizedProject = normalizeProject(project);
  if (!normalizedProject) return;
  const now = Date.now();
  const mutedUntil = typeof durationMs === 'number' && durationMs > 0 ? now + durationMs : null;
  applyState({
    ...state,
    [normalizedProject]: { mutedUntil },
  });
}

export function unmuteProjectNotifications(project: string): void {
  const normalizedProject = normalizeProject(project);
  if (!normalizedProject || !(normalizedProject in state)) return;
  const { [normalizedProject]: _removed, ...next } = state;
  applyState(next);
}

export function toggleProjectNotificationMute(project: string): boolean {
  if (isProjectNotificationMuted(project)) {
    unmuteProjectNotifications(project);
    return false;
  }
  muteProjectNotifications(project);
  return true;
}

export function __resetProjectNotificationMuteForTests(): void {
  if (expirationTimer) {
    clearTimeout(expirationTimer);
    expirationTimer = null;
  }
  state = readFromStorage();
  scheduleExpiration();
  emit();
}

export interface UseProjectNotificationMuteResult {
  mutedProjects: ProjectNotificationMuteState;
  isMuted: (project: string | null | undefined) => boolean;
  mute: (project: string, durationMs?: number | null) => void;
  unmute: (project: string) => void;
  toggle: (project: string) => boolean;
}

export function useProjectNotificationMute(): UseProjectNotificationMuteResult {
  const mutedProjects = useSyncExternalStore(
    subscribe,
    getProjectNotificationMuteState,
    getProjectNotificationMuteState,
  );
  return useMemo(() => ({
    mutedProjects,
    isMuted: (project: string | null | undefined) => {
      const normalizedProject = normalizeProject(project);
      const entry = normalizedProject ? mutedProjects[normalizedProject] : undefined;
      return entry !== undefined && (entry.mutedUntil === null || entry.mutedUntil > Date.now());
    },
    mute: muteProjectNotifications,
    unmute: unmuteProjectNotifications,
    toggle: toggleProjectNotificationMute,
  }), [mutedProjects]);
}
