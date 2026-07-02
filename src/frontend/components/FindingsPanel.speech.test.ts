// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FindingsPanel } from './FindingsPanel.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { __resetSoundPreferenceForTests, setSoundEnabled } from '../audio/sound.js';
import type { AgentState } from '../../shared/protocol.js';

type FakeBufferSource = {
  buffer: AudioBuffer | null;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
};

const fakeSources: FakeBufferSource[] = [];
const fakeAudioContexts: FakeAudioContext[] = [];
const fakeAudioEvents: string[] = [];
let fakeAudioContextInitialState: AudioContextState = 'running';

class FakeAudioContext {
  state: AudioContextState = fakeAudioContextInitialState;
  destination = {};

  constructor() {
    fakeAudioContexts.push(this);
    fakeAudioEvents.push('context');
  }

  decodeAudioData = vi.fn(async () => ({}) as AudioBuffer);
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  resume = vi.fn(async () => {
    fakeAudioEvents.push('resume');
    this.state = 'running';
  });
  createBufferSource = vi.fn(() => {
    const source: FakeBufferSource = {
      buffer: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
    };
    fakeSources.push(source);
    return source as unknown as AudioBufferSourceNode;
  });
}

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function makeFinding(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: overrides.agentId ?? 'agent-1',
    taskId: overrides.taskId ?? 'task-1',
    taskName: overrides.taskName ?? 'Some task',
    description: 'Working',
    events: [],
    anomaly: {
      type: 'needs_input',
      severity: 'info',
      explanation: 'waiting for guidance',
      detectedAt: '2026-05-24T10:00:00.000Z',
    },
    taskStatus: 'inProgress',
    cwd: '/tmp/project',
    ...overrides,
  } as AgentState;
}

function renderPanel(
  container: HTMLElement,
  findings: AgentState[],
  selectedAgentId: string | null = null,
  extras: Partial<React.ComponentProps<typeof FindingsPanel>> = {},
): Root {
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(FindingsPanel, {
      findings,
      healthy: [],
      pending: [],
      snoozed: [],
      completed: [],
      selectedAgentId,
      send: vi.fn(),
      clearCompletedFinishedCount: 0,
      clearCompletedTerminatedCount: 0,
      ...extras,
    }));
  });
  return root;
}

