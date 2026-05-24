import {
  applyProjectSidebarCommand,
  deriveProjectSidebarState,
  loadProjectSidebarSnapshot,
  projectSidebarSnapshotFromState,
  reconcileProjectSidebarSnapshot,
  saveProjectSidebarSnapshot,
  toProjectSidebarState,
  type ProjectSidebarSnapshot,
} from '../project-sidebar-prefs.js';
import { deriveProjectPriorityRanks, type ProjectSidebarState } from '../../../shared/project-sidebar.js';
import { parseOwnerRepoSlug } from '../../../shared/repo-slug.js';
import type {
  ProjectSidebarSlice,
  StoreGet,
  StoreSet,
} from '../store-types.js';
import { isActiveFinding, isHealthyRunning } from '../finding-helpers.js';
import { compareRoutableAgents } from '../../agent-priority-order.js';

function sidebarSnapshotFromStore(state: Pick<ProjectSidebarSlice, 'projectSidebarPrefs' | 'projectSidebarCatalog'>): ProjectSidebarSnapshot {
  return {
    prefs: state.projectSidebarPrefs,
    catalog: state.projectSidebarCatalog,
  };
}

function persistProjectSidebarSnapshot(snapshot: ProjectSidebarSnapshot): string | null {
  const error = saveProjectSidebarSnapshot(snapshot);
  return error?.message ?? null;
}

function isServerStateEmpty(state: ProjectSidebarState): boolean {
  return state.ordered.length === 0
    && state.pinned.length === 0
    && state.hidden.length === 0
    && Object.keys(state.catalog).length === 0;
}

function isProjectSidebarState(value: unknown): value is ProjectSidebarState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return state.version === 1
    && Array.isArray(state.ordered)
    && Array.isArray(state.pinned)
    && Array.isArray(state.hidden)
    && !!state.catalog
    && typeof state.catalog === 'object'
    && !Array.isArray(state.catalog);
}

function saveProjectSidebarToServer(
  snapshot: ProjectSidebarSnapshot,
  set: StoreSet,
): void {
  void fetch('/api/projects/sidebar', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(toProjectSidebarState(snapshot)),
  }).then((res) => {
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
  }).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    set({ projectSidebarError: msg });
  });
}

