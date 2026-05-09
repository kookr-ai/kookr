// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProjectSidebar } from './ProjectSidebar.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function seedProjects() {
  useKookrStore.getState().handleProjectSummaries([
    {
      project: 'github.com/a',
      displayName: 'owner/a',
      color: 1,
      activeAgents: 1,
      findingCount: 0,
      todayPrCount: 0,
      weekPrCount: 0,
      openPrs: 0,
      recentTasks: [],
    },
    {
      project: 'github.com/b',
      displayName: 'owner/b',
      color: 2,
      activeAgents: 0,
      findingCount: 2,
      todayPrCount: 1,
      weekPrCount: 1,
      openPrs: 0,
      recentTasks: [],
    },
  ]);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('ProjectSidebar interactions', () => {
  let container: HTMLDivElement;
  let root: Root;
  let localStore: Map<string, string>;

  beforeEach(() => {
    document.body.innerHTML = '';
    // Tell React this environment supports act() so createRoot updates flush in tests.
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStore = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => localStore.get(key) ?? null,
      setItem: (key: string, value: string) => localStore.set(key, value),
      removeItem: (key: string) => localStore.delete(key),
      clear: () => localStore.clear(),
    });
    syncGlobalStore();
    seedProjects();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    document.body.innerHTML = '';
  });

  test('organizer button opens via callback and no text manage button remains', async () => {
    const onManage = vi.fn();

    await act(async () => {
      root.render(React.createElement(ProjectSidebar, { onManage }));
    });
    await flush();

    const organizer = container.querySelector('[data-testid="project-sidebar-organizer"]');
    expect(organizer).not.toBeNull();
    expect(container.textContent).not.toContain('Manage');

    await act(async () => {
      organizer!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onManage).toHaveBeenCalledTimes(1);
  });

  test('clicking the selected project icon keeps the project drawer selected', async () => {
    useKookrStore.getState().selectProject('github.com/a');

    await act(async () => {
      root.render(React.createElement(ProjectSidebar, { onManage: vi.fn() }));
    });
    await flush();

    const iconA = container.querySelector('[data-testid="project-icon-github.com/a"]');
    expect(iconA).not.toBeNull();

    await act(async () => {
      iconA!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(useKookrStore.getState().selectedProject).toBe('github.com/a');
  });

  test('right click opens context menu and pin action updates store state', async () => {
    await act(async () => {
      root.render(React.createElement(ProjectSidebar, { onManage: vi.fn() }));
    });
    await flush();

    const iconA = container.querySelector('[data-testid="project-icon-github.com/a"]');
    expect(iconA).not.toBeNull();

    await act(async () => {
      iconA!.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 50,
      }));
    });

    const pinButton = document.body.querySelector('.project-sidebar-menu-item');
    expect(pinButton?.textContent).toBe('Pin to sidebar');

    await act(async () => {
      pinButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(useKookrStore.getState().visibleProjectSummaries.map((project) => project.project)).toEqual([
      'github.com/a',
      'github.com/b',
    ]);
    expect(useKookrStore.getState().projectSidebarRows.find((row) => row.project === 'github.com/a')?.pinned).toBe(true);
  });

  test('keyboard context menu supports move actions from the rail', async () => {
    useKookrStore.getState().pinProjectToTop('github.com/a');

    await act(async () => {
      root.render(React.createElement(ProjectSidebar, { onManage: vi.fn() }));
    });
    await flush();

    const iconA = container.querySelector('[data-testid="project-icon-github.com/a"]');
    expect(iconA).not.toBeNull();

    await act(async () => {
      iconA!.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        key: 'ContextMenu',
      }));
    });

    const buttons = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.project-sidebar-menu-item'));
    const unpinButton = buttons.find((button) => button.textContent === 'Unpin');
    expect(unpinButton).toBeDefined();

    await act(async () => {
      unpinButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(useKookrStore.getState().projectSidebarRows.find((row) => row.project === 'github.com/a')?.pinned).toBe(false);
  });

  test('move actions in context menu reorder within the current section', async () => {
    useKookrStore.getState().pinProjectToTop('github.com/a');
    useKookrStore.getState().pinProjectToTop('github.com/b');

    await act(async () => {
      root.render(React.createElement(ProjectSidebar, { onManage: vi.fn() }));
    });
    await flush();

    const iconB = container.querySelector('[data-testid="project-icon-github.com/b"]');
    expect(iconB).not.toBeNull();

    await act(async () => {
      iconB!.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 32,
        clientY: 40,
      }));
    });

    const moveDownButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.project-sidebar-menu-item'))
      .find((button) => button.textContent === 'Move down');
    expect(moveDownButton).toBeDefined();
    expect(moveDownButton?.disabled).toBe(false);

    await act(async () => {
      moveDownButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(useKookrStore.getState().visibleProjectSummaries.map((project) => project.project)).toEqual([
      'github.com/a',
      'github.com/b',
    ]);
  });
});
