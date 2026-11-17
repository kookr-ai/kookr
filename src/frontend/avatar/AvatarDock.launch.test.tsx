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
import { __resetLucyTypedForTests } from './LucyTypedInput.js';
import { __resetLastClipForTests } from '../audio/last-clip.js';
import { __resetSoundPreferenceForTests } from '../audio/sound-preference.js';
import { __resetSpeechBusForTests } from '../audio/speech-bus.js';
import { AVATAR_PANEL_KEY, __resetAvatarPanelPrefsForTests } from '../store/avatar-panel-prefs.js';
import { __resetLucyConversationForTests, appendConversationEntry, getConversationEntries } from '../store/lucy-conversation.js';
import { captureLastClip } from '../audio/last-clip.js';
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
  const all = (id: string) => [...container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
  /** The thread's entries, oldest first: each one's test id. */
  const entryIds = () => [...container.querySelectorAll<HTMLElement>('.avatar-thread-list > li')].map((li) => li.dataset.testid);
  /** Type a sentence into the composer and send it; the fetch stub answers the turn. */
  const typeAndSend = async (value: string) => {
    const input = q('avatar-typed-input') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { q('avatar-typed')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  };
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
    __resetLucyConversationForTests();
    __resetLucyTypedForTests();
    localStorage.clear();
    sessionStorage.clear();
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

  test('a long description has no scroll box of its own: the card grows and the thread is what scrolls', async () => {
    mount();
    await showCard({ description: 'Line of a very long task description.\n'.repeat(60) });
    const body = container.querySelector<HTMLElement>('.avatar-launch-body')!;
    // Not a region to tab into and scroll: that would be a third scrolling area in the column.
    expect(body.getAttribute('role')).toBeNull();
    expect(body.hasAttribute('tabindex')).toBe(false);
    expect(body.contains(q('avatar-launch-description'))).toBe(true);
    // The thread's scroll area holds the whole card, buttons included.
    expect(q('avatar-thread')!.contains(q('avatar-launch-go'))).toBe(true);
    expect(q('avatar-thread')!.contains(q('avatar-launch-cancel'))).toBe(true);
  });

  test('the launch card is the last thing in the conversation thread, after the entries and outside their list', async () => {
    mount();
    act(() => { appendConversationEntry({ kind: 'typed-you', text: 'something earlier' }); });
    await showCard();
    const thread = q('avatar-thread')!;
    const card = q('avatar-launch-card')!;
    expect(thread.contains(card)).toBe(true);
    // In the slot for cards waiting for a decision, which comes after the list of entries; a card is not a list item.
    const slot = q('avatar-thread-cards')!;
    expect(slot.contains(card)).toBe(true);
    expect(card.closest('ol, ul, li')).toBeNull();
    expect(q('avatar-messages')!.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Nothing of it is left between the thread and the composer.
    const dock = q('avatar-dock')!;
    const order = [...dock.children].map((el) => (el as HTMLElement).dataset.testid ?? el.className);
    expect(order.slice(-2)).toEqual(['avatar-thread-wrap', 'avatar-composer']);
  });

  test('the card shows in an empty thread too, under her welcome', async () => {
    mount();
    await showCard();
    expect(q('avatar-hint')).not.toBeNull();
    expect(q('avatar-thread')!.contains(q('avatar-launch-card'))).toBe(true);
  });

  describe('no triple repetition', () => {
    const READ_BACK = 'I will launch an investigation in kookr: find out why issue tasks stop chaining. Say go to start.';
    const turn = (...events: object[]) => vi.mocked(fetch).mockImplementation(async (input) => (String(input) === '/api/lucy/turn'
      ? new Response([...events, { type: 'done', end: 'answered' }].map((e) => JSON.stringify(e)).join('\n') + '\n', { status: 200 })
      : new Response('{}', { status: 200 })));
    const ASKED = 'investigate why the issue tasks stop chaining';

    test('a reply that is only the card\'s read-back gets no bubble: the operator\'s sentence, then the card', async () => {
      mount();
      turn(
        { type: 'tool_call', id: 'c1', name: 'propose_launch', args: {} },
        { type: 'proposal', proposal: proposal({ readBack: READ_BACK }) },
        { type: 'tool_result', id: 'c1', name: 'propose_launch', ok: true, summary: 'Prepared a launch card' },
        { type: 'text', delta: READ_BACK },
      );
      // The card arrives over the socket while the turn is being answered, as it does on the server.
      await showCard({ readBack: READ_BACK });
      await typeAndSend(ASKED);
      expect(entryIds()).toEqual(['avatar-typed-you']);
      expect(q('avatar-thread')!.textContent).not.toContain('I will launch an investigation');
      expect(q('avatar-launch-card')).not.toBeNull();
      // A screen reader is still told what she said: nothing else speaks a typed reply.
      expect(q('avatar-typed-announce')!.textContent).toBe(READ_BACK);
      // And the composer is free again.
      expect(q('avatar-typed-send')!.getAttribute('aria-disabled')).toBeNull();
    });

    test('line breaks and double spaces do not make the read-back a different sentence', async () => {
      mount();
      turn({ type: 'proposal', proposal: proposal({ readBack: READ_BACK }) }, { type: 'text', delta: `  ${READ_BACK.replace(': ', ':\n')}  ` });
      await showCard({ readBack: READ_BACK });
      await typeAndSend(ASKED);
      expect(entryIds()).toEqual(['avatar-typed-you']);
    });

    test('without the card on screen the read-back is shown: the operator must not be left with nothing', async () => {
      mount();
      turn({ type: 'proposal', proposal: proposal({ readBack: READ_BACK }) }, { type: 'text', delta: READ_BACK });
      // The socket never delivered the card.
      await typeAndSend(ASKED);
      expect(q('avatar-launch-card')).toBeNull();
      expect(entryIds()).toEqual(['avatar-typed-you', 'avatar-typed-reply']);
      expect(q('avatar-typed-reply')!.textContent).toContain(READ_BACK);
    });

    test('a card that arrives after the read-back was already written takes that bubble out', async () => {
      mount();
      turn({ type: 'proposal', proposal: proposal({ readBack: READ_BACK }) }, { type: 'text', delta: READ_BACK });
      await typeAndSend(ASKED);
      expect(entryIds()).toEqual(['avatar-typed-you', 'avatar-typed-reply']);
      await showCard({ readBack: READ_BACK });
      expect(entryIds()).toEqual(['avatar-typed-you']);
    });

    test('a reply that says more than the read-back keeps its bubble', async () => {
      mount();
      const more = `${READ_BACK} It will take about ten minutes.`;
      turn({ type: 'proposal', proposal: proposal({ readBack: READ_BACK }) }, { type: 'text', delta: READ_BACK }, { type: 'text', delta: ' It will take about ten minutes.' });
      await showCard({ readBack: READ_BACK });
      await typeAndSend(ASKED);
      expect(entryIds()).toEqual(['avatar-typed-you', 'avatar-typed-reply']);
      expect(q('avatar-typed-reply')!.textContent).toContain(more);
    });

    test('a reply that only happens to match, in a turn that proposed nothing, keeps its bubble', async () => {
      mount();
      turn({ type: 'text', delta: READ_BACK });
      await showCard({ readBack: READ_BACK });
      await typeAndSend('say that again');
      expect(entryIds()).toEqual(['avatar-typed-you', 'avatar-typed-reply']);
    });

    test('"You asked" is left out when the operator\'s sentence is the entry right above the card, and shown otherwise', async () => {
      mount();
      act(() => { appendConversationEntry({ kind: 'typed-you', text: `  ${ASKED} ` }); });
      await showCard();
      expect(q('avatar-launch-asked')).toBeNull();
      // Something else was said in between: the card says again what it was built from.
      act(() => { appendConversationEntry({ kind: 'typed-lucy', text: 'One moment.', status: 'done' }); });
      expect(q('avatar-launch-asked')!.textContent).toContain(ASKED);
    });

    test('her reply still being prepared (no bubble yet) does not count as "something in between"', async () => {
      mount();
      act(() => {
        appendConversationEntry({ kind: 'typed-you', text: ASKED });
        appendConversationEntry({ kind: 'typed-lucy', text: '', status: 'pending', doing: 'Preparing a task to start…' });
      });
      await showCard();
      expect(q('avatar-launch-asked')).toBeNull();
    });

    test('"You asked" stays when the sentence above is a different one', async () => {
      mount();
      act(() => { appendConversationEntry({ kind: 'typed-you', text: 'yes, do that' }); });
      await showCard();
      expect(q('avatar-launch-asked')!.textContent).toContain(ASKED);
    });
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

  test('while the launch is under way Go reads "Starting…" and is marked busy, then the card gives way to the outcome', async () => {
    mount();
    await showCard();
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation((input) => (String(input) === '/api/lucy/launch/confirm'
      ? new Promise<Response>((resolve) => { finish = resolve; })
      : Promise.resolve(new Response('{}', { status: 200 }))));
    await act(async () => { q('avatar-launch-go')!.click(); });
    await flush();
    expect(q('avatar-launch-go')!.textContent).toBe('Starting…');
    expect(q('avatar-launch-go')!.getAttribute('aria-busy')).toBe('true');
    await act(async () => { finish(new Response(JSON.stringify({ outcome: 'launched', proposalId: 'p1', taskId: 't-new', project: 'billing-api' }), { status: 200 })); });
    await flush();
    expect(q('avatar-launch-go')).toBeNull();
  });

  test('Enter confirms with via enter, but not while typing in a text field', async () => {
    mount();
    await showCard();
    const input = q('avatar-typed-input') as HTMLTextAreaElement;
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

  test('an open dialog owns Enter: the card does not launch beneath it, and does not stop the dialog\'s own handler', async () => {
    mount();
    await showCard();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    // A ConfirmDialog-style window listener added after the card.
    const dialogEnter = vi.fn();
    window.addEventListener('keydown', dialogEnter, true);
    try {
      await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
      await flush();
      expect(postBodies().filter((c) => c.url.endsWith('/confirm'))).toHaveLength(0);
      expect(dialogEnter).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', dialogEnter, true);
      dialog.remove();
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

  test('an outcome clears the card and becomes an entry of the thread that stays; Started names the project and links the task', async () => {
    mount();
    const selectAgent = vi.fn();
    useKookrStore.setState({ agents: [{ agentId: 'ag1', taskId: 't9' } as never], selectAgent } as never);
    act(() => { appendConversationEntry({ kind: 'typed-you', text: 'investigate why the issue tasks stop chaining' }); });
    await showCard();
    await send({ type: 'lucy_launch', conversationId: CONV, outcome: { outcome: 'launched', proposalId: 'p1', taskId: 't9', project: 'kookr' } });
    expect(q('avatar-launch-card')).toBeNull();
    const result = q('avatar-launch-result')!;
    expect(result.textContent).toBe('Started kookr task·Open task');
    // It is an entry of the conversation, after the operator's sentence, not a strip above the composer.
    expect(entryIds()).toEqual(['avatar-typed-you', 'avatar-launch-result']);
    expect(getConversationEntries().at(-1)).toMatchObject({ kind: 'launch-outcome', text: 'Started kookr task', started: true, taskId: 't9' });
    // Nothing to dismiss: it is part of the record.
    expect(container.querySelector('[aria-label="Dismiss"], [aria-label="Dismiss report"]')).toBeNull();
    await act(async () => { q('avatar-launch-open')!.click(); });
    expect(selectAgent).toHaveBeenCalledWith('ag1', 't9');
    // Still there after more is said.
    act(() => { appendConversationEntry({ kind: 'typed-you', text: 'thanks' }); });
    expect(entryIds()).toEqual(['avatar-typed-you', 'avatar-launch-result', 'avatar-typed-you']);
  });

  test('a queued launch says so', async () => {
    mount();
    await showCard();
    await send({ type: 'lucy_launch', conversationId: CONV, outcome: { outcome: 'launched', proposalId: 'p1', taskId: 't9', project: 'kookr', queued: true } });
    expect(q('avatar-launch-result')!.textContent).toContain('Started kookr task (queued)');
  });

  test('refused, cancelled and an outcome for another proposal', async () => {
    mount();
    await showCard();
    await send({ type: 'lucy_launch', conversationId: CONV, outcome: { outcome: 'cancelled', proposalId: 'other' } });
    expect(q('avatar-launch-card')).not.toBeNull();
    expect(all('avatar-launch-result')).toHaveLength(0);
    await send({ type: 'lucy_launch', conversationId: CONV, outcome: { outcome: 'refused', proposalId: 'p1', reason: 'No free slot right now.' } });
    expect(q('avatar-launch-card')).toBeNull();
    expect(q('avatar-launch-result')!.textContent).toBe('No free slot right now.');
    expect(q('avatar-launch-open')).toBeNull();
    await showCard({ id: 'p2' });
    await send({ type: 'lucy_launch', conversationId: CONV, outcome: { outcome: 'cancelled', proposalId: 'p2' } });
    expect(all('avatar-launch-result').map((el) => el.textContent)).toEqual(['No free slot right now.', 'Cancelled']);
    await showCard({ id: 'p3' });
    await send({ type: 'lucy_launch', conversationId: CONV, outcome: { outcome: 'declined', proposalId: 'p3' } });
    expect(all('avatar-launch-result').at(-1)!.textContent).toBe('Cancelled');
  });

  test('the same outcome told twice (the socket, then the answer to the press; or two tabs) is one entry', async () => {
    mount();
    await showCard();
    const outcome = { outcome: 'launched', proposalId: 'p1', taskId: 't9', project: 'kookr' } as const;
    await send({ type: 'lucy_launch', conversationId: CONV, outcome });
    // What another tab, which got the same broadcast, wrote into the shared thread.
    act(() => { appendConversationEntry({ kind: 'launch-outcome', text: 'Started kookr task', started: true, taskId: 't9' }, { id: 'launch-p1' }); });
    expect(all('avatar-launch-result')).toHaveLength(1);
    expect(getConversationEntries().at(-1)!.id).toBe('launch-p1');
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
    expect(q('avatar-launch-result')!.textContent).toBe('Timed out');
    // The server's own "expired", arriving after, adds nothing.
    await send({ type: 'lucy_launch', conversationId: CONV, outcome: { outcome: 'expired', proposalId: 'p1' } });
    expect(all('avatar-launch-result')).toHaveLength(1);
  });

  test('a report is a message of hers in the thread, with an Open task button; it is spoken, and stays', async () => {
    mount();
    const selectAgent = vi.fn();
    useKookrStore.setState({ agents: [{ agentId: 'ag1', taskId: 't9' } as never], selectAgent } as never);
    speech.announceLaunchReport.mockClear();
    await send({ type: 'lucy_launch', conversationId: CONV, report: { taskId: 't9', conversationId: CONV, kind: 'finished', text: 'The investigation finished.' } });
    const report = q('avatar-launch-report')!;
    expect(report.textContent).toContain('The investigation finished.');
    // A bubble of hers like any other, in the list of entries.
    expect(report.classList.contains('avatar-entry-lucy')).toBe(true);
    expect(report.querySelector('.avatar-entry-bubble')!.textContent).toBe('Lucy The investigation finished.');
    expect(entryIds()).toEqual(['avatar-launch-report']);
    expect(getConversationEntries().at(-1)).toMatchObject({ kind: 'lucy', taskId: 't9', text: 'The investigation finished.' });
    expect(speech.announceLaunchReport).toHaveBeenCalledWith('t9', 'finished');
    expect(q('avatar-launch-report-open')!.textContent).toBe('Open task');
    await act(async () => { q('avatar-launch-report-open')!.click(); });
    expect(selectAgent).toHaveBeenCalledWith('ag1', 't9');
    expect(container.querySelector('[aria-label="Dismiss report"]')).toBeNull();
  });

  test('the same report received by two tabs is one message; a later report about the same task is a new one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // A tenth of a second before the minute turns: the two tabs' clocks then fall in different minutes.
    vi.setSystemTime(new Date(2026, 10, 17, 9, 0, 59, 900));
    mount();
    const report = { taskId: 't9', conversationId: CONV, kind: 'needs_input', text: 'The task I started needs you.' } as const;
    await send({ type: 'lucy_launch', conversationId: CONV, report });
    await send({ type: 'lucy_launch', conversationId: CONV, report });
    expect(all('avatar-launch-report')).toHaveLength(1);
    vi.setSystemTime(Date.now() + 200);
    await send({ type: 'lucy_launch', conversationId: CONV, report });
    expect(all('avatar-launch-report')).toHaveLength(1);
    // The server says it again only after five minutes of the task still waiting.
    vi.setSystemTime(Date.now() + 6 * 60_000);
    await send({ type: 'lucy_launch', conversationId: CONV, report });
    expect(all('avatar-launch-report')).toHaveLength(2);
  });

  test('when the report is then said aloud, its clip joins the written message: one message, with Replay, not two', async () => {
    mount();
    await send({ type: 'lucy_launch', conversationId: CONV, report: { taskId: 't9', conversationId: CONV, kind: 'finished', text: 'The investigation finished.' } });
    act(() => { captureLastClip({ clipId: 'clip-report', text: 'The investigation finished.', audio: new ArrayBuffer(4), durationMs: 1000 }); });
    expect(entryIds()).toEqual(['avatar-launch-report']);
    expect(all('avatar-message')).toHaveLength(0);
    const report = q('avatar-launch-report')!;
    expect(report.dataset.clipId).toBe('clip-report');
    expect(report.querySelector('[data-testid="avatar-msg-aloud"]')!.textContent).toBe('said aloud');
    expect(report.querySelector('[data-testid="avatar-msg-replay"]')).not.toBeNull();
    expect(q('avatar-launch-report-open')).not.toBeNull();
    // A clip with other words is a message of its own, as before.
    act(() => { captureLastClip({ clipId: 'clip-other', text: 'Two tasks need you.', audio: new ArrayBuffer(4), durationMs: 1000 }); });
    expect(entryIds()).toEqual(['avatar-launch-report', 'avatar-message']);
  });

  test('typed input posts a typed turn with a stable conversation id and shows the reply', async () => {
    const lines = [{ type: 'text', delta: 'On it' }, { type: 'text', delta: '.' }, { type: 'done', end: 'answered' }].map((e) => JSON.stringify(e)).join('\n');
    vi.mocked(fetch).mockImplementation(async () => new Response(lines + '\n', { status: 200 }));
    mount();
    await typeAndSend('investigate why the issue tasks stop chaining');
    await typeAndSend('and again');
    const bodies = postBodies().filter((c) => c.url === '/api/lucy/turn').map((c) => c.body);
    expect(bodies[0]).toMatchObject({ text: 'investigate why the issue tasks stop chaining', input: 'typed' });
    expect(bodies[0].conversationId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(bodies[1].conversationId).toBe(bodies[0].conversationId);
    // Both requests and both replies are in the thread, oldest first (the full thread behaviour is in AvatarDock.thread.test.tsx).
    expect([...container.querySelectorAll('[data-testid="avatar-typed-you"] .avatar-entry-bubble, [data-testid="avatar-typed-reply"] .avatar-entry-bubble')].map((e) => e.textContent)).toEqual([
      'You investigate why the issue tasks stop chaining',
      'Lucy On it.',
      'You and again',
      'Lucy On it.',
    ]);
  });

  test('typed input hides itself when the first request answers 404', async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ error: 'lucy_operator_disabled', message: 'off' }), { status: 404 }));
    mount();
    expect(q('avatar-typed')).not.toBeNull();
    await typeAndSend('hello');
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
      await typeAndSend('hello');
      expect(q('avatar-typed')).toBeNull();
      expect(q('avatar-autonomy-level')).toBeNull();
    });
  });
});
