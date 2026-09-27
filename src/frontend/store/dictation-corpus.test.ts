// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';

let corpus: typeof import('./dictation-corpus.js');
const complete = { deliveryId: 'delivery-one', recordingId: 'record-one', ownerToken: 'secret', complete: true, status: 'pending' as const };
beforeEach(async () => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ archive: { status: 'saved', complete: true }, taskId: null }), { status: 200 })));
  corpus = await import('./dictation-corpus.js');
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('dictation launch provenance', () => {
  test('retains insertion facts and raw field snapshots separately; task requires its acknowledgement', async () => {
    corpus.retainDictation({ draftId: 'draft', field: 'prompt', context: 'one' }, 'typed prefix', 'automatic text', complete);
    const id = corpus.submitDictationDraft('draft', [{ field: 'prompt', context: 'one', text: '  corrected text plus typed instruction  ' }]);
    expect(id).toBeTruthy();
    const entry = corpus.listDictationSubmissions()[0];
    expect(entry.fields[0].submittedText).toBe('  corrected text plus typed instruction  ');
    expect(entry.fields[0].recordings[0]).toMatchObject({ beforeText: 'typed prefix', deliveredText: 'automatic text' });
    expect(entry.taskId).toBeUndefined();
    corpus.acknowledgeDictationLaunch('unrelated-submission', 'wrong-task');
    expect(corpus.listDictationSubmissions()[0].taskId).toBeUndefined();
    corpus.acknowledgeDictationLaunch(id!, 'actual-task');
    expect(corpus.listDictationSubmissions()[0].taskId).toBe('actual-task');
    expect(entry.fields[0]).not.toHaveProperty('reference');
  });

  test('deduplicates final delivery and does not select another context or field', () => {
    const owner = { draftId: 'draft', field: 'prompt' as const, context: 'one' };
    corpus.retainDictation(owner, '', 'first', complete);
    corpus.retainDictation(owner, '', 'first', complete);
    corpus.retainDictation({ ...owner, context: 'two' }, '', 'second', { ...complete, deliveryId: 'other', recordingId: 'record-two' });
    expect(corpus.listDictationLinks()).toHaveLength(2);
    expect(corpus.submitDictationDraft('different-draft', [{ field: 'prompt', context: 'one', text: 'wrong' }])).toBeUndefined();
    const id = corpus.submitDictationDraft('draft', [{ field: 'prompt', context: 'one', text: 'corrected' }]);
    expect(corpus.listDictationSubmissions().find(entry => entry.id === id)?.fields[0].recordings.map(link => link.recordingId)).toEqual(['record-one']);
  });

  test('pending save is retried idempotently after module restart', async () => {
    corpus.retainDictation({ draftId: 'draft', field: 'prompt', context: 'one' }, '', 'words', complete);
    const id = corpus.submitDictationDraft('draft', [{ field: 'prompt', context: 'one', text: 'correct words' }])!;
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ error: 'corpus_pending' }), { status: 409 }));
    await corpus.retryDictationCorpus(id);
    expect(corpus.listDictationSubmissions()[0].status).toBe('pending');
    vi.resetModules();
    corpus = await import('./dictation-corpus.js');
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ taskId: null }), { status: 200 }));
    await corpus.retryDictationCorpus(id);
    expect(corpus.listDictationSubmissions()[0].status).toBe('saved');
    const annotations = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/annotations'));
    const operations = annotations.map(([, init]) => JSON.parse(String(init?.body)).operationId);
    expect(new Set(operations).size).toBe(1);
  });

  test('partial and unsupported results stay omitted and never post annotations', async () => {
    corpus.retainDictation({ draftId: 'draft', field: 'prompt', context: 'one' }, '', 'partial', { deliveryId: 'partial', recordingId: null, complete: false, status: 'omitted', reason: 'incomplete_dictation' });
    const id = corpus.submitDictationDraft('draft', [{ field: 'prompt', context: 'one', text: 'partial plus typed' }]);
    expect(id).toBeUndefined();
    await corpus.retryDictationCorpus();
    expect(corpus.listDictationSubmissions()).toEqual([]);
    expect(corpus.listDictationLinks()[0]).toMatchObject({ status: 'omitted', beforeText: '', deliveredText: '', context: '' });
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/annotations'))).toBe(false);
  });

  test('failures and failed launches retain the attempt across reload without attaching a task', async () => {
    corpus.retainDictation({ draftId: 'draft', field: 'criteria', context: 'one' }, '', 'passes', complete);
    const id = corpus.submitDictationDraft('draft', [{ field: 'criteria', context: 'one', text: 'all pass' }])!;
    corpus.acknowledgeDictationLaunch(id, undefined, 'launch failed');
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    await corpus.retryDictationCorpus(id);
    vi.resetModules();
    corpus = await import('./dictation-corpus.js');
    expect(corpus.listDictationSubmissions()[0]).toMatchObject({ status: 'failed', launchError: 'launch failed' });
    expect(corpus.listDictationSubmissions()[0].taskId).toBeUndefined();
  });

  test('multiple clips keep one ordered field list without copying a final prompt into a reference', () => {
    const owner = { draftId: 'draft', field: 'prompt' as const, context: 'one' };
    corpus.retainDictation(owner, 'typed', 'first', complete);
    corpus.retainDictation(owner, 'typed first', 'second', { ...complete, deliveryId: 'second', recordingId: 'record-two' });
    corpus.submitDictationDraft('draft', [{ field: 'prompt', context: 'one', text: 'typed first second then add detail' }]);
    const field = corpus.listDictationSubmissions()[0].fields[0];
    expect(field.recordings.map(record => record.deliveredText)).toEqual(['first', 'second']);
    expect(field.recordings).toHaveLength(2);
    expect(field).not.toHaveProperty('correction');
  });
});

