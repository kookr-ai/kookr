// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./avatar-stage.js', () => ({
  AvatarStage: class {
    setState = vi.fn();
    setAnalyser = vi.fn();
    snapshot = vi.fn(() => null);
    dispose = vi.fn();
  },
}));
vi.mock('./assets/lucy-bust.glb?url', () => ({ default: '/lucy-bust.glb' }));
vi.mock('../telemetry.js', () => ({ track: vi.fn() }));

// The conversation engine has its own tests; here the dock is shown every state it can be in.
import type { UseLucyLiveResult } from '../lucy-live/useLucyLive.js';
const live = vi.hoisted(() => ({
  current: null as unknown as UseLucyLiveResult,
  mounts: 0,
  unmounts: 0,
  setEnabled: null as unknown as (enabled: boolean) => void,
}));
vi.mock('../lucy-live/useLucyLive.js', async () => {
  const React = await import('react');
  return {
    SOUND_OFF_REASON: 'Sound is off in Settings',
    useLucyLive: (): UseLucyLiveResult => {
      React.useEffect(() => {
        live.mounts += 1;
        return () => { live.unmounts += 1; };
      }, []);
      return live.current;
    },
  };
});

import { AvatarDock, type AvatarDockProps } from './AvatarDock.js';
import { getDefaultShortcutBindings } from '../../shared/contracts/shortcut-bindings.js';
import { __resetSoundPreferenceForTests, setSoundEnabled } from '../audio/sound-preference.js';
import { __resetSpeechBusForTests } from '../audio/speech-bus.js';
import { __resetLastClipForTests } from '../audio/last-clip.js';
import { AVATAR_PANEL_KEY, __resetAvatarPanelPrefsForTests } from '../store/avatar-panel-prefs.js';
import { __resetLucyConversationForTests } from '../store/lucy-conversation.js';
import { __resetLucyTypedForTests } from './LucyTypedInput.js';

function base(overrides: Partial<UseLucyLiveResult> = {}): UseLucyLiveResult {
  return {
    status: 'off',
    lucyState: 'idle',
    operatorText: '',
    operatorFinal: false,
    lucyText: '',
    lastTurnEnd: null,
    timings: { endToFirstAudioMs: null, bargeInStopMs: null },
    micLevel: 0,
    errorMessage: null,
    enabled: false,
    setEnabled: live.setEnabled,
    unavailableReason: null,
    serverStatus: { available: true },
    ...overrides,
  };
}

