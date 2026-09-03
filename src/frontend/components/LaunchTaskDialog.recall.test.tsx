// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RecentPromptEntry } from '../../shared/contracts/recent-prompts.js';

// Mock the fetch hook so the dialog gets deterministic recall entries with no
// network. The picker + fill wiring is what this test exercises.
const recentEntries: RecentPromptEntry[] = [];
// Honor `enabled` so the dialog's real `enabled: tab==='manual' && !isRelaunch`
// guard is exercised (a relaunch passes enabled=false → no entries).
vi.mock('../hooks/useRecentPrompts.js', () => ({
  useRecentPrompts: ({ enabled }: { enabled: boolean }) => (enabled ? recentEntries : []),
}));

import { LaunchTaskDialog } from './LaunchTaskDialog.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { AvailableAgentType, ClientMessage } from '../../shared/protocol.js';

const CWD = '/work/proj';

function seedStore(): void {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  const availableAgentTypes: AvailableAgentType[] = [{ type: 'claude-code', label: 'Claude Code' }];
  useKookrStore.setState({ ...nextData, availableAgentTypes, serverCwd: CWD });
}

describe('LaunchTaskDialog recall', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in test')));
    seedStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    recentEntries.length = 0;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function render(props: Partial<React.ComponentProps<typeof LaunchTaskDialog>> = {}): void {
    act(() => {
      root.render(React.createElement(LaunchTaskDialog, {
        send: (() => true) as (msg: ClientMessage) => boolean,
        onClose: vi.fn(),
        defaultAgentType: 'claude-code',
        ...props,
      }));
    });
  }

  test('no recall control when there is no history', () => {
    render();
    expect(container.querySelector('.recent-prompts')).toBeNull();
  });

  test('selecting a recalled prompt refills the Task description', () => {
    recentEntries.push({
      prompt: 'review the diff since origin/main and summarize risks',
      cwd: CWD,
      at: Date.now(),
      cwdMatch: true,
    });
    render();

    // Expand the recall panel, then click the entry.
    act(() => container.querySelector<HTMLButtonElement>('.recent-prompts-toggle')?.click());
    act(() => container.querySelector<HTMLButtonElement>('.recent-prompts-item')?.click());

    const textarea = container.querySelector<HTMLTextAreaElement>('#launch-task-description');
    expect(textarea?.value).toBe('review the diff since origin/main and summarize risks');
  });

  test('recall control is absent on the relaunch path', () => {
    recentEntries.push({ prompt: 'p', cwd: CWD, at: Date.now(), cwdMatch: true });
    // A relaunch drives the form from props (defaultPrompt set) → isRelaunch true.
    render({ defaultPrompt: 'relaunched prompt', defaultCwd: CWD });
    expect(container.querySelector('.recent-prompts')).toBeNull();
  });
});
