// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  OSS_HOOKS_SETUP_URL,
  OssProductivityView,
} from './OssProductivityView.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { ContributionAttempt, StateObservation } from '../../shared/contracts/oss-attempts.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function mkObs(state: ContributionAttempt['state'], at: string): StateObservation {
  return { state, at, source: 'refresh_poll', note: null, url: null };
}

function mkPr(
  opts: { prNumber: number; repo: string; state: ContributionAttempt['state'] },
): ContributionAttempt {
  const at = '2026-04-10T00:00:00Z';
  return {
    id: `${opts.repo}#${opts.prNumber}`,
    repo: opts.repo,
    issueNumber: null,
    issueUrl: null,
    prNumber: opts.prNumber,
    prUrl: `https://github.com/${opts.repo}/pull/${opts.prNumber}`,
    prTitle: `PR ${opts.prNumber}`,
    state: opts.state,
    history: [mkObs(opts.state, at)],
    closing: null,
    linkedIssue: undefined,
    createdAt: at,
    updatedAt: at,
  };
}

describe('OssProductivityView empty-state first-contribution CTA', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onClose: ReturnType<typeof vi.fn>;
  let onBrowsePlaybooks: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    syncGlobalStore();
    onClose = vi.fn();
    onBrowsePlaybooks = vi.fn();
    useKookrStore.setState({
      ossAttempts: [],
      ossRegistryActiveRepos: [],
      ossLastRefreshAt: null,
      ossRefreshLoading: false,
      ossRefreshError: null,
      ossTruncatedRepos: [],
      ossLastRefreshIssueCheckErrors: [],
      fetchOssAttempts: vi.fn().mockResolvedValue(undefined),
      refreshOssAttempts: vi.fn().mockResolvedValue(undefined),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
  });

  function render() {
    act(() => {
      root.render(
        React.createElement(OssProductivityView, {
          onClose,
          onBrowsePlaybooks,
        }),
      );
    });
  }

  test('empty panel keeps the Refresh hint and offers playbooks + hooks-setup CTAs', () => {
    render();

    const empty = container.querySelector('.oss-productivity-empty');
    expect(empty).toBeTruthy();
    expect(empty!.textContent).toContain('Click');
    expect(empty!.textContent).toContain('Refresh');
    expect(empty!.textContent).toContain('~/.kookr/oss-repos.json');

    const browse = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Browse playbooks');
    expect(browse).toBeDefined();

    expect(OSS_HOOKS_SETUP_URL).toBe(
      'https://github.com/kookr-ai/kookr/blob/main/docs/hooks-setup.md#oss-extension-hooks-bundled-with-the-repo',
    );
    const docs = container.querySelector<HTMLAnchorElement>('a.oss-productivity-empty-docs-link');
    expect(docs).toBeTruthy();
    expect(docs!.textContent).toBe('how OSS tracking works');
    expect(docs!.href).toBe(OSS_HOOKS_SETUP_URL);
    expect(docs!.target).toBe('_blank');
    expect(docs!.rel).toBe('noopener noreferrer');

    act(() => {
      browse!.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onBrowsePlaybooks).toHaveBeenCalledTimes(1);
  });

  test('does not show the first-contribution CTA when attempts exist', () => {
    useKookrStore.setState({
      ossAttempts: [mkPr({ repo: 'grafana/grafana', prNumber: 1, state: 'merged' })],
    });
    render();

    expect(container.querySelector('.oss-productivity-empty')).toBeNull();
    expect(container.querySelector('.oss-summary')).toBeTruthy();
    expect(container.textContent).not.toContain('Browse playbooks');
    expect(container.querySelector('a.oss-productivity-empty-docs-link')).toBeNull();
  });

  test('does not show the first-contribution CTA when a registry repo is present', () => {
    useKookrStore.setState({
      ossRegistryActiveRepos: ['grafana/grafana'],
    });
    render();

    expect(container.querySelector('.oss-productivity-empty')).toBeNull();
    expect(container.querySelector('.oss-repo-table')).toBeTruthy();
    expect(container.textContent).not.toContain('Browse playbooks');
    expect(container.querySelector('a.oss-productivity-empty-docs-link')).toBeNull();
  });
});