describe('AvatarDock hands-free talk', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const talk = () => container.querySelector<HTMLButtonElement>('[data-testid="avatar-talk"]');
  /** Extra props for the dock; reset before each test. */
  let props: Partial<AvatarDockProps> = {};
  const render = () => {
    root = createRoot(container);
    act(() => { root!.render(<AvatarDock attentionCount={0} {...props} />); });
  };
  /** Re-render after changing what the hook returns. */
  const update = (next: UseLucyLiveResult) => {
    live.current = next;
    root ??= createRoot(container);
    act(() => { root!.render(<AvatarDock attentionCount={0} {...props} />); });
  };

  beforeEach(() => {
    __resetLucyConversationForTests();
    __resetLucyTypedForTests();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    localStorage.clear();
    __resetLastClipForTests();
    __resetSoundPreferenceForTests();
    __resetSpeechBusForTests();
    localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify({ enabled: true, minimized: false, position: null }));
    __resetAvatarPanelPrefsForTests();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
    live.mounts = 0;
    live.unmounts = 0;
    live.setEnabled = vi.fn();
    live.current = base();
    props = {};
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    setSoundEnabled(true);
    __resetSoundPreferenceForTests();
    document.body.innerHTML = '';
  });

  test('shows a Talk toggle that is off by default and turns hands-free on and off', () => {
    render();
    const button = talk()!;
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('Talk to Lucy hands-free');
    act(() => button.click());
    expect(live.setEnabled).toHaveBeenLastCalledWith(true);

    update(base({ enabled: true, status: 'ready' }));
    expect(talk()!.getAttribute('aria-pressed')).toBe('true');
    // The name stays the same; aria-pressed carries on/off, the tooltip may change.
    expect(talk()!.getAttribute('aria-label')).toBe('Talk to Lucy hands-free');
    expect(talk()!.title).toBe('Stop hands-free');
    act(() => talk()!.click());
    expect(live.setEnabled).toHaveBeenLastCalledWith(false);
  });

  test('is hidden when the server cannot be asked or says no without a reason', () => {
    live.current = base({ serverStatus: null });
    render();
    expect(talk()).toBeNull();
    update(base({ serverStatus: { available: false } }));
    expect(talk()).toBeNull();
  });

  test('is disabled with the server reason when the feature is not configured', () => {
    live.current = base({ serverStatus: { available: false, reason: 'No speech recogniser configured' } });
    render();
    const button = talk()!;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(container.querySelector(`#${button.getAttribute('aria-describedby')}`)!.textContent).toBe('No speech recogniser configured');
    act(() => button.click());
    expect(live.setEnabled).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="avatar-live-notice"]')!.textContent).toBe('No speech recogniser configured');
  });

  test('is disabled with the sound-off reason while sound is off in Settings', () => {
    render();
    act(() => setSoundEnabled(false));
    const button = talk()!;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(container.querySelector(`#${button.getAttribute('aria-describedby')}`)!.textContent).toBe('Sound is off in Settings');
    act(() => button.click());
    expect(live.setEnabled).not.toHaveBeenCalled();
  });

  test('can always be switched off, even if the reason it could not start applies', () => {
    update(base({ enabled: true, status: 'connecting' }));
    act(() => setSoundEnabled(false));
    expect(talk()!.getAttribute('aria-disabled')).toBeNull();
    act(() => talk()!.click());
    expect(live.setEnabled).toHaveBeenCalledWith(false);
  });

  test('the state label and hint follow what Lucy is doing', () => {
    render();
    const label = () => container.querySelector('[data-testid="avatar-state-label"]')!.textContent;
    expect(label()).toBe('ready');
    expect(container.querySelector('[data-testid="avatar-hint"]')!.textContent).toContain('speaker button');

    update(base({ enabled: true, status: 'ready', lucyState: 'listening' }));
    expect(label()).toBe('listening');
    expect(container.querySelector('[data-testid="avatar-hint"]')!.textContent).toBe('Talk to me — I’m listening.');
    update(base({ enabled: true, status: 'ready', lucyState: 'transcribing' }));
    expect(label()).toBe('listening');
    update(base({ enabled: true, status: 'ready', lucyState: 'thinking' }));
    expect(label()).toBe('thinking');
    update(base({ enabled: true, status: 'ready', lucyState: 'speaking' }));
    expect(label()).toBe('speaking');
    update(base({ enabled: true, status: 'connecting' }));
    expect(label()).toBe('connecting');
  });

  const announce = () => container.querySelector<HTMLElement>('[data-testid="avatar-live-announce"]')!;

  test('shows what the operator said (draft muted, final normal) and Lucy’s answer in a log that is not live', () => {
    update(base({ enabled: true, status: 'ready', operatorText: 'any news on', operatorFinal: false, lucyText: '' }));
    const region = container.querySelector<HTMLElement>('[data-testid="avatar-thread"]')!;
    expect(region.getAttribute('role')).toBe('log');
    expect(region.getAttribute('aria-label')).toBe('Conversation with Lucy');
    expect(region.getAttribute('aria-live')).toBe('off'); // the log role would otherwise be polite
    expect(region.getAttribute('tabindex')).toBe('0');
    const you = () => container.querySelector<HTMLElement>('[data-testid="avatar-live-you"]')!;
    expect(you().textContent).toContain('any news on');
    expect(you().className).toContain('avatar-live-draft');
    expect(you().hasAttribute('aria-hidden')).toBe(false);

    update(base({ enabled: true, status: 'ready', operatorText: 'any news on the build?', operatorFinal: true, lucyText: 'The build passed.' }));
    expect(you().className).not.toContain('avatar-live-draft');
    expect(container.querySelector('[data-testid="avatar-live-lucy"]')!.textContent).toContain('The build passed.');
  });

  test('the announcement region exists before anything is announced', () => {
    render();
    const region = announce();
    expect(region.getAttribute('role')).toBe('status');
    expect(region.textContent).toBe('');
    update(base({ enabled: true, status: 'ready' }));
    expect(announce()).toBe(region); // the same element, never remounted
  });

  test('announces only the operator’s final words, as a new element each time, never drafts or Lucy’s answer', () => {
    update(base({ enabled: true, status: 'ready', operatorText: 'any news', operatorFinal: false }));
    expect(announce().textContent).toBe('');
    update(base({ enabled: true, status: 'ready', operatorText: 'any news on the build?', operatorFinal: true, lucyText: '' }));
    expect(announce().textContent).toBe('You said: any news on the build?');
    const first = announce().firstElementChild;
    update(base({ enabled: true, status: 'ready', operatorText: 'any news on the build?', operatorFinal: true, lucyText: 'The build passed.' }));
    expect(announce().textContent).not.toContain('The build passed.');
    expect(announce().firstElementChild).toBe(first); // not announced again
    update(base({ enabled: true, status: 'ready', operatorText: 'and tests?', operatorFinal: true, lucyText: 'The build passed.' }));
    expect(announce().textContent).toBe('You said: and tests?');
    expect(announce().firstElementChild).not.toBe(first);
    update(base());
    expect(announce().textContent).toBe('');
  });

  test('announces Connecting…, errors and the Talk-unavailable reason', () => {
    update(base({ enabled: true, status: 'connecting' }));
    expect(announce().textContent).toBe('Connecting\u2026');
    update(base({ enabled: true, status: 'ready', errorMessage: 'I could not hear that: the speech recogniser failed.' }));
    expect(announce().textContent).toBe('I could not hear that: the speech recogniser failed.');
    expect(container.querySelector('[data-testid="avatar-live-notice"]')!.textContent).toBe('I could not hear that: the speech recogniser failed.');
    update(base({ serverStatus: { available: false, reason: 'No speech recogniser configured' } }));
    act(() => talk()!.click());
    expect(announce().textContent).toBe('No speech recogniser configured');
    const first = announce().firstElementChild;
    act(() => talk()!.click());
    expect(announce().firstElementChild).not.toBe(first); // pressing again says it again
  });

  test('moves focus to the dock if the Talk button disappears while focused', () => {
    update(base({ enabled: true, status: 'ready' }));
    act(() => talk()!.focus());
    expect(document.activeElement).toBe(talk());
    update(base({ serverStatus: null }));
    expect(talk()).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('[data-testid="avatar-dock"]'));
  });

  test('shows a start failure in the live area', () => {
    update(base({ status: 'error', errorMessage: 'Microphone permission denied' }));
    expect(container.querySelector('[data-testid="avatar-live-notice"]')!.textContent).toBe('Microphone permission denied');
    expect(talk()!.getAttribute('aria-pressed')).toBe('false');
  });

  test('keeps hands-free running when the panel is minimised, and marks the bubble', () => {
    update(base({ enabled: true, status: 'ready' }));
    expect(live.mounts).toBe(1);
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Minimise Lucy"]')!.click());
    expect(container.querySelector('[data-testid="avatar-bubble"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="avatar-bubble-stop"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="avatar-bubble"]')!.getAttribute('aria-label')).toContain('listening');
    // The hook belongs to the dock, not to the 3D view, so minimising neither remounts nor stops it.
    expect(live.mounts).toBe(1);
    expect(live.unmounts).toBe(0);
  });

  test('is never saved: a fresh mount starts with the hook off and nothing in storage', () => {
    update(base({ enabled: true, status: 'ready' }));
    expect(Object.keys(localStorage).filter((k) => /lucy|live|hands/i.test(k))).toEqual([]);
    expect(localStorage.getItem(AVATAR_PANEL_KEY)).not.toMatch(/talk|live|hands/i);
    act(() => root!.unmount());
    root = null;
    live.current = base();
    render();
    expect(talk()!.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('[data-testid="avatar-live-you"]')).toBeNull();
  });
});

