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

const gatedWithDefault: Playbook = {
  id: 'gated.md',
  name: 'Gated',
  description: 'Has a kb-gated parameter with a default',
  parameters: [
    {
      name: 'useKnowledgeBase',
      description: 'Ground in kb when available',
      required: false,
      default: 'auto',
      type: 'select',
      gatedBy: 'kb',
      options: [
        { label: 'Auto', value: 'auto' },
        { label: 'Off', value: 'off' },
      ],
    },
  ],
  checklist: [],
  tags: [],
  body: 'Do the thing.',
  sourceCwd: '/repo',
  scope: 'project',
};

const gatedNoDefault: Playbook = {
  id: 'gated-bare.md',
  name: 'GatedBare',
  description: 'Kb-gated parameter with no default',
  parameters: [
    {
      name: 'kbHint',
      description: 'Free-text hint for kb',
      required: false,
      gatedBy: 'kb',
    },
  ],
  checklist: [],
  tags: [],
  body: 'Do the thing.',
  sourceCwd: '/repo',
  scope: 'project',
};

function mountWith(playbook: Playbook, capabilities: Record<string, 'available' | 'absent'>) {
  document.body.innerHTML = '';
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  syncGlobalStore();
  useKookrStore.setState({
    playbooks: [playbook],
    playbooksLoading: false,
    availableAgentTypes: [],
    defaultAgentType: 'claude-code',
    hostCapabilities: capabilities,
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(PlaybookBrowser, {
        cwd: '/repo',
        send: (_msg: ClientMessage) => true,
        onClose: () => {},
      }),
    );
  });
  return { container, root };
}

describe('PlaybookBrowser capability-gated parameters', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    if (root) act(() => root.unmount());
    document.body.innerHTML = '';
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  test('hides the control and shows the annotation when the gated dependency is absent', async () => {
    ({ container, root } = mountWith(gatedWithDefault, { kb: 'absent' }));
    await flush();

    container.querySelector<HTMLElement>('.playbook-card')!.click();
    await flush();

    // No interactive control for the gated parameter — the wrapper is a <div>
    // (not <label>) and contains no <select>/<input>/<textarea>.
    const paramRow = container.querySelector('.playbook-param-row');
    expect(paramRow).toBeTruthy();
    expect(paramRow!.querySelector('select')).toBeNull();
    expect(paramRow!.querySelector('input')).toBeNull();
    expect(paramRow!.querySelector('textarea')).toBeNull();

    // Annotation is rendered as a polite live region OUTSIDE the <label>
    // (the label wraps no control), so its text does not pollute the
    // (absent) control's accessible name.
    const note = paramRow!.querySelector('.playbook-param-gated-note') as HTMLElement;
    expect(note).toBeTruthy();
    expect(note.getAttribute('role')).toBe('status');
    expect(note.getAttribute('aria-live')).toBe('polite');
    expect(note.textContent).toMatch(/kb.*not detected/i);
  });

  test('renders the control normally when the gated dependency is available', async () => {
    ({ container, root } = mountWith(gatedWithDefault, { kb: 'available' }));
    await flush();

    container.querySelector<HTMLElement>('.playbook-card')!.click();
    await flush();

    expect(container.querySelector('.playbook-param-gated-note')).toBeNull();
    expect(container.querySelector('.playbook-param-row select')).toBeTruthy();
  });

  test('renders the control + annotation when the dependency is absent but there is no default to pin to', async () => {
    ({ container, root } = mountWith(gatedNoDefault, { kb: 'absent' }));
    await flush();

    container.querySelector<HTMLElement>('.playbook-card')!.click();
    await flush();

    const paramRow = container.querySelector('.playbook-param-row');
    expect(paramRow).toBeTruthy();
    // Without a default we cannot safely pin a value — the control stays
    // interactive and the user is informed via the annotation.
    const input = paramRow!.querySelector('input') as HTMLInputElement;
    expect(input).toBeTruthy();
    // Control references the annotation as its description, NOT its name.
    const noteId = input.getAttribute('aria-describedby');
    expect(noteId).toBeTruthy();
    const note = paramRow!.querySelector(`#${noteId}`);
    expect(note).toBeTruthy();
    expect(note!.classList.contains('playbook-param-gated-note')).toBe(true);
  });
});