test('an acknowledgement arriving while submission persistence waits is not overwritten', async () => {
  corpus.retainDictation({ draftId: 'draft', field: 'prompt', context: 'one' }, '', 'words', complete);
  const id = corpus.submitDictationDraft('draft', [{ field: 'prompt', context: 'one', text: 'edited' }])!;
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const posting = new Promise<void>(resolve => { entered = resolve; });
  vi.mocked(fetch).mockImplementation(async (url) => {
    if (String(url).endsWith('/annotations')) { entered(); await held; }
    return new Response(JSON.stringify({ taskId: null }), { status: 200 });
  });
  const work = corpus.retryDictationCorpus(id);
  await posting;
  corpus.acknowledgeDictationLaunch(id, 'actual-task');
  release();
  await work;
  expect(corpus.listDictationSubmissions()[0]).toMatchObject({ taskId: 'actual-task', status: 'pending' });
});

test('receipt-only failure remains eligible for durable acknowledgement lookup', async () => {
  corpus.retainDictation({ draftId: 'draft', field: 'prompt', context: 'one' }, '', 'words', complete);
  const id = corpus.submitDictationDraft('draft', [{ field: 'prompt', context: 'one', text: 'edited' }])!;
  corpus.acknowledgeDictationLaunch(id, undefined, 'corpus_task_receipt_pending');
  expect(corpus.listDictationSubmissions()[0].launchError).toBeUndefined();
  vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ taskId: 'actual-task' }), { status: 200 }));
  await corpus.retryDictationCorpus(id);
  expect(corpus.listDictationSubmissions()[0]).toMatchObject({ taskId: 'actual-task', status: 'saved' });
});

test('malformed stored fields and incorrect nested ownership never enter the retry queue', () => {
  const base = { id: 'bad', draftId: 'draft', createdAt: Date.now(), status: 'pending', persisted: true };
  localStorage.setItem('kookr:dictationCorpus:v1:submission:bad', JSON.stringify({ ...base, fields: {} }));
  expect(corpus.listDictationSubmissions()).toEqual([]);
  corpus.retainDictation({ draftId: 'other', field: 'prompt', context: 'one' }, '', 'words', complete);
  localStorage.setItem('kookr:dictationCorpus:v1:submission:bad', JSON.stringify({ ...base, fields: [{ field: 'prompt', submittedText: 'words', recordings: corpus.listDictationLinks() }] }));
  expect(corpus.listDictationSubmissions()).toEqual([]);
});

test('restored incomplete audio can retain candidate edits but never claims completeness', async () => {
  corpus.retainDictation({ draftId: 'draft', field: 'prompt', context: 'one' }, '', 'words', { ...complete, complete: false });
  const id = corpus.submitDictationDraft('draft', [{ field: 'prompt', context: 'one', text: 'edited' }])!;
  vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ taskId: null }), { status: 200 }));
  await corpus.retryDictationCorpus(id);
  expect(corpus.listDictationSubmissions()[0].fields[0].recordings[0].complete).toBe(false);
  expect(corpus.listDictationSubmissions()[0].status).toBe('saved');
});

