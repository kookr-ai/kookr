// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CommandPalette } from './CommandPalette.js';
import type {
  CommandAction,
  CommandFindingItem,
  CommandProjectItem,
  CommandTaskItem,
} from './command-palette-model.js';

let container: HTMLDivElement;
let root: Root;

const runDiagnostics = vi.fn();
const runSchedules = vi.fn();

const runTour = vi.fn();
const actions: CommandAction[] = [
  { id: 'diagnostics', label: 'Diagnostics', section: 'view', keywords: ['health'], run: runDiagnostics },
  { id: 'schedules', label: 'Schedules', section: 'tools', keywords: ['cron'], run: runSchedules },
  { id: 'settings', label: 'Settings', section: 'session', run: vi.fn() },
  { id: 'tour', label: 'Take the tour', section: 'session', keywords: ['onboarding', 'walkthrough'], run: runTour },
];
const tasks: CommandTaskItem[] = [
  { taskId: 't1', agentId: 'a1', label: 'Fix telegram STT', status: 'inProgress' },
];
const findings: CommandFindingItem[] = [
  {
    agentId: 'finding-agent',
    taskId: 'finding-task',
    label: 'Investigate launch failure',
    severity: 'critical',
    type: 'API Error',
    projectLabel: 'kookr',
    explanation: 'Launch dependency failed',
  },
];
const projects: CommandProjectItem[] = [
  {
    projectId: 'github.com/kookr-ai/kookr',
    label: 'kookr',
    activeAgents: 4,
    findingCount: 2,
    keywords: ['/work/kookr'],
  },
];

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function render(opts: {
  onSelectTask?: ReturnType<typeof vi.fn>;
  onSelectFinding?: ReturnType<typeof vi.fn>;
  onSelectProject?: ReturnType<typeof vi.fn>;
  onLaunchProject?: ReturnType<typeof vi.fn> | undefined;
  onClose?: ReturnType<typeof vi.fn>;
} = {}): {
  onSelectTask: ReturnType<typeof vi.fn>;
  onSelectFinding: ReturnType<typeof vi.fn>;
  onSelectProject: ReturnType<typeof vi.fn>;
  onLaunchProject: ReturnType<typeof vi.fn> | undefined;
  onClose: ReturnType<typeof vi.fn>;
} {
  const onSelectTask = opts.onSelectTask ?? vi.fn();
  const onSelectFinding = opts.onSelectFinding ?? vi.fn();
  const onSelectProject = opts.onSelectProject ?? vi.fn();
  // Passing `onLaunchProject: undefined` explicitly omits the prop (hides the
  // launch action); leaving the key out entirely wires a default mock.
  const onLaunchProject = 'onLaunchProject' in opts ? opts.onLaunchProject : vi.fn();
  const onClose = opts.onClose ?? vi.fn();
  act(() => {
    root.render(React.createElement(CommandPalette, {
      actions,
      tasks,
      findings,
      projects,
      onSelectTask,
      onSelectFinding,
      onSelectProject,
      onLaunchProject,
      onClose,
    }));
  });
  return { onSelectTask, onSelectFinding, onSelectProject, onLaunchProject, onClose };
}

