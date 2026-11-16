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
vi.mock('../lucy-live/useLucyLive.js', () => ({
  SOUND_OFF_REASON: 'Sound is off in Settings',
  useLucyLive: () => ({
    status: 'off', lucyState: 'idle', operatorText: '', operatorFinal: false, lucyText: '', lastTurnEnd: null,
    timings: { endToFirstAudioMs: null, bargeInStopMs: null }, micLevel: 0, errorMessage: null,
    enabled: false, setEnabled: vi.fn(), unavailableReason: null, serverStatus: { available: false },
  }),
}));
const speech = vi.hoisted(() => ({
  announceAsk: vi.fn(async () => 'started'),
  stopAskAnnouncement: vi.fn(),
  stopAllAskAnnouncements: vi.fn(),
  announceLaunchReport: vi.fn(async () => 'started'),
  announcePermissionNotice: vi.fn(async () => 'started'),
  stopPermissionNotice: vi.fn(),
}));
vi.mock('../audio/ask-announcement.js', () => speech);

import { AvatarDock } from './AvatarDock.js';
import { EXPIRED_TEXT, NO_BUTTONS_TEXT, SENT_TEXT } from './LucyPermissionCard.js';
import { __resetLucyTypedForTests } from './LucyTypedInput.js';
import { __resetLastClipForTests } from '../audio/last-clip.js';
import { __resetSoundPreferenceForTests } from '../audio/sound-preference.js';
import { __resetSpeechBusForTests } from '../audio/speech-bus.js';
import { AVATAR_PANEL_KEY, __resetAvatarPanelPrefsForTests } from '../store/avatar-panel-prefs.js';
import { __resetLucyLaunchForTests } from '../store/lucy-launch.js';
import { __resetLucyPermissionForTests, buildPermissionChoice, handleLucyPermissionCards } from '../store/lucy-permission.js';
import type { LucyPermissionAnnouncement, LucyPermissionCardView } from '../../shared/contracts/lucy-permission.js';

const COMMAND = 'git push --force-with-lease origin feat-issue-3932 &&\n  gh pr create --fill --base staging';

function card(over: Partial<LucyPermissionCardView> = {}): LucyPermissionCardView {
  const since = Date.now() - 60_000;
  return {
    promptId: 'req-aaaa', taskId: 't1', agentId: 'kookr-t1', taskName: 'Fix the login page', toolName: 'Bash',
    command: COMMAND, since,
    permissionRequest: { requestId: 'req-aaaa', toolName: 'Bash', toolInputHash: 'h', detectedAt: new Date(since).toISOString(), ttlMs: 5 * 60_000 },
    approveKey: '1', denyKey: '3',
    ...over,
  };
}