describe('FindingsPanel speak agent control', () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    fakeSources.length = 0;
    fakeAudioContexts.length = 0;
    fakeAudioEvents.length = 0;
    fakeAudioContextInitialState = 'running';
    syncGlobalStore();
    window.localStorage.clear();
    __resetSoundPreferenceForTests();
    useKookrStore.setState({ ttsUrl: 'http://127.0.0.1:8004' });
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(110)
      .mockReturnValueOnce(120)
      .mockReturnValueOnce(150)
      .mockReturnValue(180);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/tasks/')) {
        fakeAudioEvents.push('fetch');
        return {
          ok: true,
          json: async () => ({
            text: 'Some task is waiting for guidance.',
            audioBase64: 'AA==',
            mimeType: 'audio/wav',
            durationMs: 2400,
            usedFallback: false,
            llmMs: 1234,
            ttsMs: 480,
            cached: false,
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ checks: {}, fires: {}, falsePositives: {} }),
        text: async () => '{}',
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    __resetSoundPreferenceForTests();
    document.body.innerHTML = '';
  });

  test('renders the speak button inside each active finding card', () => {
    root = renderPanel(container, [makeFinding()]);

    const card = container.querySelector('.finding-card');
    const button = card?.querySelector<HTMLButtonElement>('[data-testid="speak-button"]');

    expect(button).toBeTruthy();
    expect(button?.dataset.agentId).toBe('agent-1');
    expect(button?.getAttribute('aria-label')).toBe('Speak task summary for Some task');
  });

  test('clicking the card speak button posts, plays, and shows timing', async () => {
    root = renderPanel(container, [makeFinding()], 'agent-1');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="speak-button"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/task-1/speak-summary', expect.objectContaining({
      method: 'POST',
    }));
    expect(fakeSources).toHaveLength(1);
    expect(fakeSources[0].start).toHaveBeenCalledOnce();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="speak-button"]')?.getAttribute('aria-label'))
      .toBe('Stop spoken task summary for Some task');
    expect(container.querySelector('.finding-speech-timing')?.textContent)
      .toContain('LLM 1.2s');
  });

  test('unlocks a suspended AudioContext before waiting on TTS generation', async () => {
    fakeAudioContextInitialState = 'suspended';
    root = renderPanel(container, [makeFinding()], 'agent-1');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="speak-button"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fakeAudioEvents.slice(0, 3)).toEqual(['context', 'resume', 'fetch']);
    expect(fakeAudioContexts[0].resume).toHaveBeenCalledOnce();
    expect(fakeSources).toHaveLength(1);
    expect(fakeSources[0].start).toHaveBeenCalledOnce();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="speak-button"]')?.getAttribute('aria-label'))
      .toBe('Stop spoken task summary for Some task');
  });

  test('clicking a suppressed speak button clears it back to idle', async () => {
    setSoundEnabled(false);
    root = renderPanel(container, [makeFinding()], 'agent-1');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="speak-button"]')!.click();
      await Promise.resolve();
    });

    const taskFetchCount = () => fetchMock.mock.calls
      .filter(([input]) => String(input).includes('/api/tasks/')).length;
    expect(taskFetchCount()).toBe(0);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="speak-button"]')?.getAttribute('aria-label'))
      .toBe('Audio suppressed for Some task by sound or Do Not Disturb settings; press to reset');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="speak-button"]')!.click();
      await Promise.resolve();
    });

    expect(taskFetchCount()).toBe(0);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="speak-button"]')?.getAttribute('aria-label'))
      .toBe('Speak task summary for Some task');
  });

  test('suppressed speak buttons do not clear other suppressed task cards', async () => {
    setSoundEnabled(false);
    root = renderPanel(container, [
      makeFinding({ agentId: 'agent-1', taskName: 'First task' }),
      makeFinding({ agentId: 'agent-2', taskId: 'task-2', taskName: 'Second task' }),
    ], 'agent-1');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-agent-id="agent-1"]')!.click();
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-agent-id="agent-2"]')!.click();
      await Promise.resolve();
    });

    expect(container.querySelector<HTMLButtonElement>('[data-agent-id="agent-1"]')?.getAttribute('aria-label'))
      .toBe('Audio suppressed for First task by sound or Do Not Disturb settings; press to reset');
    expect(container.querySelector<HTMLButtonElement>('[data-agent-id="agent-2"]')?.getAttribute('aria-label'))
      .toBe('Audio suppressed for Second task by sound or Do Not Disturb settings; press to reset');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-agent-id="agent-1"]')!.click();
      await Promise.resolve();
    });

    expect(container.querySelector<HTMLButtonElement>('[data-agent-id="agent-1"]')?.getAttribute('aria-label'))
      .toBe('Speak task summary for First task');
    expect(container.querySelector<HTMLButtonElement>('[data-agent-id="agent-2"]')?.getAttribute('aria-label'))
      .toBe('Audio suppressed for Second task by sound or Do Not Disturb settings; press to reset');
  });

  test('healthy no-anomaly task row can speak task summary', async () => {
    root = renderPanel(container, [], 'done-agent', {
      healthy: [makeFinding({
        agentId: 'done-agent',
        taskId: 'done-task',
        taskName: 'Done task',
        anomaly: null,
        taskStatus: 'inProgress',
      })],
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-agent-id="done-agent"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/done-task/speak-summary', expect.objectContaining({
      method: 'POST',
    }));
    expect(fakeSources[0].start).toHaveBeenCalledOnce();
  });

  test('starting another finding stops the previous card playback', async () => {
    root = renderPanel(container, [
      makeFinding({ agentId: 'agent-1', taskName: 'First task' }),
      makeFinding({ agentId: 'agent-2', taskId: 'task-2', taskName: 'Second task' }),
    ], 'agent-1');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-agent-id="agent-1"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const firstSource = fakeSources[0];
    expect(firstSource.start).toHaveBeenCalledOnce();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-agent-id="agent-2"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(firstSource.stop).toHaveBeenCalledOnce();
    expect(useKookrStore.getState().selectedAgentId).toBe('agent-2');
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/task-2/speak-summary', expect.objectContaining({
      method: 'POST',
    }));
  });

  test('keeps a selected grouped finding expanded so its speak button is targetable', async () => {
    root = renderPanel(container, [
      makeFinding({ agentId: 'agent-1' }),
      makeFinding({ agentId: 'agent-2' }),
      makeFinding({ agentId: 'agent-3' }),
    ], 'agent-2');

    await act(async () => { await Promise.resolve(); });

    const selectedCard = container.querySelector('.finding-card.selected');
    const button = selectedCard?.querySelector<HTMLButtonElement>('[data-testid="speak-button"]');

    expect(selectedCard).toBeTruthy();
    expect(button?.dataset.agentId).toBe('agent-2');
  });
});
