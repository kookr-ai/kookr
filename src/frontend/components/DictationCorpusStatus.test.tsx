// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DictationCorpusStatus } from './DictationCorpusStatus.js';
import type { DictationLink } from '../store/dictation-corpus.js';

const store = vi.hoisted(() => ({ links: [] as DictationLink[] }));
vi.mock('../store/dictation-corpus.js', () => ({
  dictationCorpusVersion: () => 0,
  subscribeDictationCorpus: () => () => {},
  listDictationLinks: () => store.links,
  listDictationSubmissions: () => [],
  retryDictationCorpus: vi.fn(),
  discardDictationCorpusEntry: vi.fn(),
  resumeDictationCorpusRetries: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  store.links = [];
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
async function renderReason(reason: string) {
  store.links = [{ id: 'link-one', deliveryId: 'delivery-one', recordingId: null, complete: false,
    draftId: 'draft-one', field: 'prompt', context: 'context', beforeText: '', deliveredText: '',
    createdAt: Date.now(), persisted: true, status: 'failed', reason }];
  await act(async () => { root.render(<DictationCorpusStatus />); });
}

describe('Dictation archive feedback', () => {
  test('labels the archive feedback as an accessible group', async () => {
    await renderReason('corpus_disk_reserve');
    expect(container.querySelector('[role="group"][aria-label="Dictation archive status"]')).not.toBeNull();
  });

  test.each([
    ['collection_disabled', 'Recording collection is disabled'],
    ['corpus_disk_reserve', 'free disk space'],
    ['corpus_audio_missing_or_invalid', 'original audio is missing'],
    ['corpus_owner_mismatch', 'different draft or field'],
  ])('explains %s in ordinary words', async (code, explanation) => {
    await renderReason(code);
    expect(container.textContent).toContain(explanation);
    expect(container.textContent).not.toContain(code);
  });

  test('keeps useful local explanations and gives unknown codes a readable fallback', async () => {
    await renderReason('Local retry storage limit reached; this content was not retained.');
    expect(container.textContent).toContain('Local retry storage limit reached; this content was not retained.');
    await renderReason('corpus_future_failure');
    expect(container.textContent).toContain('The archive could not retain this recording or its edits');
    expect(container.textContent).not.toContain('corpus_future_failure');
  });
});
