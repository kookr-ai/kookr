import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ProjectSummary } from '../../shared/protocol.js';
import { deriveProjectPriorityRanks } from '../../shared/project-sidebar.js';
import {
  applyProjectSidebarCommand,
  deriveProjectSidebarState,
  loadProjectSidebarSnapshot,
  reconcileProjectSidebarSnapshot,
  saveProjectSidebarSnapshot,
  type ProjectSidebarCatalogEntry,
  type ProjectSidebarPrefs,
} from './project-sidebar-prefs.js';

const PROJECT_SIDEBAR_PREFS_KEY = 'kookr:projectSidebarPrefs';

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
    openContributionAttempts: 0,
    recentTasks: [],
  };
}

describe('project-sidebar-prefs', () => {
  let storage: ReturnType<typeof fakeStorage>;

  beforeEach(() => {
    storage = fakeStorage();
    vi.stubGlobal('localStorage', storage.impl);
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('loads default prefs on empty storage', () => {
    expect(loadProjectSidebarSnapshot().prefs).toEqual({
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

    expect(loadProjectSidebarSnapshot().prefs).toEqual({
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

    expect(loadProjectSidebarSnapshot().prefs).toEqual({
      version: 2,
      ordered: ['a', 'b'],
      pinned: ['b', 'a'],
      hidden: ['b'],
    });
  });

  test('handles corrupted prefs storage gracefully', () => {
    storage.map.set(PROJECT_SIDEBAR_PREFS_KEY, 'not-json');
    expect(loadProjectSidebarSnapshot().prefs).toEqual({
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

    expect(saveProjectSidebarSnapshot({ prefs, catalog })).toBeNull();
    expect(loadProjectSidebarSnapshot()).toEqual({ prefs, catalog });
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
    const prefs = applyProjectSidebarCommand({
      catalog: {},
      prefs: {
        version: 2,
        ordered: ['a', 'b'],
        pinned: [],
        hidden: ['b'],
      },
    }, { type: 'pin', project: 'b' }, projects).prefs;

    expect(prefs).toEqual({
      version: 2,
      ordered: ['b', 'a'],
      pinned: ['b'],
      hidden: [],
    });
  });

  test('unpin keeps project visible and returns it to unpinned section', () => {
    const projects = [summary('a', 'alpha', 1), summary('b', 'bravo', 2), summary('c', 'charlie', 3)];
    const prefs = applyProjectSidebarCommand({
      catalog: {},
      prefs: {
        version: 2,
        ordered: ['b', 'a', 'c'],
        pinned: ['b'],
        hidden: [],
      },
    }, { type: 'unpin', project: 'b' }, projects).prefs;

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
    const hidden = applyProjectSidebarCommand({
      catalog: {},
      prefs: {
        version: 2,
        ordered: ['a', 'b', 'c'],
        pinned: ['b'],
        hidden: [],
      },
    }, { type: 'hide', project: 'b' }, projects).prefs;

    expect(hidden).toEqual({
      version: 2,
      ordered: ['a', 'b', 'c'],
      pinned: ['b'],
      hidden: ['b'],
    });

    const shown = applyProjectSidebarCommand({ prefs: hidden, catalog: {} }, { type: 'show', project: 'b' }, projects).prefs;
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
    const moved = applyProjectSidebarCommand({
      prefs: {
        version: 2,
        ordered: ['a', 'hidden-x', 'b', 'c', 'd'],
        pinned: ['a', 'b'],
        hidden: ['hidden-x'],
      },
      catalog: {
        'hidden-x': {
          project: 'hidden-x',
          displayName: 'hidden/x',
          color: 1,
          lastSeenAt: '2026-04-02T10:00:00.000Z',
        },
      },
    }, { type: 'move', project: 'b', direction: 'up' }, projects).prefs;

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

    const next = applyProjectSidebarCommand({
      catalog: {},
      prefs: {
        version: 2,
        ordered: ['a', 'b', 'c'],
        pinned: ['a'],
        hidden: [],
      },
    }, { type: 'reorder', project: 'c', targetPinned: true, targetProject: 'a', position: 'before' }, projects).prefs;

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

    const next = applyProjectSidebarCommand({
      catalog: {},
      prefs: {
        version: 2,
        ordered: ['a', 'b', 'c'],
        pinned: ['a', 'b'],
        hidden: [],
      },
    }, { type: 'reorder', project: 'a', targetPinned: false, targetProject: 'c', position: 'after' }, projects).prefs;

    expect(next).toEqual({
      version: 2,
      ordered: ['b', 'c', 'a'],
      pinned: ['b'],
      hidden: [],
    });
  });

  test('update catalog records latest project metadata', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-02T11:00:00.000Z'));

    const updated = reconcileProjectSidebarSnapshot({
      prefs: { version: 2, ordered: [], pinned: [], hidden: [] },
      catalog: {},
    }, [summary('a', 'alpha', 1)]).catalog;
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
    expect(applyProjectSidebarCommand({
      prefs: { version: 2, ordered: ['a'], pinned: ['a'], hidden: ['b'] },
      catalog: {},
    }, { type: 'reset' }, []).prefs).toEqual({
      version: 2,
      ordered: [],
      pinned: [],
      hidden: [],
    });
  });

  test('derives project priority ranks from visible sidebar order and skips hidden projects', () => {
    const projects = [
      summary('github.com/c', 'owner/c', 1),
      summary('github.com/a', 'owner/a', 2),
      summary('github.com/b', 'owner/b', 3),
      summary('github.com/d', 'owner/d', 4),
    ];

    const ranks = deriveProjectPriorityRanks(projects, {
      ordered: ['github.com/b', 'github.com/hidden', 'github.com/a'],
      pinned: ['github.com/a'],
      hidden: ['github.com/d'],
    });

    expect([...ranks.entries()]).toEqual([
      ['github.com/a', 0],
      ['github.com/b', 1],
    ]);
  });

  test('does not derive priority ranks from dynamic summary order when projects are unordered', () => {
    const projects = [
      summary('github.com/z', 'owner/z', 1),
      summary('github.com/a', 'owner/a', 2),
      summary('github.com/m', 'owner/m', 3),
    ];

    const ranks = deriveProjectPriorityRanks(projects, {
      ordered: [],
      pinned: [],
      hidden: [],
    });

    expect([...ranks.entries()]).toEqual([]);
  });
});
