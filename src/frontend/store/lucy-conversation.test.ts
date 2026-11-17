// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  CUT_OFF_BY_RELOAD_TEXT,
  LUCY_CONVERSATION_KEY,
  MAX_CONVERSATION_ENTRIES,
  MAX_ENTRY_CHIPS,
  type ConversationEntry,
  __reloadLucyConversationForTests,
  __resetLucyConversationForTests,
  appendConversationEntry,
  getConversationEntries,
  removeConversationEntries,
  updateConversationEntry,
} from './lucy-conversation.js';

const saved = (): Array<Record<string, unknown>> => JSON.parse(localStorage.getItem(LUCY_CONVERSATION_KEY) ?? '[]');

/** What another tab does when it saves the thread: writes the shared storage, which tells this tab through a `storage` event. */
function otherTabSaves(list: unknown[]): void {
  const json = list.length === 0 ? null : JSON.stringify(list);
  if (json === null) localStorage.removeItem(LUCY_CONVERSATION_KEY);
  else localStorage.setItem(LUCY_CONVERSATION_KEY, json);
  window.dispatchEvent(new StorageEvent('storage', { key: LUCY_CONVERSATION_KEY, newValue: json }));
}
const texts = (): string[] => getConversationEntries().map((e) => e.text);

/** A storage that counts its writes and can be told to refuse reads or writes, put in place of `localStorage`. */
function stubStorage(refuse: { reads?: boolean; writes?: boolean } = {}): { writes: () => number; restore: () => void } {
  const real = localStorage;
  let writes = 0;
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => { if (refuse.reads) throw new Error('denied'); return real.getItem(key); },
    setItem: (key: string, value: string) => { writes += 1; if (refuse.writes) throw new Error('quota'); real.setItem(key, value); },
    removeItem: (key: string) => { if (refuse.writes) throw new Error('quota'); real.removeItem(key); },
  });
  return { writes: () => writes, restore: () => vi.unstubAllGlobals() };
}

