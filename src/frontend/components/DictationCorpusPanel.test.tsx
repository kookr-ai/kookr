// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DictationCorpusPanel } from './DictationCorpusPanel.js';
import { forgetDictationCorpusRecording } from '../store/dictation-corpus.js';

vi.mock('./DictationCorpusStatus.js', () => ({ DictationCorpusStatus: () => null }));
vi.mock('../store/dictation-corpus.js', () => ({ forgetDictationCorpusRecording: vi.fn() }));

const id = 'c9258892-fb57-47bb-9e62-dc462da83050';
function recording(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, id, recordedAt: '2026-09-27T09:00:00.000Z',
    metadata: { source: 'browser', transcript: 'Original prediction.', status: 'success',
      model: { name: 'test-recognizer', revision: 'fixture-revision' }, language: 'fr' },
    audio: { filename: 'audio.wav', bytes: 32044, sha256: 'a'.repeat(64) },
    owner: { draftId: 'draft-one', field: 'prompt' }, reference: null,
    archive: { status: 'saved', complete: true }, audioAvailable: true, reviewRevision: 0,
    annotations: [{ kind: 'submission', revision: 1, operationId: 'submit-op', createdAt: '2026-09-27T09:01:00Z',
      draftId: 'draft-one', field: 'prompt', submissionId: 'submission-one', recordingIds: [id],
      beforeText: 'Typed before.', deliveredText: 'Original prediction.', submittedText: 'Edited prompt plus typed addition.' },
    { kind: 'task', revision: 2, operationId: 'task-op', createdAt: '2026-09-27T09:02:00Z',
      draftId: 'draft-one', field: 'prompt', submissionId: 'submission-one', taskId: 'task-one' }],
    ...overrides,
  };
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let container: HTMLDivElement;
let root: Root;
let currentRecord = recording();
let postCalls: Record<string, unknown>[];
let deletes: string[];
let responseForPost: ((body: Record<string, unknown>) => Response) | undefined;

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function click(label: string) { await act(async () => { button(label).click(); }); await flush(); }
async function input(value: string) {
  await act(async () => {
    const node = container.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function status(value: string) {
  await act(async () => {
    const node = container.querySelector<HTMLSelectElement>('[aria-label="Review status"]')!;
    node.value = value;
    node.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function render() { await act(async () => { root.render(<DictationCorpusPanel />); }); await flush(); }

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  currentRecord = recording(); postCalls = []; deletes = []; responseForPost = undefined;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/capabilities')) return json({ schemaVersion: 1, supported: true, enabled: true });
    if (url.includes('/records?')) return json({ schemaVersion: 1, records: [currentRecord], truncated: false });
    if (url.endsWith(`/records/${id}`) && init?.method === 'DELETE') { deletes.push(url); return json({ deleted: true }); }
    if (url.endsWith(`/records/${id}`)) return json(currentRecord);
    if (url.endsWith('/annotations')) {
      const body = JSON.parse(String(init?.body)); postCalls.push(body);
      if (responseForPost) return responseForPost(body);
      return json({ schemaVersion: 1, duplicate: false, annotation: { ...body, revision: 3, reviewRevision: 1, createdAt: '2026-09-27T10:00:00Z' } });
    }
    if (url.endsWith('/export')) return json({ schemaVersion: 1, verifiedPairs: [], candidates: [currentRecord] });
    throw new Error(`Unexpected fetch ${url}`);
  }));
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('R19.5 later dictation review', () => {
  test('keeps the original prediction and submitted field separate from the per-clip correction', async () => {
    await render();
    expect(container.textContent).toContain('Original prediction.');
    expect(container.textContent).toContain('Edited prompt plus typed addition.');
    expect(container.textContent).toContain('task-one');
    expect(container.textContent).toContain('fixture-revision');
    expect(container.querySelector('textarea')?.value).toBe('Original prediction.');
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Review status"]')?.value).toBe('candidate');
    await input('Faithful correction.');
    await click('Save review');
    expect(postCalls[0]).toMatchObject({ kind: 'review', correction: 'Faithful correction.', status: 'candidate', listened: false, expectedRevision: 0 });
    expect(postCalls[0]).not.toHaveProperty('submittedText');
    expect(container.textContent).toContain('Original prediction.');
    expect(container.textContent).toContain('Edited prompt plus typed addition.');
  });

  test('requires playback and explicit listening confirmation for a faithful reference', async () => {
    await render(); await status('faithful');
    expect(button('Save review').disabled).toBe(true);
    const confirmation = container.querySelector<HTMLInputElement>('[aria-label="I listened to this recording and confirm the correction faithfully transcribes it"]')!;
    expect(confirmation.disabled).toBe(true);
    await act(async () => { container.querySelector('audio')!.dispatchEvent(new Event('ended', { bubbles: true })); });
    expect(confirmation.disabled).toBe(false);
    expect(button('Save review').disabled).toBe(true);
    await act(async () => { confirmation.click(); });
    await click('Save review');
    expect(postCalls[0]).toMatchObject({ status: 'faithful', listened: true });
  });

  test.each([
    { archive: { status: 'saved', complete: false } },
    { audioAvailable: false },
    { audio: null, archive: { status: 'omitted', complete: false, reason: 'corpus_audio_too_large' } },
  ])('never verifies incomplete or unavailable audio (%j)', async (overrides) => {
    currentRecord = recording(overrides); await render(); await status('faithful');
    expect(button('Save review').disabled).toBe(true);
    expect(container.textContent).toContain('cannot become a verified audio/reference pair');
  });

  test('saves reviews on an HTTP LAN page without crypto.randomUUID', async () => {
    vi.stubGlobal('crypto', {});
    await render(); await input('Correction from a LAN page.'); await click('Save review');
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.operationId).toMatch(/^[A-Za-z0-9_.:-]{1,128}$/);
    expect(postCalls[0]?.correction).toBe('Correction from a LAN page.');
    expect(container.textContent).toContain('Review saved');
    expect(button('Save review').disabled).toBe(false);
  });

  test('releases the save button if preparing a review request fails', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => { throw new Error('ID source unavailable'); } });
    await render(); await click('Save review');
    expect(postCalls).toHaveLength(0);
    expect(container.textContent).toContain('Review was not confirmed saved');
    expect(button('Save review').disabled).toBe(false);
  });

  test('retains the same operation ID after a lost response so retry cannot duplicate a review', async () => {
    responseForPost = () => { throw new Error('Connection lost'); };
    await render(); await input('Correction retained.'); await click('Save review');
    expect(container.querySelector('textarea')?.value).toBe('Correction retained.');
    responseForPost = undefined; await click('Save review');
    expect(postCalls).toHaveLength(2);
    expect(postCalls[0]?.operationId).toBe(postCalls[1]?.operationId);
  });

  test('preserves the local correction on a concurrent revision conflict and requires explicit reconciliation', async () => {
    await render(); await input('My correction.');
    currentRecord = recording({ reviewRevision: 1, annotations: [{ kind: 'review', operationId: 'other', correction: 'Other tab correction.', status: 'candidate', listened: false, revision: 1, reviewRevision: 1, createdAt: '2026-09-27T10:00:00Z' }] });
    responseForPost = () => json({ error: 'corpus_revision_conflict' }, 409);
    await click('Save review');
    expect(container.querySelector('textarea')?.value).toBe('My correction.');
    expect(container.textContent).toContain('Other tab correction.');
    expect(button('Save review').disabled).toBe(true);
    await click('Keep my correction as the next revision');
    responseForPost = undefined; await click('Save review');
    expect(postCalls[1]).toMatchObject({ expectedRevision: 1, correction: 'My correction.' });
    expect(postCalls[1]?.operationId).not.toBe(postCalls[0]?.operationId);
  });

  test('requires renewed confirmation when correction changes and rejects an audio playback failure', async () => {
    await render(); await status('faithful');
    const confirmation = container.querySelector<HTMLInputElement>('[aria-label="I listened to this recording and confirm the correction faithfully transcribes it"]')!;
    await act(async () => {
      container.querySelector('audio')!.dispatchEvent(new Event('ended', { bubbles: true }));
    });
    await act(async () => { confirmation.click(); });
    expect(button('Save review').disabled).toBe(false);
    await input('Changed after confirmation.');
    expect(confirmation.checked).toBe(false);
    expect(button('Save review').disabled).toBe(true);
    await act(async () => { confirmation.click(); });
    await act(async () => {
      container.querySelector('audio')!.dispatchEvent(new Event('error', { bubbles: true }));
    });
    expect(confirmation.checked).toBe(false);
    expect(confirmation.disabled).toBe(true);
    expect(button('Save review').disabled).toBe(true);
  });

  test('reports unsupported service without pretending a local corpus exists', async () => {
    vi.mocked(fetch).mockImplementation(async () => json({ schemaVersion: 1, supported: false, enabled: false, reason: 'external_service_unsupported' }));
    await render();
    expect(container.textContent).toContain('does not support corpus review');
    expect(container.querySelector('audio')).toBeNull();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  test('distinguishes disabled speech from an unsupported external service', async () => {
    vi.mocked(fetch).mockImplementation(async () => json({ schemaVersion: 1, supported: false, enabled: false, reason: 'disabled' }));
    await render();
    expect(container.textContent).toContain('speech service is disabled');
    expect(container.textContent).not.toContain('does not support corpus review');
  });

  test('keeps playback available but disables review saving when collection is disabled', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, init) => String(url).endsWith('/capabilities')
      ? Promise.resolve(json({ schemaVersion: 1, supported: true, enabled: false })) : original(url, init));
    await render();
    expect(container.textContent).toContain('Collection is disabled');
    expect(container.querySelector('audio')).not.toBeNull();
    expect(button('Save review').disabled).toBe(true);
    expect(container.querySelector('textarea')?.disabled).toBe(true);
  });

  test('requires a distinct explicit deletion action and removes only the selected example', async () => {
    await render(); await click('Delete example'); expect(deletes).toHaveLength(0);
    expect(container.textContent).toContain('original audio and all annotations');
    await click('Delete this recording permanently');
    expect(deletes).toEqual([`/api/stt/corpus/records/${id}`]);
    expect(forgetDictationCorpusRecording).toHaveBeenCalledWith(id);
    expect(container.querySelector('audio')).toBeNull();
  });

  test('reports the manifest bound instead of suggesting a retry will fix it', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, init) => String(url).endsWith('/export')
      ? Promise.resolve(json({ error: 'corpus_export_too_large' }, 413)) : original(url, init));
    await render(); await click('Export manifest');
    expect(container.textContent).toContain('exceeds the manifest export limit');
  });

  test('downloads the versioned manifest and explains the verified/candidate separation', async () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:fixture');
    vi.stubGlobal('URL', class extends URL { static createObjectURL = createObjectURL; static revokeObjectURL = vi.fn(); });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await render(); await click('Export manifest');
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(container.textContent).toContain('0 verified pairs');
    expect(container.textContent).toContain('0 candidates');
    async function downloadedManifest(index: number) {
      const blob = createObjectURL.mock.calls[index]![0] as Blob;
      const value = await new Promise<string>((resolve) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob);
      });
      return JSON.parse(value);
    }
    expect(await downloadedManifest(0)).toMatchObject({ schemaVersion: 1, verifiedPairs: [], candidates: [] });
    await act(async () => {
      const selection = container.querySelector<HTMLSelectElement>('[aria-label="Export selection"]')!;
      selection.value = 'all'; selection.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click('Export manifest');
    expect(container.textContent).toContain('1 candidates');
    expect((await downloadedManifest(1)).candidates[0].audio.sha256).toBe('a'.repeat(64));
  });
});
