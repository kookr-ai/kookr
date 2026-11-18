import { describe, expect, test } from 'vitest';
import { MAX_UNPROMPTED_AGE_MS, MAX_UNPROMPTED_ITEMS } from '../core/lucy-operator/unprompted.js';
import { createLucyUnpromptedLog } from './lucy-unprompted.js';

const T0 = Date.parse('2026-11-17T10:00:00.000Z');

function setup() {
  let nowMs = T0;
  const log = createLucyUnpromptedLog({ now: () => nowMs });
  return { log, at: (ms: number) => { nowMs = T0 + ms; } };
}

describe('createLucyUnpromptedLog', () => {
  test('returns what was recorded, newest first, with the time it was said and its tasks', () => {
    const { log, at } = setup();
    log.record({ key: 'says:1', text: 'Docs link audit failed.', tasks: [{ id: 't1', name: 'Docs link audit' }] });
    at(30_000);
    log.record({ key: 'permission:n1', text: 'A task is waiting for your permission to use Bash. The command is on my card.', tasks: [{ id: 't2' }] });
    expect(log.recent()).toEqual([
      { text: 'A task is waiting for your permission to use Bash. The command is on my card.', at: T0 + 30_000, tasks: [{ id: 't2' }] },
      { text: 'Docs link audit failed.', at: T0, tasks: [{ id: 't1', name: 'Docs link audit' }] },
    ]);
  });

  test('keeps at most six items: the oldest go first', () => {
    const { log, at } = setup();
    for (let i = 0; i < MAX_UNPROMPTED_ITEMS + 3; i++) {
      at(i * 1000);
      log.record({ key: `says:${i}`, text: `Line ${i}.`, tasks: [] });
    }
    const texts = log.recent().map((item) => item.text);
    expect(texts).toHaveLength(MAX_UNPROMPTED_ITEMS);
    expect(texts[0]).toBe('Line 8.');
    expect(texts[texts.length - 1]).toBe('Line 3.');
  });

  test('an item is gone once it is older than fifteen minutes', () => {
    const { log, at } = setup();
    log.record({ key: 'says:1', text: 'Docs link audit failed.', tasks: [] });
    at(MAX_UNPROMPTED_AGE_MS);
    expect(log.recent()).toHaveLength(1);
    at(MAX_UNPROMPTED_AGE_MS + 1);
    expect(log.recent()).toEqual([]);
  });

  test('an item is gone as soon as what it was about is over, and does not come back', () => {
    const { log } = setup();
    let open = true;
    log.record({ key: 'permission:n1', text: 'A task is waiting for your permission to use Bash.', tasks: [{ id: 't1' }], stillOpen: () => open });
    expect(log.recent()).toHaveLength(1);
    open = false;
    expect(log.recent()).toEqual([]);
    open = true;
    expect(log.recent()).toEqual([]);
  });

  test('the same thing recorded twice is one item, at the time it was first said', () => {
    const { log, at } = setup();
    log.record({ key: 'ask:q1', text: 'The task Deploy needs your input: ship it?', tasks: [{ id: 't1' }] });
    at(20_000);
    log.record({ key: 'ask:q1', text: 'The task Deploy needs your input: ship it?', tasks: [{ id: 't1' }], sameSaying: true });
    expect(log.recent()).toEqual([{ text: 'The task Deploy needs your input: ship it?', at: T0, tasks: [{ id: 't1' }] }]);
  });

  test('a key said again after fifteen minutes with no read in between is a new item, not pruned in the same call', () => {
    const { log, at } = setup();
    log.record({ key: 'launch:t1', text: 'The task I started needs your input.', tasks: [{ id: 't1' }] });
    at(MAX_UNPROMPTED_AGE_MS + 60_000);
    log.record({ key: 'launch:t1', text: 'The task I started needs your input.', tasks: [{ id: 't1' }] });
    expect(log.recent()).toEqual([{ text: 'The task I started needs your input.', at: T0 + MAX_UNPROMPTED_AGE_MS + 60_000, tasks: [{ id: 't1' }] }]);
  });

  test('a different sentence under the same key is a new saying, at the time it was said', () => {
    const { log, at } = setup();
    log.record({ key: 'launch:t1', text: 'The task I started needs your input.', tasks: [{ id: 't1' }], inConversation: 'live-1' });
    at(5 * 60_000);
    log.record({ key: 'launch:t1', text: 'The task I started has finished.', tasks: [{ id: 't1' }] });
    expect(log.recent('live-1')).toEqual([{ text: 'The task I started has finished.', at: T0 + 5 * 60_000, tasks: [{ id: 't1' }] }]);
    // And it lives its own fifteen minutes.
    at(5 * 60_000 + MAX_UNPROMPTED_AGE_MS);
    expect(log.recent()).toHaveLength(1);
    at(5 * 60_000 + MAX_UNPROMPTED_AGE_MS + 1);
    expect(log.recent()).toEqual([]);
  });

  test('the same words recorded again without sameSaying are a new saying: new time, no conversation marks', () => {
    const { log, at } = setup();
    log.record({ key: 'launch:t1', text: 'The task I started needs your input.', tasks: [{ id: 't1' }], inConversation: 'live-1' });
    at(5 * 60_000);
    log.record({ key: 'launch:t1', text: 'The task I started needs your input.', tasks: [{ id: 't1' }] });
    expect(log.recent('live-1')).toEqual([{ text: 'The task I started needs your input.', at: T0 + 5 * 60_000, tasks: [{ id: 't1' }] }]);
  });

  test('a conversation that already holds an item in its history is told so; the others are not', () => {
    const { log, at } = setup();
    log.record({ key: 'ask:q1', text: 'The task Deploy needs your input: ship it?', tasks: [{ id: 't1' }], inConversation: 'live-1' });
    at(1000);
    // The clip route records the same question again, without a conversation: the mark is kept.
    log.record({ key: 'ask:q1', text: 'The task Deploy needs your input: ship it?', tasks: [{ id: 't1' }], sameSaying: true });
    expect(log.recent('live-1')).toEqual([expect.objectContaining({ inHistory: true })]);
    expect(log.recent('typed-1')).toEqual([expect.not.objectContaining({ inHistory: true })]);
    expect(log.recent()).toEqual([expect.not.objectContaining({ inHistory: true })]);
  });

  test('an empty sentence is not recorded, and a check that throws keeps the item', () => {
    const { log } = setup();
    log.record({ key: 'says:1', text: '   ', tasks: [] });
    log.record({ key: '', text: 'No key.', tasks: [] });
    expect(log.recent()).toEqual([]);
    log.record({ key: 'says:2', text: 'Docs link audit failed.', tasks: [], stillOpen: () => { throw new Error('store gone'); } });
    expect(log.recent()).toHaveLength(1);
  });
});
