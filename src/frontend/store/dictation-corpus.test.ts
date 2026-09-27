// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';

let corpus: typeof import('./dictation-corpus.js');
const complete = { deliveryId: 'delivery-one', recordingId: 'record-one', ownerToken: 'secret', complete: true, status: 'pending' as const };
beforeEach(async () => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ archive: { status: 'saved', complete: true }, taskId: null }), { status: 200 })));
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
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ taskId: null, archive: { status: 'saved', complete: true } }), { status: 200 }));
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
    return new Response(JSON.stringify({ taskId: null, archive: { status: 'saved', complete: true } }), { status: 200 });
  });
  const work = corpus.retryDictationCorpus(id);
  await posting;
  corpus.acknowledgeDictationLaunch(id, 'actual-task');
  release();
  await work;
  expect(corpus.listDictationSubmissions()[0]).toMatchObject({ taskId: 'actual-task', status: 'saved' });
  expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.body && JSON.parse(String(init.body)).kind === 'task')).toBe(true);
});

test('receipt-only failure remains eligible for durable acknowledgement lookup', async () => {
  corpus.retainDictation({ draftId: 'draft', field: 'prompt', context: 'one' }, '', 'words', complete);
  const id = corpus.submitDictationDraft('draft', [{ field: 'prompt', context: 'one', text: 'edited' }])!;
  corpus.acknowledgeDictationLaunch(id, undefined, 'corpus_task_receipt_pending');
  expect(corpus.listDictationSubmissions()[0].launchError).toBeUndefined();
  vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ taskId: 'actual-task', archive: { status: 'saved', complete: true } }), { status: 200 }));
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
  vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ taskId: null, archive: { status: 'saved', complete: true } }), { status: 200 }));
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
  let entered!: () => void;
  const posting = new Promise<void>(resolve => { entered = resolve; });
  vi.mocked(fetch).mockImplementation(async url => {
    if (String(url).endsWith('/annotations')) { entered(); return annotation; }
    return new Response(JSON.stringify({ archive: { status: 'saved', complete: true } }));
  });
  const work = corpus.retryDictationCorpus(id);
  await posting;
  corpus.discardDictationCorpusEntry(id);
  release(new Response('{}'));
  await work;
  expect(corpus.listDictationSubmissions()).toEqual([]);
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/annotations'))).toHaveLength(1);
});

function retainPair() {
  const owner = { draftId: 'draft', field: 'prompt' as const, context: 'one' };
  corpus.retainDictation(owner, '', 'first prediction', complete);
  corpus.retainDictation(owner, 'first prediction', 'second prediction', { ...complete, deliveryId: 'second', recordingId: 'record-two' });
  return corpus.submitDictationDraft('draft', [{ field: 'prompt', context: 'one', text: 'exact corrected field with typed additions' }])!;
}
function postedAnnotations() {
  return vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/annotations')).map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> }));
}

test.each([200, 404, 410])('a failed first recording (%s) preserves the saved sibling and freezes its omission across reload', async status => {
  const id = retainPair();
  corpus.acknowledgeDictationLaunch(id, 'created-task');
  vi.mocked(fetch).mockImplementation(async url => {
    if (String(url).endsWith('/records/record-one')) return new Response(JSON.stringify({ archive: { status: 'failed', complete: false }, error: 'corpus_not_found' }), { status });
    return new Response(JSON.stringify({ archive: { status: 'saved', complete: true }, audioAvailable: true }));
  });
  await corpus.retryDictationCorpus(id);
  const first = postedAnnotations();
  expect(first).toHaveLength(2);
  expect(first.every(post => post.url.includes('record-two'))).toBe(true);
  const reason = status === 200 ? 'corpus_archive_failed' : status === 404 ? 'corpus_not_found' : 'corpus_gone';
  expect(first[0].body).toMatchObject({ recordingIds: ['record-two'], unavailableRecordings: [{ recordingId: 'record-one', position: 0, reason }], submittedText: 'exact corrected field with typed additions' });
  expect(first[1].body).toMatchObject({ kind: 'task', taskId: 'created-task' });
  expect(corpus.listDictationSubmissions()[0].status).toBe('failed');
  vi.resetModules();
  corpus = await import('./dictation-corpus.js');
  vi.mocked(fetch).mockClear().mockImplementation(async () => new Response('{}'));
  await corpus.retryDictationCorpus(id);
  expect(postedAnnotations()).toEqual(first);
  expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).endsWith('/annotations'))).toBe(true);
});

