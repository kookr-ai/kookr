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

  function pinButton(name: string): HTMLButtonElement {
    return Array.from(container.querySelectorAll('.playbook-card'))
      .find((card) => card.querySelector('.playbook-card-name')?.textContent === name)!
      .querySelector<HTMLButtonElement>('.playbook-pin-btn')!;
  }

  /**
   * Pin one playbook for the duration of `run`, then unpin it. The browser
   * keeps pins in module state that every test in this file shares, so a pin
   * left behind would leak into the tests that follow.
   */
  async function withPinned(name: string, run: () => Promise<void>): Promise<void> {
    await act(async () => { pinButton(name).click(); });
    try {
      // Proves the click pinned it; card order alone cannot, when the
      // playbook was already first.
      expect(pinButton(name).classList.contains('pinned')).toBe(true);
      await run();
    } finally {
      if (pinButton(name).classList.contains('pinned')) {
        await act(async () => { pinButton(name).click(); });
      }
    }
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
    await withPinned('Deploy Convergence', async () => {
      await search('notebook');
      expect(cardNames()).toEqual(['Notebook Lesson Retrofit Review', 'Deploy Convergence']);
    });
  });

  test('pinned playbooks still come first among equally good matches', async () => {
    // "the" is in the description of Deploy and Retrofit, and nowhere in Janitor.
    await search('the');
    expect(cardNames()).toEqual(['Deploy Convergence', 'Notebook Lesson Retrofit Review']);
    await withPinned('Notebook Lesson Retrofit Review', async () => {
      expect(cardNames()).toEqual(['Notebook Lesson Retrofit Review', 'Deploy Convergence']);
    });
  });

  test('searches only the loopable playbooks while that filter is on', async () => {
    const loopable = playbook({
      id: 'notebook-loop.md',
      name: 'Notebook Loop',
      tags: ['workflow', 'loopable'],
      effectiveLoop: {
        iterationCap: 10,
        costCapUsd: 25,
        sources: { iterationCap: 'default', costCapUsd: 'default' },
      },
    });
    await act(async () => {
      useKookrStore.setState({ playbooks: [retrofit, janitor, deploy, loopable] });
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.playbook-filter')!.click();
    });
    // Without the filter, "notebook" also finds Retrofit and Deploy.
    await search('notebook');
    expect(cardNames()).toEqual(['Notebook Loop']);
  });

  test('says so when nothing matches', async () => {
    await search('kubernetes');
    expect(cardNames()).toEqual([]);
    expect(container.querySelector('.playbook-empty')?.textContent).toContain('kubernetes');
  });
});
