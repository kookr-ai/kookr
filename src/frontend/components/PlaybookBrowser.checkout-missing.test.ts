// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { PlaybookBrowser } from './PlaybookBrowser.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { CheckoutMissingPlaybooks, Playbook } from '../../shared/protocol.js';

// Issue #3764: the Playbooks tab names project playbooks that are on the
// remote default branch but missing from the checkout it lists.

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

const samplePlaybook: Playbook = {
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

const fourMissing: CheckoutMissingPlaybooks = {
  defaultBranchRef: 'origin/main',
  checkoutBranch: 'feat-old',
  missing: [
    'agent-notebook-reflection.md',
    'nb-janitor.md',
    'notebook-lesson-retrofit.md',
    'opencode-scoped-fix-pipeline.md',
  ],
};

describe('PlaybookBrowser checkout-missing notice (#3764)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    useKookrStore.setState({
      playbooks: [samplePlaybook],
      playbooksLoading: false,
      availableAgentTypes: [],
      defaultAgentType: 'claude-code',
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    localStorage.clear();
  });

  function render() {
    act(() => {
      root.render(
        React.createElement(PlaybookBrowser, {
          cwd: '/work/myrepo',
          send: () => true,
          onClose: () => {},
        }),
      );
    });
  }

  function notice(): Element | null {
    return container.querySelector('.playbook-checkout-missing');
  }

  test('a store with no missing playbooks renders no notice', async () => {
    render();
    await flush();
    expect(container.querySelector('.playbook-card')).toBeTruthy();
    expect(notice()).toBeNull();
  });

  test('names every missing playbook, the default branch, and the checkout branch', async () => {
    useKookrStore.setState({ playbooksCheckoutMissing: fourMissing });
    render();
    await flush();

    const el = notice();
    expect(el).toBeTruthy();
    expect(el!.getAttribute('role')).toBe('status');
    expect(el!.textContent).toContain('4 playbooks on origin/main are not in this checkout, which is on feat-old');
    const names = Array.from(el!.querySelectorAll('.playbook-checkout-missing-names li')).map((li) => li.textContent);
    expect(names).toEqual(fourMissing.missing);
    expect(el!.textContent).toContain('Update this checkout to list them.');
  });

  test('stays visible when a search matches nothing, the case the issue started from', async () => {
    useKookrStore.setState({ playbooksCheckoutMissing: fourMissing });
    render();
    await flush();

    const search = container.querySelector<HTMLInputElement>('.playbook-search-input');
    await act(async () => {
      setInputValue(search!, 'shelf');
    });
    await flush();

    expect(container.querySelector('.playbook-empty')?.textContent).toContain('No playbooks match');
    expect(notice()?.textContent).toContain('notebook-lesson-retrofit.md');
  });

  test('shows in the zero-playbook empty state too', async () => {
    useKookrStore.setState({ playbooks: [], playbooksCheckoutMissing: fourMissing });
    render();
    await flush();

    expect(container.querySelector('.playbook-empty')?.textContent).toContain('No playbooks found.');
    expect(notice()?.textContent).toContain('nb-janitor.md');
  });

  test('uses the singular, omits a detached branch, and caps the list at five names', async () => {
    useKookrStore.setState({
      playbooksCheckoutMissing: { defaultBranchRef: 'origin/master', missing: ['only.md'] },
    });
    render();
    await flush();
    expect(notice()!.textContent).toContain('1 playbook on origin/master is not in this checkout:');
    expect(notice()!.textContent).not.toContain('which is on');

    act(() => {
      useKookrStore.setState({
        playbooksCheckoutMissing: {
          defaultBranchRef: 'origin/main',
          missing: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'g.md'],
        },
      });
    });
    await flush();
    const items = Array.from(notice()!.querySelectorAll('.playbook-checkout-missing-names li')).map((li) => li.textContent);
    expect(items).toEqual(['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'and 2 more']);
  });

  test('a later playbooks message without the field clears the notice', async () => {
    useKookrStore.setState({ playbooksCheckoutMissing: fourMissing });
    render();
    await flush();
    expect(notice()).toBeTruthy();

    act(() => {
      useKookrStore.getState().handlePlaybooks([samplePlaybook], '/work/other');
    });
    await flush();
    expect(useKookrStore.getState().playbooksCheckoutMissing).toBeNull();
    expect(notice()).toBeNull();
  });
});
