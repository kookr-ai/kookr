import { beforeEach, describe, expect, test } from 'vitest';
import type { ProjectSummary } from '../../shared/protocol.js';
import {
  deriveProjectSidebarState,
  hideProjectInPrefs,
  loadProjectSidebarCatalog,
  loadProjectSidebarPrefs,
  moveVisibleProjectInPrefs,
  pinProjectToTop,
  PROJECT_SIDEBAR_CATALOG_KEY,
  PROJECT_SIDEBAR_PREFS_KEY,
  reorderVisibleProjectInPrefs,
  resetProjectSidebarPrefs,
  saveProjectSidebarCatalog,
  saveProjectSidebarPrefs,
  showProjectInPrefs,
  unpinProjectInPrefs,
  updateProjectSidebarCatalog,
  type ProjectSidebarCatalogEntry,
  type ProjectSidebarPrefs,
} from './project-sidebar-prefs.js';

function fakeStorage(data?: Map<string, string>) {
  const storage = data ?? new Map<string, string>();
  return {
    map: storage,
    impl: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    } as Pick<Storage, 'getItem' | 'setItem'>,
  };
}

function summary(project: string, displayName: string, color: number): ProjectSummary {
  return {
    project,
    displayName,
    color,
    activeAgents: 0,
    findingCount: 0,
    todayPrCount: 0,
    weekPrCount: 0,
    openPrs: 0,
    recentTasks: [],
  };
}

