import {
  deriveProjectSidebarState,
  forgetProjectFromSidebar,
  hideProjectInPrefs,
  loadProjectSidebarCatalog,
  loadProjectSidebarPrefs,
  moveVisibleProjectInPrefs,
  pinProjectToTop,
  reorderVisibleProjectInPrefs,
  resetProjectSidebarPrefs,
  saveProjectSidebarCatalog,
  saveProjectSidebarPrefs,
  showProjectInPrefs,
  unpinProjectInPrefs,
  updateProjectSidebarCatalog,
} from '../project-sidebar-prefs.js';
import { parseOwnerRepoSlug } from '../../../shared/repo-slug.js';
import { SEVERITY_ORDER } from '../store-types.js';
import type {
  ProjectSidebarSlice,
  StoreGet,
  StoreSet,
} from '../store-types.js';
import { isActiveFinding, isHealthyRunning } from '../finding-helpers.js';

function persistProjectSidebarState(
  nextPrefs: ProjectSidebarSlice['projectSidebarPrefs'],
  nextCatalog: ProjectSidebarSlice['projectSidebarCatalog'],
  options: { savePrefs?: boolean; saveCatalog?: boolean } = {},
): string | null {
  const prefsError = options.savePrefs === false ? null : saveProjectSidebarPrefs(nextPrefs);
  const catalogError = options.saveCatalog === false ? null : saveProjectSidebarCatalog(nextCatalog);
  return prefsError?.message ?? catalogError?.message ?? null;
}

