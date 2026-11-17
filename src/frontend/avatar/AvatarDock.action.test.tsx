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
}));
vi.mock('../audio/ask-announcement.js', () => speech);

import { AvatarDock } from './AvatarDock.js';
import { timeLeftWords } from './LucyActionCard.js';
import { __resetLucyTypedForTests } from './LucyTypedInput.js';
import { __resetLastClipForTests } from '../audio/last-clip.js';
import { __resetSoundPreferenceForTests } from '../audio/sound-preference.js';
import { __resetSpeechBusForTests } from '../audio/speech-bus.js';
import { AVATAR_PANEL_KEY, __resetAvatarPanelPrefsForTests } from '../store/avatar-panel-prefs.js';
import { __resetLucyActionForTests, getLucyActionSnapshot, handleLucyAction, type LucyActionMessage } from '../store/lucy-action.js';
import { __resetLucyConversationForTests } from '../store/lucy-conversation.js';
import { __resetLucyLaunchForTests, handleLucyLaunch } from '../store/lucy-launch.js';
import { useKookrStore } from '../store/useStore.js';
import type { LucyActionProposalView } from '../../shared/contracts/lucy-action.js';

const CONV = 'typed-abc';
const base = { id: 'a1', taskId: 't1', taskName: 'Billing migration', asked: 'tell the billing task to rebase on main', readBack: 'I will type that.', expiresAt: Date.now() + 100_000 };
const reply = (over: Partial<LucyActionProposalView> = {}): LucyActionProposalView => ({
  ...base, kind: 'reply', title: 'Reply to Billing migration', text: 'Rebase on main. Then run the whole test suite again and tell me what failed.', ...over,
} as LucyActionProposalView);
const answer = (): LucyActionProposalView => ({
  ...base, kind: 'answer', title: 'Answer Billing migration', askId: 'q1', question: 'Which database should the migration use?',
  answer: { kind: 'option', index: 1, label: 'SQLite' }, asked: 'answer sqlite',
});
const close = (): LucyActionProposalView => ({ ...base, kind: 'close', title: 'Close Billing migration', asked: 'close the billing task' });