describe('project-sidebar-prefs', () => {
  let storage: ReturnType<typeof fakeStorage>;

  beforeEach(() => {
    storage = fakeStorage();
  });

  test('loads default prefs on empty storage', () => {
    expect(loadProjectSidebarPrefs(storage.impl)).toEqual({
      version: 2,
      ordered: [],
      pinned: [],
      hidden: [],
    });
  });

  test('migrates v1 prefs by adding empty pinned list', () => {
    storage.map.set(PROJECT_SIDEBAR_PREFS_KEY, JSON.stringify({
      version: 1,
      ordered: ['a', 'b'],
      hidden: ['b'],
    }));

    expect(loadProjectSidebarPrefs(storage.impl)).toEqual({
      version: 2,
      ordered: ['a', 'b'],
      pinned: [],
      hidden: ['b'],
    });
  });

  test('normalizes duplicate ids in prefs', () => {
    storage.map.set(PROJECT_SIDEBAR_PREFS_KEY, JSON.stringify({
      ordered: ['a', 'a', 'b'],
      pinned: ['b', 'b', 'a'],
      hidden: ['b', 'b'],
    }));

    expect(loadProjectSidebarPrefs(storage.impl)).toEqual({
      version: 2,
      ordered: ['a', 'b'],
      pinned: ['b', 'a'],
      hidden: ['b'],
    });
  });

  test('handles corrupted prefs storage gracefully', () => {
    storage.map.set(PROJECT_SIDEBAR_PREFS_KEY, 'not-json');
    expect(loadProjectSidebarPrefs(storage.impl)).toEqual({
      version: 2,
      ordered: [],
      pinned: [],
      hidden: [],
    });
  });

  test('persists prefs and catalog', () => {
    const prefs: ProjectSidebarPrefs = { version: 2, ordered: ['b', 'a'], pinned: ['b'], hidden: ['a'] };
    const catalog: Record<string, ProjectSidebarCatalogEntry> = {
      a: { project: 'a', displayName: 'alpha', color: 1, lastSeenAt: '2026-04-02T10:00:00.000Z' },
    };

    expect(saveProjectSidebarPrefs(prefs, storage.impl)).toBeNull();
    expect(saveProjectSidebarCatalog(catalog, storage.impl)).toBeNull();
    expect(loadProjectSidebarPrefs(storage.impl)).toEqual(prefs);
    expect(loadProjectSidebarCatalog(storage.impl)).toEqual(catalog);
  });

  test('derives visible projects with pinned rows first while preserving hidden entries for recovery', () => {
    const projects = [
      summary('a', 'alpha', 1),
      summary('b', 'bravo', 2),
      summary('c', 'charlie', 3),
    ];
    const prefs: ProjectSidebarPrefs = {
      version: 2,
      ordered: ['c', 'a', 'b'],
      pinned: ['b'],
      hidden: ['a'],
    };

    const derived = deriveProjectSidebarState(projects, prefs, {});
    expect(derived.visibleProjects.map((project) => project.project)).toEqual(['b', 'c']);
    expect(derived.managerRows.map((row) => ({ project: row.project, hidden: row.hidden, pinned: row.pinned }))).toEqual([
      { project: 'c', hidden: false, pinned: false },
      { project: 'a', hidden: true, pinned: false },
      { project: 'b', hidden: false, pinned: true },
    ]);
  });

  test('uses catalog metadata for hidden offline recovery rows', () => {
    const prefs: ProjectSidebarPrefs = {
      version: 2,
      ordered: ['offline-project'],
      pinned: ['offline-project'],
      hidden: ['offline-project'],
    };
    const catalog: Record<string, ProjectSidebarCatalogEntry> = {
      'offline-project': {
        project: 'offline-project',
        displayName: 'owner/repo',
        color: 4,
        lastSeenAt: '2026-04-02T10:00:00.000Z',
      },
    };

    const derived = deriveProjectSidebarState([], prefs, catalog);
    expect(derived.visibleProjects).toEqual([]);
    expect(derived.hasRecoveryShell).toBe(true);
    expect(derived.managerRows).toEqual([
      expect.objectContaining({
        project: 'offline-project',
        displayName: 'owner/repo',
        hidden: true,
        offline: true,
        pinned: true,
      }),
    ]);
  });

  test('pin to top unhides, pins, and moves project to first visible slot', () => {
    const projects = [summary('a', 'alpha', 1), summary('b', 'bravo', 2)];
    const prefs = pinProjectToTop({
      version: 2,
      ordered: ['a', 'b'],
      pinned: [],
      hidden: ['b'],
    }, 'b', projects, {});

    expect(prefs).toEqual({
      version: 2,
      ordered: ['b', 'a'],
      pinned: ['b'],
      hidden: [],
    });
  });

  test('unpin keeps project visible and returns it to unpinned section', () => {
    const projects = [summary('a', 'alpha', 1), summary('b', 'bravo', 2), summary('c', 'charlie', 3)];
    const prefs = unpinProjectInPrefs({
      version: 2,
      ordered: ['b', 'a', 'c'],
      pinned: ['b'],
      hidden: [],
    }, 'b', projects, {});

    expect(deriveProjectSidebarState(projects, prefs, {}).visibleProjects.map((project) => project.project)).toEqual([
      'b',
      'a',
      'c',
    ]);
    expect(prefs.pinned).toEqual([]);
  });

  test('hide then show preserves prior ordering slot and pin membership', () => {
    const projects = [
      summary('a', 'alpha', 1),
      summary('b', 'bravo', 2),
      summary('c', 'charlie', 3),
    ];
    const hidden = hideProjectInPrefs({
      version: 2,
      ordered: ['a', 'b', 'c'],
      pinned: ['b'],
      hidden: [],
    }, 'b', projects, {});

    expect(hidden).toEqual({
      version: 2,
      ordered: ['a', 'b', 'c'],
      pinned: ['b'],
      hidden: ['b'],
    });

    const shown = showProjectInPrefs(hidden, 'b', projects, {});
    expect(shown).toEqual({
      version: 2,
      ordered: ['a', 'b', 'c'],
      pinned: ['b'],
      hidden: [],
    });
  });

  test('move swaps visible projects within the same section while leaving hidden ids in place', () => {
    const projects = [
      summary('a', 'alpha', 1),
      summary('b', 'bravo', 2),
      summary('c', 'charlie', 3),
      summary('d', 'delta', 4),
    ];
    const moved = moveVisibleProjectInPrefs({
      version: 2,
      ordered: ['a', 'hidden-x', 'b', 'c', 'd'],
      pinned: ['a', 'b'],
      hidden: ['hidden-x'],
    }, 'b', 'up', projects, {
      'hidden-x': {
        project: 'hidden-x',
        displayName: 'hidden/x',
        color: 1,
        lastSeenAt: '2026-04-02T10:00:00.000Z',
      },
    });

    expect(moved).toEqual({
      version: 2,
      ordered: ['b', 'hidden-x', 'a', 'c', 'd'],
      pinned: ['b', 'a'],
      hidden: ['hidden-x'],
    });
  });

  test('reorder can move an unpinned project into the pinned section', () => {
    const projects = [
      summary('a', 'alpha', 1),
      summary('b', 'bravo', 2),
      summary('c', 'charlie', 3),
    ];

    const next = reorderVisibleProjectInPrefs({
      version: 2,
      ordered: ['a', 'b', 'c'],
      pinned: ['a'],
      hidden: [],
    }, 'c', true, 'a', 'before', projects, {});

    expect(next).toEqual({
      version: 2,
      ordered: ['c', 'a', 'b'],
      pinned: ['c', 'a'],
      hidden: [],
    });
  });

  test('reorder can move a pinned project into the unpinned section', () => {
    const projects = [
      summary('a', 'alpha', 1),
      summary('b', 'bravo', 2),
      summary('c', 'charlie', 3),
    ];

    const next = reorderVisibleProjectInPrefs({
      version: 2,
      ordered: ['a', 'b', 'c'],
      pinned: ['a', 'b'],
      hidden: [],
    }, 'a', false, 'c', 'after', projects, {});

    expect(next).toEqual({
      version: 2,
      ordered: ['b', 'c', 'a'],
      pinned: ['b'],
      hidden: [],
    });
  });

  test('update catalog records latest project metadata', () => {
    const updated = updateProjectSidebarCatalog({}, [summary('a', 'alpha', 1)], '2026-04-02T11:00:00.000Z');
    expect(updated).toEqual({
      a: {
        project: 'a',
        displayName: 'alpha',
        color: 1,
        lastSeenAt: '2026-04-02T11:00:00.000Z',
      },
    });
  });

  test('reset returns empty ordered, pinned, and hidden lists', () => {
    expect(resetProjectSidebarPrefs()).toEqual({
      version: 2,
      ordered: [],
      pinned: [],
      hidden: [],
    });
  });
});