test('retry storage is bounded when many large submissions are made and never truncates a saved snapshot', () => {
  corpus.retainDictation({ draftId: 'draft', field: 'prompt', context: 'one' }, '', 'words', complete);
  for (let index = 0; index < 60; index++) corpus.submitDictationDraft('draft', [{ field: 'prompt', context: 'one', text: 'x'.repeat(32_000) }]);
  const entries = corpus.listDictationSubmissions();
  expect(JSON.stringify([...corpus.listDictationLinks(), ...entries]).length * 2).toBeLessThan(corpus.MAX_CORPUS_RETRY_BYTES + 2000);
  expect(entries.some(entry => entry.status === 'omitted')).toBe(true);
  for (const entry of entries.filter(item => item.status !== 'omitted')) expect(entry.fields[0].submittedText).toHaveLength(32_000);
});

test('LAN pages without randomUUID still submit a protocol-valid correlation UUID', () => {
  vi.stubGlobal('crypto', undefined);
  corpus.retainDictation({ draftId: 'draft', field: 'prompt', context: 'one' }, '', 'words', complete);
  const id = corpus.submitDictationDraft('draft', [{ field: 'prompt', context: 'one', text: 'edited' }]);
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});


test.each(['collection_disabled', 'unsupported_external_service'])('%s never collects private field content into corpus retry storage', reason => {
  corpus.retainDictation({ draftId: 'draft', field: 'prompt', context: 'private relaunch prompt' }, 'private typed prefix', 'private dictated words', { deliveryId: 'omitted', recordingId: null, complete: false, status: 'omitted', reason });
  expect(corpus.submitDictationDraft('draft', [{ field: 'prompt', context: 'private relaunch prompt', text: 'private submitted correction' }])).toBeUndefined();
  const corpusValues = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!).filter(key => key.startsWith('kookr:dictationCorpus:')).map(key => localStorage.getItem(key)).join('');
  for (const text of ['private relaunch prompt', 'private typed prefix', 'private dictated words', 'private submitted correction']) expect(corpusValues).not.toContain(text);
  expect(corpus.listDictationLinks()[0]).toMatchObject({ status: 'omitted', reason });
  expect(corpus.listDictationSubmissions()).toEqual([]);
});

test.each(['discard', 'delete'])('%s during a delayed acknowledgement lookup cannot resurrect retry data or post annotations', async action => {
  corpus.retainDictation({ draftId: 'draft', field: 'prompt', context: 'one' }, '', 'words', complete);
  const id = corpus.submitDictationDraft('draft', [{ field: 'prompt', context: 'one', text: 'edited' }])!;
  let release!: (response: Response) => void;
  const receipt = new Promise<Response>(resolve => { release = resolve; });
  vi.mocked(fetch).mockImplementation(async url => String(url).endsWith('/task') ? receipt : new Response('{}'));
  const work = corpus.retryDictationCorpus(id);
  await Promise.resolve();
  if (action === 'discard') corpus.discardDictationCorpusEntry(id);
  else corpus.forgetDictationCorpusRecording('record-one');
  expect(corpus.listDictationSubmissions()).toEqual([]);
  release(new Response(JSON.stringify({ taskId: 'created-task' })));
  await work;
  expect(corpus.listDictationSubmissions()).toEqual([]);
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/annotations'))).toBe(false);
});

test('discard during a pending submission POST prevents the following task association POST', async () => {
  corpus.retainDictation({ draftId: 'draft', field: 'prompt', context: 'one' }, '', 'words', complete);
  const id = corpus.submitDictationDraft('draft', [{ field: 'prompt', context: 'one', text: 'edited' }])!;
  corpus.acknowledgeDictationLaunch(id, 'task');
  let release!: (response: Response) => void;
  const annotation = new Promise<Response>(resolve => { release = resolve; });
  vi.mocked(fetch).mockImplementation(async () => annotation);
  const work = corpus.retryDictationCorpus(id);
  await Promise.resolve();
  corpus.discardDictationCorpusEntry(id);
  release(new Response('{}'));
  await work;
  expect(corpus.listDictationSubmissions()).toEqual([]);
  expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
});
