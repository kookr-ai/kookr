// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LaunchTaskDialog } from './LaunchTaskDialog.js';
import { GETTING_STARTED_GUIDE_URL } from './CliInstallGuidanceBanner.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { AvailableAgentType, ClientMessage } from '../../shared/protocol.js';

const CWD = '/home/user/proj';

function seedStore(overrides: Record<string, unknown> = {}): void {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  const availableAgentTypes: AvailableAgentType[] = [
    { type: 'claude-code', label: 'Claude Code' },
  ];
  useKookrStore.setState({ ...nextData, availableAgentTypes, serverCwd: CWD, ...overrides });
}

describe('LaunchTaskDialog no-CLI-detected install banner (#3142)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in test')));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
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

  test('shows the install-guidance banner and keeps the picker + Launch when no CLI is advertised', () => {
    seedStore({ availableAgentTypes: [] });
    render({ defaultPrompt: 'do the thing', defaultCwd: CWD });

    const banner = container.querySelector('[data-testid="cli-install-guidance-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('No coding-agent CLI detected');
    expect(banner?.textContent).toContain('Claude Code');
    expect(banner?.textContent).toContain('Codex');
    expect(banner?.textContent).toContain('Grok Build');
    const link = banner?.querySelector('a');
    expect(link?.getAttribute('href')).toBe(GETTING_STARTED_GUIDE_URL);

    // Non-blocking: picker present and the Launch button enabled (prompt + cwd set).
    expect(container.querySelector('.agent-type-select select')).not.toBeNull();
    const launch = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('type') === 'submit',
    ) as HTMLButtonElement | undefined;
    expect(launch).toBeDefined();
    expect(launch?.disabled).toBe(false);
    // Wired into the submit button's aria-describedby for screen-reader users.
    expect(launch?.getAttribute('aria-describedby')?.split(' ')).toContain(
      'cli-install-guidance-banner',
    );
  });

  test('shows the banner on the Playbooks tab too (a playbook launch also needs a CLI)', () => {
    seedStore({ availableAgentTypes: [] });
    render({ initialTab: 'playbooks' });

    expect(container.querySelector('[data-testid="cli-install-guidance-banner"]')).not.toBeNull();
    // Confirm we are actually on the Playbooks surface, not the manual form.
    expect(container.querySelector('.launch-prompt-field')).toBeNull();
  });

  test('reacts to availableAgentTypes arriving after mount (WS snapshot path)', () => {
    seedStore(); // one CLI advertised → banner absent
    render({ defaultPrompt: 'do the thing', defaultCwd: CWD });
    expect(container.querySelector('[data-testid="cli-install-guidance-banner"]')).toBeNull();

    act(() => {
      useKookrStore.setState({ availableAgentTypes: [] });
    });

    expect(container.querySelector('[data-testid="cli-install-guidance-banner"]')).not.toBeNull();
  });

  test('hides the banner when at least one CLI is advertised', () => {
    seedStore();
    render({ defaultPrompt: 'do the thing', defaultCwd: CWD });

    expect(container.querySelector('[data-testid="cli-install-guidance-banner"]')).toBeNull();
    // Launch stays enabled in the normal case too.
    const launch = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('type') === 'submit',
    ) as HTMLButtonElement | undefined;
    expect(launch?.disabled).toBe(false);
  });
});