export function createProjectSidebarSlice(set: StoreSet, get: StoreGet): ProjectSidebarSlice {
  const initialSidebarSnapshot = loadProjectSidebarSnapshot();
  const initialSidebarDerived = deriveProjectSidebarState(
    [],
    initialSidebarSnapshot.prefs,
    initialSidebarSnapshot.catalog,
  );

  return {
    selectedProject: typeof localStorage !== 'undefined' ? localStorage.getItem('kookr-selected-project') : null,
    projectSidebarVisible: initialSidebarDerived.hasRecoveryShell,
    projectSummaries: [],
    visibleProjectSummaries: initialSidebarDerived.visibleProjects,
    projectSidebarRows: initialSidebarDerived.managerRows,
    projectSidebarPrefs: initialSidebarSnapshot.prefs,
    projectSidebarCatalog: initialSidebarSnapshot.catalog,
    projectSidebarError: null,
    projectSidebarServerHydrated: false,
    projectSummariesHydrated: false,
    discoveryStatus: null,
    discoveryBusy: false,
    trackOssError: null,
    trackOssBusy: false,
    untrackOssError: null,
    untrackOssBusy: false,

    selectProject: (project) => {
      set({ selectedProject: project });
      if (project && typeof localStorage !== 'undefined') {
        localStorage.setItem('kookr-selected-project', project);
      } else if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('kookr-selected-project');
      }

      if (!project) {
        // Deselecting project — clear any previously auto-selected finding
        set({ selectedAgentId: null });
        return;
      }

      // Surface something useful for the project using the same ordering
      // contract as keyboard navigation, scoped to the selected project.
      const state = get();
      const { agents, selectAgent } = state;
      const projectAgents = agents.filter((a) => a.projectId === project);
      const order = {
        chipTaskIds: new Set((state.coordinator?.chips ?? []).map((chip) => chip.taskId)),
        originalIndex: new Map(agents.map((agent, index) => [agent.agentId, index])),
        projectPriorityRanks: deriveProjectPriorityRanks(state.projectSummaries, state.projectSidebarPrefs),
      };
      const findings = projectAgents
        .filter(isActiveFinding)
        .sort((left, right) => compareRoutableAgents(left, right, order));
      if (findings.length > 0) {
        selectAgent(findings[0].agentId);
        return;
      }

      const healthy = projectAgents
        .filter(isHealthyRunning)
        .sort((left, right) => compareRoutableAgents(left, right, { ...order, includeSeverity: false }))[0];
      if (healthy) {
        selectAgent(healthy.agentId);
        return;
      }

      // No findings, no healthy task — clear via selectAgent so detail-pane
      // side state (respondAllAgentIds, leftPane, narrowTab) resets too.
      selectAgent(null);
    },

    toggleProjectSidebar: () => {
      set((prev) => ({ projectSidebarVisible: !prev.projectSidebarVisible }));
    },

    hydrateProjectSidebarFromServer: async () => {
      try {
        const res = await fetch('/api/projects/sidebar');
        if (!res.ok) {
          set({ projectSidebarError: `HTTP ${res.status}` });
          return;
        }
        const data: unknown = await res.json();
        if (!isProjectSidebarState(data)) {
          set({ projectSidebarError: 'Invalid project sidebar state' });
          return;
        }

        const prev = get();
        const localSnapshot = sidebarSnapshotFromStore(prev);
        const localState = toProjectSidebarState(localSnapshot);
        const nextState = isServerStateEmpty(data) && !isServerStateEmpty(localState)
          ? localState
          : data;
        const nextSnapshot = projectSidebarSnapshotFromState(nextState);
        const derived = deriveProjectSidebarState(prev.projectSummaries, nextSnapshot.prefs, nextSnapshot.catalog);
        const persistError = persistProjectSidebarSnapshot(nextSnapshot);

        set({
          projectSidebarPrefs: nextSnapshot.prefs,
          projectSidebarCatalog: nextSnapshot.catalog,
          visibleProjectSummaries: derived.visibleProjects,
          projectSidebarRows: derived.managerRows,
          projectSidebarServerHydrated: true,
          projectSidebarError: persistError,
          ...(derived.hasRecoveryShell ? { projectSidebarVisible: true } : {}),
        });

        if (nextState === localState) {
          saveProjectSidebarToServer(nextSnapshot, set);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set({ projectSidebarError: msg });
      }
    },

    handleProjectSummaries: (projects) => {
      const prev = get();
      const prevSnapshot = sidebarSnapshotFromStore(prev);
      const nextSnapshot = reconcileProjectSidebarSnapshot(prevSnapshot, projects);
      const derived = deriveProjectSidebarState(projects, nextSnapshot.prefs, nextSnapshot.catalog);
      const error = nextSnapshot.catalog === prev.projectSidebarCatalog
        ? null
        : persistProjectSidebarSnapshot(nextSnapshot);
      if (prev.projectSidebarServerHydrated && nextSnapshot.catalog !== prev.projectSidebarCatalog) {
        saveProjectSidebarToServer(nextSnapshot, set);
      }

      set({
        projectSummaries: projects,
        visibleProjectSummaries: derived.visibleProjects,
        projectSidebarRows: derived.managerRows,
        projectSidebarCatalog: nextSnapshot.catalog,
        projectSidebarError: error,
        projectSummariesHydrated: true,
        ...(derived.hasRecoveryShell ? { projectSidebarVisible: true } : {}),
      });
    },

    pinProjectToTop: (project) => {
      const prev = get();
      const nextSnapshot = applyProjectSidebarCommand(sidebarSnapshotFromStore(prev), { type: 'pin', project }, prev.projectSummaries);
      const derived = deriveProjectSidebarState(prev.projectSummaries, nextSnapshot.prefs, nextSnapshot.catalog);
      const error = persistProjectSidebarSnapshot(nextSnapshot);
      if (prev.projectSidebarServerHydrated) {
        saveProjectSidebarToServer(nextSnapshot, set);
      }

      set({
        projectSidebarPrefs: nextSnapshot.prefs,
        visibleProjectSummaries: derived.visibleProjects,
        projectSidebarRows: derived.managerRows,
        projectSidebarError: error,
        ...(derived.hasRecoveryShell ? { projectSidebarVisible: true } : {}),
      });
    },

    unpinSidebarProject: (project) => {
      const prev = get();
      const nextSnapshot = applyProjectSidebarCommand(sidebarSnapshotFromStore(prev), { type: 'unpin', project }, prev.projectSummaries);
      const derived = deriveProjectSidebarState(prev.projectSummaries, nextSnapshot.prefs, nextSnapshot.catalog);
      const error = persistProjectSidebarSnapshot(nextSnapshot);
      if (prev.projectSidebarServerHydrated) {
        saveProjectSidebarToServer(nextSnapshot, set);
      }

      set({
        projectSidebarPrefs: nextSnapshot.prefs,
        visibleProjectSummaries: derived.visibleProjects,
        projectSidebarRows: derived.managerRows,
        projectSidebarError: error,
        ...(derived.hasRecoveryShell ? { projectSidebarVisible: true } : {}),
      });
    },

    hideSidebarProject: (project) => {
      const prev = get();
      const nextSnapshot = applyProjectSidebarCommand(sidebarSnapshotFromStore(prev), { type: 'hide', project }, prev.projectSummaries);
      const derived = deriveProjectSidebarState(prev.projectSummaries, nextSnapshot.prefs, nextSnapshot.catalog);
      const hidingSelected = prev.selectedProject === project;
      const error = persistProjectSidebarSnapshot(nextSnapshot);
      if (prev.projectSidebarServerHydrated) {
        saveProjectSidebarToServer(nextSnapshot, set);
      }

      if (hidingSelected && typeof localStorage !== 'undefined') {
        localStorage.removeItem('kookr-selected-project');
      }

      set({
        projectSidebarPrefs: nextSnapshot.prefs,
        visibleProjectSummaries: derived.visibleProjects,
        projectSidebarRows: derived.managerRows,
        projectSidebarError: error,
        ...(hidingSelected ? { selectedProject: null } : {}),
        ...(derived.hasRecoveryShell ? { projectSidebarVisible: true } : {}),
      });
    },

    showSidebarProject: (project) => {
      const prev = get();
      const nextSnapshot = applyProjectSidebarCommand(sidebarSnapshotFromStore(prev), { type: 'show', project }, prev.projectSummaries);
      const derived = deriveProjectSidebarState(prev.projectSummaries, nextSnapshot.prefs, nextSnapshot.catalog);
      const error = persistProjectSidebarSnapshot(nextSnapshot);
      if (prev.projectSidebarServerHydrated) {
        saveProjectSidebarToServer(nextSnapshot, set);
      }

      set({
        projectSidebarPrefs: nextSnapshot.prefs,
        visibleProjectSummaries: derived.visibleProjects,
        projectSidebarRows: derived.managerRows,
        projectSidebarError: error,
        ...(derived.hasRecoveryShell ? { projectSidebarVisible: true } : {}),
      });
    },

    moveSidebarProject: (project, direction) => {
      const prev = get();
      const nextSnapshot = applyProjectSidebarCommand(sidebarSnapshotFromStore(prev), { type: 'move', project, direction }, prev.projectSummaries);
      const derived = deriveProjectSidebarState(prev.projectSummaries, nextSnapshot.prefs, nextSnapshot.catalog);
      const error = persistProjectSidebarSnapshot(nextSnapshot);
      if (prev.projectSidebarServerHydrated) {
        saveProjectSidebarToServer(nextSnapshot, set);
      }

      set({
        projectSidebarPrefs: nextSnapshot.prefs,
        visibleProjectSummaries: derived.visibleProjects,
        projectSidebarRows: derived.managerRows,
        projectSidebarError: error,
      });
    },

    reorderSidebarProject: (project, targetPinned, targetProject, position) => {
      const prev = get();
      const nextSnapshot = applyProjectSidebarCommand(
        sidebarSnapshotFromStore(prev),
        { type: 'reorder', project, targetPinned, targetProject, position },
        prev.projectSummaries,
      );
      const derived = deriveProjectSidebarState(prev.projectSummaries, nextSnapshot.prefs, nextSnapshot.catalog);
      const error = persistProjectSidebarSnapshot(nextSnapshot);
      if (prev.projectSidebarServerHydrated) {
        saveProjectSidebarToServer(nextSnapshot, set);
      }

      set({
        projectSidebarPrefs: nextSnapshot.prefs,
        visibleProjectSummaries: derived.visibleProjects,
        projectSidebarRows: derived.managerRows,
        projectSidebarError: error,
        ...(derived.hasRecoveryShell ? { projectSidebarVisible: true } : {}),
      });
    },

    resetProjectSidebar: () => {
      const prev = get();
      const nextSnapshot = applyProjectSidebarCommand(sidebarSnapshotFromStore(prev), { type: 'reset' }, prev.projectSummaries);
      const derived = deriveProjectSidebarState(prev.projectSummaries, nextSnapshot.prefs, nextSnapshot.catalog);
      const error = persistProjectSidebarSnapshot(nextSnapshot);
      if (prev.projectSidebarServerHydrated) {
        saveProjectSidebarToServer(nextSnapshot, set);
      }

      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('kookr-selected-project');
      }

      set({
        selectedProject: null,
        projectSidebarPrefs: nextSnapshot.prefs,
        visibleProjectSummaries: derived.visibleProjects,
        projectSidebarRows: derived.managerRows,
        projectSidebarError: error,
        ...(derived.hasRecoveryShell ? { projectSidebarVisible: true } : {}),
      });
    },

    clearProjectSidebarError: () => {
      set({ projectSidebarError: null });
    },

    fetchDiscoveryStatus: async () => {
      try {
        const res = await fetch('/api/projects/discovery-status');
        if (!res.ok) {
          set({ discoveryStatus: { projects: [], warnings: [], lastError: `HTTP ${res.status}` } });
          return;
        }
        const data = await res.json();
        set({ discoveryStatus: data });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set({ discoveryStatus: { projects: [], warnings: [], lastError: msg } });
      }
    },

    rescanSkills: async () => {
      set({ discoveryBusy: true });
      try {
        const res = await fetch('/api/projects/rescan-skills', { method: 'POST' });
        if (!res.ok) {
          set({
            discoveryStatus: { projects: [], warnings: [], lastError: `HTTP ${res.status}` },
            discoveryBusy: false,
          });
          return;
        }
        const data = await res.json();
        set({ discoveryStatus: data, discoveryBusy: false });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set({
          discoveryStatus: { projects: [], warnings: [], lastError: msg },
          discoveryBusy: false,
        });
      }
    },

    trackOssProject: async (repo: string) => {
      const slug = parseOwnerRepoSlug(repo);
      if (!slug) {
        const msg = 'Enter a valid owner/repo (e.g. "grafana/grafana")';
        set({ trackOssError: msg });
        return { ok: false, error: msg };
      }
      set({ trackOssBusy: true, trackOssError: null });
      try {
        const res = await fetch('/api/projects/track', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo: slug }),
        });
        if (!res.ok) {
          let errMsg = `HTTP ${res.status}`;
          try {
            const body = await res.json();
            if (body?.error) errMsg = body.error;
          } catch {
            // body wasn't JSON
          }
          set({ trackOssBusy: false, trackOssError: errMsg });
          return { ok: false, error: errMsg };
        }
        set({ trackOssBusy: false, trackOssError: null });
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set({ trackOssBusy: false, trackOssError: msg });
        return { ok: false, error: msg };
      }
    },

    clearTrackOssError: () => {
      set({ trackOssError: null });
    },

    untrackOssProject: async (repo: string) => {
      const slug = parseOwnerRepoSlug(repo);
      if (!slug) {
        const msg = 'Enter a valid owner/repo (e.g. "grafana/grafana")';
        set({ untrackOssError: msg });
        return { ok: false, error: msg };
      }
      set({ untrackOssBusy: true, untrackOssError: null });
      try {
        const res = await fetch('/api/projects/untrack', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo: slug }),
        });
        if (!res.ok) {
          let errMsg = `HTTP ${res.status}`;
          try {
            const body = await res.json();
            if (body?.error) errMsg = body.error;
          } catch {
            // body wasn't JSON
          }
          set({ untrackOssBusy: false, untrackOssError: errMsg });
          return { ok: false, error: errMsg };
        }
        // Server accepted — forget the project from local sidebar prefs +
        // catalog so it doesn't linger as an offline row until the next WS
        // broadcast. If the next broadcast still sends this project (skill
        // discovery, limits, notes), it will be re-added automatically.
        const projectId = `github.com/${slug}`;
        const prev = get();
        const forgotten = applyProjectSidebarCommand(
          sidebarSnapshotFromStore(prev),
          { type: 'forget', project: projectId },
          prev.projectSummaries,
        );
        const remainingSummaries = prev.projectSummaries.filter(
          (p) => p.project !== projectId,
        );
        const derived = deriveProjectSidebarState(
          remainingSummaries,
          forgotten.prefs,
          forgotten.catalog,
        );
        const hidingSelected = prev.selectedProject === projectId;
        const persistError = persistProjectSidebarSnapshot(forgotten);
        if (prev.projectSidebarServerHydrated) {
          saveProjectSidebarToServer(forgotten, set);
        }
        if (hidingSelected && typeof localStorage !== 'undefined') {
          localStorage.removeItem('kookr-selected-project');
        }
        set({
          projectSidebarPrefs: forgotten.prefs,
          projectSidebarCatalog: forgotten.catalog,
          projectSummaries: remainingSummaries,
          visibleProjectSummaries: derived.visibleProjects,
          projectSidebarRows: derived.managerRows,
          projectSidebarError: persistError,
          untrackOssBusy: false,
          untrackOssError: null,
          ...(hidingSelected ? { selectedProject: null } : {}),
        });
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set({ untrackOssBusy: false, untrackOssError: msg });
        return { ok: false, error: msg };
      }
    },

    clearUntrackOssError: () => {
      set({ untrackOssError: null });
    },
  };
}