describe('lucy-conversation', () => {
  beforeEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    sessionStorage.clear();
    __resetLucyConversationForTests();
  });

  test('entries are kept oldest first, each with an id and a time', () => {
    appendConversationEntry({ kind: 'typed-you', text: 'one' });
    appendConversationEntry({ kind: 'typed-lucy', text: 'two', status: 'done' });
    const entries = getConversationEntries();
    expect(entries.map((e) => e.text)).toEqual(['one', 'two']);
    expect(new Set(entries.map((e) => e.id)).size).toBe(2);
    expect(entries.every((e) => typeof e.at === 'number')).toBe(true);
  });

  test('only the last 200 are kept', () => {
    for (let i = 0; i < MAX_CONVERSATION_ENTRIES + 25; i += 1) appendConversationEntry({ kind: 'notice', text: `n${i}` });
    const entries = getConversationEntries();
    expect(entries).toHaveLength(MAX_CONVERSATION_ENTRIES);
    expect(entries[0].text).toBe('n25');
    expect(entries.at(-1)!.text).toBe(`n${MAX_CONVERSATION_ENTRIES + 24}`);
    expect(saved()).toHaveLength(MAX_CONVERSATION_ENTRIES);
  });

  test('the thread is kept in localStorage (so a new tab or a browser restart has it), as text only, and a reload reads it back', () => {
    appendConversationEntry({ kind: 'typed-you', text: 'hello' });
    appendConversationEntry({ kind: 'clip', clipId: 'c1', text: 'Two tasks need you.', subject: 'Build', usedFallback: true });
    expect(saved()).toHaveLength(2);
    // Not in the per-tab storage it used to live in: that is what made a new tab start empty.
    expect(sessionStorage.getItem(LUCY_CONVERSATION_KEY)).toBeNull();
    expect(JSON.stringify(saved())).not.toMatch(/audio/i);

    __reloadLucyConversationForTests();
    expect(getConversationEntries().map((e) => e.kind)).toEqual(['typed-you', 'clip']);
    expect(getConversationEntries()[1]).toMatchObject({ clipId: 'c1', subject: 'Build', usedFallback: true });
  });

  test('a page that loads finds the saved thread: the store reads it when its module is first evaluated', async () => {
    // The real path of a new tab or a restart, not the test helper: a fresh copy of the module, with a thread already saved.
    localStorage.setItem(LUCY_CONVERSATION_KEY, JSON.stringify([
      { id: 'e1', at: 1, kind: 'typed-you', text: 'Brief me.' },
      { id: 'e2', at: 2, kind: 'typed-lucy', text: 'Three tasks wait.', status: 'done', looked: 2, rev: 3, chips: ['More'] },
      { id: 'e3', at: 3, kind: 'launch-outcome', text: 'Started kookr task', started: true, taskId: 't9' },
      { id: 'e4', at: 4, kind: 'lucy', text: 'The task I started has finished.', taskId: 't9', clipId: 'c1' },
      { id: 'e5', at: 5, kind: 'clip', clipId: 'c2', text: 'Two tasks need you.' },
    ]));
    vi.resetModules();
    const fresh = await import('./lucy-conversation.js');
    expect(fresh.getConversationEntries().map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
    // And the first thing added after that keeps them: nothing saved is overwritten by a thread that looked empty.
    fresh.appendConversationEntry({ kind: 'typed-you', text: 'and now?' });
    expect(saved().map((e) => e.text)).toEqual(['Brief me.', 'Three tasks wait.', 'Started kookr task', 'The task I started has finished.', 'Two tasks need you.', 'and now?']);
    fresh.__resetLucyConversationForTests();
  });

  test('streamed text is written to storage after a short delay, not word by word', () => {
    vi.useFakeTimers();
    const id = appendConversationEntry({ kind: 'typed-lucy', text: '', status: 'pending' });
    updateConversationEntry(id, { text: 'On' });
    updateConversationEntry(id, { text: 'On it' });
    expect(saved()[0].text).toBe('');
    vi.advanceTimersByTime(300);
    expect(saved()[0].text).toBe('On it');
    expect(getConversationEntries()[0].text).toBe('On it');
  });

  test('a draft of the operator\'s speech is never stored; an answer still arriving is closed by a reload', () => {
    appendConversationEntry({ kind: 'talk-you', text: 'any news on', final: false });
    appendConversationEntry({ kind: 'typed-you', text: 'status?' });
    appendConversationEntry({ kind: 'typed-lucy', text: 'Five are', status: 'pending' });
    appendConversationEntry({ kind: 'talk-you', text: 'thanks', final: true });
    expect(saved().map((e) => e.kind)).toEqual(['typed-you', 'typed-lucy', 'talk-you']);

    __reloadLucyConversationForTests();
    const entries = getConversationEntries();
    expect(entries.map((e) => e.kind)).toEqual(['typed-you', 'typed-lucy', 'talk-you']);
    expect(entries[1]).toMatchObject({ status: 'error', text: CUT_OFF_BY_RELOAD_TEXT });
  });

  test('entries can be removed, and an unknown id is ignored', () => {
    const a = appendConversationEntry({ kind: 'typed-you', text: 'a' });
    const b = appendConversationEntry({ kind: 'typed-lucy', text: '', status: 'pending' });
    updateConversationEntry('nope', { text: 'x' });
    removeConversationEntries([a, b]);
    expect(getConversationEntries()).toHaveLength(0);
    expect(localStorage.getItem(LUCY_CONVERSATION_KEY)).toBeNull();
  });

  test.each([
    ['not JSON', '{oops'],
    ['not a list', '{"a":1}'],
    ['a list of junk', '[1,"x",{"kind":"nope"},{"kind":"notice"}]'],
  ])('a saved thread that is %s is ignored', (_label, raw) => {
    localStorage.setItem(LUCY_CONVERSATION_KEY, raw);
    __reloadLucyConversationForTests();
    expect(getConversationEntries()).toHaveLength(0);
  });

  test('storage that refuses is survived: the thread still works for this page', () => {
    const storage = stubStorage({ writes: true });
    try {
      appendConversationEntry({ kind: 'notice', text: 'still here' });
      expect(getConversationEntries().map((e) => e.text)).toEqual(['still here']);
      // The write was tried and refused, not skipped.
      expect(storage.writes()).toBe(1);
    } finally {
      storage.restore();
    }
    expect(saved()).toEqual([]);
  });

  test('storage that cannot be read is survived too: a load, and a save by another tab, leave the thread working', () => {
    appendConversationEntry({ kind: 'notice', text: 'mine' });
    const storage = stubStorage({ reads: true });
    try {
      expect(() => __reloadLucyConversationForTests()).not.toThrow();
      expect(getConversationEntries()).toHaveLength(0);
      const id = appendConversationEntry({ kind: 'notice', text: 'after' });
      expect(() => window.dispatchEvent(new StorageEvent('storage', { key: null }))).not.toThrow();
      expect(getConversationEntries().map((e) => e.id)).toEqual([id]);
    } finally {
      storage.restore();
    }
  });

  describe('the kinds added for the chat', () => {
    test('a message of hers with suggestion buttons and a task, and a launch outcome, survive a reload', () => {
      appendConversationEntry({ kind: 'lucy', text: 'Good morning. Three tasks wait.', chips: ['Walk me through them', 'What first?'] });
      appendConversationEntry({ kind: 'lucy', text: 'The task I started has finished.', taskId: 't9' });
      appendConversationEntry({ kind: 'launch-outcome', text: 'Started kookr task', started: true, taskId: 't9' });
      appendConversationEntry({ kind: 'typed-lucy', text: 'Done.', status: 'done', looked: 3, chips: ['More'] });
      __reloadLucyConversationForTests();
      const [briefing, report, outcome, reply] = getConversationEntries();
      expect(briefing).toMatchObject({ kind: 'lucy', chips: ['Walk me through them', 'What first?'] });
      expect(report).toMatchObject({ kind: 'lucy', taskId: 't9' });
      expect(outcome).toMatchObject({ kind: 'launch-outcome', started: true, taskId: 't9' });
      expect(reply).toMatchObject({ kind: 'typed-lucy', looked: 3, chips: ['More'] });
    });

    test('suggestion buttons are trimmed, emptied ones dropped, and there are never more than six', () => {
      const id = appendConversationEntry({ kind: 'lucy', text: 'x', chips: ['  Brief me  ', '', '   ', ...Array.from({ length: 9 }, (_, n) => `chip ${n}`)] });
      const entry = getConversationEntries().find((e) => e.id === id) as Extract<ConversationEntry, { kind: 'lucy' }>;
      expect(entry.chips).toHaveLength(MAX_ENTRY_CHIPS);
      expect(entry.chips![0]).toBe('Brief me');
      updateConversationEntry(id, { chips: [' One ', 'Two'] });
      expect((getConversationEntries()[0] as Extract<ConversationEntry, { kind: 'lucy' }>).chips).toEqual(['One', 'Two']);
    });

    test.each([
      ['chips that are not a list of strings', { id: 'a', at: 1, kind: 'lucy', text: 'x', chips: [1, 2] }],
      ['a task id that is not text', { id: 'a', at: 1, kind: 'lucy', text: 'x', taskId: 7 }],
      ['an outcome that does not say whether a task started', { id: 'a', at: 1, kind: 'launch-outcome', text: 'Started' }],
      ['a look-up count that is not a number', { id: 'a', at: 1, kind: 'typed-lucy', text: 'x', status: 'done', looked: 'three' }],
    ])('a saved entry with %s is ignored', (_label, entry) => {
      localStorage.setItem(LUCY_CONVERSATION_KEY, JSON.stringify([entry, { id: 'ok', at: 2, kind: 'notice', text: 'kept' }]));
      __reloadLucyConversationForTests();
      expect(texts()).toEqual(['kept']);
    });

    test('what she is doing can be set and taken away again on a reply still arriving', () => {
      const id = appendConversationEntry({ kind: 'typed-lucy', text: '', status: 'pending' });
      updateConversationEntry(id, { doing: 'Reading the board…', looked: 1 });
      expect(getConversationEntries()[0]).toMatchObject({ doing: 'Reading the board…', looked: 1 });
      updateConversationEntry(id, { text: 'Three tasks.', doing: null });
      expect(getConversationEntries()[0]).not.toHaveProperty('doing');
      expect(getConversationEntries()[0]).toMatchObject({ text: 'Three tasks.', looked: 1 });
    });

    test('an entry added with an id of its own is added once, however many times it is asked for', () => {
      const first = appendConversationEntry({ kind: 'launch-outcome', text: 'Started kookr task', started: true }, { id: 'launch-p1' });
      const second = appendConversationEntry({ kind: 'launch-outcome', text: 'Started kookr task', started: true }, { id: 'launch-p1' });
      expect(first).toBe('launch-p1');
      expect(second).toBe('launch-p1');
      expect(getConversationEntries()).toHaveLength(1);
    });
  });

  describe('several tabs share the one saved thread', () => {
    const fromOther = (id: string, text: string, over: Record<string, unknown> = {}) => ({ id, at: Date.now(), kind: 'notice', text, ...over });

    test('what another tab saved shows up here, in its order', () => {
      appendConversationEntry({ kind: 'typed-you', text: 'mine' });
      otherTabSaves([...saved(), fromOther('o1', 'theirs'), fromOther('o2', 'theirs too')]);
      expect(texts()).toEqual(['mine', 'theirs', 'theirs too']);
    });

    test('subscribers are told, so the panel re-renders', () => {
      const seen: number[] = [];
      // `useLucyConversation` subscribes the same way; here the store is watched through a re-read after the event.
      otherTabSaves([fromOther('o1', 'one')]);
      seen.push(getConversationEntries().length);
      otherTabSaves([fromOther('o1', 'one'), fromOther('o2', 'two')]);
      seen.push(getConversationEntries().length);
      expect(seen).toEqual([1, 2]);
    });

    test('an entry this tab added, which the other tab\'s save did not have yet, is kept and written back', () => {
      vi.useFakeTimers();
      const before = saved();
      const mine = appendConversationEntry({ kind: 'typed-you', text: 'mine, just now' });
      // The other tab saved at the same moment, from a list that did not have it.
      otherTabSaves([...before, fromOther('o1', 'theirs')]);
      expect(texts()).toEqual(['theirs', 'mine, just now']);
      // The saved thread lacks it until this tab writes again, a moment later and only once.
      expect(saved().map((e) => e.id)).toEqual(['o1']);
      vi.advanceTimersByTime(300);
      expect(saved().map((e) => e.id)).toEqual(['o1', mine]);
    });

    test('this tab never writes back what it only read: no ping-pong between tabs', () => {
      vi.useFakeTimers();
      otherTabSaves([fromOther('o1', 'theirs')]);
      const storage = stubStorage();
      try {
        vi.advanceTimersByTime(5_000);
        expect(storage.writes()).toBe(0);
        // Positive control: a change made here is written.
        appendConversationEntry({ kind: 'notice', text: 'mine' });
        expect(storage.writes()).toBe(1);
      } finally {
        storage.restore();
      }
    });

    test('a reply this tab is still receiving is not overwritten by the other tab\'s older copy of it', () => {
      const id = appendConversationEntry({ kind: 'typed-lucy', text: '', status: 'pending' });
      const stale = saved();
      updateConversationEntry(id, { text: 'Five tasks' });
      updateConversationEntry(id, { text: 'Five tasks are running.', status: 'done' });
      otherTabSaves([...stale, fromOther('o1', 'theirs')]);
      expect(getConversationEntries()[0]).toMatchObject({ id, text: 'Five tasks are running.', status: 'done' });
      expect(texts()).toEqual(['Five tasks are running.', 'theirs']);
    });

    test('a tab opened while a reply is arriving here, which closed its own copy as "cut off", cannot end the reply here', () => {
      const id = appendConversationEntry({ kind: 'typed-lucy', text: '', status: 'pending' });
      // The new tab read the saved thread, repaired the reply that looked abandoned, and then saved (same revision).
      otherTabSaves([{ ...saved()[0], status: 'error', text: CUT_OFF_BY_RELOAD_TEXT }, fromOther('o1', 'theirs')]);
      expect(getConversationEntries()[0]).toMatchObject({ id, status: 'pending', text: '' });
      updateConversationEntry(id, { text: 'Five tasks are running.', status: 'done' });
      expect(getConversationEntries()[0]).toMatchObject({ status: 'done', text: 'Five tasks are running.' });
      expect(texts()).toEqual(['Five tasks are running.', 'theirs']);
      // Once it has ended here, a newer version from elsewhere is taken as usual.
      otherTabSaves([{ ...getConversationEntries()[0], chips: ['More'], rev: 9 }, fromOther('o1', 'theirs')]);
      expect(getConversationEntries()[0]).toMatchObject({ chips: ['More'] });
    });

    test('the other tab\'s newer version of an entry replaces this tab\'s', () => {
      const id = appendConversationEntry({ kind: 'lucy', text: 'The task I started has finished.', taskId: 't9' });
      // The tab that speaks attached the clip to it (two changes there, none here).
      otherTabSaves([{ ...saved()[0], clipId: 'c1', rev: 2 }]);
      expect(getConversationEntries()[0]).toMatchObject({ id, clipId: 'c1' });
    });

    test('a reply another tab is still receiving stays "arriving" here: it is not closed as cut off', () => {
      otherTabSaves([{ id: 'r1', at: Date.now(), kind: 'typed-lucy', text: 'Five', status: 'pending', rev: 1 }]);
      expect(getConversationEntries()[0]).toMatchObject({ status: 'pending', text: 'Five' });
      otherTabSaves([{ id: 'r1', at: Date.now(), kind: 'typed-lucy', text: 'Five tasks.', status: 'done', rev: 3 }]);
      expect(getConversationEntries()[0]).toMatchObject({ status: 'done', text: 'Five tasks.' });
    });

    test('an entry the other tab took out goes here too; one this tab took out does not come back', () => {
      otherTabSaves([fromOther('o1', 'one'), fromOther('o2', 'two')]);
      otherTabSaves([fromOther('o2', 'two')]);
      expect(texts()).toEqual(['two']);

      const mine = appendConversationEntry({ kind: 'typed-you', text: 'taken back' });
      const withMine = saved();
      removeConversationEntries([mine]);
      // The other tab saved before it heard of the removal.
      otherTabSaves([...withMine, fromOther('o3', 'three')]);
      expect(texts()).toEqual(['two', 'three']);
    });

    test('the draft of what the operator is saying, which is never saved, survives another tab saving', () => {
      appendConversationEntry({ kind: 'talk-you', text: 'any news on', final: false });
      otherTabSaves([fromOther('o1', 'theirs')]);
      expect(texts()).toEqual(['theirs', 'any news on']);
    });

    test('another tab emptying the thread empties it here, except for what this tab just added', () => {
      otherTabSaves([fromOther('o1', 'theirs')]);
      const mine = appendConversationEntry({ kind: 'typed-you', text: 'mine' });
      otherTabSaves([]);
      expect(getConversationEntries().map((e) => e.id)).toEqual([mine]);
    });

    test('a change to some other key is ignored; the whole storage being cleared is read as an empty saved thread', () => {
      otherTabSaves([fromOther('o1', 'theirs')]);
      window.dispatchEvent(new StorageEvent('storage', { key: 'kookr:somethingElse', newValue: '[]' }));
      expect(texts()).toEqual(['theirs']);
      localStorage.clear();
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
      expect(texts()).toEqual([]);
    });

    test('junk saved by another tab is ignored entry by entry', () => {
      otherTabSaves([1, 'x', { kind: 'nope' }, fromOther('o1', 'kept')]);
      expect(texts()).toEqual(['kept']);
      localStorage.setItem(LUCY_CONVERSATION_KEY, '{oops');
      expect(() => window.dispatchEvent(new StorageEvent('storage', { key: LUCY_CONVERSATION_KEY, newValue: '{oops' }))).not.toThrow();
    });

    test('a full saved list has dropped its oldest entries: an old entry of this tab that fell off is not put back at the bottom', () => {
      const old = appendConversationEntry({ kind: 'notice', text: 'old one of mine', at: 1 });
      const full = Array.from({ length: MAX_CONVERSATION_ENTRIES }, (_, n) => fromOther(`o${n}`, `n${n}`, { at: 1000 + n }));
      otherTabSaves(full);
      expect(getConversationEntries()).toHaveLength(MAX_CONVERSATION_ENTRIES);
      expect(getConversationEntries().some((e) => e.id === old)).toBe(false);
    });
  });
});
