import { afterEach, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createTranscriptionCorpus } from './transcription-corpus.cjs';

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });
const owner = { draftId: 'launch:tab-one:draft', field: 'prompt' };
function record(identity, complete = true) {
  return { id: identity.recordingId, complete, audio: Buffer.from('controlled-fixture-audio'), format: 'wav',
    metadata: { source: 'browser', status: complete ? 'success' : 'error', transcript: 'Original prediction', model: { backend: 'fixture', revision: null },
      language: 'fr', startedAt: new Date().toISOString(), durationSeconds: 1, elapsedMs: 1 } };
}
async function fixture(options = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'corpus-api-'));
  directories.push(directory);
  const env = { KOOKR_STT_CORPUS: 'true', KOOKR_STT_CORPUS_DIR: directory };
  const corpus = createTranscriptionCorpus({ env, logger: { warn: vi.fn() }, ...options });
  const identity = corpus.reserve(owner);
  return { directory, env, corpus, identity };
}
function submission(identity, overrides = {}) {
  return { operationId: 'submit-op', kind: 'submission', ownerToken: identity.ownerToken, ...owner,
    submissionId: 'submission-one', recordingIds: [identity.recordingId], beforeText: 'Typed first',
    deliveredText: 'Original prediction', submittedText: 'Exact edited prompt + typed addition', ...overrides };
}
function review(overrides = {}) {
  return { operationId: 'review-one', kind: 'review', expectedRevision: 0, correction: 'Faithful spoken words', status: 'faithful', listened: true, ...overrides };
}

test('Launch before audio save remains pending, then retries idempotently across service restart', async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const { corpus, identity, env } = await fixture({ fileSystem: { statfs: async (...args) => { await barrier; return fs.statfs(...args); } } });
  const writing = corpus.write(record(identity));
  expect((await corpus.api.get(identity.recordingId)).archive.status).toBe('pending');
  await expect(corpus.api.annotate(identity.recordingId, submission(identity))).rejects.toMatchObject({ message: 'corpus_pending', status: 409 });
  release();
  const originalPath = await writing;
  const originalBytes = await fs.readFile(originalPath);
  const result = await corpus.api.annotate(identity.recordingId, submission(identity));
  expect(result.annotation).toMatchObject({ revision: 1, submittedText: 'Exact edited prompt + typed addition' });
  const restarted = createTranscriptionCorpus({ env });
  expect(await restarted.api.annotate(identity.recordingId, submission(identity))).toMatchObject({ duplicate: true, annotation: { revision: 1 } });
  expect((await restarted.api.get(identity.recordingId)).annotations).toHaveLength(1);
  expect(await fs.readFile(originalPath)).toEqual(originalBytes);
  expect((await fs.stat(path.join(path.dirname(originalPath), 'annotations.json'))).mode & 0o777).toBe(0o600);
});

test('a failed archive never accepts a submission or invents saved state after restart', async () => {
  const { corpus, identity, env } = await fixture({ fileSystem: { writeFile: async () => { throw new Error('private data'); } } });
  expect(await corpus.write(record(identity))).toBeNull();
  expect((await corpus.api.get(identity.recordingId)).archive).toMatchObject({ status: 'failed', reason: 'corpus_write_failed' });
  await expect(corpus.api.annotate(identity.recordingId, submission(identity))).rejects.toMatchObject({ status: 409 });
  await expect(createTranscriptionCorpus({ env }).api.get(identity.recordingId)).rejects.toMatchObject({ status: 404 });
});

test('annotation persistence failure retains the original and can be retried without losing revisions', async () => {
  let failAnnotation = false;
  const { corpus, identity } = await fixture({ fileSystem: { rename: async (from, to) => {
    if (failAnnotation && to.endsWith('annotations.json')) throw new Error('disk failed');
    return fs.rename(from, to);
  } } });
  await corpus.write(record(identity));
  failAnnotation = true;
  await expect(corpus.api.annotate(identity.recordingId, submission(identity))).rejects.toThrow('disk failed');
  expect((await corpus.api.get(identity.recordingId)).annotations).toEqual([]);
  failAnnotation = false;
  expect((await corpus.api.annotate(identity.recordingId, submission(identity))).annotation.revision).toBe(1);
});

