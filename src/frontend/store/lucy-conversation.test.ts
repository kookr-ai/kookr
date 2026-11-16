// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  CUT_OFF_BY_RELOAD_TEXT,
  LUCY_CONVERSATION_KEY,
  MAX_CONVERSATION_ENTRIES,
  __reloadLucyConversationForTests,
  __resetLucyConversationForTests,
  appendConversationEntry,
  getConversationEntries,
  removeConversationEntries,
  updateConversationEntry,
} from './lucy-conversation.js';

const saved = (): Array<Record<string, unknown>> => JSON.parse(sessionStorage.getItem(LUCY_CONVERSATION_KEY) ?? '[]');

describe('lucy-conversation', () => {
  beforeEach(() => {
    vi.useRealTimers();
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

  test('the thread is kept in sessionStorage, as text only, and a reload reads it back', () => {
    appendConversationEntry({ kind: 'typed-you', text: 'hello' });
    appendConversationEntry({ kind: 'clip', clipId: 'c1', text: 'Two tasks need you.', subject: 'Build', usedFallback: true });
    expect(localStorage.getItem(LUCY_CONVERSATION_KEY)).toBeNull();
    expect(JSON.stringify(saved())).not.toMatch(/audio/i);

    __reloadLucyConversationForTests();
    expect(getConversationEntries().map((e) => e.kind)).toEqual(['typed-you', 'clip']);
    expect(getConversationEntries()[1]).toMatchObject({ clipId: 'c1', subject: 'Build', usedFallback: true });
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
    expect(sessionStorage.getItem(LUCY_CONVERSATION_KEY)).toBeNull();
  });

  test.each([
    ['not JSON', '{oops'],
    ['not a list', '{"a":1}'],
    ['a list of junk', '[1,"x",{"kind":"nope"},{"kind":"notice"}]'],
  ])('a saved thread that is %s is ignored', (_label, raw) => {
    sessionStorage.setItem(LUCY_CONVERSATION_KEY, raw);
    __reloadLucyConversationForTests();
    expect(getConversationEntries()).toHaveLength(0);
  });

  test('storage that refuses is survived: the thread still works for this page', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    try {
      appendConversationEntry({ kind: 'notice', text: 'still here' });
      expect(getConversationEntries().map((e) => e.text)).toEqual(['still here']);
    } finally {
      setItem.mockRestore();
    }
  });
});
