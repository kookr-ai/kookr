// @vitest-environment happy-dom

// "Lucy's room": the layout where she takes the whole window. Entering and leaving it (button, shortcut,
// address), what the switch must not disturb (the 3D view, a half-typed message, the live region), where
// keyboard focus goes, "Open task" leaving it, and the side rail that replaces the folded strip.

import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const stages = vi.hoisted(() => [] as Array<{ dispose: ReturnType<typeof vi.fn> }>);
const tracked = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const live = vi.hoisted(() => ({ available: false }));

vi.mock('./avatar-stage.js', () => ({
  AvatarStage: class {
    setState = vi.fn();
    setAnalyser = vi.fn();
    snapshot = vi.fn(() => null);
    dispose = vi.fn();
    constructor() { stages.push(this); }
  },
}));
vi.mock('./assets/lucy-bust.glb?url', () => ({ default: '/lucy-bust.glb' }));
vi.mock('../telemetry.js', () => ({ track: (event: Record<string, unknown>) => { tracked.push(event); } }));
vi.mock('../lucy-live/useLucyLive.js', () => ({
  SOUND_OFF_REASON: 'Sound is off in Settings',
  useLucyLive: () => ({
    status: 'off', lucyState: 'idle', operatorText: '', operatorFinal: false, lucyText: '', lastTurnEnd: null,
    timings: { endToFirstAudioMs: null, bargeInStopMs: null }, micLevel: 0, errorMessage: null,
    enabled: false, setEnabled: vi.fn(), unavailableReason: null, serverStatus: { available: live.available },
  }),
}));
vi.mock('../audio/ask-announcement.js', () => ({
  announceAsk: vi.fn(async () => 'started'),
  announcePermissionNotice: vi.fn(async () => 'started'),
  announceLaunchReport: vi.fn(async () => 'started'),
  stopAskAnnouncement: vi.fn(),
  stopPermissionNotice: vi.fn(),
  stopAllAskAnnouncements: vi.fn(),
  setLiveAskSpeaker: vi.fn(() => () => {}),
}));

import { AvatarDock, COLUMN_WIDTH_PROPERTY, type AvatarDockProps } from './AvatarDock.js';
import type { OperatorAskView } from '../../shared/contracts/asks.js';
import type { LucyPermissionCardView } from '../../shared/contracts/lucy-permission.js';
import { getDefaultShortcutBindings } from '../../shared/contracts/shortcut-bindings.js';
import { __resetLastClipForTests } from '../audio/last-clip.js';
import { __resetSoundPreferenceForTests } from '../audio/sound-preference.js';
import { __resetSpeechBusForTests } from '../audio/speech-bus.js';
import {
  AVATAR_PANEL_KEY,
  AVATAR_ROOM_KEY,
  AVATAR_TRAY_EXPANDED_KEY,
  __resetAvatarPanelPrefsForTests,
  getAvatarRoom,
  setAvatarRoom,
  updateAvatarPanelPrefs,
  useAvatarPageCovered,
} from '../store/avatar-panel-prefs.js';
import { __resetLucyConversationForTests, appendConversationEntry } from '../store/lucy-conversation.js';
import { __resetLucyPermissionForTests, handleLucyPermissionCards } from '../store/lucy-permission.js';
import { __resetOperatorAsksForTests, handleOperatorAsks } from '../store/operator-asks.js';
import { useKookrStore } from '../store/useStore.js';
import { __resetLucyTypedForTests, sendLucyTypedText } from './LucyTypedInput.js';
import { __resetLucyBriefingForTests } from './useLucyBriefing.js';

const MIN = 60_000;
const NOW = Date.parse('2026-11-16T12:00:00Z');
const ROOM_SHORTCUT = getDefaultShortcutBindings('default').lucy_room_toggle;
const rootWidth = (): string => document.documentElement.style.getPropertyValue(COLUMN_WIDTH_PROPERTY);

function ask(id: string, over: Partial<OperatorAskView> = {}): OperatorAskView {
  return {
    id, taskId: `task-${id}`, taskName: `Task ${id}`, question: `Question ${id}?`, options: ['Yes', 'No'], allowText: true,
    state: 'pending', createdAt: NOW - MIN, expiresAt: NOW + 30 * MIN, ...over,
  };
}

function permission(over: Partial<LucyPermissionCardView> = {}): LucyPermissionCardView {
  const since = NOW - MIN;
  return {
    promptId: 'req-aaaa', taskId: 'task-perm', agentId: 'kookr-perm', taskName: 'Docs publish', toolName: 'Bash',
    command: 'npm publish', since,
    permissionRequest: { requestId: 'req-aaaa', toolName: 'Bash', toolInputHash: 'h', detectedAt: new Date(since).toISOString(), ttlMs: 5 * MIN },
    approveKey: '1', denyKey: '3',
    ...over,
  };
}