test('draft, field, token and related-clip ownership prevent cross-linking concurrent tabs', async () => {
  const { corpus, identity } = await fixture();
  const other = corpus.reserve({ draftId: 'launch:tab-two', field: 'criteria' });
  await Promise.all([corpus.write(record(identity)), corpus.write(record(other))]);
  for (const override of [{ draftId: 'launch:tab-two' }, { field: 'criteria' }, { ownerToken: other.ownerToken }, { recordingIds: [identity.recordingId, other.recordingId] }]) {
    await expect(corpus.api.annotate(identity.recordingId, submission(identity, override))).rejects.toMatchObject({ status: 403 });
  }
  await corpus.api.annotate(identity.recordingId, submission(identity));
  await expect(corpus.api.annotate(identity.recordingId, submission(identity, { submittedText: 'Different retry' }))).rejects.toMatchObject({ message: 'corpus_operation_conflict' });
});

test('task association requires a saved submission and cannot be changed on retry', async () => {
  const { corpus, identity } = await fixture();
  await corpus.write(record(identity));
  const ack = { operationId: 'ack-one', kind: 'task', ownerToken: identity.ownerToken, ...owner, submissionId: 'submission-one', taskId: 'task-acknowledged' };
  await expect(corpus.api.annotate(identity.recordingId, ack)).rejects.toMatchObject({ message: 'corpus_submission_missing' });
  await corpus.api.annotate(identity.recordingId, submission(identity));
  expect((await corpus.api.get(identity.recordingId)).annotations.every((entry) => !entry.taskId)).toBe(true);
  await corpus.api.annotate(identity.recordingId, ack);
  await expect(corpus.api.annotate(identity.recordingId, { ...ack, operationId: 'ack-two', taskId: 'wrong-task' })).rejects.toMatchObject({ message: 'corpus_task_conflict' });
});

test('listening and explicit faithful review export a reference independently of the launch snapshot', async () => {
  const { corpus, identity } = await fixture();
  const originalPath = await corpus.write(record(identity));
  await corpus.api.annotate(identity.recordingId, submission(identity));
  expect(await corpus.api.exportManifest()).toMatchObject({ schemaVersion: 1, verifiedPairs: [], candidates: [{ reference: null }] });
  expect((await corpus.api.audio(identity.recordingId)).bytes.toString()).toBe('controlled-fixture-audio');
  await corpus.api.annotate(identity.recordingId, review());
  const manifest = await corpus.api.exportManifest();
  expect(manifest.candidates).toEqual([]);
  expect(manifest.verifiedPairs[0]).toMatchObject({
    metadata: { transcript: 'Original prediction', model: { backend: 'fixture', revision: null } },
    audio: { sha256: createHash('sha256').update('controlled-fixture-audio').digest('hex') },
    reference: { text: 'Faithful spoken words', reviewRevision: 1 },
    annotations: [expect.objectContaining({ submittedText: 'Exact edited prompt + typed addition' }), expect.objectContaining({ status: 'faithful' })],
  });
  expect(JSON.parse(await fs.readFile(originalPath, 'utf8')).reference).toBeNull();
  expect(JSON.stringify(manifest)).not.toContain(identity.ownerToken);
  expect(JSON.stringify(manifest)).not.toContain('tokenHash');
  await corpus.api.annotate(identity.recordingId, review({ operationId: 'reformulate', expectedRevision: 1, status: 'reformulation' }));
  expect((await corpus.api.exportManifest()).verifiedPairs).toEqual([]);
  await corpus.api.annotate(identity.recordingId, review({ operationId: 'exclude', expectedRevision: 2, status: 'excluded' }));
  expect(await corpus.api.exportManifest()).toMatchObject({ verifiedPairs: [], candidates: [] });
});

test('unchanged prediction requires explicit listening and optimistic revision prevents stale browser saves', async () => {
  const { corpus, identity } = await fixture();
  await corpus.write(record(identity));
  await expect(corpus.api.annotate(identity.recordingId, review({ correction: 'Original prediction', listened: false }))).rejects.toMatchObject({ status: 409 });
  await corpus.api.annotate(identity.recordingId, review({ status: 'candidate', listened: false }));
  await expect(corpus.api.annotate(identity.recordingId, review({ operationId: 'another-tab' }))).rejects.toMatchObject({ message: 'corpus_revision_conflict' });
  expect((await corpus.api.exportManifest()).verifiedPairs).toEqual([]);
});

