import { afterEach, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createTranscriptionCorpus, ensureCorpusApiToken, readCorpusApiToken } from './transcription-corpus.cjs';

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

test('HTTP corpus API requires private authentication, proxy marker and no browser Origin', async () => {
  const { corpus, identity, directory } = await fixture();
  const token = await ensureCorpusApiToken(directory);
  await corpus.write(record(identity));
  const server = createServer(async (req, res) => { if (!await corpus.api.handleHttp(req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/corpus`;
  try {
    expect((await fetch(`${base}/records`)).status).toBe(403);
    expect((await fetch(`${base}/records`, { headers: { 'x-kookr-corpus': '1', Origin: 'https://attacker.example' } })).status).toBe(403);
    expect((await fetch(`${base}/records`, { headers: { 'x-kookr-corpus': '1' } })).status).toBe(401);
    const headers = { 'x-kookr-corpus': '1', authorization: `Bearer ${token}` };
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


test('a missing clip after a failed write and restart preserves its position beside a retained owned clip', async () => {
  let failedId;
  const { corpus, identity: failed, env } = await fixture({ fileSystem: { writeFile: async (filename, ...args) => {
    if (failedId && filename.includes(`.pending-${failedId}`)) throw new Error('controlled audio write failure');
    return fs.writeFile(filename, ...args);
  } } });
  failedId = failed.recordingId;
  expect(await corpus.write(record(failed))).toBeNull();
  const saved = corpus.reserve(owner);
  await corpus.write(record(saved));
  const foreign = corpus.reserve({ ...owner, draftId: 'another-draft' });
  await corpus.write(record(foreign));

  const restarted = createTranscriptionCorpus({ env });
  await expect(restarted.api.get(failed.recordingId)).rejects.toMatchObject({ status: 404 });
  const unavailable = [{ recordingId: failed.recordingId, position: 0, reason: 'corpus_write_failed' }];
  const body = submission(saved, { unavailableRecordings: unavailable });
  const result = await restarted.api.annotate(saved.recordingId, body);
  expect(result.annotation).toMatchObject({
    recordingIds: [saved.recordingId], unavailableRecordings: unavailable,
    submittedText: 'Exact edited prompt + typed addition',
  });
  // JSON object key order is not part of an operation's identity.
  const retry = { ...body, unavailableRecordings: [{ reason: 'corpus_write_failed', position: 0, recordingId: failed.recordingId }] };
  expect(await restarted.api.annotate(saved.recordingId, retry)).toMatchObject({ duplicate: true, annotation: { revision: 1 } });
  expect(await createTranscriptionCorpus({ env }).api.annotate(saved.recordingId, body)).toMatchObject({ duplicate: true });
  await expect(restarted.api.annotate(saved.recordingId, { ...body, unavailableRecordings: [{ ...unavailable[0], reason: 'different_loss' }] })).rejects.toMatchObject({ message: 'corpus_operation_conflict' });
  await expect(restarted.api.annotate(saved.recordingId, submission(saved, {
    operationId: 'foreign-link', submissionId: 'foreign-attempt',
    recordingIds: [saved.recordingId, foreign.recordingId], unavailableRecordings: unavailable,
  }))).rejects.toMatchObject({ message: 'corpus_owner_mismatch', status: 403 });
});

test('unavailable membership rejects malformed, overlapping, unordered and unbounded loss reports', async () => {
  const { corpus, identity } = await fixture();
  await corpus.write(record(identity));
  const absentId = randomUUID();
  const valid = { recordingId: absentId, position: 0, reason: 'corpus_not_found' };
  const malformed = [
    null, {}, [null], [{ ...valid, filename: '../outside' }], [{ ...valid, recordingId: '../outside' }],
    [{ ...valid, recordingId: identity.recordingId }], [{ ...valid, position: -1 }], [{ ...valid, position: 32 }],
    [{ ...valid, position: 0.5 }], [{ ...valid, reason: '' }], [{ ...valid, reason: 'x'.repeat(129) }],
    [{ ...valid, reason: 'private text instead of a reason code' }],
    [valid, { ...valid, position: 1 }], [valid, { ...valid, recordingId: randomUUID() }],
    [{ ...valid, position: 2 }, { ...valid, recordingId: randomUUID(), position: 1 }],
    Array.from({ length: 32 }, (_, position) => ({ ...valid, recordingId: randomUUID(), position })),
  ];
  for (const unavailableRecordings of malformed) {
    expect(() => corpus.api.annotate(identity.recordingId, submission(identity, { unavailableRecordings }))).toThrow('corpus_invalid_unavailable_recordings');
  }
  expect((await corpus.api.annotate(identity.recordingId, submission(identity, { unavailableRecordings: [valid] }))).annotation.unavailableRecordings).toEqual([valid]);
});


test('private authentication works across a real network bridge analogue and forwarding headers cannot bypass it', async ({ skip }) => {
  const external = Object.values(networkInterfaces()).flat().find((address) => address.family === 'IPv4' && !address.internal)?.address;
  // Hosts without a non-loopback IPv4 interface still run loopback protocol
  // tests; this bridge analogue requires a real routable local socket.
  if (!external) { skip(); return; }
  const { corpus, identity, directory } = await fixture();
  const token = await ensureCorpusApiToken(directory);
  await corpus.write(record(identity));
  const peers = [];
  const server = createServer(async (req, res) => {
    peers.push(req.socket.remoteAddress);
    if (!await corpus.api.handleHttp(req, res)) { res.writeHead(404); res.end(); }
  });
  server.listen(0, '0.0.0.0');
  await once(server, 'listening');
  const base = `http://${external}:${server.address().port}/corpus`;
  const forwarding = { 'x-kookr-corpus': '1', 'x-forwarded-for': '127.0.0.1', forwarded: 'for="[::1]";proto=http', 'x-real-ip': '::1' };
  const requests = [
    ['/capabilities', 'GET'], ['/records', 'GET'], [`/records/${identity.recordingId}`, 'GET'],
    [`/records/${identity.recordingId}/audio`, 'GET'], ['/export', 'GET'],
    [`/records/${identity.recordingId}/annotations`, 'POST'], [`/records/${identity.recordingId}`, 'DELETE'],
  ];
  try {
    for (const [route, method] of requests) {
      for (const authorization of [undefined, 'Bearer invalid', `Bearer ${'0'.repeat(64)}`, `Bearer ${corpus.configId}`]) {
        const response = await fetch(`${base}${route}`, { method,
          headers: { ...forwarding, ...(authorization ? { authorization } : {}) },
          ...(method === 'POST' ? { body: JSON.stringify(submission(identity)) } : {}) });
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'corpus_authentication_required' });
      }
    }
    expect(peers).toEqual(Array(requests.length * 4).fill(external));
    expect((await corpus.api.get(identity.recordingId)).annotations).toEqual([]);
    const headers = { 'x-kookr-corpus': '1', authorization: `Bearer ${token}` };
    for (const [route, method] of requests) {
      const response = await fetch(`${base}${route}`, { method, headers,
        ...(method === 'POST' ? { body: JSON.stringify(submission(identity)) } : {}) });
      expect(response.status).toBe(200);
      const result = await response.text();
      expect(result).not.toContain(token);
    }
    await expect(corpus.api.get(identity.recordingId)).rejects.toMatchObject({ status: 404 });
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('IPv6 and IPv4-mapped loopback sockets require the same private key', async ({ skip }) => {
  const { corpus, directory } = await fixture();
  const token = await ensureCorpusApiToken(directory);
  const peers = [];
  const server = createServer(async (req, res) => {
    peers.push(req.socket.remoteAddress);
    await corpus.api.handleHttp(req, res);
  });
  try {
    const listening = once(server, 'listening');
    server.listen(0, '::');
    await listening;
  } catch (error) {
    if (error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL') { skip(); return; }
    throw error;
  }
  try {
    for (const host of ['[::1]', '127.0.0.1']) {
      const base = `http://${host}:${server.address().port}/corpus/capabilities`;
      expect((await fetch(base, { headers: { 'x-kookr-corpus': '1' } })).status).toBe(401);
      const response = await fetch(base, { headers: { 'x-kookr-corpus': '1', authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ supported: true });
    }
    expect(peers).toEqual(['::1', '::1', '::ffff:127.0.0.1', '::ffff:127.0.0.1']);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('private API keys publish atomically, converge across initializers and survive service restart', async () => {
  const { directory, corpus, env } = await fixture();
  // A crashed initializer may leave a private temp file, never a final key.
  await fs.writeFile(path.join(directory, '.api-token-crashed'), '', { mode: 0o600 });
  expect(await readCorpusApiToken(directory)).toBeNull();
  const keys = await Promise.all(Array.from({ length: 16 }, () => ensureCorpusApiToken(directory)));
  expect(new Set(keys).size).toBe(1);
  expect(keys[0]).toMatch(/^[a-f0-9]{64}$/);
  expect((await fs.stat(path.join(directory, '.api-token'))).mode & 0o777).toBe(0o600);
  expect((await fs.readdir(directory)).sort()).toEqual(['.api-token', '.api-token-crashed']);
  expect(await corpus.api.initialize()).toBe(true);
  expect(await createTranscriptionCorpus({ env }).api.initialize()).toBe(true);
  expect(await readCorpusApiToken(directory)).toBe(keys[0]);
  expect(JSON.stringify(await corpus.api.exportManifest())).not.toContain(keys[0]);
});

test('unsafe key permissions, symlinks, contents and ownership never become API credentials', async () => {
  const { directory } = await fixture();
  const keyPath = path.join(directory, '.api-token');
  await ensureCorpusApiToken(directory);
  await fs.chmod(keyPath, 0o644);
  await expect(readCorpusApiToken(directory)).rejects.toThrow('corpus_api_token_unsafe');
  await expect(ensureCorpusApiToken(directory)).rejects.toThrow('corpus_api_token_unsafe');
  await fs.chmod(keyPath, 0o600);
  await fs.writeFile(keyPath, 'z'.repeat(64));
  await expect(readCorpusApiToken(directory)).rejects.toThrow('corpus_api_token_unsafe');
  await fs.rm(keyPath);
  const outside = path.join(directory, 'outside-key');
  await fs.writeFile(outside, 'a'.repeat(64), { mode: 0o600 });
  await fs.symlink(outside, keyPath);
  await expect(readCorpusApiToken(directory)).rejects.toThrow('corpus_api_token_unsafe');
  await expect(ensureCorpusApiToken(directory)).rejects.toThrow('corpus_api_token_unsafe');
  expect(await fs.readFile(outside, 'utf8')).toBe('a'.repeat(64));
  await fs.rm(keyPath);
  await ensureCorpusApiToken(directory);
  if (typeof process.getuid === 'function') {
    await expect(readCorpusApiToken(directory, { fileSystem: { lstat: async (...args) => {
      const stat = await fs.lstat(...args); stat.uid = process.getuid() + 1; return stat;
    } } })).rejects.toThrow('corpus_api_token_unsafe');
    await expect(readCorpusApiToken(directory, { fileSystem: { open: async (...args) => {
      const handle = await fs.open(...args);
      return { stat: async () => { const stat = await handle.stat(); stat.uid = process.getuid() + 1; return stat; },
        readFile: (...readArgs) => handle.readFile(...readArgs), close: () => handle.close() };
    } } })).rejects.toThrow('corpus_api_token_unsafe');
  }
});

test('disabled collection never creates a key, and authentication failures do not block archival', async () => {
  const { directory, env, identity } = await fixture();
  const disabled = createTranscriptionCorpus({ env: { ...env, KOOKR_STT_CORPUS: 'false' } });
  expect(await disabled.api.initialize()).toBe(false);
  expect(await fs.readdir(directory)).toEqual([]);
  expect(await readCorpusApiToken(path.join(directory, 'absent'))).toBeNull();
  expect(await fs.readdir(directory)).toEqual([]);
  const failedKey = createTranscriptionCorpus({ env, fileSystem: { link: async () => { throw new Error('controlled key publication failure'); } } });
  expect(await failedKey.api.initialize()).toBe(false);
  expect(await fs.readdir(directory)).toEqual([]);
  const recording = failedKey.reserve(owner);
  expect(await failedKey.write(record(recording))).not.toBeNull();
  expect((await failedKey.api.get(recording.recordingId)).metadata.transcript).toBe('Original prediction');
  expect(identity.recordingId).not.toBe(recording.recordingId);
  const token = await ensureCorpusApiToken(directory);
  const readOnlyIo = Object.fromEntries(['mkdir', 'writeFile', 'link', 'rm'].map((name) => [name, vi.fn()]));
  const disabledRestarted = createTranscriptionCorpus({ env: { ...env, KOOKR_STT_CORPUS: 'false' }, fileSystem: readOnlyIo });
  expect(await disabledRestarted.api.initialize()).toBe(true);
  for (const operation of Object.values(readOnlyIo)) expect(operation).not.toHaveBeenCalled();
  expect(await readCorpusApiToken(directory)).toBe(token);
});


test('transient credential publication failure recovers on retry while a loaded key stays stable', async () => {
  const { directory, env } = await fixture();
  let failPublication = true;
  const link = vi.fn(async (...args) => {
    if (failPublication) throw new Error('controlled temporary publication failure');
    return fs.link(...args);
  });
  const corpus = createTranscriptionCorpus({ env, fileSystem: { link } });
  expect(await corpus.api.initialize()).toBe(false);
  expect(await readCorpusApiToken(directory)).toBeNull();
  failPublication = false;
  expect(await corpus.api.initialize()).toBe(true);
  const saved = await readCorpusApiToken(directory);
  expect(saved).toMatch(/^[a-f0-9]{64}$/);
  expect(link).toHaveBeenCalledTimes(2);
  failPublication = true;
  expect(await corpus.api.initialize()).toBe(true);
  expect(await readCorpusApiToken(directory)).toBe(saved);
  expect(link).toHaveBeenCalledTimes(2);
});