describe('AvatarDock: permission cards (issue #3932)', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const choice = vi.fn((_msg: unknown) => true);
  const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const all = (id: string) => [...container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
  const push = (cards: LucyPermissionCardView[], announce?: LucyPermissionAnnouncement) =>
    act(async () => { handleLucyPermissionCards({ type: 'lucyPermissionCards', cards, ...(announce ? { announce } : {}) }); });

  function mount() {
    localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify({ enabled: true, minimized: false, position: null }));
    __resetAvatarPanelPrefsForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => { root!.render(<AvatarDock attentionCount={1} onPermissionChoice={choice} />); });
  }

  beforeEach(() => {
    localStorage.clear();
    choice.mockClear();
    for (const fn of Object.values(speech)) fn.mockClear();
    __resetLastClipForTests(); __resetSoundPreferenceForTests(); __resetSpeechBusForTests();
    __resetLucyLaunchForTests(); __resetLucyTypedForTests(); __resetLucyPermissionForTests();
  });
  afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    container?.remove();
    vi.useRealTimers();
  });

  test('a card shows the task, the tool and the whole command; she says it once', async () => {
    mount();
    await push([card()], { noticeId: 'perm-1', promptIds: ['req-aaaa'] });
    expect(q('avatar-permission-command')!.textContent).toBe(COMMAND);
    expect(q('avatar-permission-ask')!.textContent).toBe('Waiting for your permission to use Bash');
    expect(q('avatar-permission')!.textContent).toContain('Fix the login page');
    expect(speech.announcePermissionNotice).toHaveBeenCalledTimes(1);
    expect(speech.announcePermissionNotice).toHaveBeenCalledWith('perm-1');
    // The same list again (a reconnect, another card changing): nothing more is said.
    await push([card()]);
    expect(speech.announcePermissionNotice).toHaveBeenCalledTimes(1);
  });

  test('three cards are three cards; a grouped sentence is one announcement', async () => {
    mount();
    await push([card(), card({ promptId: 'req-b', taskId: 't2', agentId: 'kookr-t2' }), card({ promptId: 'req-c', taskId: 't3', agentId: 'kookr-t3' })],
      { noticeId: 'perm-group', promptIds: ['req-b', 'req-c'] });
    expect(all('avatar-permission')).toHaveLength(3);
    expect(speech.announcePermissionNotice).toHaveBeenCalledTimes(1);
  });

  test('Approve once sends the finding card\'s permissionChoice message, once', async () => {
    mount();
    const shown = card();
    await push([shown]);
    await act(async () => { q('avatar-permission-approve')!.click(); });
    expect(choice).toHaveBeenCalledTimes(1);
    expect(choice.mock.calls[0]![0]).toEqual({
      type: 'permissionChoice', agentId: 'kookr-t1', keystroke: '1', permissionRequest: shown.permissionRequest,
    });
    expect(q('avatar-permission-note')!.textContent).toBe(SENT_TEXT);
    await act(async () => { q('avatar-permission-approve')!.click(); });
    await act(async () => { q('avatar-permission-deny')!.click(); });
    expect(choice).toHaveBeenCalledTimes(1);
  });

  test('Deny sends the No option\'s key', async () => {
    mount();
    await push([card()]);
    await act(async () => { q('avatar-permission-deny')!.click(); });
    expect(choice.mock.calls[0]![0]).toMatchObject({ keystroke: '3' });
  });

  test('the card goes when the prompt is answered anywhere, and she stops', async () => {
    mount();
    await push([card()], { noticeId: 'perm-1', promptIds: ['req-aaaa'] });
    await push([]);
    expect(q('avatar-permission')).toBeNull();
    expect(speech.stopPermissionNotice).toHaveBeenCalledWith('perm-1');
  });

  test('a grouped sentence is stopped only when none of its prompts is left', async () => {
    mount();
    const b = card({ promptId: 'req-b', taskId: 't2' });
    const c = card({ promptId: 'req-c', taskId: 't3' });
    await push([b, c], { noticeId: 'perm-group', promptIds: ['req-b', 'req-c'] });
    await push([c]);
    expect(speech.stopPermissionNotice).not.toHaveBeenCalled();
    await push([]);
    expect(speech.stopPermissionNotice).toHaveBeenCalledWith('perm-group');
  });

  test('a stale prompt sends nothing: a card no longer on the list, or past the binding time limit', async () => {
    mount();
    const stale = card();
    await push([card({ promptId: 'req-other' })]);
    expect(buildPermissionChoice(stale, 'approve', Date.now())).toBeNull();

    const old = Date.now() - 6 * 60_000;
    await push([card({ since: old, permissionRequest: { ...card().permissionRequest!, detectedAt: new Date(old).toISOString() } })]);
    expect(q('avatar-permission-approve')).toBeNull();
    expect(q('avatar-permission-deny')).toBeNull();
    expect(q('avatar-permission-note')!.textContent).toBe(EXPIRED_TEXT);
  });

  test('the button time limit follows the server clock, not a browser clock that is ahead', async () => {
    mount();
    // The browser clock is 4 minutes ahead of the server's: the card, 1 minute old by the server, keeps its buttons.
    const serverNow = Date.now() - 4 * 60_000;
    const since = serverNow - 60_000;
    const shown = card({ since, permissionRequest: { ...card().permissionRequest!, detectedAt: new Date(since).toISOString() } });
    await act(async () => { handleLucyPermissionCards({ type: 'lucyPermissionCards', cards: [shown], serverNow }); });
    expect(q('avatar-permission-approve')).not.toBeNull();
  });

  test('a prompt no button can be bound to gets no buttons and says where to answer', async () => {
    mount();
    const { permissionRequest: _binding, approveKey: _a, denyKey: _d, ...bare } = card({ promptId: 'pane:t1:1' });
    await push([bare]);
    expect(q('avatar-permission-approve')).toBeNull();
    expect(q('avatar-permission-note')!.textContent).toBe(NO_BUTTONS_TEXT);
  });

  test('a missing Deny option shows Approve once alone', async () => {
    mount();
    const { denyKey: _d, ...noDeny } = card();
    await push([noDeny]);
    expect(q('avatar-permission-approve')).not.toBeNull();
    expect(q('avatar-permission-deny')).toBeNull();
  });

  test('with the panel off nothing is said', async () => {
    await push([card()], { noticeId: 'perm-1', promptIds: ['req-aaaa'] });
    expect(speech.announcePermissionNotice).not.toHaveBeenCalled();
  });
});