test.each(['partial', 'missing', 'corrupt'])('%s audio cannot create or retain a verified pair', async (mode) => {
  const { corpus, identity } = await fixture();
  const original = await corpus.write(record(identity, mode !== 'partial'));
  const audio = path.join(path.dirname(original), 'audio.wav');
  if (mode === 'missing') await fs.rm(audio);
  if (mode === 'corrupt') await fs.writeFile(audio, 'different audio');
  await expect(corpus.api.annotate(identity.recordingId, review())).rejects.toMatchObject({ message: 'corpus_faithful_requires_complete_audio' });
  await corpus.api.annotate(identity.recordingId, review({ status: 'candidate', listened: false }));
  expect((await corpus.api.exportManifest()).verifiedPairs).toEqual([]);
});

test('audio disappearing after review removes the pair from verified exports', async () => {
  const { corpus, identity } = await fixture();
  const original = await corpus.write(record(identity));
  await corpus.api.annotate(identity.recordingId, review());
  await fs.rm(path.join(path.dirname(original), 'audio.wav'));
  expect(await corpus.api.exportManifest()).toMatchObject({ verifiedPairs: [], candidates: [{ archive: { status: 'failed', complete: false }, reference: null }] });
});

test('deletion removes audio and annotations and an in-flight archive cannot resurrect it', async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const { corpus, identity, directory } = await fixture({ fileSystem: { rename: async (from, to) => { if (path.basename(from).startsWith('.pending-')) await barrier; return fs.rename(from, to); } } });
  const writing = corpus.write(record(identity));
  await vi.waitFor(async () => expect((await fs.readdir(directory)).length).toBeGreaterThan(0));
  const deletion = corpus.api.remove(identity.recordingId);
  release();
  await Promise.all([writing, deletion]);
  await expect(corpus.api.get(identity.recordingId)).rejects.toMatchObject({ status: 404 });
  expect((await corpus.api.list()).records).toEqual([]);
  const next = corpus.reserve(owner);
  const original = await corpus.write(record(next));
  await corpus.api.annotate(next.recordingId, submission(next));
  await corpus.api.remove(next.recordingId);
  await expect(fs.stat(path.dirname(original))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await corpus.api.remove(next.recordingId)).toEqual({ deleted: true });
});

test('path traversal and directory/file symlinks cannot escape the private corpus', async () => {
  const { corpus, identity, directory } = await fixture();
  const original = await corpus.write(record(identity));
  expect(() => corpus.api.remove('../outside')).toThrow('corpus_invalid_id');
  const outside = await fs.mkdtemp(path.join(tmpdir(), 'corpus-outside-'));
  directories.push(outside);
  await fs.writeFile(path.join(outside, 'keep'), 'must survive', { mode: 0o600 });
  const fakeId = randomUUID();
  await fs.symlink(outside, path.join(path.dirname(path.dirname(original)), fakeId));
  await expect(corpus.api.remove(fakeId)).rejects.toMatchObject({ message: 'corpus_unsafe_directory' });
  expect(await fs.readFile(path.join(outside, 'keep'), 'utf8')).toBe('must survive');
  await fs.rm(path.join(path.dirname(original), 'audio.wav'));
  await fs.symlink(path.join(outside, 'keep'), path.join(path.dirname(original), 'audio.wav'));
  await expect(corpus.api.audio(identity.recordingId)).rejects.toBeDefined();
  await corpus.api.remove(identity.recordingId);
  expect(await fs.readFile(path.join(outside, 'keep'), 'utf8')).toBe('must survive');
  expect(directory).not.toBe(outside);
});

test('disabled collection still reads retained records but refuses annotation writes', async () => {
  const { corpus, identity, env } = await fixture();
  await corpus.write(record(identity));
  const disabled = createTranscriptionCorpus({ env: { ...env, KOOKR_STT_CORPUS: 'false' } });
  expect((await disabled.api.get(identity.recordingId)).archive.status).toBe('saved');
  expect(() => disabled.api.annotate(identity.recordingId, review())).toThrow('collection_disabled');
  expect(await disabled.api.remove(identity.recordingId)).toEqual({ deleted: true });
});

