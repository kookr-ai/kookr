// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createKookrStore, useKookrStore } from '../../store/useStore.js';
import type { ApiResult } from '../../api/client.js';
import type { MigratableResponse, MigrateTasksResponse } from '../../api/tasks.js';

const { getMigratableTasks, migrateTasks } = vi.hoisted(() => ({
  getMigratableTasks: vi.fn(),
  migrateTasks: vi.fn(),
}));

vi.mock('../../api/tasks.js', () => ({ getMigratableTasks, migrateTasks }));

// Imported AFTER the mock is registered so the component binds the stubbed api.
const { MigrateTaskControl } = await import('./MigrateTaskControl.js');

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

/** Resolve the pending preview/migrate promises and let React re-render. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function migratableOk(candidates: MigratableResponse['candidates']): ApiResult<MigratableResponse> {
  return { ok: true, status: 200, body: { targetAgent: 'codex-cli', candidates } };
}

function findEligibilityLine(container: HTMLElement): string {
  return container.querySelector('[data-testid="migrate-eligibility"]')?.textContent ?? '';
}

function confirmButton(container: HTMLElement): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll('.confirm-dialog-actions button'));
  const btn = buttons.find((b) => b.textContent === 'Migrate' || b.textContent === 'Migrating…');
  if (!(btn instanceof HTMLButtonElement)) throw new Error('confirm button not found');
  return btn;
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

describe('MigrateTaskControl eligibility preview', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    useKookrStore.setState({
      availableAgentTypes: [
        { type: 'claude-code', label: 'Claude Code' },
        { type: 'codex-cli', label: 'Codex CLI' },
      ],
      handleAlert: vi.fn(),
    });
    getMigratableTasks.mockReset();
    migrateTasks.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  function render() {
    root = createRoot(container);
    act(() => {
      root!.render(<MigrateTaskControl taskId="task-1" currentAgentType="claude-code" />);
    });
  }

  test('shows an eligible preview and keeps confirm enabled', async () => {
    getMigratableTasks.mockResolvedValue(
      migratableOk([
        { taskId: 'task-1', name: null, cwd: '/repo', fromAgent: 'claude-code', status: 'terminated', eligible: true, worktreeShared: false },
      ]),
    );
    render();

    // Open the per-task migrate dialog.
    click(container.querySelector('.action-btn')!);
    await flush();

    // Preview is ids-scoped to THIS task for the selected target.
    expect(getMigratableTasks).toHaveBeenCalledWith(
      expect.objectContaining({ targetAgent: 'codex-cli', taskIds: ['task-1'] }),
      expect.anything(),
    );
    // Preview line uses the human agent label (matching the picker), not the id.
    expect(findEligibilityLine(container)).toBe('Migratable to Codex CLI');
    expect(confirmButton(container).disabled).toBe(false);
  });

  test('shows the block reason and disables confirm when ineligible', async () => {
    getMigratableTasks.mockResolvedValue(
      migratableOk([
        { taskId: 'task-1', eligible: false, reason: 'live_session_exists', worktreeShared: null },
      ]),
    );
    render();

    click(container.querySelector('.action-btn')!);
    await flush();

    expect(findEligibilityLine(container)).toBe(
      'Migrate blocked: Task is still running — stop it first, then migrate',
    );
    const btn = confirmButton(container);
    expect(btn.disabled).toBe(true);

    // Clicking the disabled confirm must not fire a known-blocked migrate.
    click(btn);
    await flush();
    expect(migrateTasks).not.toHaveBeenCalled();
  });

  test('confirming an eligible task posts an ids-scoped migrate', async () => {
    getMigratableTasks.mockResolvedValue(
      migratableOk([
        { taskId: 'task-1', name: null, cwd: '/repo', fromAgent: 'claude-code', status: 'terminated', eligible: true, worktreeShared: false },
      ]),
    );
    const migrateResponse: ApiResult<MigrateTasksResponse> = {
      ok: true,
      status: 200,
      body: {
        targetAgent: 'codex-cli',
        defaultUpdated: false,
        results: [{ taskId: 'task-1', outcome: 'migrated', newTaskId: 'task-2' }],
      },
    };
    migrateTasks.mockResolvedValue(migrateResponse);
    render();

    click(container.querySelector('.action-btn')!);
    await flush();

    click(confirmButton(container));
    await flush();

    expect(migrateTasks).toHaveBeenCalledWith({
      targetAgent: 'codex-cli',
      scope: { kind: 'ids', taskIds: ['task-1'] },
    });
  });

  test('treats a fetch failure (non-ok body) as unknown without disabling confirm', async () => {
    getMigratableTasks.mockResolvedValue({ ok: false, status: 500, body: { error: 'boom' } });
    render();

    click(container.querySelector('.action-btn')!);
    await flush();

    expect(findEligibilityLine(container)).toBe('Could not check eligibility');
    expect(confirmButton(container).disabled).toBe(false);
  });

  test('treats a rejected fetch as unknown without disabling confirm', async () => {
    // Exercises the useEffect .catch branch specifically (distinct from a non-ok
    // envelope): a network error must not become an unhandled rejection.
    getMigratableTasks.mockRejectedValue(new Error('network down'));
    render();

    click(container.querySelector('.action-btn')!);
    await flush();

    expect(findEligibilityLine(container)).toBe('Could not check eligibility');
    expect(confirmButton(container).disabled).toBe(false);
  });

  test('treats a task absent from the candidate list as unknown, confirm enabled', async () => {
    // The server filters not_found ids out of candidates, so a missing task
    // yields no match — a non-definitive state that must not block confirm.
    getMigratableTasks.mockResolvedValue(migratableOk([]));
    render();

    click(container.querySelector('.action-btn')!);
    await flush();

    expect(findEligibilityLine(container)).toBe('Could not check eligibility');
    expect(confirmButton(container).disabled).toBe(false);
  });

  test('suppresses the Enter-to-confirm shortcut while the task is ineligible', async () => {
    // The disabled button already blocks pointer clicks; this guards the keyboard
    // path (ConfirmDialog's global Enter handler + confirm()'s blocked short-circuit).
    getMigratableTasks.mockResolvedValue(
      migratableOk([
        { taskId: 'task-1', eligible: false, reason: 'live_session_exists', worktreeShared: null },
      ]),
    );
    render();

    click(container.querySelector('.action-btn')!);
    await flush();
    expect(confirmButton(container).disabled).toBe(true);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();
    expect(migrateTasks).not.toHaveBeenCalled();
  });
});