describe('AvatarDock: Lucy action card', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const flush = async () => { await act(async () => { await Promise.resolve(); }); };
  const send = (msg: LucyActionMessage) => act(async () => { handleLucyAction(msg); });
  const showCard = (proposal: LucyActionProposalView = reply()) => send({ conversationId: CONV, proposal });
  // The dock makes other requests of its own (its settings); only the ones about her proposals are looked at.
  const posts = () => vi.mocked(fetch).mock.calls
    .map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init?.body ?? 'null')) }))
    .filter((call) => call.url.startsWith('/api/lucy/'));

  function mount() {
    localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify({ enabled: true, minimized: false, position: null }));
    __resetAvatarPanelPrefsForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => { root!.render(<AvatarDock attentionCount={0} />); });
  }

  beforeEach(() => {
    __resetLucyConversationForTests();
    __resetLucyTypedForTests();
    localStorage.clear();
    __resetLastClipForTests(); __resetSoundPreferenceForTests(); __resetSpeechBusForTests();
    __resetLucyLaunchForTests(); __resetLucyActionForTests();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ outcome: 'unknown', proposalId: 'zzz' }), { status: 200 })));
  });
  afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    container?.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('nothing is shown until she proposes something', () => {
    mount();
    expect(q('avatar-action')).toBeNull();
  });

  test('a reply card shows its title, the whole text that will be typed, the operator\'s words, Send and Cancel', async () => {
    mount();
    await showCard();
    expect(q('avatar-action-title')!.textContent).toBe('Reply to Billing migration');
    expect(q('avatar-action-kind')!.textContent).toBe('Reply');
    // Exactly what will be sent: the full text, not a summary of it.
    expect(q('avatar-action-text')!.textContent).toBe(reply().kind === 'reply' ? (reply() as { text: string }).text : '');
    expect(q('avatar-action-asked')!.textContent).toContain('tell the billing task to rebase on main');
    expect(q('avatar-action-confirm')!.textContent).toBe('Send');
    expect(q('avatar-action-cancel')!.textContent).toBe('Cancel');
    expect(q('avatar-action-card')!.getAttribute('aria-label')).toBe('Reply Lucy proposes to send');
  });

  test('an answer card shows the question and the chosen choice', async () => {
    mount();
    await showCard(answer());
    expect(q('avatar-action-title')!.textContent).toBe('Answer Billing migration');
    expect(q('avatar-action-question')!.textContent).toContain('Which database should the migration use?');
    expect(q('avatar-action-text')!.textContent).toContain('SQLite');
    expect(q('avatar-action-text')!.textContent).toContain('Your choice');
    expect(q('avatar-action-confirm')!.textContent).toBe('Send');
  });

  test('a free-text answer is shown in full as the operator\'s answer', async () => {
    mount();
    await showCard({ ...answer(), answer: { kind: 'text', text: 'Use the staging database.' } } as LucyActionProposalView);
    expect(q('avatar-action-text')!.textContent).toContain('Your answer');
    expect(q('avatar-action-text')!.textContent).toContain('Use the staging database.');
  });

  test('a close card says what closing does and its button says Close', async () => {
    mount();
    await showCard(close());
    expect(q('avatar-action-title')!.textContent).toBe('Close Billing migration');
    expect(q('avatar-action-kind')!.textContent).toBe('Close');
    expect(q('avatar-action-text')!.textContent).toMatch(/says it is finished/);
    expect(q('avatar-action-confirm')!.textContent).toBe('Close');
  });

  test('the card says how long it waits, and that nothing happens unless the operator confirms', async () => {
    mount();
    await showCard();
    expect(q('avatar-action-expiry')!.getAttribute('role')).toBe('timer');
    expect(q('avatar-action-expiry')!.textContent).toMatch(/^Waits for you for 1 min \d+ s\. Nothing happens unless you confirm\.$/);
    expect(timeLeftWords(100_000, 0)).toBe('1 min 40 s');
    expect(timeLeftWords(40_000, 0)).toBe('40 s');
    expect(timeLeftWords(0, 5)).toBe('0 s');
  });

  test('long text scrolls inside its own keyboard-reachable region; the buttons are outside it', async () => {
    mount();
    await showCard(reply({ text: 'A very long reply. '.repeat(200) } as Partial<LucyActionProposalView>));
    const body = q('avatar-action-card')!.querySelector<HTMLElement>('.avatar-launch-body')!;
    expect(body.getAttribute('role')).toBe('region');
    expect(body.tabIndex).toBe(0);
    expect(body.contains(q('avatar-action-text'))).toBe(true);
    expect(body.contains(q('avatar-action-confirm'))).toBe(false);
    expect(body.contains(q('avatar-action-cancel'))).toBe(false);
  });

  test('the card sits right next to the launch card, above the composer', async () => {
    mount();
    await showCard();
    const dock = q('avatar-dock')!;
    const order = [...dock.children].map((el) => (el as HTMLElement).dataset.testid ?? el.className);
    expect(order.slice(-3)).toEqual(['avatar-thread-wrap', 'avatar-action', 'avatar-typed']);
    // With a launch result line also showing, the launch block comes first, the action card after it.
    await act(async () => {
      handleLucyLaunch({ type: 'lucy_launch', conversationId: CONV, report: { taskId: 't9', conversationId: CONV, kind: 'finished', text: 'The task I started has finished.' } });
    });
    const both = [...dock.children].map((el) => (el as HTMLElement).dataset.testid ?? el.className);
    expect(both.slice(-4)).toEqual(['avatar-thread-wrap', 'avatar-launch', 'avatar-action', 'avatar-typed']);
  });

  test('Send posts the conversation and the proposal id, and nothing else', async () => {
    mount();
    await showCard();
    await act(async () => { q('avatar-action-confirm')!.click(); });
    await flush();
    expect(posts()).toEqual([{ url: '/api/lucy/action/confirm', body: { conversationId: CONV, proposalId: 'a1' } }]);
  });

  test('Cancel posts a decline', async () => {
    mount();
    await showCard();
    await act(async () => { q('avatar-action-cancel')!.click(); });
    await flush();
    expect(posts()).toEqual([{ url: '/api/lucy/action/decline', body: { conversationId: CONV, proposalId: 'a1' } }]);
  });

  test('Enter does not confirm an action card: only a click or the operator\'s "go" does', async () => {
    mount();
    await showCard();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await flush();
    expect(posts()).toEqual([]);
    expect(q('avatar-action-card')).not.toBeNull();
  });

  test('a second press while the first is on its way sends nothing more', async () => {
    let release: (value: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn((url: string) => (String(url).startsWith('/api/lucy/')
      ? new Promise<Response>((resolve) => { release = resolve; })
      : Promise.resolve(new Response('{}', { status: 200 })))));
    mount();
    await showCard();
    await act(async () => { q('avatar-action-confirm')!.click(); });
    expect(q('avatar-action-confirm')!.getAttribute('aria-disabled')).toBe('true');
    await act(async () => { q('avatar-action-confirm')!.click(); q('avatar-action-cancel')!.click(); });
    expect(posts()).toHaveLength(1);
    await act(async () => { release(new Response(JSON.stringify({ outcome: 'done', proposalId: 'a1', kind: 'reply', taskId: 't1' }), { status: 200 })); });
    await flush();
    expect(q('avatar-action-result')!.textContent).toContain('Sent');
  });

  test.each([
    [{ outcome: 'done', proposalId: 'a1', kind: 'reply', taskId: 't1' }, 'Sent'],
    [{ outcome: 'done', proposalId: 'a1', kind: 'close', taskId: 't1' }, 'Closed'],
    [{ outcome: 'done', proposalId: 'a1', kind: 'answer', taskId: 't1', note: 'The task had ended, so it was not typed into it.' }, 'Recorded. The task had ended, so it was not typed into it.'],
    [{ outcome: 'refused', proposalId: 'a1', reason: 'That question was already answered, so I did not send anything.' }, 'That question was already answered, so I did not send anything.'],
    [{ outcome: 'declined', proposalId: 'a1' }, 'Cancelled'],
    [{ outcome: 'cancelled', proposalId: 'a1' }, 'Cancelled'],
    [{ outcome: 'expired', proposalId: 'a1' }, 'That request timed out'],
  ] as const)('the server\'s outcome %j turns the card into the one line %j', async (outcome, line) => {
    mount();
    await showCard();
    await send({ conversationId: CONV, outcome });
    expect(q('avatar-action-card')).toBeNull();
    expect(q('avatar-action-result')!.querySelector('span')!.textContent).toBe(line);
    expect(q('avatar-action-result')!.getAttribute('role')).toBe('status');
  });

  test('an outcome for another proposal leaves the card alone', async () => {
    mount();
    await showCard();
    await send({ conversationId: CONV, outcome: { outcome: 'done', proposalId: 'other', kind: 'reply', taskId: 't1' } });
    expect(q('avatar-action-card')).not.toBeNull();
    expect(q('avatar-action-result')).toBeNull();
  });

  test('the result line opens the task and can be dismissed', async () => {
    const selectAgent = vi.fn();
    useKookrStore.setState({ agents: [{ agentId: 'kookr-s1', taskId: 't1' }] as never, selectAgent } as never);
    mount();
    await showCard();
    await send({ conversationId: CONV, outcome: { outcome: 'done', proposalId: 'a1', kind: 'reply', taskId: 't1' } });
    await act(async () => { q('avatar-action-open')!.click(); });
    expect(selectAgent).toHaveBeenCalledWith('kookr-s1', 't1');
    await act(async () => { container.querySelector<HTMLElement>('[aria-label="Dismiss result"]')!.click(); });
    expect(q('avatar-action')).toBeNull();
  });

  test('a failed press says so and keeps the card, so the operator can try again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    mount();
    await showCard();
    await act(async () => { q('avatar-action-confirm')!.click(); });
    await flush();
    expect(q('avatar-action-error')!.textContent).toBe('Lucy could not do that. Try again.');
    expect(q('avatar-action-card')).not.toBeNull();
    expect(getLucyActionSnapshot().sending).toBe(false);
  });

  test('the card goes by itself when its time is up', async () => {
    vi.useFakeTimers();
    mount();
    await showCard(reply({ expiresAt: Date.now() + 5_000 } as Partial<LucyActionProposalView>));
    expect(q('avatar-action-card')).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(5_100); });
    expect(q('avatar-action-card')).toBeNull();
    expect(q('avatar-action-result')!.textContent).toContain('That request timed out');
    expect(posts()).toEqual([]);
  });

  test('a new card replaces the one shown, and clears the last result', async () => {
    mount();
    await showCard();
    await send({ conversationId: CONV, outcome: { outcome: 'declined', proposalId: 'a1' } });
    expect(q('avatar-action-result')).not.toBeNull();
    await showCard({ ...close(), id: 'a2' });
    expect(q('avatar-action-result')).toBeNull();
    expect(q('avatar-action-title')!.textContent).toBe('Close Billing migration');
  });
});
