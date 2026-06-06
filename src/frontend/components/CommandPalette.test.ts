// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CommandPalette } from './CommandPalette.js';
import type { CommandAction, CommandTaskItem } from './command-palette-model.js';

let container: HTMLDivElement;
let root: Root;

const runDiagnostics = vi.fn();
const runSchedules = vi.fn();

const actions: CommandAction[] = [
  { id: 'diagnostics', label: 'Diagnostics', section: 'view', keywords: ['health'], run: runDiagnostics },
  { id: 'schedules', label: 'Schedules', section: 'tools', keywords: ['cron'], run: runSchedules },
  { id: 'settings', label: 'Settings', section: 'session', run: vi.fn() },
];
const tasks: CommandTaskItem[] = [
  { taskId: 't1', agentId: 'a1', label: 'Fix telegram STT', status: 'inProgress' },
];

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function render(onSelectTask = vi.fn(), onClose = vi.fn()): { onSelectTask: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> } {
  act(() => {
    root.render(React.createElement(CommandPalette, { actions, tasks, onSelectTask, onClose }));
  });
  return { onSelectTask, onClose };
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
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('browse mode shows all actions grouped by section, no tasks', () => {
    render();
    const rows = container.querySelectorAll('[data-testid="command-palette-action"]');
    expect(rows.length).toBe(3);
    expect(container.querySelectorAll('[data-testid="command-palette-task"]').length).toBe(0);
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

  test('clicking an action runs it and closes', () => {
    const { onClose } = render();
    const schedules = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="command-palette-action"]'))
      .find((b) => b.dataset.actionId === 'schedules')!;
    act(() => schedules.click());
    expect(runSchedules).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
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

  test('selecting a task calls onSelectTask with its agentId', () => {
    const { onSelectTask } = render();
    const input = container.querySelector<HTMLInputElement>('[data-testid="command-palette-input"]')!;
    act(() => setInputValue(input, 'telegram'));
    const taskRow = container.querySelector<HTMLButtonElement>('[data-testid="command-palette-task"]')!;
    act(() => taskRow.click());
    expect(onSelectTask).toHaveBeenCalledWith('a1');
  });
});