describe('AvatarDock: Lucy’s room', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const q = <T extends HTMLElement = HTMLElement>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`);
  const all = <T extends HTMLElement = HTMLElement>(id: string) => [...container.querySelectorAll<T>(`[data-testid="${id}"]`)];
  const dock = () => q('avatar-dock');
  const bubble = () => q<HTMLButtonElement>('avatar-bubble');
  const toggle = () => q<HTMLButtonElement>('avatar-room-toggle');
  const composer = () => q<HTMLTextAreaElement>('avatar-typed-input');
  const mode = () => dock()?.getAttribute('data-column-mode');
  const headerButtons = () => [...container.querySelectorAll<HTMLButtonElement>('.avatar-dock-header button')].map((b) => b.getAttribute('aria-label') ?? b.textContent);
  const savedPrefs = (): { enabled: boolean; minimized: boolean } => JSON.parse(localStorage.getItem(AVATAR_PANEL_KEY) ?? 'null');
  const panelActions = () => tracked.filter((event) => event.type === 'lucy_panel_action').map((event) => event.action);

  const start = (prefs: { minimized?: boolean; width?: number } = {}, room = false): void => {
    localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify({ enabled: true, minimized: false, ...prefs }));
    if (room) sessionStorage.setItem(AVATAR_ROOM_KEY, '1');
    __resetAvatarPanelPrefsForTests();
  };
  const render = (props: Partial<AvatarDockProps> = {}): void => {
    root = createRoot(container);
    act(() => { root!.render(<AvatarDock attentionCount={0} roomShortcut={ROOM_SHORTCUT} {...props} />); });
  };
  /** What a reload of the tab does: the page is rebuilt, the module state is read again from storage. */
  const reload = (props: Partial<AvatarDockProps> = {}): void => {
    act(() => root?.unmount());
    __resetAvatarPanelPrefsForTests();
    render(props);
  };
  const click = (element: Element | null | undefined): void => {
    expect(element).not.toBeNull();
    act(() => { element!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  };
  /** A click on an answer or "Open task" button, after the "cards just changed" guard has run out. */
  const clickCard = (element: Element | null | undefined): void => {
    act(() => { vi.setSystemTime(Date.now() + 500); });
    click(element);
  };
  const key = (init: KeyboardEventInit): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    act(() => { document.dispatchEvent(event); });
    return event;
  };
  const pressRoomShortcut = (init: KeyboardEventInit = {}): KeyboardEvent => key({ key: 'L', code: 'KeyL', altKey: true, shiftKey: true, ...init });
  const setWindowWidth = (width: number): void => {
    act(() => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
      window.dispatchEvent(new Event('resize'));
    });
  };
  const pushAsks = (asks: OperatorAskView[]) => act(() => { handleOperatorAsks(asks, undefined, NOW); });
  const pushPermissions = (cards: LucyPermissionCardView[]) => act(() => { handleLucyPermissionCards({ type: 'lucyPermissionCards', cards }); });

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    localStorage.clear();
    sessionStorage.clear();
    stages.length = 0;
    tracked.length = 0;
    live.available = false;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    __resetAvatarPanelPrefsForTests();
    __resetLucyConversationForTests();
    __resetLucyTypedForTests();
    __resetLastClipForTests();
    __resetSoundPreferenceForTests();
    __resetSpeechBusForTests();
    __resetOperatorAsksForTests();
    __resetLucyPermissionForTests();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1920 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1080 });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    vi.useRealTimers();
    localStorage.clear();
    sessionStorage.clear();
    __resetAvatarPanelPrefsForTests();
    __resetOperatorAsksForTests();
    __resetLucyPermissionForTests();
    __resetLucyConversationForTests();
    document.documentElement.style.removeProperty(COLUMN_WIDTH_PROPERTY);
    document.body.innerHTML = '';
  });

  describe('entering and leaving', () => {
    test('the column has a labelled Expand button; pressing it gives her the whole window, and the same button brings the dashboard back', () => {
      start();
      render();
      expect(mode()).toBe('docked');
      expect(toggle()!.textContent).toBe('Expand');
      expect(toggle()!.querySelector('svg')).not.toBeNull();
      expect(toggle()!.title).toBe('Give Lucy the whole window (Alt+Shift+L)');
      expect(headerButtons()).toEqual(['Replay last message', 'Expand', 'Minimise Lucy']);
      const button = toggle()!;

      click(button);
      expect(mode()).toBe('room');
      expect(dock()!.classList.contains('avatar-dock-room')).toBe(true);
      expect(dock()!.getAttribute('data-room-rail')).toBe('true');
      // No width of its own: the stylesheet makes it the whole window.
      expect(dock()!.style.width).toBe('');
      expect(q('avatar-column-resizer')).toBeNull();
      // The same button, now the way back; Minimise is not offered in the room.
      expect(toggle()).toBe(button);
      expect(button.textContent).toBe('Back to dashboard');
      expect(button.title).toBe('Back to dashboard (Alt+Shift+L)');
      expect(headerButtons()).toEqual(['Replay last message', 'Back to dashboard']);

      click(button);
      expect(mode()).toBe('docked');
      expect(dock()!.classList.contains('avatar-dock-room')).toBe(false);
      expect(dock()!.hasAttribute('data-room-rail')).toBe(false);
      expect(dock()!.style.width).toBe('380px');
      expect(q('avatar-column-resizer')).not.toBeNull();
      expect(headerButtons()).toEqual(['Replay last message', 'Expand', 'Minimise Lucy']);
    });

    test('a full-width sheet already is the whole window, so it has no Expand', () => {
      start();
      setWindowWidth(600);
      render();
      expect(mode()).toBe('sheet');
      expect(toggle()).toBeNull();
      expect(headerButtons()).toEqual(['Replay last message', 'Minimise Lucy']);
    });

    test('the room is a region with its own name, and the column gets its name back', () => {
      start();
      render();
      expect(dock()!.tagName).toBe('SECTION');
      expect(dock()!.getAttribute('aria-label')).toBe('Lucy avatar');
      click(toggle());
      expect(dock()!.getAttribute('aria-label')).toBe('Lucy’s room');
      click(toggle());
      expect(dock()!.getAttribute('aria-label')).toBe('Lucy avatar');
    });

    test('the shortcut does the same from anywhere, is recorded, and a held key does not flip it back', () => {
      start();
      render();
      const first = pressRoomShortcut();
      expect(first.defaultPrevented).toBe(true);
      expect(mode()).toBe('room');
      pressRoomShortcut({ repeat: true });
      expect(mode()).toBe('room');
      pressRoomShortcut();
      expect(mode()).toBe('docked');
      expect(tracked.filter((event) => event.type === 'shortcut_used')).toEqual([
        { type: 'shortcut_used', key: 'Alt+Shift+L', action: 'lucy_room_toggle', context: 'global' },
        { type: 'shortcut_used', key: 'Alt+Shift+L', action: 'lucy_room_toggle', context: 'global' },
      ]);
    });

    test('the dock tells the store it covers the page while the room is on screen, and stops when it leaves, unmounts or the panel goes off', () => {
      // A probe beside the REAL dock (App's own test uses a stand-in): this is what the dashboard's shortcuts and its inert state read.
      const Probe = (): React.ReactElement => <i data-testid="shown">{String(useAvatarPageCovered())}</i>;
      const shown = (): string | undefined => q('shown')?.textContent ?? undefined;
      start();
      root = createRoot(container);
      act(() => { root!.render(<><Probe /><AvatarDock attentionCount={0} roomShortcut={ROOM_SHORTCUT} /></>); });
      expect(shown()).toBe('false');
      click(toggle());
      expect(mode()).toBe('room');
      expect(shown()).toBe('true');
      click(toggle());
      expect(mode()).toBe('docked');
      expect(shown()).toBe('false');
      click(toggle());
      expect(shown()).toBe('true');
      act(() => { root!.render(<Probe />); });
      expect(shown()).toBe('false');
      // Switched off while in the room.
      act(() => { root!.render(<><Probe /><AvatarDock attentionCount={0} roomShortcut={ROOM_SHORTCUT} /></>); });
      expect(shown()).toBe('true');
      act(() => { updateAvatarPanelPrefs({ enabled: false }); });
      expect(shown()).toBe('false');
    });

    test('the dock says it covers the whole page in the room and as the open full-width sheet, and nowhere else (#4154)', () => {
      // What makes the dashboard inert underneath her (App.tsx). The docked column and the overlay leave the page in sight.
      const Probe = (): React.ReactElement => <i data-testid="covered">{String(useAvatarPageCovered())}</i>;
      const covered = (): string | undefined => q('covered')?.textContent ?? undefined;
      const withProbe = <><Probe /><AvatarDock attentionCount={0} roomShortcut={ROOM_SHORTCUT} /></>;
      start();
      root = createRoot(container);
      act(() => { root!.render(withProbe); });
      expect(mode()).toBe('docked');
      expect(covered()).toBe('false');
      click(toggle());
      expect(mode()).toBe('room');
      expect(covered()).toBe('true');
      click(toggle());
      expect(covered()).toBe('false');

      setWindowWidth(1200);
      expect(mode()).toBe('overlay');
      expect(covered()).toBe('false');

      setWindowWidth(600);
      expect(mode()).toBe('sheet');
      expect(covered()).toBe('true');
      // Minimised to the bubble, the page is in sight again.
      act(() => { updateAvatarPanelPrefs({ minimized: true }); });
      expect(bubble()).not.toBeNull();
      expect(covered()).toBe('false');
      act(() => { updateAvatarPanelPrefs({ minimized: false }); });
      expect(covered()).toBe('true');

      // The dock goes away (switched off, crashed): nothing covers the page.
      act(() => { root!.render(<Probe />); });
      expect(covered()).toBe('false');
    });

    test('a key pressed in the middle of IME composition does not flip the room', () => {
      start();
      render();
      pressRoomShortcut({ isComposing: true });
      expect(mode()).toBe('docked');
      pressRoomShortcut();
      expect(mode()).toBe('room');
      pressRoomShortcut({ isComposing: true });
      expect(mode()).toBe('room');
    });

    test('Alt+L alone (Quick launch) and Alt+Shift+M (Talk) do not touch the room', () => {
      start();
      render();
      const quickLaunch = key({ key: 'l', code: 'KeyL', altKey: true });
      key({ key: 'M', code: 'KeyM', altKey: true, shiftKey: true });
      expect(mode()).toBe('docked');
      expect(quickLaunch.defaultPrevented).toBe(false);
    });

    test('while a dialog blocks the dashboard’s shortcuts the room shortcut does nothing, and without a binding there is none', () => {
      start();
      render({ shortcutsBlocked: true });
      const blocked = pressRoomShortcut();
      expect(mode()).toBe('docked');
      expect(blocked.defaultPrevented).toBe(false);

      act(() => { root!.render(<AvatarDock attentionCount={0} />); });
      pressRoomShortcut();
      expect(mode()).toBe('docked');
      // No shortcut to mention in the button's tooltip either.
      expect(toggle()!.title).toBe('Give Lucy the whole window');
    });

    test('Escape does not leave the room: it already deselects the task in the dashboard', () => {
      start({}, true);
      render();
      expect(mode()).toBe('room');
      key({ key: 'Escape' });
      expect(mode()).toBe('room');
      expect(getAvatarRoom()).toBe(true);
    });

    test('entering and leaving are recorded as expand and collapse, once each', () => {
      start();
      render();
      click(toggle());
      click(toggle());
      expect(panelActions()).toEqual(['expand', 'collapse']);
    });
  });

  describe('remembered for this browser tab only', () => {
    test('the room is kept in sessionStorage, not in the shared preferences, and a reload comes back to it', () => {
      start();
      render();
      click(toggle());
      expect(sessionStorage.getItem(AVATAR_ROOM_KEY)).toBe('1');
      // Nothing about the room is written where the other tabs would read it.
      expect(savedPrefs()).toEqual({ enabled: true, minimized: false });

      reload();
      expect(mode()).toBe('room');

      click(toggle());
      expect(sessionStorage.getItem(AVATAR_ROOM_KEY)).toBeNull();
      reload();
      expect(mode()).toBe('docked');
    });

    test('a page that loads in the room, or never enters it, does not play the switch animation; a switch does', () => {
      start({}, true);
      render();
      expect(dock()!.hasAttribute('data-room-switch')).toBe(false);
      click(toggle());
      expect(dock()!.getAttribute('data-room-switch')).toBe('leave');
      click(toggle());
      expect(dock()!.getAttribute('data-room-switch')).toBe('enter');

      reload();
      expect(mode()).toBe('room');
      expect(dock()!.hasAttribute('data-room-switch')).toBe(false);
    });

    test('after a visit to the room, minimising and opening her again is not a switch: nothing plays', () => {
      start();
      render();
      click(toggle());
      click(toggle());
      expect(dock()!.getAttribute('data-room-switch')).toBe('leave');
      click(container.querySelector('button[aria-label="Minimise Lucy"]'));
      click(bubble());
      expect(mode()).toBe('docked');
      expect(dock()!.hasAttribute('data-room-switch')).toBe(false);
      // From the bubble into the room by the shortcut is a switch, and the way back to the bubble ends it.
      click(container.querySelector('button[aria-label="Minimise Lucy"]'));
      pressRoomShortcut();
      expect(dock()!.getAttribute('data-room-switch')).toBe('enter');
      pressRoomShortcut();
      click(bubble());
      expect(dock()!.hasAttribute('data-room-switch')).toBe(false);
    });
  });

  describe('the page under the room', () => {
    test('the column tells the page how much room it takes; the room takes none, and leaving gives the column its room back', () => {
      start({ width: 500 });
      render();
      expect(rootWidth()).toBe('500px');
      click(toggle());
      expect(rootWidth()).toBe('');
      click(toggle());
      expect(rootWidth()).toBe('500px');
    });

    test('a page loaded straight into the room never sets it, in a wide window or a narrow one', () => {
      start({}, true);
      render();
      expect(rootWidth()).toBe('');
      setWindowWidth(1000);
      expect(mode()).toBe('room');
      expect(rootWidth()).toBe('');
      setWindowWidth(600);
      expect(mode()).toBe('room');
      expect(rootWidth()).toBe('');
    });

    test('unmounting in the room leaves nothing behind on the page', () => {
      start();
      render();
      click(toggle());
      act(() => root!.unmount());
      root = null;
      expect(rootWidth()).toBe('');
    });
  });

  describe('what the switch must not disturb', () => {
    test('the 3D view is the same element and is never rebuilt', () => {
      start();
      render();
      const view = container.querySelector('.avatar-dock-view');
      expect(stages).toHaveLength(1);
      click(toggle());
      click(toggle());
      click(toggle());
      expect(container.querySelector('.avatar-dock-view')).toBe(view);
      expect(stages).toHaveLength(1);
      expect(stages[0].dispose).not.toHaveBeenCalled();
    });

    test('a half-typed message stays in the same text box, and the conversation keeps its scroller', () => {
      start();
      render();
      const box = composer()!;
      const thread = q('avatar-thread');
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'investigate why the');
        box.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(box.value).toBe('investigate why the');

      click(toggle());
      expect(composer()).toBe(box);
      expect(box.value).toBe('investigate why the');
      expect(q('avatar-thread')).toBe(thread);
      // Roomier here: it starts at two lines.
      expect(box.getAttribute('rows')).toBe('2');

      click(toggle());
      expect(composer()).toBe(box);
      expect(box.value).toBe('investigate why the');
      expect(box.getAttribute('rows')).toBe('1');
    });

    test('the briefing is asked for once when she is first shown, and not again by entering or leaving the room', async () => {
      const fetcher = vi.fn(async (_input: RequestInfo | URL) => new Response('{}', { status: 404 }));
      vi.stubGlobal('fetch', fetcher);
      __resetLucyBriefingForTests();
      const briefingRequests = () => fetcher.mock.calls.filter(([input]) => String(input).includes('briefing')).length;
      try {
        start();
        render();
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
        // The server said no (404), so nothing counts as offered yet: a re-run of the "shown" effect would ask again.
        expect(briefingRequests()).toBe(1);
        click(toggle());
        click(toggle());
        pressRoomShortcut();
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
        expect(mode()).toBe('room');
        expect(briefingRequests()).toBe(1);
      } finally {
        vi.unstubAllGlobals();
        __resetLucyBriefingForTests();
      }
    });

    test('the one live region is the same element in the column, in the room and as the bubble, and stays last', () => {
      start();
      render();
      const announcer = q('avatar-live-announce')!;
      expect(container.lastElementChild).toBe(announcer);

      click(toggle());
      expect(q('avatar-live-announce')).toBe(announcer);
      expect(container.lastElementChild).toBe(announcer);
      expect(all('avatar-live-announce')).toHaveLength(1);

      click(toggle());
      click(container.querySelector('button[aria-label="Minimise Lucy"]'));
      expect(bubble()).not.toBeNull();
      expect(q('avatar-live-announce')).toBe(announcer);

      // From the bubble straight into the room, by the shortcut.
      pressRoomShortcut();
      expect(mode()).toBe('room');
      expect(q('avatar-live-announce')).toBe(announcer);
      expect(container.lastElementChild).toBe(announcer);
    });

    test('what the live region last announced is still in it, in the same element, after the switch', () => {
      start();
      render();
      act(() => { handleOperatorAsks([ask('a')], 'a', NOW); });
      const notice = q('avatar-ask-announce')!;
      expect(notice.textContent).toBe('New question from Task a.');
      click(toggle());
      // Not announced a second time: nothing was removed and added again.
      expect(q('avatar-ask-announce')).toBe(notice);
      expect(notice.textContent).toBe('New question from Task a.');
    });
  });

  describe('keyboard focus', () => {
    test('entering puts focus in the text box; leaving by the button keeps it on that button', () => {
      start();
      render();
      const button = toggle()!;
      button.focus();
      click(button);
      expect(document.activeElement).toBe(composer());

      button.focus();
      click(button);
      expect(mode()).toBe('docked');
      expect(document.activeElement).toBe(button);
    });

    test('leaving by the shortcut from somewhere else in the room lands on Expand', () => {
      start();
      render();
      pressRoomShortcut();
      expect(document.activeElement).toBe(composer());
      q('avatar-thread')!.focus();
      pressRoomShortcut();
      expect(mode()).toBe('docked');
      expect(document.activeElement).toBe(toggle());
    });

    test('leaving by the shortcut in the middle of typing leaves focus in the text box', () => {
      start();
      render();
      pressRoomShortcut();
      expect(document.activeElement).toBe(composer());
      pressRoomShortcut();
      expect(mode()).toBe('docked');
      expect(document.activeElement).toBe(composer());
    });

    test('leaving the room in a window where she is a full-width sheet (no Expand button) puts focus on Minimise, not on the page', () => {
      start();
      render();
      click(toggle());
      expect(mode()).toBe('room');
      toggle()!.focus();
      setWindowWidth(700);
      expect(mode()).toBe('room');
      click(toggle());
      expect(mode()).toBe('sheet');
      expect(toggle()).toBeNull();
      expect(document.activeElement).toBe(container.querySelector('button[aria-label="Minimise Lucy"]'));
    });

    test('leaving the room by the shortcut with a dialog open keeps focus in the dialog, and so does entering', () => {
      start();
      render();
      const overlay = document.createElement('div');
      overlay.className = 'dialog-overlay';
      const input = document.createElement('input');
      overlay.appendChild(input);
      document.body.appendChild(overlay);
      input.focus();
      pressRoomShortcut();
      expect(mode()).toBe('room');
      expect(document.activeElement).toBe(input);
      pressRoomShortcut();
      expect(mode()).toBe('docked');
      expect(document.activeElement).toBe(input);
    });

    test('a page that loads in the room starts with focus in the text box', () => {
      start({}, true);
      render();
      expect(document.activeElement).toBe(composer());
    });

    test('with the operator feature off there is no text box, so focus goes to the room itself', async () => {
      start();
      render();
      // The server answers 404 to a typed turn when the feature is off; the composer then removes its box for good.
      await act(async () => {
        sendLucyTypedText('hello', { fetcher: async () => new Response('{}', { status: 404 }) });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(composer()).toBeNull();
      click(toggle());
      expect(mode()).toBe('room');
      expect(document.activeElement).toBe(dock());
    });
  });

  describe('while she is minimised', () => {
    test('the shortcut opens her in the room without touching the shared "minimised" choice, and again puts the bubble back with focus on it', () => {
      start({ minimized: true });
      render();
      expect(bubble()).not.toBeNull();
      expect(stages).toHaveLength(0);

      pressRoomShortcut();
      expect(mode()).toBe('room');
      expect(bubble()).toBeNull();
      // The 3D view is built for the room, as it is when the bubble is opened.
      expect(stages).toHaveLength(1);
      expect(document.activeElement).toBe(composer());
      // Other tabs keep their bubble: the saved choice is unchanged.
      expect(savedPrefs().minimized).toBe(true);

      pressRoomShortcut();
      expect(dock()).toBeNull();
      expect(bubble()).not.toBeNull();
      expect(document.activeElement).toBe(bubble());
      expect(stages[0].dispose).toHaveBeenCalledTimes(1);
      expect(rootWidth()).toBe('');
    });

    test('a tab in the room stays open when another tab minimises her', () => {
      start({}, true);
      render();
      expect(mode()).toBe('room');
      act(() => {
        localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify({ enabled: true, minimized: true }));
        window.dispatchEvent(new StorageEvent('storage', { key: AVATAR_PANEL_KEY, newValue: localStorage.getItem(AVATAR_PANEL_KEY) }));
      });
      expect(mode()).toBe('room');
      expect(bubble()).toBeNull();
      expect(stages).toHaveLength(1);
      expect(stages[0].dispose).not.toHaveBeenCalled();
    });
  });

  describe('the header in the room', () => {
    test('Talk moves up beside Replay and leaves the composer; back in the column it sits beside the text box again', () => {
      live.available = true;
      start();
      render();
      const header = () => container.querySelector('.avatar-dock-header')!;
      const composerBox = () => q('avatar-composer')!;
      expect(composerBox().contains(q('avatar-talk'))).toBe(true);
      expect(header().contains(q('avatar-talk'))).toBe(false);

      click(toggle());
      expect(all('avatar-talk')).toHaveLength(1);
      expect(header().contains(q('avatar-talk'))).toBe(true);
      expect(composerBox().contains(q('avatar-talk'))).toBe(false);
      expect(headerButtons()).toEqual(['Talk to Lucy hands-free', 'Replay last message', 'Back to dashboard']);
      // Her name and what she is doing stay on the left.
      expect(header().firstElementChild!.textContent).toBe('LUCY');
      expect(q('avatar-state-label')!.textContent).toBe('ready');

      click(toggle());
      expect(composerBox().contains(q('avatar-talk'))).toBe(true);
      expect(header().contains(q('avatar-talk'))).toBe(false);
    });
  });

  describe('the side rail: what waits on you', () => {
    const waitingCards = () => all('avatar-ask').filter((card) => card.dataset.askState === 'pending');

    test('permission cards first, then every question a task waits for as an open card, then the opinions folded under one line', () => {
      start({}, true);
      render();
      pushAsks([
        ask('late', { expiresAt: NOW + 20 * MIN }),
        ask('soon', { expiresAt: NOW + 5 * MIN }),
        ask('op1', { taskEnded: true }),
        ask('op2', { taskEnded: true }),
      ]);
      pushPermissions([permission()]);

      const tray = q('avatar-tray')!;
      expect(tray.classList.contains('avatar-tray-rail')).toBe(true);
      // A title, not a button: the rail cannot be folded.
      expect(q('avatar-tray-toggle')).toBeNull();
      expect(q('avatar-tray-title')!.querySelector('h2')!.textContent).toBe('Waiting on you');
      // The number is what is shown; "waiting" is added for a screen reader only.
      expect(q('avatar-tray-count')!.textContent).toBe('3 waiting');
      expect(q('avatar-tray-count')!.querySelector('.sr-only')!.textContent).toBe(' waiting');

      // More than one card open at once, the one that closes soonest first, with their answers on screen.
      expect(waitingCards().map((card) => card.dataset.askId)).toEqual(['soon', 'late']);
      expect(all('avatar-ask-option').map((option) => option.textContent)).toEqual(['Yes', 'No', 'Yes', 'No']);
      // An always-open card has no line to fold back to.
      expect(q('avatar-ask-collapse')).toBeNull();
      expect(all('avatar-ask-row')).toHaveLength(0);

      // In the order on screen: permissions, questions, opinions.
      const order = [...tray.querySelectorAll('[data-testid="avatar-permission"], [data-testid="avatar-ask"], [data-testid="avatar-opinions"]')].map((el) => el.getAttribute('data-testid'));
      expect(order).toEqual(['avatar-permission', 'avatar-ask', 'avatar-ask', 'avatar-opinions']);

      // The opinions: one line, folded; unfolding shows a line each, and pressing one opens its card.
      const opinions = q('avatar-opinions-toggle')!;
      expect(opinions.getAttribute('aria-expanded')).toBe('false');
      expect(opinions.textContent).toContain('2 opinions wanted by finished tasks');
      click(opinions);
      expect(all('avatar-ask-row')).toHaveLength(2);
      clickCard(container.querySelector('[data-ask-id="op1"] [data-testid="avatar-ask-row"]'));
      expect(waitingCards().map((card) => card.dataset.askId)).toEqual(['soon', 'late', 'op1']);
      expect(q('avatar-ask-collapse')).not.toBeNull();
    });

    test('when nothing waits it says so in one quiet line and stays in place', () => {
      start({}, true);
      render();
      const tray = q('avatar-tray')!;
      expect(tray.classList.contains('avatar-tray-rail')).toBe(true);
      expect(q('avatar-tray-empty')!.textContent).toBe('Nothing is waiting on you.');
      expect(q('avatar-tray-count')).toBeNull();

      pushAsks([ask('a')]);
      expect(q('avatar-tray-empty')).toBeNull();
      expect(q('avatar-tray')).toBe(tray);
      expect(q('avatar-tray-count')!.textContent).toBe('1 waiting');

      // Opinion requests block nothing: with only those left, nothing is waiting, and they are still offered.
      pushAsks([ask('op1', { taskEnded: true })]);
      expect(q('avatar-tray-empty')!.textContent).toBe('Nothing is waiting on you.');
      expect(q('avatar-tray-count')).toBeNull();
      expect(q('avatar-opinions-toggle')!.textContent).toContain('1 opinion wanted by finished task');

      // Back in the column with nothing waiting, the strip is not shown at all, as before.
      pushAsks([]);
      click(toggle());
      expect(q('avatar-tray')).toBeNull();
    });

    test('an answer typed into a card survives the switch to the column and back', () => {
      start({}, true);
      render();
      pushAsks([ask('a')]);
      const input = q<HTMLInputElement>('avatar-ask-input')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'tonight, after the');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      click(toggle());
      // The column's strip is unfolded while a question waits, and the soonest question is open in it with the text kept.
      expect(q<HTMLInputElement>('avatar-ask-input')!.value).toBe('tonight, after the');
      click(toggle());
      expect(q<HTMLInputElement>('avatar-ask-input')!.value).toBe('tonight, after the');
    });

    test('the rail leaves the strip’s own fold alone: it never saves a fold, and the column\'s strip is back after it', () => {
      start();
      render();
      pushAsks([ask('a'), ask('b')]);
      // In the column a waiting question unfolds the strip by itself: the soonest is whole, the other one line.
      expect(q('avatar-tray-toggle')!.getAttribute('aria-expanded')).toBe('true');
      expect(waitingCards()).toHaveLength(1);
      expect(all('avatar-ask-row')).toHaveLength(1);

      click(toggle());
      expect(waitingCards()).toHaveLength(2);
      expect(sessionStorage.getItem(AVATAR_TRAY_EXPANDED_KEY)).toBeNull();

      click(toggle());
      // Back in the column, with the saved fold (nothing) never changed.
      expect(sessionStorage.getItem(AVATAR_TRAY_EXPANDED_KEY)).toBeNull();
      expect(waitingCards()).toHaveLength(1);
    });

    test('an answer pressed in the moment after the switch is ignored, like any press after the cards move', () => {
      const onAnswerAsk = vi.fn(() => true);
      start();
      render({ onAnswerAsk });
      pushAsks([ask('a')]);
      act(() => { vi.setSystemTime(Date.now() + 5_000); });
      click(toggle());
      click(q('avatar-ask-option'));
      expect(onAnswerAsk).not.toHaveBeenCalled();
      clickCard(q('avatar-ask-option'));
      expect(onAnswerAsk).toHaveBeenCalledWith('a', { optionIndex: 0 });
    });

    test('below 1100 px the room is one column: the strip sits above the conversation, exactly as in the column', () => {
      start({}, true);
      setWindowWidth(1000);
      render();
      expect(mode()).toBe('room');
      expect(dock()!.getAttribute('data-room-rail')).toBe('false');
      // Nothing waits: no strip.
      expect(q('avatar-tray')).toBeNull();

      pushAsks([ask('a'), ask('b')]);
      expect(q('avatar-tray')!.classList.contains('avatar-tray-rail')).toBe(false);
      expect(q('avatar-tray-toggle')!.getAttribute('aria-expanded')).toBe('true');
      expect(waitingCards()).toHaveLength(1);
      expect(all('avatar-ask-row')).toHaveLength(1);
      // The same header as the wide room.
      expect(headerButtons()).toEqual(['Replay last message', 'Back to dashboard']);

      // Widening the window brings the rail, with its cards open; narrowing folds them away again.
      setWindowWidth(1100);
      expect(dock()!.getAttribute('data-room-rail')).toBe('true');
      expect(waitingCards()).toHaveLength(2);
      setWindowWidth(1099);
      expect(dock()!.getAttribute('data-room-rail')).toBe('false');
      expect(waitingCards()).toHaveLength(1);
    });
  });

  describe('"Open task" leaves the room, so the task is on screen beside her', () => {
    test('on a question card: the task is selected and she is the column again', () => {
      const onOpenTask = vi.fn(() => true);
      start({}, true);
      render({ onOpenTask });
      pushAsks([ask('a')]);
      clickCard(q('avatar-ask-open-task'));
      expect(onOpenTask).toHaveBeenCalledWith('task-a');
      expect(mode()).toBe('docked');
      expect(getAvatarRoom()).toBe(false);
      expect(sessionStorage.getItem(AVATAR_ROOM_KEY)).toBeNull();
      expect(rootWidth()).toBe('380px');
      expect(panelActions()).toEqual(['collapse']);
    });

    test('a task that cannot be shown keeps her in the room, and the card says why', () => {
      const onOpenTask = vi.fn(() => false);
      start({}, true);
      render({ onOpenTask });
      pushAsks([ask('a')]);
      clickCard(q('avatar-ask-open-task'));
      expect(onOpenTask).toHaveBeenCalledWith('task-a');
      expect(mode()).toBe('room');
      expect(q('avatar-ask-note')!.textContent).toBe('This task is not shown in the dashboard right now.');
    });

    test('on a permission card', () => {
      const onOpenTask = vi.fn(() => true);
      start({}, true);
      render({ onOpenTask });
      pushPermissions([permission()]);
      clickCard(q('avatar-permission-open-task'));
      expect(onOpenTask).toHaveBeenCalledWith('task-perm');
      expect(mode()).toBe('docked');
    });

    test('on a report in the conversation, which selects the task without going through the dock', () => {
      const selectAgent = vi.fn();
      useKookrStore.setState({ agents: [{ agentId: 'ag1', taskId: 't9' } as never], selectAgent } as never);
      start({}, true);
      render();
      act(() => { appendConversationEntry({ kind: 'lucy', text: 'The investigation finished.', taskId: 't9' }); });
      click(q('avatar-launch-report-open'));
      expect(selectAgent).toHaveBeenCalledWith('ag1', 't9');
      expect(mode()).toBe('docked');
    });

    test('a report about a task the dashboard no longer shows selects nothing and keeps her in the room', () => {
      const selectAgent = vi.fn();
      useKookrStore.setState({ agents: [], selectAgent } as never);
      start({}, true);
      render();
      act(() => { appendConversationEntry({ kind: 'lucy', text: 'The investigation finished.', taskId: 'gone' }); });
      click(q('avatar-launch-report-open'));
      expect(selectAgent).not.toHaveBeenCalled();
      expect(mode()).toBe('room');
    });

    test('entered from the bubble, she comes back as the column, not as the bubble: the task is beside her', () => {
      const onOpenTask = vi.fn(() => true);
      start({ minimized: true }, true);
      render({ onOpenTask });
      expect(mode()).toBe('room');
      pushAsks([ask('a')]);
      clickCard(q('avatar-ask-open-task'));
      expect(mode()).toBe('docked');
      expect(bubble()).toBeNull();
      expect(savedPrefs().minimized).toBe(false);
      // The 3D view was open in the room and stays open in the column.
      expect(stages).toHaveLength(1);
      expect(stages[0].dispose).not.toHaveBeenCalled();
    });

    test('outside the room "Open task" changes nothing about her layout', () => {
      const onOpenTask = vi.fn(() => true);
      sessionStorage.setItem(AVATAR_TRAY_EXPANDED_KEY, '1');
      start();
      render({ onOpenTask });
      pushAsks([ask('a')]);
      // The one question is open whole already: no row to press.
      clickCard(q('avatar-ask-open-task'));
      expect(onOpenTask).toHaveBeenCalledWith('task-a');
      expect(mode()).toBe('docked');
      expect(panelActions()).toEqual([]);
    });
  });

  test('someone who never enters the room gets the column exactly as before, with one more button', () => {
    start();
    render();
    expect(dock()!.className).toBe('avatar-dock avatar-dock-idle');
    expect(dock()!.getAttribute('data-column-mode')).toBe('docked');
    expect(dock()!.hasAttribute('data-room-rail')).toBe(false);
    expect(dock()!.hasAttribute('data-room-switch')).toBe(false);
    expect(dock()!.style.width).toBe('380px');
    expect(composer()!.getAttribute('rows')).toBe('1');
    expect(panelActions()).toEqual([]);
    expect(sessionStorage.getItem(AVATAR_ROOM_KEY)).toBeNull();
  });

  describe('the conversation as a centred reading column', () => {
    const centred = () => dock()!.classList.contains('avatar-dock-centred');
    const railWidth = () => dock()!.style.getPropertyValue('--lucy-rail-width');

    test('the room tells the stylesheet how wide its rail is, and that the conversation is centred beside it', () => {
      start({}, true);
      render();
      expect(railWidth()).toBe('461px');
      expect(centred()).toBe(true);
      setWindowWidth(2560);
      expect(railWidth()).toBe('520px');
      setWindowWidth(1440);
      expect(railWidth()).toBe('400px');
      expect(centred()).toBe(true);
      // Just wide enough for the rail: the conversation fills what is left, and is not treated as centred.
      setWindowWidth(1100);
      expect(railWidth()).toBe('400px');
      expect(centred()).toBe(false);
      // No rail: nothing to say about its width, and the whole window is the conversation's.
      setWindowWidth(1000);
      expect(railWidth()).toBe('');
      expect(centred()).toBe(true);
    });

    test('the docked column is centred only once it is dragged clearly wider than the reading width', () => {
      start({ width: 839 });
      render();
      expect(centred()).toBe(false);
      act(() => { q('avatar-column-resizer')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })); });
      expect(dock()!.style.width).toBe('855px');
      expect(centred()).toBe(true);
      // Back in the column the rail's width is not left behind.
      click(toggle());
      expect(railWidth()).toBe('461px');
      click(toggle());
      expect(railWidth()).toBe('');
      expect(dock()!.style.width).toBe('855px');
    });
  });

  test('the room can be entered from outside the dock (the address), and the dock follows', () => {
    start();
    render();
    act(() => { setAvatarRoom(true); });
    expect(mode()).toBe('room');
    expect(document.activeElement).toBe(composer());
  });

  describe('a dialog of the dashboard, and focus left under her (#4166)', () => {
    /** A control of the dashboard under her, outside the dock (in App it sits in the wrapper that goes inert). */
    const pageButton = (): HTMLButtonElement => {
      const button = document.createElement('button');
      button.textContent = 'Share task';
      document.body.appendChild(button);
      return button;
    };
    /** A dialog over the page, as a dashboard component or App renders one. */
    /** App re-rendering the same dock with new props (`render` mounts a new one). */
    const rerender = (props: Partial<AvatarDockProps>): void => {
      act(() => { root!.render(<AvatarDock attentionCount={0} roomShortcut={ROOM_SHORTCUT} {...props} />); });
    };
    const dialogButton = (): HTMLButtonElement => {
      const overlay = document.createElement('div');
      overlay.className = 'dialog-overlay';
      const button = document.createElement('button');
      button.textContent = 'Copy link';
      overlay.appendChild(button);
      document.body.appendChild(overlay);
      return button;
    };

    test('the room is not entered while a dashboard component has a dialog open, and is left whatever is open', () => {
      start();
      let dialogOpen = true;
      render({ dashboardDialogOpen: () => dialogOpen });
      const field = dialogButton();
      act(() => { field.focus(); });

      pressRoomShortcut();
      expect(mode()).toBe('docked');
      expect(getAvatarRoom()).toBe(false);
      click(toggle());
      expect(mode()).toBe('docked');
      // The dialog keeps the keyboard.
      expect(document.activeElement).toBe(field);

      dialogOpen = false;
      pressRoomShortcut();
      expect(mode()).toBe('room');
      // Leaving is never refused.
      dialogOpen = true;
      pressRoomShortcut();
      expect(mode()).toBe('docked');
    });

    test('a resize that brings up the open sheet moves focus from the dashboard to her text box', () => {
      start();
      render();
      const share = pageButton();
      act(() => { share.focus(); });
      setWindowWidth(600);
      expect(mode()).toBe('sheet');
      expect(document.activeElement).toBe(composer());
    });

    test('the same, when the dashboard swaps its desktop panes for its mobile ones at that width and the focused one is gone', () => {
      // App renders its panes in a different tree at 768 px and narrower, in the same commit that brings up her
      // sheet: the button that had focus is unmounted before the dock looks, and focus is on the page itself.
      const Panes = (): React.ReactElement => {
        const [narrow, setNarrow] = useState(() => window.innerWidth <= 768);
        useEffect(() => {
          const onResize = (): void => setNarrow(window.innerWidth <= 768);
          window.addEventListener('resize', onResize);
          return () => window.removeEventListener('resize', onResize);
        }, []);
        const task = <button data-testid="task-card">Task</button>;
        return narrow ? <section>{task}</section> : <main>{task}</main>;
      };
      start();
      root = createRoot(container);
      act(() => { root!.render(<><Panes /><AvatarDock attentionCount={0} roomShortcut={ROOM_SHORTCUT} /></>); });
      const card = q<HTMLButtonElement>('task-card')!;
      act(() => { card.focus(); });
      setWindowWidth(600);
      expect(mode()).toBe('sheet');
      expect(card.isConnected).toBe(false);
      expect(document.activeElement).toBe(composer());
    });

    test('the sheet takes no focus that was nowhere (a phone opening the page) or in a dialog', () => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
      start();
      render();
      expect(mode()).toBe('sheet');
      expect(document.activeElement).toBe(document.body);
      act(() => root?.unmount());

      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1920 });
      render();
      const field = dialogButton();
      act(() => { field.focus(); });
      setWindowWidth(600);
      expect(mode()).toBe('sheet');
      expect(document.activeElement).toBe(field);
    });

    test('reopened as the sheet from the bubble, focus goes to the minimise button as before, not the text box', () => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
      start({ minimized: true });
      render();
      click(bubble());
      expect(mode()).toBe('sheet');
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Minimise Lucy');
    });

    test('when the last dialog closes while she covers the page and focus went back under her, she takes it', () => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
      start();
      render({ dialogOpen: true });
      expect(mode()).toBe('sheet');
      // Diagnostics, opened from the top bar, sends focus back to its trigger: in the inert dashboard.
      const trigger = pageButton();
      act(() => { trigger.focus(); });
      rerender({ dialogOpen: false });
      expect(document.activeElement).toBe(composer());

      // Focus dropped to the page: the same.
      rerender({ dialogOpen: true });
      act(() => { (document.activeElement as HTMLElement).blur(); });
      expect(document.activeElement).toBe(document.body);
      rerender({ dialogOpen: false });
      expect(document.activeElement).toBe(composer());
    });

    test('a dialog closing leaves focus alone when it is in the dock, in another dialog, or when she does not cover the page', () => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
      start();
      render({ dialogOpen: true });
      const minimise = container.querySelector<HTMLButtonElement>('[aria-label="Minimise Lucy"]')!;
      act(() => { minimise.focus(); });
      rerender({ dialogOpen: false });
      expect(document.activeElement).toBe(minimise);

      // From the palette to Diagnostics: one dialog follows another, and the second holds focus.
      rerender({ dialogOpen: true });
      const diagnostics = dialogButton();
      act(() => { diagnostics.focus(); });
      rerender({ dialogOpen: true });
      expect(document.activeElement).toBe(diagnostics);
      // A dialog App does not count is still open and has the keyboard: it keeps it.
      rerender({ dialogOpen: false });
      expect(document.activeElement).toBe(diagnostics);
      act(() => root?.unmount());

      // Beside the page (the docked column) the dashboard is in sight: focus stays where it went back to.
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1920 });
      render({ dialogOpen: true });
      expect(mode()).toBe('docked');
      const trigger = pageButton();
      act(() => { trigger.focus(); });
      rerender({ dialogOpen: false });
      expect(document.activeElement).toBe(trigger);
    });
  });
});
