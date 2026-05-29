// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { PlaybookBrowser } from './PlaybookBrowser.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { ClientMessage, Playbook } from '../../shared/protocol.js';
import type { ProjectSummary } from '../../shared/protocol.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function setInputValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function flush() {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

const loopablePlaybook: Playbook = {
  id: 'workflow.md',
  name: 'Workflow',
  description: 'Loop-compatible workflow',
  parameters: [],
  checklist: [],
  tags: ['workflow', 'loopable'],
  effectiveLoop: {
    iterationCap: 6,
    costCapUsd: 25,
    sources: {
      iterationCap: 'default',
      costCapUsd: 'default',
    },
  },
  body: 'Do it.',
  sourceCwd: '/repo',
  scope: 'project',
};

const plainPlaybook: Playbook = {
  id: 'plain.md',
  name: 'Plain',
  description: 'One shot',
  parameters: [],
  checklist: [],
  tags: [],
  body: 'Do it once.',
  sourceCwd: '/repo',
  scope: 'project',
};

const projectSummary: ProjectSummary = {
  project: 'github.com/acme/target',
  displayName: 'acme/target',
  color: 1,
  activeAgents: 0,
  findingCount: 0,
  todayPrCount: 0,
  weekPrCount: 0,
  openPrs: 0,
  recentTasks: [],
  localPath: '/target',
};