test('an annotation failure for the first retained clip does not suppress another clip or criteria field', async () => {
  const id = retainPair();
  const raw = corpus.listDictationSubmissions()[0];
  corpus.retainDictation({ draftId: 'draft', field: 'criteria', context: 'criteria' }, '', 'pass', { ...complete, deliveryId: 'criteria', recordingId: 'record-criteria' });
  corpus.discardDictationCorpusEntry(id);
  const actualId = corpus.submitDictationDraft('draft', [{ field: 'prompt', context: 'one', text: raw.fields[0].submittedText }, { field: 'criteria', context: 'criteria', text: 'all tests pass' }])!;
  corpus.acknowledgeDictationLaunch(actualId, 'created-task');
  vi.mocked(fetch).mockImplementation(async url => String(url).endsWith('/records/record-one/annotations')
    ? new Response(JSON.stringify({ error: 'disk_write_failed' }), { status: 500 })
    : new Response(JSON.stringify({ archive: { status: 'saved', complete: true }, audioAvailable: true })));
  await corpus.retryDictationCorpus(actualId);
  const posts = postedAnnotations();
  expect(posts.filter(post => post.url.includes('record-two')).map(post => post.body.kind)).toEqual(['submission', 'task']);
  expect(posts.filter(post => post.url.includes('record-criteria')).map(post => post.body.kind)).toEqual(['submission', 'task']);
  expect(posts.find(post => post.url.includes('record-two'))?.body.recordingIds).toEqual(['record-one', 'record-two']);
  expect(corpus.listDictationSubmissions()[0].status).toBe('failed');
});

test.each(['pending', 'network', 'http'])('a %s preflight never freezes a temporary absence into the submission', async outcome => {
  const id = retainPair();
  vi.mocked(fetch).mockImplementation(async url => {
    if (String(url).endsWith('/records/record-one')) {
      if (outcome === 'network') throw new Error('network unavailable');
      if (outcome === 'http') return new Response(JSON.stringify({ error: 'temporarily_unavailable' }), { status: 503 });
      return new Response(JSON.stringify({ archive: { status: 'pending', complete: true } }));
    }
    return new Response(JSON.stringify({ taskId: null, archive: { status: 'saved', complete: true } }));
  });
  await corpus.retryDictationCorpus(id);
  expect(corpus.listDictationSubmissions()[0].fields[0].archiveMembership).toBeUndefined();
  expect(postedAnnotations()).toEqual([]);
  vi.mocked(fetch).mockClear().mockImplementation(async () => new Response(JSON.stringify({ taskId: null, archive: { status: 'saved', complete: true } })));
  await corpus.retryDictationCorpus(id);
  expect(postedAnnotations()).toHaveLength(2);
  for (const post of postedAnnotations()) {
    expect(post.body.recordingIds).toEqual(['record-one', 'record-two']);
    expect(post.body.unavailableRecordings).toBeUndefined();
  }
});

test('browser quota failures preserve bounded in-tab edits and failed deletion cannot resurrect stored data', async () => {
  const originalSet = Storage.prototype.setItem;
  const originalRemove = Storage.prototype.removeItem;
  try {
    Storage.prototype.setItem = vi.fn(() => { throw new Error('QuotaExceededError'); });
    const id = retainPair();
    expect(corpus.listDictationSubmissions()[0]).toMatchObject({ persisted: false });
    await corpus.retryDictationCorpus(id);
    expect(corpus.listDictationSubmissions()[0]).toMatchObject({ persisted: false, status: 'saved' });
    expect(postedAnnotations()[0].body.submittedText).toBe('exact corrected field with typed additions');
    Storage.prototype.setItem = originalSet;
    corpus.acknowledgeDictationLaunch(id, 'task');
    expect(corpus.listDictationSubmissions()[0].persisted).toBe(true);
    Storage.prototype.removeItem = vi.fn(() => { throw new Error('SecurityError'); });
    corpus.discardDictationCorpusEntry(id);
    expect(corpus.listDictationSubmissions()).toEqual([]);
    await corpus.retryDictationCorpus(id);
    expect(corpus.listDictationSubmissions()).toEqual([]);
  } finally { Storage.prototype.setItem = originalSet; Storage.prototype.removeItem = originalRemove; }
});
