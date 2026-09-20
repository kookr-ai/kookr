// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RecentPromptEntry } from '../../shared/contracts/recent-prompts.js';
import { LAST_EFFORT_KEY, LAST_MODEL_KEY } from '../store/last-launch-pins.js';
import { LAST_AGENT_TYPE_KEY } from '../store/last-agent-type.js';

// Mock the fetch hook so Quick Launch gets deterministic recall entries with
// no network. The picker + fill wiring is what this test exercises; fail-closed
// to [] is the same shape the real hook returns on a failed fetch.
const recentEntries: RecentPromptEntry[] = [];
const hookCalls: Array<{ enabled: boolean; cwd: string }> = [];
vi.mock('../hooks/useRecentPrompts.js', () => ({
  useRecentPrompts: (args: { enabled: boolean; cwd: string }) => {
    hookCalls.push(args);
    return args.enabled ? recentEntries : [];
  },
}));

import { QuickLaunch } from './QuickLaunch.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { ClientMessage } from '../../shared/protocol.js';

const CWD = '/tmp/work';
const RECALLED = 'review the diff since origin/main and summarize risks';

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

describe('QuickLaunch recent-prompt recall (#3334)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let sent: ClientMessage[];
  let closed: number;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    useKookrStore.setState({
      serverCwd: CWD,
      sttUrl: '',
      defaultAgentType: 'claude-code',
      selectedAgentId: null,
      agents: [],
      availableAgentTypes: [
        { type: 'claude-code', label: 'Claude Code' },
        { type: 'codex-cli', label: 'Codex CLI' },
      ],
    });
    sent = [];
    closed = 0;
    hookCalls.length = 0;
    recentEntries.length = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    recentEntries.length = 0;
    hookCalls.length = 0;
  });

  function render(): void {
    act(() => {
      root.render(React.createElement(QuickLaunch, {
        send: (msg: ClientMessage) => {
          sent.push(msg);
          return true;
        },
        onClose: () => { closed += 1; },
      }));
    });
  }

  test('no recall control when there is no history', async () => {
    render();
    await flush();
    expect(container.querySelector('.recent-prompts')).toBeNull();
  });

  test('shows the existing picker once the working directory has resolved', async () => {
    recentEntries.push({
      prompt: RECALLED,
      cwd: CWD,
      at: Date.now(),
      cwdMatch: true,
    });
    render();
    await flush();

    const toggle = container.querySelector('.recent-prompts-toggle');
    expect(toggle).not.toBeNull();
    expect(toggle?.textContent).toContain('Recent prompts');
    expect(toggle?.textContent).toContain('(1)');
    expect(hookCalls.some((call) => !call.enabled && call.cwd === '')).toBe(true);
    expect(hookCalls.some((call) => call.enabled && call.cwd === CWD)).toBe(true);
  });

  test('selecting a row copies the prompt into the input and does not launch or close', async () => {
    recentEntries.push({
      prompt: RECALLED,
      cwd: CWD,
      at: Date.now(),
      cwdMatch: true,
    });
    render();
    await flush();

    act(() => container.querySelector<HTMLButtonElement>('.recent-prompts-toggle')?.click());
    act(() => container.querySelector<HTMLButtonElement>('.recent-prompts-item')?.click());

    const input = container.querySelector<HTMLInputElement>('input.quick-launch-input');
    expect(input?.value).toBe(RECALLED);
    expect(sent).toEqual([]);
    expect(closed).toBe(0);
  });

  test('recall does not change working directory, agent, effort, or model pins', async () => {
    localStorage.setItem(LAST_AGENT_TYPE_KEY, 'codex-cli');
    localStorage.setItem(LAST_EFFORT_KEY, 'high');
    localStorage.setItem(LAST_MODEL_KEY, 'gpt-6-astra');
    recentEntries.push({
      prompt: RECALLED,
      cwd: '/work/other',
      at: Date.now(),
      cwdMatch: false,
    });
    render();
    await flush();

    const details = container.querySelector<HTMLDetailsElement>('.quick-launch-pins');
    expect(details).not.toBeNull();
    act(() => { details!.open = true; });

    const cwdBefore = container.querySelector('.quick-launch-cwd')?.textContent;
    const agentBefore = container.querySelector<HTMLSelectElement>('.agent-type-select select')?.value;
    const effortBefore = container.querySelector<HTMLSelectElement>('select[aria-label="Reasoning effort"]')?.value;
    const modelBefore = container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')?.value;
    expect(cwdBefore).toBe(CWD);
    expect(agentBefore).toBe('codex-cli');
    expect(effortBefore).toBe('high');
    expect(modelBefore).toBe('gpt-6-astra');

    act(() => container.querySelector<HTMLButtonElement>('.recent-prompts-toggle')?.click());
    act(() => container.querySelector<HTMLButtonElement>('.recent-prompts-item')?.click());

    expect(container.querySelector<HTMLInputElement>('input.quick-launch-input')?.value).toBe(RECALLED);
    expect(container.querySelector('.quick-launch-cwd')?.textContent).toBe(cwdBefore);
    expect(container.querySelector<HTMLSelectElement>('.agent-type-select select')?.value).toBe(agentBefore);
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Reasoning effort"]')?.value).toBe(effortBefore);
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')?.value).toBe(modelBefore);
    expect(sent).toEqual([]);
    expect(closed).toBe(0);
  });

  test('Safari-style mousedown on Recent prompts does not close the bar', async () => {
    recentEntries.push({
      prompt: RECALLED,
      cwd: CWD,
      at: Date.now(),
      cwdMatch: true,
    });
    render();
    await flush();

    const input = container.querySelector<HTMLInputElement>('input.quick-launch-input');
    const toggle = container.querySelector<HTMLButtonElement>('.recent-prompts-toggle');
    expect(toggle).not.toBeNull();
    act(() => input?.focus());

    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    act(() => {
      toggle!.dispatchEvent(mouseDown);
      toggle!.click();
    });
    expect(mouseDown.defaultPrevented).toBe(true);

    await act(async () => {
      await Promise.resolve();
    });
    expect(closed).toBe(0);
    expect(container.querySelector('.quick-launch-bar')).not.toBeNull();
    expect(container.querySelector('.recent-prompts-panel')).not.toBeNull();
  });
});
