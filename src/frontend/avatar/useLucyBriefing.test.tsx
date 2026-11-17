// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LUCY_BRIEFING_PATH } from '../../shared/contracts/lucy-briefing.js';
import { __resetLucyConversationForTests, appendConversationEntry, getConversationEntries } from '../store/lucy-conversation.js';
import type { PresenceSources } from './operator-presence.js';
import { BRIEFING_FRESH_MS, __resetLucyBriefingForTests, offerBriefing, useLucyBriefing } from './useLucyBriefing.js';

const MIN = 60_000;
const START = 1_700_000_000_000;

interface Briefing { text: string; chips: string[]; signature: string }
const WAITING: Briefing = { text: 'Billing migration is stopped on a question. Two more are working.', chips: ['Walk me through the question', 'What is everyone working on?'], signature: 'sig-waiting' };
const CLEAR: Briefing = { text: 'All clear: nothing needs you. Three tasks are working.', chips: ['What is everyone working on?'], signature: 'sig-clear' };

/** A server whose briefing the test sets, and a count of how often it was asked. */
function fakeServer(initial: Briefing | number) {
  const state = { current: initial as Briefing | number };
  const fetcher = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    expect(String(input)).toBe(LUCY_BRIEFING_PATH);
    const answer = state.current;
    if (typeof answer === 'number') return new Response(JSON.stringify({ error: 'lucy_operator_disabled' }), { status: answer });
    return new Response(JSON.stringify({ ...answer, at: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return { state, fetcher: fetcher as unknown as typeof fetch, calls: () => fetcher.mock.calls.length };
}

const briefings = () => getConversationEntries().filter((entry) => entry.kind === 'typed-lucy' && entry.briefing !== undefined);

describe('offerBriefing', () => {
  let now = START;
  const clock = () => now;

  beforeEach(() => {
    now = START;
    __resetLucyConversationForTests();
    __resetLucyBriefingForTests();
  });

  test('a briefing is fresh for 30 minutes', () => {
    expect(BRIEFING_FRESH_MS).toBe(30 * MIN);
  });

  test('writes the briefing as a finished message from Lucy, with its follow-ups and its signature', async () => {
    const server = fakeServer(WAITING);
    expect(await offerBriefing('opened', { fetcher: server.fetcher, now: clock })).toBe('written');
    expect(getConversationEntries()).toEqual([
      expect.objectContaining({ kind: 'typed-lucy', status: 'done', text: WAITING.text, chips: WAITING.chips, briefing: 'sig-waiting', at: START }),
    ]);
  });

  test('a message without follow-ups stores no empty list', async () => {
    const server = fakeServer({ ...CLEAR, chips: [] });
    await offerBriefing('opened', { fetcher: server.fetcher, now: clock });
    expect(getConversationEntries()[0]).not.toHaveProperty('chips');
  });

  test('panel shown: the same signature within 30 minutes is not repeated', async () => {
    const server = fakeServer(WAITING);
    await offerBriefing('opened', { fetcher: server.fetcher, now: clock });
    now += BRIEFING_FRESH_MS - 1;
    expect(await offerBriefing('opened', { fetcher: server.fetcher, now: clock })).toBe('repeat');
    expect(briefings()).toHaveLength(1);
  });

  test('panel shown: the same signature is written again once the last one is 30 minutes old', async () => {
    const server = fakeServer(WAITING);
    await offerBriefing('opened', { fetcher: server.fetcher, now: clock });
    now += BRIEFING_FRESH_MS;
    expect(await offerBriefing('opened', { fetcher: server.fetcher, now: clock })).toBe('written');
    expect(briefings()).toHaveLength(2);
  });

  test('panel shown: a changed signature is written even a minute after the last briefing', async () => {
    const server = fakeServer(WAITING);
    await offerBriefing('opened', { fetcher: server.fetcher, now: clock });
    now += MIN;
    server.state.current = CLEAR;
    expect(await offerBriefing('opened', { fetcher: server.fetcher, now: clock })).toBe('written');
    expect(briefings().map((entry) => entry.text)).toEqual([WAITING.text, CLEAR.text]);
  });

  test('panel shown: it is the newest briefing in the thread that counts, not an older one with the same signature', async () => {
    appendConversationEntry({ kind: 'typed-lucy', status: 'done', text: CLEAR.text, briefing: 'sig-clear', at: START - 20 * MIN });
    appendConversationEntry({ kind: 'typed-lucy', status: 'done', text: WAITING.text, briefing: 'sig-waiting', at: START - 10 * MIN });
    appendConversationEntry({ kind: 'typed-you', text: 'thanks', at: START - 5 * MIN });
    const server = fakeServer(CLEAR);
    expect(await offerBriefing('opened', { fetcher: server.fetcher, now: clock })).toBe('written');
  });

  test('operator back: nothing is written when the signature is the one of the last briefing, however old', async () => {
    const server = fakeServer(WAITING);
    await offerBriefing('opened', { fetcher: server.fetcher, now: clock });
    now += 5 * 60 * MIN;
    expect(await offerBriefing('returned', { fetcher: server.fetcher, now: clock })).toBe('repeat');
    expect(briefings()).toHaveLength(1);
  });

  test('operator back: a changed signature is written', async () => {
    const server = fakeServer(WAITING);
    await offerBriefing('opened', { fetcher: server.fetcher, now: clock });
    now += 11 * MIN;
    server.state.current = CLEAR;
    expect(await offerBriefing('returned', { fetcher: server.fetcher, now: clock })).toBe('written');
    expect(briefings().map((entry) => entry.briefing)).toEqual(['sig-waiting', 'sig-clear']);
  });

  test('operator back: the last briefing is remembered even when the thread no longer holds it', async () => {
    const server = fakeServer(WAITING);
    await offerBriefing('opened', { fetcher: server.fetcher, now: clock });
    __resetLucyConversationForTests();
    now += 11 * MIN;
    expect(await offerBriefing('returned', { fetcher: server.fetcher, now: clock })).toBe('repeat');
    expect(briefings()).toHaveLength(0);
  });

  test.each([
    ['the conversation is off (404)', 404],
    ['the conversation cannot run (503)', 503],
  ])('writes nothing when %s', async (_label, status) => {
    const server = fakeServer(status);
    expect(await offerBriefing('opened', { fetcher: server.fetcher, now: clock })).toBe('unavailable');
    expect(getConversationEntries()).toEqual([]);
  });

  test('writes nothing when the server cannot be reached or answers something else', async () => {
    const offline = vi.fn(async () => { throw new TypeError('offline'); }) as unknown as typeof fetch;
    expect(await offerBriefing('opened', { fetcher: offline, now: clock })).toBe('unavailable');
    const junk = vi.fn(async () => new Response(JSON.stringify({ text: '', signature: 7 }), { status: 200 })) as unknown as typeof fetch;
    expect(await offerBriefing('opened', { fetcher: junk, now: clock })).toBe('unavailable');
    expect(getConversationEntries()).toEqual([]);
  });

  test('two offers at the same moment give one briefing', async () => {
    const server = fakeServer(WAITING);
    const [first, second] = await Promise.all([
      offerBriefing('opened', { fetcher: server.fetcher, now: clock }),
      offerBriefing('returned', { fetcher: server.fetcher, now: clock }),
    ]);
    expect([first, second]).toEqual(['written', 'busy']);
    expect(server.calls()).toBe(1);
    expect(briefings()).toHaveLength(1);
  });
});

describe('useLucyBriefing', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let now = START;
  let hidden = false;
  const visibility = new Set<() => void>();
  const activity = new Set<() => void>();
  const presence: PresenceSources = {
    now: () => now,
    isHidden: () => hidden,
    onVisibilityChange: (listener) => { visibility.add(listener); return () => visibility.delete(listener); },
    onActivity: (listener) => { activity.add(listener); return () => activity.delete(listener); },
  };
  const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  const movePointer = async () => { act(() => { for (const listener of activity) listener(); }); await settle(); };
  const showTab = async () => { hidden = false; act(() => { for (const listener of visibility) listener(); }); await settle(); };
  const hideTab = () => { hidden = true; act(() => { for (const listener of visibility) listener(); }); };

  function Harness({ shown, fetcher }: { shown: boolean; fetcher: typeof fetch }) {
    useLucyBriefing({ shown, fetcher, now: () => now, presence });
    return null;
  }
  const render = async (shown: boolean, fetcher: typeof fetch) => {
    act(() => { root!.render(<Harness shown={shown} fetcher={fetcher} />); });
    await settle();
  };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    now = START;
    hidden = false;
    visibility.clear();
    activity.clear();
    __resetLucyConversationForTests();
    __resetLucyBriefingForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  test('she writes the briefing the first time the panel is shown, and not again when it is minimised and reopened', async () => {
    const server = fakeServer(WAITING);
    await render(true, server.fetcher);
    expect(briefings().map((entry) => entry.text)).toEqual([WAITING.text]);
    await render(false, server.fetcher);
    now += 45 * MIN;
    await render(true, server.fetcher);
    expect(server.calls()).toBe(1);
    expect(briefings()).toHaveLength(1);
  });

  test('while the panel is minimised she writes nothing, until it is opened', async () => {
    const server = fakeServer(WAITING);
    await render(false, server.fetcher);
    expect(server.calls()).toBe(0);
    await render(true, server.fetcher);
    expect(briefings()).toHaveLength(1);
  });

  test('a page reloaded a moment later does not repeat the same briefing; one whose content changed is written', async () => {
    const server = fakeServer(WAITING);
    await render(true, server.fetcher);
    // A reload: the page starts again, the thread is still there.
    act(() => root?.unmount());
    __resetLucyBriefingForTests();
    root = createRoot(container);
    now += 2 * MIN;
    await render(true, server.fetcher);
    expect(server.calls()).toBe(2);
    expect(briefings()).toHaveLength(1);

    act(() => root?.unmount());
    __resetLucyBriefingForTests();
    root = createRoot(container);
    now += 2 * MIN;
    server.state.current = CLEAR;
    await render(true, server.fetcher);
    expect(briefings().map((entry) => entry.text)).toEqual([WAITING.text, CLEAR.text]);
  });

  test('back after ten minutes away with changed work: she writes once, although the tab and the pointer both report the return', async () => {
    const server = fakeServer(WAITING);
    await render(true, server.fetcher);
    hideTab();
    now += 10 * MIN;
    server.state.current = CLEAR;
    await showTab();
    await movePointer();
    await movePointer();
    expect(server.calls()).toBe(2);
    expect(briefings().map((entry) => entry.text)).toEqual([WAITING.text, CLEAR.text]);
  });

  test('back after ten minutes away with nothing changed: she stays silent', async () => {
    const server = fakeServer(WAITING);
    await render(true, server.fetcher);
    now += 40 * MIN;
    await movePointer();
    expect(server.calls()).toBe(2);
    expect(briefings()).toHaveLength(1);
  });

  test('back after nine minutes: the server is not even asked', async () => {
    const server = fakeServer(WAITING);
    await render(true, server.fetcher);
    now += 9 * MIN;
    server.state.current = CLEAR;
    await movePointer();
    expect(server.calls()).toBe(1);
    expect(briefings()).toHaveLength(1);
  });

  test('a briefing that could not be fetched when the panel opened is tried again the next time it is shown', async () => {
    const server = fakeServer(503);
    await render(true, server.fetcher);
    expect(briefings()).toHaveLength(0);
    await render(false, server.fetcher);
    server.state.current = WAITING;
    await render(true, server.fetcher);
    expect(briefings()).toHaveLength(1);
  });

  test('after the panel is gone, a return writes nothing', async () => {
    const server = fakeServer(WAITING);
    await render(true, server.fetcher);
    act(() => root?.unmount());
    root = null;
    now += 30 * MIN;
    server.state.current = CLEAR;
    for (const listener of activity) listener();
    expect(activity.size + visibility.size).toBe(0);
    expect(server.calls()).toBe(1);
  });
});
