// @vitest-environment jsdom

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
  announceLaunchReport: vi.fn(async () => 'started'),
}));
vi.mock('../audio/ask-announcement.js', () => speech);

import { AvatarDock } from './AvatarDock.js';
import { __resetLucyTypedForTests } from './LucyTypedInput.js';
import { __resetLastClipForTests } from '../audio/last-clip.js';
import { __resetSoundPreferenceForTests } from '../audio/sound-preference.js';
import { __resetSpeechBusForTests } from '../audio/speech-bus.js';
import { AVATAR_PANEL_KEY, __resetAvatarPanelPrefsForTests } from '../store/avatar-panel-prefs.js';
import { __resetLucyLaunchForTests, handleLucyLaunch } from '../store/lucy-launch.js';
import { useKookrStore } from '../store/useStore.js';
import type { LucyLaunchProposalView } from '../../shared/contracts/lucy-launch.js';

const CONV = 'typed-abc';
function proposal(over: Partial<LucyLaunchProposalView> = {}): LucyLaunchProposalView {
  return {
    id: 'p1', kind: 'investigation', project: 'kookr',
    description: 'Find out why issue tasks stop chaining after the third task.\nReport findings only, open no pull request.',
    agentType: 'claude-code', asked: 'investigate why the issue tasks stop chaining', readBack: 'I will launch an investigation.',
    expiresAt: Date.now() + 60_000, level: 'balanced', ...over,
  };
}