describe('PlaybookBrowser loopable workflows', () => {
  let container: HTMLDivElement;
  let root: Root;
  let sent: ClientMessage[];
  let closeCount: number;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    useKookrStore.setState({
      playbooks: [loopablePlaybook, plainPlaybook],
      playbooksLoading: false,
      availableAgentTypes: [],
      defaultAgentType: 'claude-code',
    });
    sent = [];
    closeCount = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(PlaybookBrowser, {
          cwd: '/repo',
          send: (msg: ClientMessage) => {
            sent.push(msg);
            return true;
          },
          onClose: () => { closeCount += 1; },
        }),
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  test('renders loopable tag as a badge on the playbook card', async () => {
    await flush();

    // The loopable playbook card should show both 'workflow' and 'loopable' badges
    const cards = container.querySelectorAll('.playbook-card');
    const workflowCard = Array.from(cards).find((c) => c.textContent?.includes('Workflow'));
    expect(workflowCard).toBeTruthy();
    expect(workflowCard!.querySelector('.playbook-tag-loopable')).toBeTruthy();
    expect(workflowCard!.querySelector('.playbook-tag-workflow')).toBeTruthy();
    expect(workflowCard!.querySelector('.playbook-tag-loopable svg')).toBeTruthy();
    expect(workflowCard!.querySelector('.playbook-tag-workflow svg')).toBeTruthy();

    // The plain playbook should not show any tag badges
    const plainCard = Array.from(cards).find((c) => c.textContent?.includes('Plain'));
    expect(plainCard).toBeTruthy();
    expect(plainCard!.querySelector('.playbook-tag-loopable')).toBeNull();
  });

  test('shows loopable filter button with correct count', async () => {
    await flush();

    const filterBtn = container.querySelector<HTMLButtonElement>('.playbook-filter');
    expect(filterBtn).toBeTruthy();
    expect(filterBtn!.textContent).toContain('Loopable workflows (1)');
    expect(filterBtn!.querySelector('svg')).toBeTruthy();
  });

  test('renders pin as an accessible icon button', async () => {
    await flush();

    const pinBtn = container.querySelector<HTMLButtonElement>('.playbook-pin-btn');
    expect(pinBtn).toBeTruthy();
    expect(pinBtn!.getAttribute('aria-label')).toBe('Pin playbook to top');
    expect(pinBtn!.querySelector('svg')).toBeTruthy();
  });

  test('renders pinned state with filled pin controls', async () => {
    await flush();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.playbook-pin-btn')!.click();
    });

    const pinnedBtn = container.querySelector<HTMLButtonElement>('.playbook-pin-btn.pinned');
    expect(pinnedBtn).toBeTruthy();
    expect(pinnedBtn!.getAttribute('aria-label')).toBe('Unpin playbook');
    expect(pinnedBtn!.querySelector('svg.filled')).toBeTruthy();
    expect(container.querySelector('.playbook-pin-indicator svg.filled')).toBeTruthy();
  });

  test('filter button shows only loopable playbooks when active', async () => {
    await flush();

    // Before filtering: both playbooks visible
    expect(container.textContent).toContain('Workflow');
    expect(container.textContent).toContain('Plain');

    // Activate filter
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.playbook-filter')!.click();
    });

    // Only loopable playbook should appear
    expect(container.textContent).toContain('Workflow');
    expect(container.textContent).not.toContain('Plain');
  });

  test('filter combined with search hides non-matching loopable playbooks', async () => {
    await flush();

    // Activate loopable filter first
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.playbook-filter')!.click();
    });

    // Search for something that matches only the plain playbook
    await act(async () => {
      setInputValue(container.querySelector<HTMLInputElement>('.playbook-search-input')!, 'Plain');
    });

    // No cards should appear because 'Plain' is not loopable
    expect(container.querySelector('.playbook-card')).toBeNull();
  });

  test('shows validation message for non-loopable playbook when looped mode would apply', async () => {
    await flush();

    // Click into the plain (non-loopable) playbook detail
    await act(async () => {
      const cards = container.querySelectorAll<HTMLElement>('.playbook-card');
      const plainCard = Array.from(cards).find((c) => c.textContent?.includes('Plain'));
      plainCard!.click();
    });

    // The "Run looped" button should be disabled
    const loopedBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('.launch-mode-option'))
      .find((btn) => btn.textContent === 'Run looped');
    expect(loopedBtn).toBeTruthy();
    expect(loopedBtn!.disabled).toBe(true);

    // The validation message should be visible
    expect(container.textContent).toContain('Looping unavailable: this playbook is not tagged loopable.');
  });

  test('loopable tag badge shown in detail view header', async () => {
    await flush();

    // Click into the loopable playbook
    await act(async () => {
      const cards = container.querySelectorAll<HTMLElement>('.playbook-card');
      const workflowCard = Array.from(cards).find((c) => c.textContent?.includes('Workflow'));
      workflowCard!.click();
    });

    // The detail header should show the loopable tag badge
    expect(container.querySelector('.playbook-tag-loopable')).toBeTruthy();
  });

  test('launches loopable playbooks through the looped endpoint', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ id: 'task-1' }),
    });
    await flush();

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLElement>('.playbook-card'))
        .find((card) => card.textContent?.includes('Workflow'))!
        .click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('.launch-mode-option'))
        .find((button) => button.textContent === 'Run looped')!
        .click();
    });
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(sent).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith('/api/playbooks/ralph-loop', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kookr-Launch-Source': 'ui' },
    }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      playbookPath: 'workflow.md',
      cwd: '/repo',
      parameterValues: {},
    });
    expect(closeCount).toBe(1);
  });

  test('sends split source and target cwd for project-context standard launches', async () => {
    await act(async () => {
      root.render(
        React.createElement(PlaybookBrowser, {
          cwd: '/repo',
          playbookSourceCwd: '/catalog',
          taskTargetCwd: '/target',
          projectContext: projectSummary,
          send: (msg: ClientMessage) => {
            sent.push(msg);
            return true;
          },
          onClose: () => { closeCount += 1; },
        }),
      );
    });
    await flush();

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLElement>('.playbook-card'))
        .find((card) => card.textContent?.includes('Plain'))!
        .click();
    });
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(sent).toEqual([expect.objectContaining({
      type: 'launchPlaybook',
      playbookPath: 'plain.md',
      playbookSourceCwd: '/catalog',
      taskTargetCwd: '/target',
      projectId: 'github.com/acme/target',
      parameterValues: {},
    })]);
    expect(sent[0]).not.toHaveProperty('cwd');
    expect(closeCount).toBe(1);
  });

  test('sends split source and target cwd for project-context looped launches', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ id: 'task-1' }),
    });
    await act(async () => {
      root.render(
        React.createElement(PlaybookBrowser, {
          cwd: '/repo',
          playbookSourceCwd: '/catalog',
          taskTargetCwd: '/target',
          projectContext: projectSummary,
          send: (msg: ClientMessage) => {
            sent.push(msg);
            return true;
          },
          onClose: () => { closeCount += 1; },
        }),
      );
    });
    await flush();

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLElement>('.playbook-card'))
        .find((card) => card.textContent?.includes('Workflow'))!
        .click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('.launch-mode-option'))
        .find((button) => button.textContent === 'Run looped')!
        .click();
    });
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledWith('/api/playbooks/ralph-loop', expect.objectContaining({
      method: 'POST',
    }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      playbookPath: 'workflow.md',
      playbookSourceCwd: '/catalog',
      taskTargetCwd: '/target',
      projectId: 'github.com/acme/target',
      parameterValues: {},
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('cwd');
    expect(closeCount).toBe(1);
  });

  test('sends split source and target cwd when a catalog playbook runs in a different cwd', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ id: 'task-1' }),
    });
    await act(async () => {
      useKookrStore.setState({
        playbooks: [{ ...loopablePlaybook, sourceCwd: '/catalog' }],
      });
      root.render(
        React.createElement(PlaybookBrowser, {
          cwd: '/target',
          send: (msg: ClientMessage) => {
            sent.push(msg);
            return true;
          },
          onClose: () => { closeCount += 1; },
        }),
      );
    });
    await flush();

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLElement>('.playbook-card'))
        .find((card) => card.textContent?.includes('Workflow'))!
        .click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('.launch-mode-option'))
        .find((button) => button.textContent === 'Run looped')!
        .click();
    });
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledWith('/api/playbooks/ralph-loop', expect.objectContaining({
      method: 'POST',
    }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      playbookPath: 'workflow.md',
      playbookSourceCwd: '/catalog',
      taskTargetCwd: '/target',
      parameterValues: {},
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('cwd');
    expect(closeCount).toBe(1);
  });

  test('sends split source and target cwd for standard catalog playbook launches', async () => {
    await act(async () => {
      useKookrStore.setState({
        playbooks: [{ ...plainPlaybook, sourceCwd: '/catalog' }],
      });
      root.render(
        React.createElement(PlaybookBrowser, {
          cwd: '/target',
          send: (msg: ClientMessage) => {
            sent.push(msg);
            return true;
          },
          onClose: () => { closeCount += 1; },
        }),
      );
    });
    await flush();

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLElement>('.playbook-card'))
        .find((card) => card.textContent?.includes('Plain'))!
        .click();
    });
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(sent).toEqual([expect.objectContaining({
      type: 'launchPlaybook',
      playbookPath: 'plain.md',
      playbookSourceCwd: '/catalog',
      taskTargetCwd: '/target',
      parameterValues: {},
    })]);
    expect(sent[0]).not.toHaveProperty('cwd');
    expect(closeCount).toBe(1);
  });

  test('keeps pinned playbook cwd when catalog source differs from target cwd', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ id: 'task-1' }),
    });
    await act(async () => {
      useKookrStore.setState({
        playbooks: [{ ...loopablePlaybook, sourceCwd: '/catalog', cwd: '/pinned' }],
      });
      root.render(
        React.createElement(PlaybookBrowser, {
          cwd: '/target',
          send: (msg: ClientMessage) => {
            sent.push(msg);
            return true;
          },
          onClose: () => { closeCount += 1; },
        }),
      );
    });
    await flush();

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLElement>('.playbook-card'))
        .find((card) => card.textContent?.includes('Workflow'))!
        .click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('.launch-mode-option'))
        .find((button) => button.textContent === 'Run looped')!
        .click();
    });
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      playbookPath: 'workflow.md',
      playbookSourceCwd: '/catalog',
      taskTargetCwd: '/pinned',
      parameterValues: {},
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('cwd');
    expect(closeCount).toBe(1);
  });

  test('keeps pinned playbook cwd for standard launches from a project context', async () => {
    await act(async () => {
      useKookrStore.setState({
        playbooks: [{ ...plainPlaybook, sourceCwd: '/catalog', cwd: '/pinned' }],
      });
      root.render(
        React.createElement(PlaybookBrowser, {
          cwd: '/target',
          playbookSourceCwd: '/catalog',
          taskTargetCwd: '/target',
          projectContext: projectSummary,
          send: (msg: ClientMessage) => {
            sent.push(msg);
            return true;
          },
          onClose: () => { closeCount += 1; },
        }),
      );
    });
    await flush();

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLElement>('.playbook-card'))
        .find((card) => card.textContent?.includes('Plain'))!
        .click();
    });
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(sent).toEqual([expect.objectContaining({
      type: 'launchPlaybook',
      playbookPath: 'plain.md',
      playbookSourceCwd: '/catalog',
      taskTargetCwd: '/pinned',
      parameterValues: {},
    })]);
    expect(sent[0]).not.toHaveProperty('cwd');
    expect(sent[0]).not.toHaveProperty('projectId');
    expect(container.querySelector('.playbook-target-cwd-field')).toBeNull();
    expect(closeCount).toBe(1);
  });

  test('edits the project target cwd without leaving playbook detail or looped mode', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ id: 'task-1' }),
    });
    function BrowserWithTargetState() {
      const [targetCwd, setTargetCwd] = React.useState('/target');
      return React.createElement(PlaybookBrowser, {
        cwd: targetCwd,
        playbookSourceCwd: '/catalog',
        taskTargetCwd: targetCwd,
        projectContext: projectSummary,
        onTaskTargetCwdChange: setTargetCwd,
        send: (msg: ClientMessage) => {
          sent.push(msg);
          return true;
        },
        onClose: () => { closeCount += 1; },
      });
    }
    await act(async () => {
      root.render(React.createElement(BrowserWithTargetState));
    });
    await flush();

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLElement>('.playbook-card'))
        .find((card) => card.textContent?.includes('Workflow'))!
        .click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('.launch-mode-option'))
        .find((button) => button.textContent === 'Run looped')!
        .click();
    });
    await act(async () => {
      setInputValue(container.querySelector<HTMLInputElement>('.playbook-target-cwd-field input')!, '/other-target');
    });
    await flush();

    expect(container.textContent).toContain('Workflow');
    const loopedButton = Array.from(container.querySelectorAll<HTMLButtonElement>('.launch-mode-option'))
      .find((button) => button.textContent === 'Run looped')!;
    expect(loopedButton.className).toContain('active');

    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      playbookSourceCwd: '/catalog',
      taskTargetCwd: '/other-target',
      projectId: 'github.com/acme/target',
    });
    expect(closeCount).toBe(1);
  });

  test('shows the conflict dialog and replaces via the new endpoint when 409 carries conflictKind', async () => {
    // First call (Launch) returns the new conflict body. Second call (Replace)
    // returns 201. We confirm the dialog renders, then the Replace button
    // triggers POST /api/tasks/:id/ralph-loop/replace-with-new.
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/playbooks/ralph-loop') {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: 'matching looped playbook task already exists: existing-1',
            taskId: 'existing-1',
            conflictKind: 'duplicate_active_loop',
            ralphLoop: {
              status: 'running',
              currentIteration: 4,
              lastIterationStartedAt: Date.now() - 30_000,
            },
          }),
        };
      }
      if (url === '/api/tasks/existing-1/ralph-loop/replace-with-new') {
        return { ok: true, status: 201, json: async () => ({ id: 'task-new' }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    await flush();

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLElement>('.playbook-card'))
        .find((card) => card.textContent?.includes('Workflow'))!
        .click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('.launch-mode-option'))
        .find((b) => b.textContent === 'Run looped')!
        .click();
    });
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    // Conflict dialog rendered with the iteration count from the body.
    const banner = container.querySelector('.ralph-conflict-banner');
    expect(banner).toBeTruthy();
    expect(banner!.textContent).toContain('iteration 4');

    // Click "Replace it (start fresh)".
    const replaceBtn = Array.from(banner!.querySelectorAll<HTMLButtonElement>('button'))
      .find((b) => b.textContent?.includes('Replace it'));
    expect(replaceBtn).toBeTruthy();
    await act(async () => { replaceBtn!.click(); });
    await flush();

    // Replace endpoint was called.
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks/existing-1/ralph-loop/replace-with-new',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(closeCount).toBe(1);
  });

  test('replace loop sends split source and target cwd for project-context launches', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/playbooks/ralph-loop') {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: 'matching looped playbook task already exists: existing-1',
            taskId: 'existing-1',
            conflictKind: 'duplicate_active_loop',
            ralphLoop: {
              status: 'running',
              currentIteration: 4,
              lastIterationStartedAt: Date.now() - 30_000,
            },
          }),
        };
      }
      if (url === '/api/tasks/existing-1/ralph-loop/replace-with-new') {
        return { ok: true, status: 201, json: async () => ({ id: 'task-new' }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    await act(async () => {
      root.render(
        React.createElement(PlaybookBrowser, {
          cwd: '/repo',
          playbookSourceCwd: '/catalog',
          taskTargetCwd: '/target',
          projectContext: projectSummary,
          send: (msg: ClientMessage) => {
            sent.push(msg);
            return true;
          },
          onClose: () => { closeCount += 1; },
        }),
      );
    });
    await flush();

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLElement>('.playbook-card'))
        .find((card) => card.textContent?.includes('Workflow'))!
        .click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('.launch-mode-option'))
        .find((b) => b.textContent === 'Run looped')!
        .click();
    });
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    const banner = container.querySelector('.ralph-conflict-banner')!;
    const replaceBtn = Array.from(banner.querySelectorAll<HTMLButtonElement>('button'))
      .find((b) => b.textContent?.includes('Replace it'))!;
    await act(async () => { replaceBtn.click(); });
    await flush();

    const replaceCall = fetchMock.mock.calls.find((call) => call[0] === '/api/tasks/existing-1/ralph-loop/replace-with-new');
    expect(replaceCall).toBeTruthy();
    const body = JSON.parse(replaceCall![1].body);
    expect(body).toMatchObject({
      playbookPath: 'workflow.md',
      playbookSourceCwd: '/catalog',
      taskTargetCwd: '/target',
      projectId: 'github.com/acme/target',
      parameterValues: {},
    });
    expect(body).not.toHaveProperty('cwd');
    expect(closeCount).toBe(1);
  });

  test('replace loop sends split source and target cwd for catalog playbook launches', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/playbooks/ralph-loop') {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: 'matching looped playbook task already exists: existing-1',
            taskId: 'existing-1',
            conflictKind: 'duplicate_active_loop',
            ralphLoop: {
              status: 'running',
              currentIteration: 4,
              lastIterationStartedAt: Date.now() - 30_000,
            },
          }),
        };
      }
      if (url === '/api/tasks/existing-1/ralph-loop/replace-with-new') {
        return { ok: true, status: 201, json: async () => ({ id: 'task-new' }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    await act(async () => {
      useKookrStore.setState({
        playbooks: [{ ...loopablePlaybook, sourceCwd: '/catalog' }],
      });
      root.render(
        React.createElement(PlaybookBrowser, {
          cwd: '/target',
          send: (msg: ClientMessage) => {
            sent.push(msg);
            return true;
          },
          onClose: () => { closeCount += 1; },
        }),
      );
    });
    await flush();

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLElement>('.playbook-card'))
        .find((card) => card.textContent?.includes('Workflow'))!
        .click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('.launch-mode-option'))
        .find((button) => button.textContent === 'Run looped')!
        .click();
    });
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    const banner = container.querySelector('.ralph-conflict-banner')!;
    const replaceBtn = Array.from(banner.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Replace it'))!;
    await act(async () => { replaceBtn.click(); });
    await flush();

    const replaceCall = fetchMock.mock.calls.find((call) => call[0] === '/api/tasks/existing-1/ralph-loop/replace-with-new');
    expect(replaceCall).toBeTruthy();
    const body = JSON.parse(replaceCall![1].body);
    expect(body).toMatchObject({
      playbookPath: 'workflow.md',
      playbookSourceCwd: '/catalog',
      taskTargetCwd: '/target',
      parameterValues: {},
    });
    expect(body).not.toHaveProperty('cwd');
    expect(closeCount).toBe(1);
  });

  test('falls through to the generic toast when 409 lacks conflictKind (old backend)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        // No conflictKind field — the new frontend should NOT show the
        // dialog and should fall back to the existing alert behavior.
        error: 'matching looped playbook task already exists: legacy-1',
        taskId: 'legacy-1',
      }),
    });
    await flush();

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLElement>('.playbook-card'))
        .find((c) => c.textContent?.includes('Workflow'))!
        .click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('.launch-mode-option'))
        .find((b) => b.textContent === 'Run looped')!
        .click();
    });
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(container.querySelector('.ralph-conflict-banner')).toBeNull();
    // The dialog stays open because the launch errored — `onClose` not called.
    expect(closeCount).toBe(0);
  });

  test('shows a standalone-plugin conflict inline when 409 carries conflictKind', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        error: 'standalone ralph-wiggum plugin detected — would double-fire on Stop',
        conflictKind: 'standalone_ralph_plugin',
        matchedFiles: ['/repo/.claude/settings.local.json'],
        reasons: ['enabledPlugins["ralph-wiggum@claude-code-plugins"] is true'],
      }),
    });
    await flush();

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLElement>('.playbook-card'))
        .find((c) => c.textContent?.includes('Workflow'))!
        .click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('.launch-mode-option'))
        .find((b) => b.textContent === 'Run looped')!
        .click();
    });
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    const banner = container.querySelector('.ralph-conflict-banner');
    expect(banner).toBeTruthy();
    expect(banner!.textContent).toContain('Standalone Ralph plugin is enabled');
    expect(banner!.textContent).toContain('/repo/.claude/settings.local.json');
    expect(banner!.textContent).toContain('enabledPlugins["ralph-wiggum@claude-code-plugins"] is true');
    expect(closeCount).toBe(0);
  });

  test('shows standalone-plugin conflict when Replace is blocked by the guard', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/playbooks/ralph-loop') {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: 'matching looped playbook task already exists: existing-1',
            taskId: 'existing-1',
            conflictKind: 'duplicate_active_loop',
            ralphLoop: {
              status: 'running',
              currentIteration: 4,
              lastIterationStartedAt: Date.now() - 30_000,
            },
          }),
        };
      }
      if (url === '/api/tasks/existing-1/ralph-loop/replace-with-new') {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: 'standalone ralph-wiggum plugin detected — would double-fire on Stop',
            conflictKind: 'standalone_ralph_plugin',
            matchedFiles: ['/repo/.claude/settings.local.json'],
            reasons: ['enabledPlugins["ralph-wiggum@claude-code-plugins"] is true'],
          }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    await flush();

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLElement>('.playbook-card'))
        .find((card) => card.textContent?.includes('Workflow'))!
        .click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('.launch-mode-option'))
        .find((b) => b.textContent === 'Run looped')!
        .click();
    });
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    const duplicateBanner = container.querySelector('.ralph-conflict-banner')!;
    expect(duplicateBanner.textContent).toContain('A loop is already running');
    const replaceBtn = Array.from(duplicateBanner.querySelectorAll<HTMLButtonElement>('button'))
      .find((b) => b.textContent?.includes('Replace it'));
    expect(replaceBtn).toBeTruthy();
    await act(async () => { replaceBtn!.click(); });
    await flush();

    const pluginBanner = container.querySelector('.ralph-conflict-banner')!;
    expect(pluginBanner.textContent).toContain('Standalone Ralph plugin is enabled');
    expect(pluginBanner.textContent).toContain('/repo/.claude/settings.local.json');
    expect(closeCount).toBe(0);
  });
});