test('bounded annotations reject oversized text, duplicates and untrusted added fields', async () => {
  const { corpus, identity } = await fixture();
  await corpus.write(record(identity));
  for (const body of [submission(identity, { submittedText: 'x'.repeat(32001) }), submission(identity, { recordingIds: [identity.recordingId, identity.recordingId] }), { ...review(), filename: '../outside' }, { ...review(), operationId: 123 }]) {
    expect(() => corpus.api.annotate(identity.recordingId, body)).toThrow();
  }
});

test('HTTP corpus API requires the local proxy header and rejects browser Origins', async () => {
  const { corpus, identity } = await fixture();
  await corpus.write(record(identity));
  const server = createServer(async (req, res) => { if (!await corpus.api.handleHttp(req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/corpus`;
  try {
    expect((await fetch(`${base}/records`)).status).toBe(403);
    expect((await fetch(`${base}/records`, { headers: { 'x-kookr-corpus': '1', Origin: 'https://attacker.example' } })).status).toBe(403);
    const headers = { 'x-kookr-corpus': '1' };
    expect(await (await fetch(`${base}/capabilities`, { headers })).json()).toEqual({ schemaVersion: 1, supported: true, enabled: true });
    expect((await (await fetch(`${base}/records`, { headers })).json()).records).toHaveLength(1);
    const submitted = await fetch(`${base}/records/${identity.recordingId}/annotations`, { method: 'POST', headers, body: JSON.stringify(submission(identity)) });
    expect(submitted.status).toBe(200);
    const oversized = await fetch(`${base}/records/${identity.recordingId}/annotations`, { method: 'POST', headers, body: JSON.stringify({ text: 'x'.repeat(128 * 1024) }) });
    expect(oversized.status).toBe(413);
    const audio = await fetch(`${base}/records/${identity.recordingId}/audio`, { headers });
    expect(audio.headers.get('content-type')).toBe('audio/wav');
    expect(await audio.text()).toBe('controlled-fixture-audio');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('failed deletion keeps retained audio visible and accepts a later retry', async () => {
  let failDelete = true;
  const { corpus, identity } = await fixture({ fileSystem: { rm: async (location, options) => {
    if (failDelete && options?.recursive && /^[a-f0-9-]{36}$/.test(path.basename(location))) throw new Error('disk removal failed');
    return fs.rm(location, options);
  } } });
  await corpus.write(record(identity));
  await expect(corpus.api.remove(identity.recordingId)).rejects.toThrow('disk removal failed');
  expect((await corpus.api.get(identity.recordingId)).archive.status).toBe('saved');
  expect((await corpus.api.list()).records).toHaveLength(1);
  failDelete = false;
  await corpus.api.remove(identity.recordingId);
  expect((await corpus.api.list()).records).toEqual([]);
});

test('export rejects an oversized manifest while smaller review pages remain available', async () => {
  const { corpus, identity } = await fixture();
  await corpus.write(record(identity));
  const large = 'x'.repeat(32000);
  // Controlled sidecars keep this byte-bound regression fast without hundreds
  // of disk-reserve calls; the API still validates and reads every real file.
  for (let i = 0; i < 6; i++) {
    const current = i === 0 ? identity : corpus.reserve(owner);
    if (i !== 0) await corpus.write(record(current));
    const view = await corpus.api.get(current.recordingId);
    const location = path.join(corpus.directory, view.recordedAt.slice(0, 10), view.id, 'annotations.json');
    const annotations = Array.from({ length: 50 }, (_, n) => ({ kind: 'review', status: 'candidate', correction: large, reviewRevision: n + 1 }));
    await fs.writeFile(location, JSON.stringify({ schemaVersion: 1, annotations }), { mode: 0o600 });
  }
  expect((await corpus.api.list({ limit: 1 })).records).toHaveLength(1);
  await expect(corpus.api.exportManifest()).rejects.toMatchObject({ status: 413 });
});