describe('AvatarDock: Lucy launch card and typed input', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const flush = async () => { await act(async () => { await Promise.resolve(); }); };
  const send = (msg: Parameters<typeof handleLucyLaunch>[0]) => act(async () => { handleLucyLaunch(msg); });
  const showCard = (over: Partial<LucyLaunchProposalView> = {}) => send({ type: 'lucy_launch', conversationId: CONV, proposal: proposal(over) });
  const postBodies = () => vi.mocked(fetch).mock.calls.map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init?.body ?? 'null')) }));

  function mount() {
    localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify({ enabled: true, minimized: false, position: null }));
    __resetAvatarPanelPrefsForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => { root!.render(<AvatarDock attentionCount={0} />); });
  }

  beforeEach(() => {
    localStorage.clear();
    __resetLastClipForTests(); __resetSoundPreferenceForTests(); __resetSpeechBusForTests();
    __resetLucyLaunchForTests(); __resetLucyTypedForTests();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ outcome: 'unknown', proposalId: 'zzz' }), { status: 200 })));
  });
  afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    container?.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('shows the full description, the operator words, kind, project and level', async () => {
    mount();
    await showCard();
    expect(q('avatar-launch-description')!.textContent).toBe(proposal().description);
    expect(q('avatar-launch-asked')!.textContent).toContain('investigate why the issue tasks stop chaining');
    expect(q('avatar-launch-project')!.textContent).toBe('kookr');
    expect(q('avatar-launch-kind')!.textContent).toBe('Investigation');
    expect(q('avatar-launch-level')!.textContent).toBe('Balanced');
    expect(q('avatar-launch-go')).not.toBeNull();
  });

  test('Go posts a confirm with via click and no level', async () => {
    mount();
    await showCard();
    await act(async () => { q('avatar-launch-go')!.click(); });
    await flush();
    const calls = postBodies().filter((c) => c.url === '/api/lucy/launch/confirm');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ conversationId: CONV, proposalId: 'p1', via: 'click' });
    expect('level' in calls[0]!.body).toBe(false);
  });

  test('Enter confirms with via enter, but not while typing in a text field', async () => {
    mount();
    await showCard();
    const input = q('avatar-typed-input') as HTMLInputElement;
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    expect(postBodies().filter((c) => c.url.endsWith('/confirm'))).toHaveLength(0);

    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await flush();
    const calls = postBodies().filter((c) => c.url.endsWith('/confirm'));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ conversationId: CONV, proposalId: 'p1', via: 'enter' });
  });

  test('Enter belongs to the card even when another window listener (the dashboard\'s next-task shortcut) was added before it', async () => {
    const dashboardEnter = vi.fn();
    // Added before the card exists, in the bubble phase, like App's own handler.
    window.addEventListener('keydown', dashboardEnter);
    try {
      mount();
      await showCard();
      await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
      await flush();
      expect(postBodies().filter((c) => c.url.endsWith('/confirm'))).toHaveLength(1);
      expect(dashboardEnter).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', dashboardEnter);
    }
  });

  test('Cancel declines', async () => {
    mount();
    await showCard();
    await act(async () => { q('avatar-launch-cancel')!.click(); });
    await flush();
    expect(postBodies().filter((c) => c.url === '/api/lucy/launch/decline')[0]!.body).toEqual({ conversationId: CONV, proposalId: 'p1' });
  });

  test('a hands-off card has a countdown and only Cancel, which cancels', async () => {
    mount();
    await showCard({ level: 'hands-off', launchesAt: Date.now() + 8_000 });
    expect(q('avatar-launch-go')).toBeNull();
    expect(q('avatar-launch-countdown')!.textContent).toMatch(/Starts in [78] s/);
    // Enter does nothing on a hands-off card.
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    expect(postBodies().filter((c) => c.url.endsWith('/confirm'))).toHaveLength(0);
    await act(async () => { q('avatar-launch-cancel')!.click(); });
    await flush();
    expect(postBodies().filter((c) => c.url === '/api/lucy/launch/cancel')).toHaveLength(1);
  });

  test('an outcome clears the card and says what happened; Started links the task', async () => {
    mount();
    const selectAgent = vi.fn();
    useKookrStore.setState({ agents: [{ agentId: 'ag1', taskId: 't9' } as never], selectAgent } as never);
    await showCard();
    await send({ type: 'lucy_launch', conversationId: CONV, outcome: { outcome: 'launched', proposalId: 'p1', taskId: 't9', project: 'kookr' } });
    expect(q('avatar-launch-card')).toBeNull();
    expect(q('avatar-launch-result')!.textContent).toContain('Started');
    await act(async () => { q('avatar-launch-open')!.click(); });
    expect(selectAgent).toHaveBeenCalledWith('ag1', 't9');
  });

  test('refused, cancelled and an outcome for another proposal', async () => {
    mount();
    await showCard();
    await send({ type: 'lucy_launch', conversationId: CONV, outcome: { outcome: 'cancelled', proposalId: 'other' } });
    expect(q('avatar-launch-card')).not.toBeNull();
    await send({ type: 'lucy_launch', conversationId: CONV, outcome: { outcome: 'refused', proposalId: 'p1', reason: 'No free slot right now.' } });
    expect(q('avatar-launch-card')).toBeNull();
    expect(q('avatar-launch-result')!.textContent).toContain('No free slot right now.');
    await showCard();
    await send({ type: 'lucy_launch', conversationId: CONV, outcome: { outcome: 'cancelled', proposalId: 'p1' } });
    expect(q('avatar-launch-result')!.textContent).toContain('Cancelled');
  });

  test('a new proposal replaces the old one', async () => {
    mount();
    await showCard();
    await showCard({ id: 'p2', description: 'Second task' });
    expect(container.querySelectorAll('[data-testid="avatar-launch-card"]')).toHaveLength(1);
    expect(q('avatar-launch-description')!.textContent).toBe('Second task');
  });

  test('the card disappears by itself at expiresAt', async () => {
    vi.useFakeTimers();
    mount();
    await showCard({ expiresAt: Date.now() + 5_000 });
    expect(q('avatar-launch-card')).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(5_100); });
    expect(q('avatar-launch-card')).toBeNull();
    expect(q('avatar-launch-result')!.textContent).toContain('timed out');
  });

  test('a report shows its sentence, is spoken, and opens the task', async () => {
    mount();
    const selectAgent = vi.fn();
    useKookrStore.setState({ agents: [{ agentId: 'ag1', taskId: 't9' } as never], selectAgent } as never);
    await send({ type: 'lucy_launch', conversationId: CONV, report: { taskId: 't9', conversationId: CONV, kind: 'finished', text: 'The investigation finished.' } });
    expect(q('avatar-launch-report')!.textContent).toContain('The investigation finished.');
    expect(speech.announceLaunchReport).toHaveBeenCalledWith('t9', 'finished');
    await act(async () => { q('avatar-launch-report-open')!.click(); });
    expect(selectAgent).toHaveBeenCalledWith('ag1', 't9');
  });

  test('typed input posts a typed turn with a stable conversation id and shows the reply', async () => {
    const lines = [{ type: 'text', delta: 'On it' }, { type: 'text', delta: '.' }, { type: 'done', end: 'answered' }].map((e) => JSON.stringify(e)).join('\n');
    vi.mocked(fetch).mockImplementation(async () => new Response(lines + '\n', { status: 200 }));
    mount();
    const input = q('avatar-typed-input') as HTMLInputElement;
    const type = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => { q('avatar-typed')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    };
    await type('investigate why the issue tasks stop chaining');
    await type('and again');
    const bodies = postBodies().filter((c) => c.url === '/api/lucy/turn').map((c) => c.body);
    expect(bodies[0]).toMatchObject({ text: 'investigate why the issue tasks stop chaining', input: 'typed' });
    expect(bodies[0].conversationId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(bodies[1].conversationId).toBe(bodies[0].conversationId);
    expect(q('avatar-typed-reply')!.textContent).toBe('On it.');
  });

  test('typed input hides itself when the first request answers 404', async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ error: 'lucy_operator_disabled', message: 'off' }), { status: 404 }));
    mount();
    expect(q('avatar-typed')).not.toBeNull();
    const input = q('avatar-typed-input') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'hello');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { q('avatar-typed')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(q('avatar-typed')).toBeNull();
  });

  describe('the autonomy label', () => {
    const settingsFetch = (settings: Record<string, unknown>, turnStatus = 200) => vi.mocked(fetch).mockImplementation(async (input) =>
      String(input) === '/api/settings'
        ? new Response(JSON.stringify(settings), { status: 200 })
        : new Response(JSON.stringify({ error: 'x', message: 'x' }), { status: turnStatus }));

    test('shows Balanced when settings have no level', async () => {
      settingsFetch({});
      mount();
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
      expect(q('avatar-autonomy-level')!.textContent).toBe('Lucy autonomy: Balanced');
    });

    test('shows nothing, rather than a guess, when the settings cannot be read', async () => {
      vi.mocked(fetch).mockImplementation(async () => new Response('nope', { status: 500 }));
      mount();
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
      expect(q('avatar-autonomy-level')).toBeNull();
    });

    test('shows Hands-off from settings, and follows a settings save', async () => {
      settingsFetch({ lucyAutonomy: 'hands-off' });
      mount();
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
      expect(q('avatar-autonomy-level')!.textContent).toBe('Lucy autonomy: Hands-off');
      await act(async () => { window.dispatchEvent(new CustomEvent('kookr:settings-updated', { detail: { lucyAutonomy: 'careful' } })); });
      expect(q('avatar-autonomy-level')!.textContent).toBe('Lucy autonomy: Careful');
      // Read-only text: nothing to press, and nothing was sent.
      expect(q('avatar-autonomy-level')!.querySelector('button, input, select')).toBeNull();
    });

    test('is gone with the typed input when the feature is off (404)', async () => {
      settingsFetch({}, 404);
      mount();
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
      const input = q('avatar-typed-input') as HTMLInputElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'hello');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => { q('avatar-typed')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      expect(q('avatar-typed')).toBeNull();
      expect(q('avatar-autonomy-level')).toBeNull();
    });
  });
});
