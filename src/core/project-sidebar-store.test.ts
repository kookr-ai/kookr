import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectSidebarStore, normalizeProjectSidebarState } from './project-sidebar-store.js';

describe('ProjectSidebarStore', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-sidebar-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('loads defaults when project-sidebar.json is missing', async () => {
    const store = new ProjectSidebarStore(tempDir);
    await store.load();

    expect(store.getState()).toEqual({
      version: 1,
      ordered: [],
      pinned: [],
      hidden: [],
      catalog: {},
    });
  });

  test('saves and reloads pinned project preferences', async () => {
    const store = new ProjectSidebarStore(tempDir);
    await store.load();
    store.setState({
      ordered: ['github.com/a/repo', 'github.com/b/repo'],
      pinned: ['github.com/b/repo'],
      hidden: ['github.com/a/repo'],
      catalog: {
        'github.com/b/repo': {
          project: 'github.com/b/repo',
          displayName: 'b/repo',
          color: 3,
          lastSeenAt: '2026-05-09T00:00:00.000Z',
        },
      },
    });
    await store.save();

    const reloaded = new ProjectSidebarStore(tempDir);
    await reloaded.load();

    expect(reloaded.getState()).toEqual({
      version: 1,
      ordered: ['github.com/a/repo', 'github.com/b/repo'],
      pinned: ['github.com/b/repo'],
      hidden: ['github.com/a/repo'],
      catalog: {
        'github.com/b/repo': {
          project: 'github.com/b/repo',
          displayName: 'b/repo',
          color: 3,
          lastSeenAt: '2026-05-09T00:00:00.000Z',
        },
      },
    });
  });

  test('save writes compact JSON without pretty-print indentation (issue #2304)', async () => {
    const store = new ProjectSidebarStore(tempDir);
    await store.load();
    store.setState({
      ordered: ['github.com/a/repo'],
      pinned: ['github.com/a/repo'],
      hidden: [],
      catalog: {
        'github.com/a/repo': {
          project: 'github.com/a/repo',
          displayName: 'a/repo',
          color: 1,
          lastSeenAt: '2026-05-09T00:00:00.000Z',
        },
      },
    });
    await store.save();

    const raw = readFileSync(join(tempDir, 'project-sidebar.json'), 'utf8');
    // Compact form has no 2-space indent after newlines (pretty-print marker).
    expect(raw).not.toMatch(/\n {2}"/);
    // Keys are adjacent without space after colon (compact stringify).
    expect(raw).toContain('"version":1');
    const parsed = JSON.parse(raw);
    expect(parsed.ordered).toEqual(['github.com/a/repo']);
    expect(parsed.pinned).toEqual(['github.com/a/repo']);
  });

  test('normalizes malformed persisted values', () => {
    expect(normalizeProjectSidebarState({
      ordered: ['a', 42, 'a', 'b'],
      pinned: ['b', 'c', null],
      hidden: ['a', 'a'],
      catalog: {
        a: { project: 'a', displayName: 'A', color: 1, lastSeenAt: 'now' },
        bad: { project: 'bad', color: 'red' },
      },
    })).toEqual({
      version: 1,
      ordered: ['a', 'b'],
      pinned: ['b', 'c'],
      hidden: ['a'],
      catalog: {
        a: { project: 'a', displayName: 'A', color: 1, lastSeenAt: 'now' },
      },
    });
  });

  test('getSeedProjects includes ordered, pinned, hidden, and catalog-only projects', async () => {
    const store = new ProjectSidebarStore(tempDir);
    await store.load();
    store.setState({
      ordered: ['github.com/a/repo'],
      pinned: ['github.com/b/repo'],
      hidden: ['github.com/c/repo'],
      catalog: {
        'github.com/d/repo': {
          project: 'github.com/d/repo',
          displayName: 'd/repo',
          color: 1,
          lastSeenAt: '2026-05-09T00:00:00.000Z',
        },
      },
    });

    expect(store.getSeedProjects()).toEqual([
      'github.com/a/repo',
      'github.com/b/repo',
      'github.com/c/repo',
      'github.com/d/repo',
    ]);
  });
});
