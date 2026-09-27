// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest';

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); vi.resetModules(); });
function draft(recordingId = 'record-one', tabId = 'tab-one') {
  return { recordingId, tabId, audioSha256: 'a'.repeat(64), correction: 'Human correction.',
    status: 'candidate' as const, expectedRevision: 0, played: false, confirmed: false,
    request: { operationId: 'operation-one', kind: 'review' as const, expectedRevision: 0,
      correction: 'Human correction.', status: 'candidate' as const, listened: false } };
}

describe('bounded per-recording review retries', () => {
  test('survives module reload with the exact request and isolates tabs and recording IDs', async () => {
    let store = await import('./dictation-review-drafts.js');
    store.retainDictationReviewDraft(draft());
    vi.resetModules(); store = await import('./dictation-review-drafts.js');
    expect(store.loadDictationReviewDraft('record-one', 'tab-one')?.request).toEqual(draft().request);
    expect(store.loadDictationReviewDraft('record-one', 'tab-two')).toBeNull();
    expect(store.loadDictationReviewDraft('record-two', 'tab-one')).toBeNull();
  });
  test('bounds retry count and text without evicting a pending correction, and expires old drafts', async () => {
    const store = await import('./dictation-review-drafts.js');
    for (let i = 0; i < store.MAX_REVIEW_DRAFTS; i++) expect(store.retainDictationReviewDraft(draft(`record-${i}`)).persisted).toBe(true);
    expect(store.retainDictationReviewDraft(draft('extra'))).toEqual({ persisted: false, reason: 'full' });
    expect(store.loadDictationReviewDraft('record-0', 'tab-one')?.correction).toBe('Human correction.');
    const future = Date.now() + store.REVIEW_DRAFT_TTL_MS + 1;
    vi.spyOn(Date, 'now').mockReturnValue(future);
    expect(store.loadDictationReviewDraft('record-0', 'tab-one')).toBeNull();
    expect(store.retainDictationReviewDraft({ ...draft(), request: null, correction: 'x'.repeat(store.MAX_REVIEW_CORRECTION_CHARS) }).persisted).toBe(true);
    expect(store.retainDictationReviewDraft({ ...draft(), request: null, correction: 'x'.repeat(store.MAX_REVIEW_CORRECTION_CHARS + 1) }).persisted).toBe(false);
  });
  test('keeps a fallback on storage failure and does not resurrect a discarded retry', async () => {
    const store = await import('./dictation-review-drafts.js');
    store.retainDictationReviewDraft(draft());
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(store.retainDictationReviewDraft({ ...draft(), correction: 'New edit.', request: null })).toEqual({ persisted: false, reason: 'storage' });
    expect(store.loadDictationReviewDraft('record-one', 'tab-one')?.correction).toBe('New edit.');
    store.discardDictationReviewDraft('record-one', 'tab-one');
    expect(store.loadDictationReviewDraft('record-one', 'tab-one')).toBeNull();
  });
  test('only clears matching completions and deletion removes all tabs for that recording', async () => {
    const store = await import('./dictation-review-drafts.js');
    store.retainDictationReviewDraft(draft());
    store.retainDictationReviewDraft(draft('record-one', 'tab-two'));
    store.retainDictationReviewDraft(draft('record-two', 'tab-one'));
    expect(store.discardDictationReviewDraft('record-one', 'tab-one', 'old-operation')).toBe(false);
    expect(store.loadDictationReviewDraft('record-one', 'tab-one')).not.toBeNull();
    store.forgetDictationReviewDrafts('record-one');
    expect(store.loadDictationReviewDraft('record-one', 'tab-one')).toBeNull();
    expect(store.loadDictationReviewDraft('record-one', 'tab-two')).toBeNull();
    expect(store.loadDictationReviewDraft('record-two', 'tab-one')).not.toBeNull();
  });
});
