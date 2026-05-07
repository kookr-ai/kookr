// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { PlaybookBrowser } from './PlaybookBrowser.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { ClientMessage, Playbook } from '../../shared/protocol.js';

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

const SUPPRESS_KEY = 'kookr:suppressOtherAuthorWarning';

const implementIssuePlaybook: Playbook = {
  id: 'implement-github-issue.md',
  name: 'Implement GitHub Issue',
  description: 'Pick an issue and ship it',
  parameters: [
    { name: 'allowOtherAuthors', description: 'allow other authors', required: true, default: 'false', type: 'select', options: [
      { label: 'Only mine', value: 'false' },
      { label: 'Any author', value: 'true' },
    ] },
  ],
  checklist: [],
  tags: ['workflow'],
  body: 'Body.',
  sourceCwd: '/repo',
};

const otherPlaybook: Playbook = {
  id: 'other.md',
  name: 'Other',
  description: 'Some other thing',
  parameters: [
    { name: 'allowOtherAuthors', description: 'unrelated knob', required: false, default: 'true' },
  ],
  checklist: [],
  tags: [],
  body: 'Body.',
  sourceCwd: '/repo',
};

describe('PlaybookBrowser other-author warning', () => {
  let container: HTMLDivElement;
  let root: Root;
  let sent: ClientMessage[];
  let closeCount: number;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    useKookrStore.setState({
      playbooks: [implementIssuePlaybook, otherPlaybook],
      playbooksLoading: false,
      availableAgentTypes: [],
      defaultAgentType: 'claude-code',
    });
    sent = [];
    closeCount = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
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
  });

  async function openImplementIssueDetail() {
    await flush();
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLElement>('.playbook-card'))
        .find((c) => c.textContent?.includes('Implement GitHub Issue'))!
        .click();
    });
    await flush();
  }

  function setSelect(name: string, value: string) {
    const select = Array.from(container.querySelectorAll<HTMLSelectElement>('.playbook-params select'))
      .find((s) => s.previousSibling?.textContent === name || s.parentElement?.textContent?.includes(name))!;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function submitForm() {
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }

  test('does not show warning when allowOtherAuthors is false', async () => {
    await openImplementIssueDetail();
    // Default is "false" — go straight to submit.
    await act(async () => { submitForm(); });
    await flush();

    expect(container.querySelector('.confirm-dialog')).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'launchPlaybook', playbookPath: 'implement-github-issue.md' });
    expect(closeCount).toBe(1);
  });

  test('shows warning and blocks launch when allowOtherAuthors=true', async () => {
    await openImplementIssueDetail();
    await act(async () => { setSelect('allowOtherAuthors', 'true'); });
    await act(async () => { submitForm(); });
    await flush();

    expect(container.querySelector('.confirm-dialog')).toBeTruthy();
    expect(container.textContent).toContain('Implementing issues from other authors');
    expect(sent).toHaveLength(0);
    expect(closeCount).toBe(0);
    expect(localStorage.getItem(SUPPRESS_KEY)).toBeNull();
  });

  test('confirming without checkbox launches and does not persist suppression', async () => {
    await openImplementIssueDetail();
    await act(async () => { setSelect('allowOtherAuthors', 'true'); });
    await act(async () => { submitForm(); });
    await flush();

    const confirmBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('.confirm-dialog-actions button'))
      .find((b) => b.textContent === 'Continue anyway')!;
    await act(async () => { confirmBtn.click(); });
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'launchPlaybook' });
    expect(localStorage.getItem(SUPPRESS_KEY)).toBeNull();
    expect(closeCount).toBe(1);
  });

  test('confirming with "do not show again" persists suppression and launches', async () => {
    await openImplementIssueDetail();
    await act(async () => { setSelect('allowOtherAuthors', 'true'); });
    await act(async () => { submitForm(); });
    await flush();

    const checkbox = container.querySelector<HTMLInputElement>('.confirm-dialog-checkbox input[type="checkbox"]')!;
    await act(async () => { checkbox.click(); });

    const confirmBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('.confirm-dialog-actions button'))
      .find((b) => b.textContent === 'Continue anyway')!;
    await act(async () => { confirmBtn.click(); });
    await flush();

    expect(localStorage.getItem(SUPPRESS_KEY)).toBe('1');
    expect(sent).toHaveLength(1);
  });

  test('cancel keeps user on the form and does not launch', async () => {
    await openImplementIssueDetail();
    await act(async () => { setSelect('allowOtherAuthors', 'true'); });
    await act(async () => { submitForm(); });
    await flush();

    const cancelBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('.confirm-dialog-actions button'))
      .find((b) => b.textContent === 'Cancel')!;
    await act(async () => { cancelBtn.click(); });
    await flush();

    expect(container.querySelector('.confirm-dialog')).toBeNull();
    expect(sent).toHaveLength(0);
    expect(closeCount).toBe(0);
    // The detail form is still on screen.
    expect(container.querySelector('.playbook-detail-name')?.textContent).toContain('Implement GitHub Issue');
  });

  test('skips warning when localStorage suppression is already set', async () => {
    localStorage.setItem(SUPPRESS_KEY, '1');
    await openImplementIssueDetail();
    await act(async () => { setSelect('allowOtherAuthors', 'true'); });
    await act(async () => { submitForm(); });
    await flush();

    expect(container.querySelector('.confirm-dialog')).toBeNull();
    expect(sent).toHaveLength(1);
  });

  test('warning is scoped to implement-github-issue, not other playbooks', async () => {
    await flush();
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLElement>('.playbook-card'))
        .find((c) => c.textContent?.includes('Other'))!
        .click();
    });
    await flush();

    // The "other" playbook also has a param literally named allowOtherAuthors,
    // but the warning is keyed off the playbook id, not the param name.
    await act(async () => { submitForm(); });
    await flush();

    expect(container.querySelector('.confirm-dialog')).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ playbookPath: 'other.md' });
  });
});