export function createProjectSidebarSlice(set: StoreSet, get: StoreGet): ProjectSidebarSlice {
  const initialSidebarPrefs = loadProjectSidebarPrefs();
  const initialSidebarCatalog = loadProjectSidebarCatalog();
  const initialSidebarDerived = deriveProjectSidebarState([], initialSidebarPrefs, initialSidebarCatalog);

  return {
    selectedProject: typeof localStorage !== 'undefined' ? localStorage.getItem('kookr-selected-project') : null,
    projectSidebarVisible: initialSidebarDerived.hasRecoveryShell,
    projectSummaries: [],
    visibleProjectSummaries: initialSidebarDerived.visibleProjects,
    projectSidebarRows: initialSidebarDerived.managerRows,
    projectSidebarPrefs: initialSidebarPrefs,
    projectSidebarCatalog: initialSidebarCatalog,
    projectSidebarError: null,
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

      // Surface something useful for the project so the user is not greeted
      // by an empty detail pane. Priority order:
      //   1. Highest-severity active finding (matches `nextBottleneck` order).
      //   2. First healthy running task in the project.
      //   3. Otherwise, clear selection.
      const { agents, selectAgent } = get();
      const projectAgents = agents.filter((a) => a.projectId === project);
      const findings = projectAgents
        .filter(isActiveFinding)
        .sort(
          (left, right) =>
            SEVERITY_ORDER[left.anomaly!.severity] -
            SEVERITY_ORDER[right.anomaly!.severity],
        );
      if (findings.length > 0) {
        selectAgent(findings[0].agentId);
        return;
      }

      const healthy = projectAgents.find(isHealthyRunning);
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

    handleProjectSummaries: (projects) => {
      const prev = get();
      const nextCatalog = updateProjectSidebarCatalog(prev.projectSidebarCatalog, projects);
      const derived = deriveProjectSidebarState(projects, prev.projectSidebarPrefs, nextCatalog);
      const error = nextCatalog === prev.projectSidebarCatalog
        ? null
        : persistProjectSidebarState(prev.projectSidebarPrefs, nextCatalog, { savePrefs: false });

      set({
        projectSummaries: projects,
        visibleProjectSummaries: derived.visibleProjects,
        projectSidebarRows: derived.managerRows,
        projectSidebarCatalog: nextCatalog,
        projectSidebarError: error,
        projectSummariesHydrated: true,
        ...(derived.hasRecoveryShell ? { projectSidebarVisible: true } : {}),
      });
    },

    pinProjectToTop: (project) => {
      const prev = get();
      const nextPrefs = pinProjectToTop(prev.projectSidebarPrefs, project, prev.projectSummaries, prev.projectSidebarCatalog);
      const derived = deriveProjectSidebarState(prev.projectSummaries, nextPrefs, prev.projectSidebarCatalog);
      const error = persistProjectSidebarState(nextPrefs, prev.projectSidebarCatalog, { saveCatalog: false });

      set({
        projectSidebarPrefs: nextPrefs,
        visibleProjectSummaries: derived.visibleProjects,
        projectSidebarRows: derived.managerRows,
        projectSidebarError: error,
        ...(derived.hasRecoveryShell ? { projectSidebarVisible: true } : {}),
      });
    },

    unpinSidebarProject: (project) => {
      const prev = get();
      const nextPrefs = unpinProjectInPrefs(prev.projectSidebarPrefs, project, prev.projectSummaries, prev.projectSidebarCatalog);
      const derived = deriveProjectSidebarState(prev.projectSummaries, nextPrefs, prev.projectSidebarCatalog);
      const error = persistProjectSidebarState(nextPrefs, prev.projectSidebarCatalog, { saveCatalog: false });

      set({
        projectSidebarPrefs: nextPrefs,
        visibleProjectSummaries: derived.visibleProjects,
        projectSidebarRows: derived.managerRows,
        projectSidebarError: error,
        ...(derived.hasRecoveryShell ? { projectSidebarVisible: true } : {}),
      });
    },

    hideSidebarProject: (project) => {
      const prev = get();
      const nextPrefs = hideProjectInPrefs(prev.projectSidebarPrefs, project, prev.projectSummaries, prev.projectSidebarCatalog);
      const derived = deriveProjectSidebarState(prev.projectSummaries, nextPrefs, prev.projectSidebarCatalog);
      const hidingSelected = prev.selectedProject === project;
      const error = persistProjectSidebarState(nextPrefs, prev.projectSidebarCatalog, { saveCatalog: false });

      if (hidingSelected && typeof localStorage !== 'undefined') {
        localStorage.removeItem('kookr-selected-project');
      }

      set({
        projectSidebarPrefs: nextPrefs,
        visibleProjectSummaries: derived.visibleProjects,
        projectSidebarRows: derived.managerRows,
        projectSidebarError: error,
        ...(hidingSelected ? { selectedProject: null } : {}),
        ...(derived.hasRecoveryShell ? { projectSidebarVisible: true } : {}),
      });
    },

    showSidebarProject: (project) => {
      const prev = get();
      const nextPrefs = showProjectInPrefs(prev.projectSidebarPrefs, project, prev.projectSummaries, prev.projectSidebarCatalog);
      const derived = deriveProjectSidebarState(prev.projectSummaries, nextPrefs, prev.projectSidebarCatalog);
      const error = persistProjectSidebarState(nextPrefs, prev.projectSidebarCatalog, { saveCatalog: false });

      set({
        projectSidebarPrefs: nextPrefs,
        visibleProjectSummaries: derived.visibleProjects,
        projectSidebarRows: derived.managerRows,
        projectSidebarError: error,
        ...(derived.hasRecoveryShell ? { projectSidebarVisible: true } : {}),
      });
    },

    moveSidebarProject: (project, direction) => {
      const prev = get();
      const nextPrefs = moveVisibleProjectInPrefs(prev.projectSidebarPrefs, project, direction, prev.projectSummaries, prev.projectSidebarCatalog);
      const derived = deriveProjectSidebarState(prev.projectSummaries, nextPrefs, prev.projectSidebarCatalog);
      const error = persistProjectSidebarState(nextPrefs, prev.projectSidebarCatalog, { saveCatalog: false });

      set({
        projectSidebarPrefs: nextPrefs,
        visibleProjectSummaries: derived.visibleProjects,
        projectSidebarRows: derived.managerRows,
        projectSidebarError: error,
      });
    },

    reorderSidebarProject: (project, targetPinned, targetProject, position) => {
      const prev = get();
      const nextPrefs = reorderVisibleProjectInPrefs(
        prev.projectSidebarPrefs,
        project,
        targetPinned,
        targetProject,
        position,
        prev.projectSummaries,
        prev.projectSidebarCatalog,
      );
      const derived = deriveProjectSidebarState(prev.projectSummaries, nextPrefs, prev.projectSidebarCatalog);
      const error = persistProjectSidebarState(nextPrefs, prev.projectSidebarCatalog, { saveCatalog: false });

      set({
        projectSidebarPrefs: nextPrefs,
        visibleProjectSummaries: derived.visibleProjects,
        projectSidebarRows: derived.managerRows,
        projectSidebarError: error,
        ...(derived.hasRecoveryShell ? { projectSidebarVisible: true } : {}),
      });
    },

    resetProjectSidebar: () => {
      const prev = get();
      const nextPrefs = resetProjectSidebarPrefs();
      const derived = deriveProjectSidebarState(prev.projectSummaries, nextPrefs, prev.projectSidebarCatalog);
      const error = persistProjectSidebarState(nextPrefs, prev.projectSidebarCatalog, { saveCatalog: false });

      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('kookr-selected-project');
      }

      set({
        selectedProject: null,
        projectSidebarPrefs: nextPrefs,
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
        const forgotten = forgetProjectFromSidebar(
          prev.projectSidebarPrefs,
          prev.projectSidebarCatalog,
          projectId,
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
        const persistError = persistProjectSidebarState(forgotten.prefs, forgotten.catalog);
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
