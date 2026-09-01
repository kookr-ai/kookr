// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { PlaybookBrowser } from './PlaybookBrowser.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { Playbook, PlaybookSourceIdentity } from '../../shared/protocol.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

async function flush() {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

// The user-tier resource the source task actually executed.
const userTriage: Playbook = {
  id: 'triage.md',
  name: 'User Triage',
  description: 'From ~/.kookr/playbooks',
  parameters: [],
  checklist: [],
  tags: [],
  body: 'User triage body.',
  scope: 'user',
  sourceCwd: '/home/dev/.kookr/playbooks',
  sourceDigest: 'sha-user',
};

// A same-id project-tier resource that would WIN id precedence in the catalog.
const projectTriage: Playbook = {
  ...userTriage,
  name: 'Project Triage',
  description: 'Shadowing project playbook',
  body: 'Different project instructions.',
  scope: 'project',
  sourceCwd: '/work/repo',
  sourceDigest: 'sha-project',
};

const userSource: PlaybookSourceIdentity = {
  id: 'triage.md',
  scope: 'user',
  sourceCwd: '/home/dev/.kookr/playbooks',
  sourceDigest: 'sha-user',
};

describe('PlaybookBrowser relaunch source identity', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    useKookrStore.setState({
      playbooksLoading: false,
      availableAgentTypes: [],
      defaultAgentType: 'claude-code',
    });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    localStorage.clear();
  });

  function render(props: Record<string, unknown>) {
    root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(PlaybookBrowser, {
          cwd: '/work/repo',
          send: () => true,
          onClose: () => {},
          ...props,
        }),
      );
    });
  }

  test('auto-selects the exact recorded resource when it is present in the catalog', async () => {
    useKookrStore.setState({ playbooks: [userTriage] });
    render({
      relaunchPlaybookId: 'triage.md',
      relaunchPlaybookSource: userSource,
    });
    await flush();

    // Detail view opened on the matched resource; no stale note.
    const header = container.querySelector('.playbook-detail-header');
    expect(header).toBeTruthy();
    expect(header!.textContent).toContain('User Triage');
    expect(container.querySelector('.playbook-relaunch-note')).toBeNull();
    expect(container.querySelector('.playbook-search')).toBeNull();
  });

  test('does NOT substitute a same-id playbook from another tier — shows an unavailable note', async () => {
    // Only the shadowing project-tier resource exists now; the user-tier
    // resource the task ran is gone.
    useKookrStore.setState({ playbooks: [projectTriage] });
    render({
      relaunchPlaybookId: 'triage.md',
      relaunchPlaybookSource: userSource,
    });
    await flush();

    // Stays on the list (no auto-open), with an explicit unavailable note.
    expect(container.querySelector('.playbook-detail-header')).toBeNull();
    expect(container.querySelector('.playbook-search')).toBeTruthy();
    const note = container.querySelector('.playbook-relaunch-note');
    expect(note).toBeTruthy();
    expect(note!.textContent).toContain('no longer available');
  });

  test('still reselects the same resource after an in-place edit (new digest)', async () => {
    // Relaunch targets the resource path, not a pinned byte version — editing
    // the playbook and relaunching must reopen it, not force a reselect.
    useKookrStore.setState({ playbooks: [{ ...userTriage, sourceDigest: 'sha-user-edited' }] });
    render({
      relaunchPlaybookId: 'triage.md',
      relaunchPlaybookSource: userSource,
    });
    await flush();

    const header = container.querySelector('.playbook-detail-header');
    expect(header).toBeTruthy();
    expect(header!.textContent).toContain('User Triage');
    expect(container.querySelector('.playbook-relaunch-note')).toBeNull();
  });

  test('re-resolves against a later catalog instead of locking on a stale snapshot', async () => {
    // Mount while the store still holds a DIFFERENT cwd's catalog (the dialog's
    // own scoped fetch is still in flight). The target resource is absent, so
    // the first pass finds no match — but it must not lock: when the correct
    // catalog arrives, the exact resource is selected and the note clears.
    useKookrStore.setState({ playbooks: [projectTriage] }); // stale, wrong tier
    render({
      relaunchPlaybookId: 'triage.md',
      relaunchPlaybookSource: userSource,
    });
    await flush();
    // Transiently unavailable against the stale snapshot, no auto-open.
    expect(container.querySelector('.playbook-detail-header')).toBeNull();
    expect(container.querySelector('.playbook-relaunch-note')).toBeTruthy();

    // The dialog's fetch resolves with the correct catalog.
    act(() => {
      useKookrStore.setState({ playbooks: [userTriage] });
    });
    await flush();

    const header = container.querySelector('.playbook-detail-header');
    expect(header).toBeTruthy();
    expect(header!.textContent).toContain('User Triage');
    expect(container.querySelector('.playbook-relaunch-note')).toBeNull();
  });

  test('legacy task without a recorded source still preselects by id (back-compat)', async () => {
    useKookrStore.setState({ playbooks: [projectTriage] });
    render({
      relaunchPlaybookId: 'triage.md',
      // no relaunchPlaybookSource — legacy record
    });
    await flush();

    const header = container.querySelector('.playbook-detail-header');
    expect(header).toBeTruthy();
    expect(header!.textContent).toContain('Project Triage');
    expect(container.querySelector('.playbook-relaunch-note')).toBeNull();
  });

  test('legacy task whose id is absent from the catalog shows a missing-identity note', async () => {
    useKookrStore.setState({ playbooks: [{ ...userTriage, id: 'other.md', name: 'Other' }] });
    render({
      relaunchPlaybookId: 'triage.md',
      // no relaunchPlaybookSource — legacy record
    });
    await flush();

    expect(container.querySelector('.playbook-detail-header')).toBeNull();
    const note = container.querySelector('.playbook-relaunch-note');
    expect(note).toBeTruthy();
    expect(note!.textContent).toContain('predates playbook source tracking');
  });
});
