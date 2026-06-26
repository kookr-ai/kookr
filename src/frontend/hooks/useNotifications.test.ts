// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { __resetSoundPreferenceForTests, setSoundEnabled, setSoundVolume } from '../audio/sound.js';
import { __resetDndForTests, disableDnd } from './useDnd.js';
import {
  __resetProjectNotificationMuteForTests,
  muteProjectNotifications,
  unmuteProjectNotifications,
} from './useProjectNotificationMute.js';
import { useNotifications } from './useNotifications.js';
import { useKookrStore } from '../store/useStore.js';
import type { AgentState } from '../../shared/protocol.js';
import type { Anomaly } from '../../shared/contracts/anomalies.js';

const DETECTED_AT = new Date('2026-05-14T12:00:00.000Z');

function mkAgent(agentId: string, projectId = 'github.com/kookr-ai/kookr'): AgentState {
  const anomaly: Anomaly = {
    agentId,
    type: 'permission_blocked',
    severity: 'warning',
    explanation: 'mock finding',
    detectedAt: DETECTED_AT,
  };
  return {
    agentId,
    events: [],
    anomaly,
    projectId,
    taskStatus: 'inProgress',
  };
}

describe('useNotifications', () => {
  let root: Root | null;
  let container: HTMLDivElement;
  let store: Map<string, string>;
  let documentHidden = true;
  let notificationCtor: ReturnType<typeof vi.fn>;
  let notificationInstances: Array<{ close: ReturnType<typeof vi.fn>; onclick: (() => void) | null }>;

  function Wrapper() {
    useNotifications();
    return null;
  }

  function mount(strict = false): void {
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container);
      const tree = strict
        ? React.createElement(React.StrictMode, null, React.createElement(Wrapper))
        : React.createElement(Wrapper);
      root.render(tree);
    });
  }

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    root = null;
    store = new Map();
    notificationInstances = [];
    documentHidden = true;

    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    });

    notificationCtor = vi.fn().mockImplementation(function (this: { close: ReturnType<typeof vi.fn>; onclick: (() => void) | null }) {
      this.close = vi.fn();
      this.onclick = null;
      notificationInstances.push(this);
    });
    Object.defineProperty(notificationCtor, 'permission', {
      configurable: true,
      value: 'granted',
    });
    Object.defineProperty(notificationCtor, 'requestPermission', {
      configurable: true,
      value: vi.fn(),
    });
    vi.stubGlobal('Notification', notificationCtor);

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => documentHidden,
    });

    __resetSoundPreferenceForTests();
    __resetDndForTests();
    __resetProjectNotificationMuteForTests();
    disableDnd();
    useKookrStore.setState({ agents: [], selectedAgentId: null });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    __resetSoundPreferenceForTests();
    __resetDndForTests();
    __resetProjectNotificationMuteForTests();
    vi.unstubAllGlobals();
    useKookrStore.setState({ agents: [], selectedAgentId: null });
  });

  test('does not create per-finding desktop notifications while sound alerts are enabled', () => {
    useKookrStore.setState({ agents: [mkAgent('agent-a')] });

    mount();

    expect(notificationCtor).not.toHaveBeenCalled();
  });

  test('does not notify when a new finding arrives after mount while sound alerts are enabled', () => {
    mount();

    act(() => {
      useKookrStore.setState({ agents: [mkAgent('agent-a')] });
    });

    expect(notificationCtor).not.toHaveBeenCalled();
  });

  test('uses desktop notifications as the fallback when sound alerts are muted', () => {
    setSoundEnabled(false);
    useKookrStore.setState({ agents: [mkAgent('agent-a')] });

    mount();

    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(notificationCtor).toHaveBeenCalledWith(
      'Agent: permission blocked',
      expect.objectContaining({ body: 'mock finding' }),
    );
  });

  test('uses desktop notifications as the fallback when alert volume is zero', () => {
    setSoundVolume(0);
    useKookrStore.setState({ agents: [mkAgent('agent-a')] });

    mount();

    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(notificationCtor).toHaveBeenCalledWith(
      'Agent: permission blocked',
      expect.objectContaining({ body: 'mock finding' }),
    );
  });

  test('notifies when a new finding arrives after mount while sound alerts are muted', () => {
    setSoundEnabled(false);
    mount();

    act(() => {
      useKookrStore.setState({ agents: [mkAgent('agent-a')] });
    });

    expect(notificationCtor).toHaveBeenCalledTimes(1);
  });

  test('does not notify for muted projects while sound alerts are muted', () => {
    setSoundEnabled(false);
    muteProjectNotifications('github.com/kookr-ai/kookr');
    useKookrStore.setState({
      agents: [
        mkAgent('agent-muted', 'github.com/kookr-ai/kookr'),
        mkAgent('agent-open', 'github.com/kookr-ai/other'),
      ],
    });

    mount();

    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(notificationCtor).toHaveBeenCalledWith(
      'Agent: permission blocked',
      expect.objectContaining({ tag: 'kookr-agent-open' }),
    );
  });

  test('does not replay a muted-project finding after unmute', () => {
    setSoundEnabled(false);
    muteProjectNotifications('github.com/kookr-ai/kookr');
    useKookrStore.setState({ agents: [mkAgent('agent-muted')] });
    mount();
    expect(notificationCtor).not.toHaveBeenCalled();

    act(() => {
      unmuteProjectNotifications('github.com/kookr-ai/kookr');
      useKookrStore.setState({ agents: [mkAgent('agent-muted')] });
    });

    expect(notificationCtor).not.toHaveBeenCalled();
  });

  test('StrictMode does not immediately close muted-sound fallback notifications', () => {
    setSoundEnabled(false);
    useKookrStore.setState({ agents: [mkAgent('agent-a')] });

    mount(true);

    expect(notificationInstances).toHaveLength(1);
    expect(notificationInstances[0]?.close).not.toHaveBeenCalled();
  });

  test('closes outstanding desktop notifications when sound alerts are re-enabled', () => {
    setSoundEnabled(false);
    useKookrStore.setState({ agents: [mkAgent('agent-a')] });
    mount();
    expect(notificationInstances).toHaveLength(1);

    act(() => {
      setSoundEnabled(true);
    });

    expect(notificationInstances[0]?.close).toHaveBeenCalledTimes(1);
  });
});