describe('CommandPalette', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    runDiagnostics.mockClear();
    runSchedules.mockClear();
    runTour.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('browse mode shows all actions grouped by section, no tasks', () => {
    render();
    const rows = container.querySelectorAll('[data-testid="command-palette-action"]');
    expect(rows.length).toBe(4);
    expect(container.querySelectorAll('[data-testid="command-palette-task"]').length).toBe(0);
    expect(container.querySelectorAll('[data-testid="command-palette-finding"]').length).toBe(0);
    expect(container.querySelectorAll('[data-testid="command-palette-project"]').length).toBe(0);
    expect(container.textContent).toContain('View');
    expect(container.textContent).toContain('Tools');
    expect(container.textContent).toContain('Session');
  });

  test('typing filters actions and surfaces matching tasks', () => {
    render();
    const input = container.querySelector<HTMLInputElement>('[data-testid="command-palette-input"]')!;
    act(() => setInputValue(input, 'telegram'));
    expect(container.querySelectorAll('[data-testid="command-palette-action"]').length).toBe(0);
    const taskRows = container.querySelectorAll('[data-testid="command-palette-task"]');
    expect(taskRows.length).toBe(1);
    expect(taskRows[0].textContent).toContain('Fix telegram STT');
  });

  test('typing surfaces matching findings with severity metadata', () => {
    render();
    const input = container.querySelector<HTMLInputElement>('[data-testid="command-palette-input"]')!;
    act(() => setInputValue(input, 'launch dependency'));
    const findingRows = container.querySelectorAll('[data-testid="command-palette-finding"]');
    expect(findingRows.length).toBe(1);
    expect(findingRows[0].textContent).toContain('Investigate launch failure');
    expect(findingRows[0].textContent).toContain('critical · API Error');
  });

  test('typing surfaces matching projects with project load metadata', () => {
    render();
    const input = container.querySelector<HTMLInputElement>('[data-testid="command-palette-input"]')!;
    act(() => setInputValue(input, '/work/kookr'));
    const projectRows = container.querySelectorAll('[data-testid="command-palette-project"]');
    expect(projectRows.length).toBe(1);
    expect(projectRows[0].textContent).toContain('github.com/kookr-ai/kookr');
    expect(projectRows[0].textContent).toContain('4 active agents · 2 findings');
  });

  test('clicking an action runs it and closes', () => {
    const { onClose } = render();
    const schedules = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="command-palette-action"]'))
      .find((b) => b.dataset.actionId === 'schedules')!;
    act(() => schedules.click());
    expect(runSchedules).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('typing tour lists Take the tour', () => {
    render();
    const input = container.querySelector<HTMLInputElement>('[data-testid="command-palette-input"]')!;
    act(() => setInputValue(input, 'tour'));
    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="command-palette-action"]'));
    expect(rows.map((row) => row.dataset.actionId)).toEqual(['tour']);
    expect(rows[0].textContent).toContain('Take the tour');
    act(() => rows[0].click());
    expect(runTour).toHaveBeenCalledTimes(1);
  });

  test('Enter runs the first matching action by keyboard', () => {
    render();
    const input = container.querySelector<HTMLInputElement>('[data-testid="command-palette-input"]')!;
    act(() => setInputValue(input, 'health'));
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(runDiagnostics).toHaveBeenCalledTimes(1);
  });

  test('announces the visually selected row with combobox active descendant semantics', () => {
    render();
    const input = container.querySelector<HTMLInputElement>('[data-testid="command-palette-input"]')!;
    const list = container.querySelector<HTMLElement>('[data-testid="command-palette-list"]')!;

    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(list.id).not.toBe('');
    expect(input.getAttribute('aria-controls')).toBe(list.id);
    expect(list.getAttribute('role')).toBe('listbox');

    const initialActiveId = input.getAttribute('aria-activedescendant');
    const initialActiveRow = initialActiveId ? document.getElementById(initialActiveId) : null;
    expect(initialActiveRow).not.toBeNull();
    expect(initialActiveRow).toBe(container.querySelector('.cmd-row.sel'));
    expect(initialActiveRow?.getAttribute('role')).toBe('option');
    expect(initialActiveRow?.getAttribute('tabindex')).toBe('-1');
    expect(initialActiveRow?.getAttribute('aria-selected')).toBe('true');
    expect(initialActiveRow?.getAttribute('aria-label')).toBe('Action: Diagnostics');

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });

    const nextActiveId = input.getAttribute('aria-activedescendant');
    const nextActiveRow = nextActiveId ? document.getElementById(nextActiveId) : null;
    expect(nextActiveId).not.toBe(initialActiveId);
    expect(nextActiveRow).toBe(container.querySelector('.cmd-row.sel'));
    expect(nextActiveRow?.getAttribute('aria-selected')).toBe('true');
    expect(nextActiveRow?.getAttribute('aria-label')).toBe('Action: Schedules');
    expect(initialActiveRow?.getAttribute('aria-selected')).toBe('false');

    act(() => setInputValue(input, 'telegram'));

    const filteredActiveId = input.getAttribute('aria-activedescendant');
    const filteredActiveRow = filteredActiveId ? document.getElementById(filteredActiveId) : null;
    expect(filteredActiveRow).toBe(container.querySelector('.cmd-row.sel'));
    expect(filteredActiveRow?.getAttribute('data-testid')).toBe('command-palette-task');
    expect(filteredActiveRow?.getAttribute('aria-label')).toBe('Task: Fix telegram STT');
  });

  test('keeps empty results valid for the listbox contract', () => {
    render();
    const input = container.querySelector<HTMLInputElement>('[data-testid="command-palette-input"]')!;

    act(() => setInputValue(input, 'no matching command'));

    const list = container.querySelector<HTMLElement>('[data-testid="command-palette-list"]')!;
    const emptyOption = list.querySelector<HTMLElement>('[role="option"]')!;
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
    expect(emptyOption).not.toBeNull();
    expect(emptyOption.className).toBe('cmd-empty');
    expect(emptyOption.getAttribute('aria-disabled')).toBe('true');
    expect(emptyOption.getAttribute('aria-selected')).toBe('false');
  });

  test('selecting a task calls onSelectTask with its agentId and taskId', () => {
    const { onSelectTask } = render();
    const input = container.querySelector<HTMLInputElement>('[data-testid="command-palette-input"]')!;
    act(() => setInputValue(input, 'telegram'));
    const taskRow = container.querySelector<HTMLButtonElement>('[data-testid="command-palette-task"]')!;
    act(() => taskRow.click());
    expect(onSelectTask).toHaveBeenCalledWith('a1', 't1');
  });

  test('selecting a finding calls onSelectFinding with its agentId and taskId', () => {
    const { onSelectFinding } = render();
    const input = container.querySelector<HTMLInputElement>('[data-testid="command-palette-input"]')!;
    act(() => setInputValue(input, 'api error'));
    const findingRow = container.querySelector<HTMLButtonElement>('[data-testid="command-palette-finding"]')!;
    act(() => findingRow.click());
    expect(onSelectFinding).toHaveBeenCalledWith('finding-agent', 'finding-task');
  });

  test('selecting a project calls onSelectProject with its project id', () => {
    const { onSelectProject } = render();
    const input = container.querySelector<HTMLInputElement>('[data-testid="command-palette-input"]')!;
    act(() => setInputValue(input, 'kookr-ai'));
    const projectRow = container.querySelector<HTMLButtonElement>('[data-testid="command-palette-project"]')!;
    act(() => projectRow.click());
    expect(onSelectProject).toHaveBeenCalledWith('github.com/kookr-ai/kookr');
  });

  test('a matched project offers a distinct launch action alongside plain selection', () => {
    render();
    const input = container.querySelector<HTMLInputElement>('[data-testid="command-palette-input"]')!;
    act(() => setInputValue(input, 'kookr-ai'));
    const selectRow = container.querySelector<HTMLButtonElement>('[data-testid="command-palette-project"]')!;
    const launchRow = container.querySelector<HTMLButtonElement>('[data-testid="command-palette-project-launch"]')!;
    expect(selectRow).not.toBeNull();
    expect(launchRow).not.toBeNull();
    expect(launchRow.textContent).toContain('Launch task in kookr');
    expect(launchRow.getAttribute('aria-label')).toBe('Launch task in kookr — opens the manual launch dialog');
    // WCAG 2.5.3: visible primary text is a leading substring of the accessible name.
    expect(launchRow.getAttribute('aria-label')).toContain('Launch task in kookr');
    // The launch row is a separate selectable row immediately after the select row.
    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>('.cmd-row'));
    expect(rows.indexOf(launchRow)).toBe(rows.indexOf(selectRow) + 1);
  });

  test('clicking the project launch row calls onLaunchProject and closes', () => {
    const { onLaunchProject, onSelectProject, onClose } = render();
    const input = container.querySelector<HTMLInputElement>('[data-testid="command-palette-input"]')!;
    act(() => setInputValue(input, 'kookr-ai'));
    const launchRow = container.querySelector<HTMLButtonElement>('[data-testid="command-palette-project-launch"]')!;
    act(() => launchRow.click());
    expect(onLaunchProject).toHaveBeenCalledWith('github.com/kookr-ai/kookr');
    expect(onSelectProject).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('the project launch row is reachable and activatable by keyboard', () => {
    const { onLaunchProject } = render();
    const input = container.querySelector<HTMLInputElement>('[data-testid="command-palette-input"]')!;
    act(() => setInputValue(input, 'kookr-ai'));
    // First selectable project row is the plain select; ArrowDown moves to the launch row.
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    const activeId = input.getAttribute('aria-activedescendant');
    const activeRow = activeId ? document.getElementById(activeId) : null;
    expect(activeRow?.getAttribute('data-testid')).toBe('command-palette-project-launch');
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onLaunchProject).toHaveBeenCalledWith('github.com/kookr-ai/kookr');
  });

  test('omitting onLaunchProject hides the launch action but keeps plain selection', () => {
    const { onSelectProject } = render({ onLaunchProject: undefined });
    const input = container.querySelector<HTMLInputElement>('[data-testid="command-palette-input"]')!;
    act(() => setInputValue(input, 'kookr-ai'));
    expect(container.querySelector('[data-testid="command-palette-project-launch"]')).toBeNull();
    const projectRow = container.querySelector<HTMLButtonElement>('[data-testid="command-palette-project"]')!;
    act(() => projectRow.click());
    expect(onSelectProject).toHaveBeenCalledWith('github.com/kookr-ai/kookr');
  });
});
