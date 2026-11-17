// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { OperatorAskView } from '../../shared/contracts/asks.js';
import type { LucyPermissionAnnouncement, LucyPermissionCardView } from '../../shared/contracts/lucy-permission.js';
import type { AskAnnouncementResult } from '../audio/ask-announcement.js';
import { __resetLucyConversationForTests, getConversationEntries } from '../store/lucy-conversation.js';
import { announceOrWrite, writtenAsk, writtenPermissionNotice, type WrittenWords } from './unspoken-words.js';

const WORDS: WrittenWords = { text: 'Billing migration asks: Run the table rename on production now?', taskId: 't1' };

/** An announcer like `announceAsk`: it POSTs for the clip through the fetcher it is given, then ends with `result`. */
function announcer(result: AskAnnouncementResult) {
  return async ({ fetcher }: { fetcher: typeof fetch }): Promise<AskAnnouncementResult> => {
    await fetcher('/api/asks/a1/speak', { method: 'POST' }).catch(() => undefined);
    return result;
  };
}
const respondWith = (status: number, body: unknown = {}) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

describe('announceOrWrite', () => {
  beforeEach(() => __resetLucyConversationForTests());
  afterEach(() => vi.unstubAllGlobals());

  test.each([
    ['the speech service is not configured (503)', 503],
    ['the speech service failed (502)', 502],
  ])('no clip because %s: her words are written once, as a finished message from her about that task', async (_label, status) => {
    respondWith(status, { error: 'tts' });
    expect(await announceOrWrite(announcer('error'), () => WORDS)).toBe('error');
    expect(getConversationEntries()).toEqual([
      expect.objectContaining({ kind: 'typed-lucy', status: 'done', text: WORDS.text, taskId: 't1' }),
    ]);
  });

  test('no clip because the server could not be reached: her words are written', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    await announceOrWrite(announcer('error'), () => WORDS);
    expect(getConversationEntries().map((entry) => entry.text)).toEqual([WORDS.text]);
  });

  test('a clip was fetched and then failed to play: nothing is written, because the clip writes its own entry', async () => {
    respondWith(200, { clipId: 'c1', text: 'spoken text', audioBase64: 'UklGRg==' });
    const written = vi.fn(() => WORDS);
    expect(await announceOrWrite(announcer('error'), written)).toBe('error');
    expect(getConversationEntries()).toEqual([]);
    expect(written).not.toHaveBeenCalled();
  });

  test.each(['started', 'muted', 'dnd', 'blocked', 'other-tab', 'cancelled', 'live'] as const)(
    'a result of %s writes nothing', async (result) => {
      respondWith(result === 'cancelled' ? 409 : 200, { clipId: 'c1', text: 'spoken text', audioBase64: 'UklGRg==' });
      const written = vi.fn(() => WORDS);
      expect(await announceOrWrite(announcer(result), written)).toBe(result);
      expect(getConversationEntries()).toEqual([]);
      expect(written).not.toHaveBeenCalled();
    },
  );

  test('the words are asked for only after the failure, and a null answer writes nothing', async () => {
    respondWith(503);
    let closed = false;
    const promise = announceOrWrite(announcer('error'), () => (closed ? null : WORDS));
    closed = true; // the question was answered while the clip was being fetched
    await promise;
    expect(getConversationEntries()).toEqual([]);
  });

  test('an announcer that throws counts as an error, and the words are written', async () => {
    const result = await announceOrWrite(async () => { throw new Error('boom'); }, () => ({ text: 'A task asks: Ship it?' }));
    expect(result).toBe('error');
    expect(getConversationEntries()).toEqual([expect.objectContaining({ text: 'A task asks: Ship it?' })]);
    expect(getConversationEntries()[0]).not.toHaveProperty('taskId');
  });

  test('never throws, even when the words cannot be produced', async () => {
    respondWith(503);
    await expect(announceOrWrite(announcer('error'), () => { throw new Error('no words'); })).resolves.toBe('error');
    expect(getConversationEntries()).toEqual([]);
  });
});

describe('writtenAsk', () => {
  const ask = (over: Partial<OperatorAskView> = {}): OperatorAskView => ({
    id: 'a1', taskId: 't1', taskName: 'Billing migration', question: 'Run the table rename on production now?', options: ['Yes', 'No', 'Later'],
    allowText: false, state: 'pending', createdAt: 1, expiresAt: 2, ...over,
  });

  test('says who asks and the question, without the choices', () => {
    expect(writtenAsk(ask(), [ask()])).toEqual({ text: 'Billing migration asks: Run the table rename on production now?', taskId: 't1' });
  });

  test('a task without a sayable name is "A task"; line breaks in the question become spaces', () => {
    const unnamed = ask({ taskName: undefined, question: 'Ship\n  the migration\nnow?' });
    expect(writtenAsk(unnamed, [unnamed])?.text).toBe('A task asks: Ship the migration now?');
  });

  test('a very long question is cut; the card shows all of it', () => {
    const long = ask({ question: 'word '.repeat(200) });
    const text = writtenAsk(long, [long])!.text;
    expect(text.length).toBeLessThanOrEqual('Billing migration asks: '.length + 300);
    expect(text.endsWith('…')).toBe(true);
  });

  test('a question that is no longer waiting is not written', () => {
    expect(writtenAsk(ask(), [ask({ state: 'answered' })])).toBeNull();
    expect(writtenAsk(ask(), [])).toBeNull();
    expect(writtenAsk(ask(), [ask({ id: 'other' })])).toBeNull();
  });
});

describe('writtenPermissionNotice', () => {
  const card = (promptId: string, taskId: string): LucyPermissionCardView => ({ promptId, taskId, agentId: `kookr-${taskId}`, toolName: 'Bash', command: 'rm -rf build', since: 1 });
  const single: LucyPermissionAnnouncement = { noticeId: 'perm-1', promptIds: ['p1'], text: 'The task "Fix login" is waiting for your permission to use Bash. The command is on my card.' };

  test('is the server\'s sentence, about the one task it names', () => {
    expect(writtenPermissionNotice(single, [card('p1', 't1'), card('p9', 't9')])).toEqual({ text: single.text, taskId: 't1' });
  });

  test('a grouped sentence points at no single task', () => {
    const grouped: LucyPermissionAnnouncement = { noticeId: 'perm-g', promptIds: ['p1', 'p2'], text: 'Two more tasks are waiting for you.' };
    expect(writtenPermissionNotice(grouped, [card('p1', 't1'), card('p2', 't2')])).toEqual({ text: 'Two more tasks are waiting for you.' });
  });

  test('nothing is written once every prompt has been answered, or when an older server sent no sentence', () => {
    expect(writtenPermissionNotice(single, [card('p9', 't9')])).toBeNull();
    expect(writtenPermissionNotice({ noticeId: 'perm-1', promptIds: ['p1'] }, [card('p1', 't1')])).toBeNull();
    expect(writtenPermissionNotice({ ...single, text: '   ' }, [card('p1', 't1')])).toBeNull();
  });
});
