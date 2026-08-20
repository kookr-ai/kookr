// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentState } from '../../shared/protocol.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { DetailPanel } from './DetailPanel.js';

vi.mock('../telemetry.js', () => ({ track: vi.fn(), trackClick: vi.fn() }));
vi.mock('./ActivityPanel.js', () => ({ ActivityPanel: () => React.createElement('div', { 'data-testid': 'activity-panel' }) }));
vi.mock('./GitHubPanel.js', () => ({ GitHubPanel: () => React.createElement('div', { 'data-testid': 'github-panel' }) }));
vi.mock('./TerminalPanel.js', () => ({ TerminalPanel: () => React.createElement('div', { 'data-testid': 'terminal-panel' }) }));
vi.mock('./DiffPane.js', () => ({ DiffPane: () => React.createElement('div', { 'data-testid': 'diff-pane' }) }));
vi.mock('./SnoozeDialog.js', () => ({ SnoozeDialog: () => null }));
vi.mock('./EffectiveHookSettingsModal.js', () => ({ EffectiveHookSettingsModal: () => null }));

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function renderDetailPanel(container: HTMLElement, agent: AgentState): Root {
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(DetailPanel, {
        agent,
        send: vi.fn(() => true),
        onLaunch: vi.fn(),
        onRequestComplete: vi.fn(),
      }),
    );
  });
  return root;
}

describe('DetailPanel completion PR links', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  function completedAgent(prUrls: string[] | undefined): AgentState {
    return {
      agentId: 'kookr-done',
      taskId: 'task-1',
      taskName: 'PR task',
      events: [],
      anomaly: null,
      taskStatus: 'completed',
      cwd: '/repo',
      startedAt: '2026-06-11T12:00:00.000Z',
      completionDigest: {
        bullets: ['Changed 1 file'],
        filesChanged: ['src/app.ts'],
        ...(prUrls === undefined ? {} : { prUrls }),
      },
    };
  }

  // Locate PR anchors by their semantic role (link) scoped to the block's
  // deliberate test seam, not by the styling-only class — so restyling the
  // link never breaks these behavioral assertions.
  function prBlock(): HTMLElement | null {
    return container.querySelector<HTMLElement>('[data-testid="detail-digest-prs"]');
  }
  function prLinks(): HTMLAnchorElement[] {
    return Array.from(prBlock()?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? []);
  }

  test('renders a labelled anchor per PR URL, opening in a new tab', () => {
    root = renderDetailPanel(container, completedAgent([
      'https://github.com/kookr-ai/kookr/pull/2731',
      'https://github.com/kookr-ai/kookr/pull/2698',
    ]));

    const block = prBlock();
    expect(block).not.toBeNull();
    expect(block?.textContent).toContain('Pull requests:');

    const links = prLinks();
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).toBe('https://github.com/kookr-ai/kookr/pull/2731');
    expect(links[0].textContent).toContain('PR #2731');
    expect(links[0].getAttribute('target')).toBe('_blank');
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
    expect(links[1].textContent).toContain('PR #2698');

    // Sibling digest content is untouched by the added PR block.
    expect(container.textContent).toContain('Changed 1 file');
    expect(container.textContent).toContain('Files changed:');
    expect(container.textContent).toContain('src/app.ts');
  });

  test('renders a single parseable URL with the singular heading and #number label', () => {
    root = renderDetailPanel(container, completedAgent(['https://github.com/kookr-ai/kookr/pull/2731']));

    const block = prBlock();
    expect(block?.textContent).toContain('Pull request:');
    expect(block?.textContent).not.toContain('Pull requests:');
    const links = prLinks();
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toContain('PR #2731');
  });

  test('parses the /pulls/ path variant and labels each URL of a mixed list independently', () => {
    root = renderDetailPanel(container, completedAgent([
      'https://api.github.com/repos/kookr-ai/kookr/pulls/42',
      'https://example.com/merge-request',
    ]));

    const links = prLinks();
    expect(links).toHaveLength(2);
    expect(links[0].textContent).toContain('PR #42');
    expect(links[1].textContent).toContain('View PR');
  });

  test('falls back to "View PR" when no number is parseable', () => {
    root = renderDetailPanel(container, completedAgent(['https://example.com/merge-request']));

    const links = prLinks();
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toContain('View PR');
  });

  test('renders nothing when prUrls is absent, leaving other digest content intact', () => {
    root = renderDetailPanel(container, completedAgent(undefined));
    expect(prBlock()).toBeNull();
    expect(container.textContent).toContain('Changed 1 file');
    expect(container.textContent).toContain('Files changed:');
  });

  test('renders nothing when prUrls is an empty array', () => {
    root = renderDetailPanel(container, completedAgent([]));
    expect(prBlock()).toBeNull();
  });
});
