// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  PLAYBOOKS_AUTHORING_REFERENCE_URL,
  PLAYBOOKS_USER_GUIDE_URL,
  PlaybookBrowser,
} from './PlaybookBrowser.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { Playbook } from '../../shared/protocol.js';

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

describe('PlaybookBrowser empty-state docs links', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    useKookrStore.setState({
      playbooks: [],
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

  test('zero playbooks shows the path hint and both authoring docs links', async () => {
    render();
    await flush();

    const empty = container.querySelector('.playbook-empty');
    expect(empty).toBeTruthy();
    expect(empty!.textContent).toContain('No playbooks found.');
    expect(empty!.textContent).toContain('.kookr/playbooks/*.md');

    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>('a.playbook-empty-docs-link'));
    expect(links).toHaveLength(2);
    expect(PLAYBOOKS_USER_GUIDE_URL).toBe(
      'https://github.com/kookr-ai/kookr/blob/main/docs/user-guide.md#playbooks',
    );
    expect(PLAYBOOKS_AUTHORING_REFERENCE_URL).toBe(
      'https://github.com/kookr-ai/kookr/blob/main/docs/reference/playbooks.md',
    );

    const guide = links.find((link) => link.textContent === 'Playbooks in the user guide');
    expect(guide).toBeDefined();
    expect(guide!.href).toBe(PLAYBOOKS_USER_GUIDE_URL);
    expect(guide!.target).toBe('_blank');
    expect(guide!.rel).toBe('noopener noreferrer');

    const reference = links.find((link) => link.textContent === 'Authoring reference');
    expect(reference).toBeDefined();
    expect(reference!.href).toBe(PLAYBOOKS_AUTHORING_REFERENCE_URL);
    expect(reference!.target).toBe('_blank');
    expect(reference!.rel).toBe('noopener noreferrer');
  });

  test('does not show the docs links when playbooks exist', async () => {
    useKookrStore.setState({ playbooks: [samplePlaybook] });
    render();
    await flush();

    expect(container.querySelector('.playbook-card')).toBeTruthy();
    expect(container.querySelector('.playbook-empty-docs')).toBeNull();
    expect(container.querySelector('a.playbook-empty-docs-link')).toBeNull();
    expect(container.textContent).not.toContain('Playbooks in the user guide');
    expect(container.textContent).not.toContain('Authoring reference');
  });

  test('search-no-match empty state does not show the docs links', async () => {
    useKookrStore.setState({ playbooks: [samplePlaybook] });
    render();
    await flush();

    const search = container.querySelector<HTMLInputElement>('.playbook-search-input');
    expect(search).toBeTruthy();
    await act(async () => {
      setInputValue(search!, 'zzzz-no-match');
    });
    await flush();

    expect(container.querySelector('.playbook-empty')?.textContent).toContain('No playbooks match');
    expect(container.querySelector('.playbook-empty-docs')).toBeNull();
    expect(container.querySelector('a.playbook-empty-docs-link')).toBeNull();
  });
});
