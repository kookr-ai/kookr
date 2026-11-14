// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { PlaybookBrowser } from './PlaybookBrowser.js';
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

function playbook(overrides: Partial<Playbook> & Pick<Playbook, 'id' | 'name'>): Playbook {
  return {
    description: '',
    parameters: [],
    checklist: [],
    tags: [],
    body: 'Do it.',
    sourceCwd: '/repo',
    scope: 'project',
    ...overrides,
  };
}

// Alphabetical order is Deploy, Janitor, Retrofit — so a test that expects
// Retrofit first is checking the search ranking, not the default sort.
const deploy = playbook({
  id: 'deploy.md',
  name: 'Deploy Convergence',
  description: 'Roll the build out.',
  body: 'After the rollout, add one lesson to the notebook.',
});
const janitor = playbook({
  id: 'janitor.md',
  name: 'Janitor Sweep',
  description: 'Report store hygiene.',
  tags: ['maintenance'],
  body: 'List duplicates.',
});
const retrofit = playbook({
  id: 'notebook-lesson-retrofit.md',
  name: 'Notebook Lesson Retrofit Review',
  description: 'Find the lessons a hook could make unnecessary.',
  tags: ['memory'],
  body: 'Take a snapshot of every shelf.',
});

describe('PlaybookBrowser search', () => {
  let container: HTMLDivElement;
  let root: Root;

  function cardNames(): string[] {
    return Array.from(container.querySelectorAll('.playbook-card .playbook-card-name'))
      .map((el) => el.textContent ?? '');
  }

  async function search(query: string): Promise<void> {
    const input = container.querySelector<HTMLInputElement>('.playbook-search-input')!;
    await act(async () => { setInputValue(input, query); });
    await flush();
  }

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    useKookrStore.setState({
      playbooks: [retrofit, janitor, deploy],
      playbooksLoading: false,
      availableAgentTypes: [],
      defaultAgentType: 'claude-code',
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.stubGlobal('fetch', vi.fn());
    root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(PlaybookBrowser, { cwd: '/repo', send: () => true, onClose: () => {} }),
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  test('with no query, playbooks keep their alphabetical order', async () => {
    await flush();
    expect(cardNames()).toEqual(['Deploy Convergence', 'Janitor Sweep', 'Notebook Lesson Retrofit Review']);
  });

  test('finds a playbook by a word that is only in its instructions', async () => {
    await search('shelf');
    expect(cardNames()).toEqual(['Notebook Lesson Retrofit Review']);
  });

  test('finds a playbook by a tag', async () => {
    await search('maintenance');
    expect(cardNames()).toEqual(['Janitor Sweep']);
  });

  test('matches several words in any order across fields', async () => {
    await search('shelf notebook');
    expect(cardNames()).toEqual(['Notebook Lesson Retrofit Review']);
  });

  test('ranks a name match above a playbook that only mentions the word in its instructions', async () => {
    await search('notebook');
    expect(cardNames()).toEqual(['Notebook Lesson Retrofit Review', 'Deploy Convergence']);
  });

  test('a pinned playbook with only an instructions match stays below a name match', async () => {
    await flush();
    // Clicks the pin button on the Deploy card: pins it, or unpins it if pinned.
    const toggleDeployPin = () => act(async () => {
      Array.from(container.querySelectorAll('.playbook-card'))
        .find((card) => card.textContent?.includes('Deploy Convergence'))!
        .querySelector<HTMLButtonElement>('.playbook-pin-btn')!
        .click();
    });
    await toggleDeployPin();
    try {
      // Pinned puts Deploy first when nothing is searched...
      expect(cardNames()[0]).toBe('Deploy Convergence');
      // ...but the name match still leads once a query is typed.
      await search('notebook');
      expect(cardNames()).toEqual(['Notebook Lesson Retrofit Review', 'Deploy Convergence']);
    } finally {
      // The usage tracker is module state shared by every test in this file.
      await search('');
      await toggleDeployPin();
    }
  });

  test('says so when nothing matches', async () => {
    await search('kubernetes');
    expect(cardNames()).toEqual([]);
    expect(container.querySelector('.playbook-empty')?.textContent).toContain('kubernetes');
  });
});