describe('AvatarDock Talk shortcut and the bubble\u2019s off control (#4010)', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const talkShortcut = getDefaultShortcutBindings('default').lucy_talk_toggle;
  let props: Partial<AvatarDockProps> = {};
  const render = (next: UseLucyLiveResult = live.current) => {
    live.current = next;
    root ??= createRoot(container);
    act(() => { root!.render(<AvatarDock attentionCount={0} talkShortcut={talkShortcut} {...props} />); });
  };
  const bubble = () => container.querySelector<HTMLButtonElement>('[data-testid="avatar-bubble"]');
  const stop = () => container.querySelector<HTMLButtonElement>('[data-testid="avatar-bubble-stop"]');
  const press = (init: KeyboardEventInit = {}, target: EventTarget = document.body) => {
    const event = new KeyboardEvent('keydown', { key: 'M', code: 'KeyM', altKey: true, shiftKey: true, bubbles: true, cancelable: true, ...init });
    act(() => { target.dispatchEvent(event); });
    return event;
  };
  const minimise = () => act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Minimise Lucy"]')!.click());

  beforeEach(() => {
    __resetLucyConversationForTests();
    __resetLucyTypedForTests();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    localStorage.clear();
    __resetLastClipForTests();
    __resetSoundPreferenceForTests();
    __resetSpeechBusForTests();
    localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify({ enabled: true, minimized: false, position: null }));
    __resetAvatarPanelPrefsForTests();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
    live.setEnabled = vi.fn();
    live.current = base();
    props = {};
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    setSoundEnabled(true);
    __resetSoundPreferenceForTests();
    document.body.innerHTML = '';
  });

  test('the shortcut switches Talk on and off, with the panel open or minimised', () => {
    render();
    expect(press().defaultPrevented).toBe(true);
    expect(live.setEnabled).toHaveBeenLastCalledWith(true);
    render(base({ enabled: true, status: 'ready' }));
    minimise();
    expect(bubble()).not.toBeNull();
    press();
    expect(live.setEnabled).toHaveBeenLastCalledWith(false);
    expect(live.setEnabled).toHaveBeenCalledTimes(2);
    // A toggle that works leaves the panel minimised.
    expect(bubble()).not.toBeNull();
  });

  test('works while a text box has focus, and leaves Alt+M to dictation', () => {
    render();
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    input.focus();
    const dictation = press({ key: 'm', shiftKey: false }, input);
    expect(dictation.defaultPrevented).toBe(false);
    expect(live.setEnabled).not.toHaveBeenCalled();
    press({}, input);
    expect(live.setEnabled).toHaveBeenCalledWith(true);
    expect(document.activeElement).toBe(input);
  });

  test('ignores a held key, an IME composition, and presses while a dialog blocks shortcuts', () => {
    render();
    press({ repeat: true });
    press({ isComposing: true });
    expect(live.setEnabled).not.toHaveBeenCalled();
    props = { shortcutsBlocked: true };
    render();
    press();
    expect(live.setEnabled).not.toHaveBeenCalled();
    props = {};
    render();
    press();
    expect(live.setEnabled).toHaveBeenCalledTimes(1);
  });

  test('does nothing when the Talk button is hidden (server status unknown)', () => {
    render(base({ serverStatus: null }));
    expect(container.querySelector('[data-testid="avatar-talk"]')).toBeNull();
    press();
    expect(live.setEnabled).not.toHaveBeenCalled();
  });

  test('when Talk is unavailable, a press while minimised opens the panel to show why', () => {
    render(base({ serverStatus: { available: false, reason: 'No speech recogniser configured' } }));
    minimise();
    expect(bubble()).not.toBeNull();
    press();
    expect(live.setEnabled).not.toHaveBeenCalled();
    expect(bubble()).toBeNull();
    expect(container.querySelector('[data-testid="avatar-live-notice"]')!.textContent).toBe('No speech recogniser configured');
  });

  test('opening the panel for the reason leaves focus in the text box the operator is typing in', () => {
    render(base({ serverStatus: { available: false, reason: 'No speech recogniser configured' } }));
    minimise();
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    input.focus();
    press({}, input);
    expect(bubble()).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  test('opening the panel for the reason moves focus from the bubble to the panel', () => {
    render(base({ serverStatus: { available: false, reason: 'No speech recogniser configured' } }));
    minimise();
    act(() => bubble()!.focus());
    press({}, bubble()!);
    expect(bubble()).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('button[aria-label="Minimise Lucy"]'));
  });

  test('names the shortcut in the Talk button\u2019s tooltip', () => {
    render();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="avatar-talk"]')!.title).toBe('Talk to Lucy hands-free (Alt+Shift+M)');
  });

  test('the minimised bubble has a one-click off control only while Talk is on', () => {
    render();
    minimise();
    expect(stop()).toBeNull();
    render(base({ enabled: true, status: 'ready' }));
    const button = stop()!;
    expect(button.getAttribute('aria-label')).toBe('Stop hands-free');
    expect(button.title).toBe('Stop hands-free (Alt+Shift+M)');
    // Not inside the bubble: a press must not also open the panel.
    expect(bubble()!.contains(button)).toBe(false);
    act(() => button.click());
    expect(live.setEnabled).toHaveBeenCalledTimes(1);
    expect(live.setEnabled).toHaveBeenLastCalledWith(false);
    expect(bubble()).not.toBeNull();
  });

  test('switches off even when sound is off in Settings', () => {
    render(base({ enabled: true, status: 'ready' }));
    minimise();
    act(() => setSoundEnabled(false));
    act(() => stop()!.click());
    expect(live.setEnabled).toHaveBeenLastCalledWith(false);
  });

  test('hands keyboard focus to the bubble when the off control disappears', () => {
    render(base({ enabled: true, status: 'ready' }));
    minimise();
    act(() => stop()!.focus());
    expect(document.activeElement).toBe(stop());
    render(base());
    expect(stop()).toBeNull();
    expect(document.activeElement).toBe(bubble());
  });
});
