'use strict';

// The speech service owns audio and sidecars. Callers supply UUIDs, never paths.
const path = require('node:path');
const { constants } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/;
const TYPES = { wav: 'audio/wav', ogg: 'audio/ogg', mp3: 'audio/mpeg', mp4: 'audio/mp4', m4a: 'audio/mp4', webm: 'audio/webm', flac: 'audio/flac', aac: 'audio/aac', bin: 'application/octet-stream' };
const MAX_BODY = 128 * 1024;
const MAX_RESPONSE = 8 * 1024 * 1024;
const MAX_SIDECAR = 2 * 1024 * 1024;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function fail(code, status = 400) { throw Object.assign(new Error(code), { status }); }
function idCheck(id) { if (!UUID.test(id)) fail('corpus_invalid_id'); }
function privateStat(stat, directory) {
  return (directory ? stat.isDirectory() : stat.isFile())
    && (stat.mode & 0o777) === (directory ? 0o700 : 0o600)
    && (typeof process.getuid !== 'function' || stat.uid === process.getuid());
}
function publicOwner(owner) { return owner ? { draftId: owner.draftId, field: owner.field } : null; }

function createCorpusApi({ config, io, reservations, flush }) {
  let mutations = Promise.resolve();
  let queued = 0;

  async function directorySafe(directory) {
    const stat = await io.lstat(directory);
    if (stat.isSymbolicLink() || !privateStat(stat, true)) fail('corpus_unsafe_directory', 409);
  }

  async function readPrivate(filename, maximum) {
    // O_NOFOLLOW closes the file-symlink gap between validating and opening it.
    const handle = await io.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!privateStat(stat, false) || stat.size > maximum) fail('corpus_unsafe_file', 409);
      return await handle.readFile();
    } finally { await handle.close(); }
  }

  async function dates() {
    try { await directorySafe(config.directory); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return (await io.readdir(config.directory)).filter((name) => DATE.test(name)).sort().reverse();
  }

  async function locate(id) {
    idCheck(id);
    for (const date of await dates()) {
      const day = path.join(config.directory, date);
      await directorySafe(day);
      const location = path.join(day, id);
      try { await directorySafe(location); return location; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return null;
  }

  async function documentAt(location) {
    const record = JSON.parse((await readPrivate(path.join(location, 'record.json'), 300 * 1024)).toString());
    if (record.schemaVersion !== 1 || record.id !== path.basename(location)
      || !record.metadata || !record.audio || !/^audio\.(wav|ogg|mp3|mp4|m4a|webm|flac|aac|bin)$/.test(record.audio.filename)
      || !/^[a-f0-9]{64}$/.test(record.audio.sha256)
      || !Number.isInteger(record.audio.bytes) || record.audio.bytes < 0 || record.audio.bytes > 25 * 1024 * 1024) {
      fail('corpus_invalid_record', 409);
    }
    return record;
  }

  async function sidecarAt(location) {
    try {
      const saved = JSON.parse((await readPrivate(path.join(location, 'annotations.json'), MAX_SIDECAR)).toString());
      if (saved.schemaVersion !== 1 || !Array.isArray(saved.annotations) || saved.annotations.length > 256) fail('corpus_invalid_annotations', 409);
      return saved.annotations;
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }

  async function audioAt(location, record) {
    const bytes = await readPrivate(path.join(location, record.audio.filename), 25 * 1024 * 1024);
    if (bytes.length !== record.audio.bytes || hash(bytes) !== record.audio.sha256) fail('corpus_audio_mismatch', 409);
    return bytes;
  }

  async function viewAt(location) {
    const record = await documentAt(location);
    const annotations = await sidecarAt(location);
    let audioAvailable = false;
    let reason;
    try { await audioAt(location, record); audioAvailable = true; }
    catch { reason = 'corpus_audio_missing_or_invalid'; }
    const complete = record.complete ?? (record.metadata.status === 'success');
    return {
      ...record, owner: publicOwner(record.owner), reference: null,
      archive: { status: audioAvailable ? 'saved' : 'failed', complete: complete && audioAvailable, ...(reason ? { reason } : {}) },
      audioAvailable, annotations,
      reviewRevision: annotations.filter((item) => item.kind === 'review').length,
    };
  }

  async function get(id) {
    idCheck(id);
    const state = reservations.get(id);
    if (state?.deleted) fail('corpus_not_found', 404);
    const location = await locate(id);
    if (location) return viewAt(location);
    if (state) return {
      schemaVersion: 1, id, recordedAt: state.recordedAt, metadata: state.metadata,
      audio: null, reference: null, owner: publicOwner(state.owner), annotations: [], reviewRevision: 0,
      audioAvailable: false,
      archive: { status: state.status, complete: state.complete, ...(state.reason ? { reason: state.reason } : {}) },
    };
    fail('corpus_not_found', 404);
  }

  async function list({ offset = 0, limit = 200 } = {}) {
    if (!Number.isInteger(offset) || offset < 0 || offset > 100000 || !Number.isInteger(limit) || limit < 1 || limit > 200) fail('corpus_invalid_pagination');
    const result = [];
    let seen = 0;
    let bytes = 128; // JSON envelope and commas.
    for (const date of await dates()) {
      const day = path.join(config.directory, date);
      await directorySafe(day);
      for (const id of (await io.readdir(day)).filter((name) => UUID.test(name)).sort()) {
        if (seen++ < offset) continue;
        if (result.length >= limit) return { schemaVersion: 1, records: result, truncated: true };
        const location = path.join(day, id);
        await directorySafe(location);
        const view = await viewAt(location);
        bytes += Buffer.byteLength(JSON.stringify(view)) + 1;
        if (bytes > MAX_RESPONSE) fail('corpus_response_limit', 413);
        result.push(view);
      }
    }
    return { schemaVersion: 1, records: result, truncated: false };
  }

  function mutate(work) {
    if (queued >= 32) return Promise.reject(Object.assign(new Error('corpus_queue_full'), { status: 429 }));
    queued++;
    const operation = mutations.then(work).finally(() => { queued--; });
    mutations = operation.catch(() => {});
    return operation;
  }

  function validateBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.operationId !== 'string' || !IDENTIFIER.test(body.operationId)) fail('corpus_invalid_annotation');
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY) fail('corpus_payload_too_large', 413);
    const common = ['operationId', 'kind'];
    const ownerFields = ['ownerToken', 'draftId', 'field', 'submissionId'];
    const permitted = body.kind === 'submission' ? [...common, ...ownerFields, 'recordingIds', 'unavailableRecordings', 'beforeText', 'deliveredText', 'submittedText']
      : body.kind === 'task' ? [...common, ...ownerFields, 'taskId']
        : body.kind === 'review' ? [...common, 'expectedRevision', 'correction', 'status', 'listened'] : [];
    if (!permitted.length || Object.keys(body).some((key) => !permitted.includes(key))) fail('corpus_invalid_annotation');
    const text = (value) => typeof value === 'string' && value.length <= 32000;
    if (body.kind === 'review') {
      if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 0 || !text(body.correction)
        || !['candidate', 'faithful', 'reformulation', 'excluded'].includes(body.status) || typeof body.listened !== 'boolean') fail('corpus_invalid_review');
    } else {
      if (typeof body.ownerToken !== 'string' || !UUID.test(body.ownerToken)
        || typeof body.draftId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(body.draftId)
        || !['prompt', 'criteria'].includes(body.field) || typeof body.submissionId !== 'string' || !IDENTIFIER.test(body.submissionId)) fail('corpus_invalid_owner');
      if (body.kind === 'submission' && (!Array.isArray(body.recordingIds) || !body.recordingIds.length || body.recordingIds.length > 32
        || new Set(body.recordingIds).size !== body.recordingIds.length || body.recordingIds.some((id) => typeof id !== 'string' || !UUID.test(id))
        || !text(body.beforeText) || !text(body.deliveredText) || !text(body.submittedText))) fail('corpus_invalid_submission');
      if (body.kind === 'submission' && body.unavailableRecordings !== undefined) {
        const unavailable = body.unavailableRecordings;
        if (!Array.isArray(unavailable) || unavailable.length + body.recordingIds.length > 32
          || unavailable.some((item, index) => !item || typeof item !== 'object' || Array.isArray(item)
            || Object.keys(item).length !== 3 || Object.keys(item).some((key) => !['recordingId', 'position', 'reason'].includes(key))
            || typeof item.recordingId !== 'string' || !UUID.test(item.recordingId)
            || body.recordingIds.includes(item.recordingId)
            || !Number.isInteger(item.position) || item.position < 0 || item.position > 31
            || (index > 0 && item.position <= unavailable[index - 1].position)
            || typeof item.reason !== 'string' || !IDENTIFIER.test(item.reason))
          || new Set(unavailable.map((item) => item.recordingId)).size !== unavailable.length) fail('corpus_invalid_unavailable_recordings');
      }
      if (body.kind === 'task' && (typeof body.taskId !== 'string' || !IDENTIFIER.test(body.taskId))) fail('corpus_invalid_task');
    }
  }

  function annotate(id, body) {
    idCheck(id); validateBody(body);
    if (!config.enabled) fail('collection_disabled', 409);
    return mutate(async () => {
      const state = reservations.get(id);
      if (state?.deleted) fail('corpus_not_found', 404);
      const location = await locate(id);
      if (!location) {
        if (state?.status === 'pending') fail('corpus_pending', 409);
        fail(state?.reason ?? 'corpus_not_found', state ? 409 : 404);
      }
      const record = await documentAt(location);
      const annotations = await sidecarAt(location);
      const { ownerToken, ...persisted } = body;
      if (persisted.unavailableRecordings) {
        // Omitted membership records a client-reported loss, not a link to
        // another archive. Keep original positions without relaxing ownership
        // checks on recordings that are retained and addressable.
        persisted.unavailableRecordings = persisted.unavailableRecordings.map(({ recordingId, position, reason }) => ({ recordingId, position, reason }));
      }
      if (body.kind !== 'review') {
        if (!record.owner || record.owner.draftId !== body.draftId || record.owner.field !== body.field
          || record.owner.tokenHash !== hash(ownerToken)) fail('corpus_owner_mismatch', 403);
      }
      // Canonical field ordering makes retries independent of JSON key order.
      const digest = hash(JSON.stringify(Object.fromEntries(Object.entries(persisted).sort(([a], [b]) => a.localeCompare(b)))));
      const prior = annotations.find((item) => item.operationId === body.operationId);
      if (prior) {
        if (prior.payloadHash !== digest) fail('corpus_operation_conflict', 409);
        return { schemaVersion: 1, annotation: prior, duplicate: true };
      }
      let reviewRevision;
      if (body.kind === 'submission') {
        if (!body.recordingIds.includes(id)) fail('corpus_invalid_submission');
        if (annotations.some((item) => item.kind === 'submission' && item.submissionId === body.submissionId)) fail('corpus_submission_conflict', 409);
        for (const related of body.recordingIds) {
          const relatedState = reservations.get(related);
          let owner = relatedState?.owner;
          if (!owner) {
            const other = await locate(related);
            if (other) owner = (await documentAt(other)).owner;
          }
          if (!owner || owner.draftId !== body.draftId || owner.field !== body.field || relatedState?.deleted) fail('corpus_owner_mismatch', 403);
        }
      } else if (body.kind === 'task') {
        if (!annotations.some((item) => item.kind === 'submission' && item.submissionId === body.submissionId)) fail('corpus_submission_missing', 409);
        const associated = annotations.find((item) => item.kind === 'task' && item.submissionId === body.submissionId);
        if (associated && associated.taskId !== body.taskId) fail('corpus_task_conflict', 409);
        if (associated) return { schemaVersion: 1, annotation: associated, duplicate: true };
      } else {
        reviewRevision = annotations.filter((item) => item.kind === 'review').length;
        if (body.expectedRevision !== reviewRevision) fail('corpus_revision_conflict', 409);
        if (body.status === 'faithful') {
          if (!body.listened || !body.correction.trim() || !(record.complete ?? record.metadata.status === 'success')) fail('corpus_faithful_requires_complete_audio', 409);
          try { await audioAt(location, record); } catch { fail('corpus_faithful_requires_complete_audio', 409); }
        }
      }
      if (annotations.length >= 256) fail('corpus_annotation_limit', 413);
      const annotation = { ...persisted, payloadHash: digest, revision: annotations.length + 1,
        createdAt: new Date().toISOString(), ...(reviewRevision === undefined ? {} : { reviewRevision: reviewRevision + 1 }) };
      const serialized = JSON.stringify({ schemaVersion: 1, annotations: [...annotations, annotation] }, null, 2) + '\n';
      if (Buffer.byteLength(serialized) > MAX_SIDECAR) fail('corpus_annotation_limit', 413);
      const disk = await io.statfs(config.directory, { bigint: true });
      if (BigInt(disk.bavail) * BigInt(disk.bsize) - BigInt(Buffer.byteLength(serialized)) < 1024n ** 3n) fail('corpus_disk_reserve', 507);
      const temporary = path.join(location, `.annotations-${randomUUID()}`);
      try {
        await io.writeFile(temporary, serialized, { mode: 0o600, flag: 'wx' });
        await io.rename(temporary, path.join(location, 'annotations.json'));
      } finally { await io.rm(temporary, { force: true }); }
      return { schemaVersion: 1, annotation, duplicate: false };
    });
  }

  function remove(id) {
    idCheck(id);
    return mutate(async () => {
      const state = reservations.get(id);
      if (state) state.deleted = true;
      // Writers observe the tombstone before rename; awaiting admitted writes
      // also covers a deletion arriving while the atomic rename is in flight.
      try {
        await flush();
        const location = await locate(id);
        if (location) await io.rm(location, { recursive: true, force: true });
        return { deleted: true };
      } catch (error) {
        // A failed removal must not hide retained audio until a service restart.
        if (state) Object.assign(state, { deleted: false, status: 'failed', reason: 'corpus_delete_failed' });
        throw error;
      }
    });
  }

  async function exportManifest() {
    const verifiedPairs = [], candidates = [];
    let offset = 0;
    let bytes = 256; // JSON envelope and separators.
    let page;
    do {
      page = await list({ offset, limit: 200 });
      for (const record of page.records) {
        const latest = record.annotations.filter((item) => item.kind === 'review').at(-1);
        if (latest?.status === 'excluded') continue;
        const entry = { ...record, audioUrl: `/api/stt/corpus/records/${record.id}/audio` };
        if (latest?.status === 'faithful' && record.archive.complete && record.audioAvailable) {
          entry.reference = { text: latest.correction, reviewRevision: latest.reviewRevision, confirmedAt: latest.createdAt };
          verifiedPairs.push(entry);
        } else candidates.push(entry);
        bytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
        if (bytes > MAX_RESPONSE) fail('corpus_export_limit', 413);
      }
      offset += page.records.length;
      // Bound response memory. Larger corpora are still available in paged review.
      if (offset >= 2000 && page.truncated) fail('corpus_export_limit', 413);
    } while (page.truncated);
    return { schemaVersion: 1, exportedAt: new Date().toISOString(), verifiedPairs, candidates };
  }

  async function audio(id) {
    const location = await locate(id);
    if (!location) fail('corpus_not_found', 404);
    const record = await documentAt(location);
    return { bytes: await audioAt(location, record), contentType: TYPES[record.audio.filename.slice(6)] };
  }

  async function handleHttp(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/corpus/')) return false;
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };
    try {
      if (req.headers.origin || req.headers['x-kookr-corpus'] !== '1') fail('corpus_proxy_required', 403);
      const match = /^\/corpus\/records\/([^/]+)(?:\/(audio|annotations))?$/.exec(url.pathname);
      if (req.method === 'GET' && url.pathname === '/corpus/capabilities') json(200, { schemaVersion: 1, supported: true, enabled: config.enabled });
      else if (req.method === 'GET' && url.pathname === '/corpus/records') json(200, await list({ offset: Number(url.searchParams.get('offset') ?? 0), limit: Number(url.searchParams.get('limit') ?? 200) }));
      else if (req.method === 'GET' && url.pathname === '/corpus/export') json(200, await exportManifest());
      else if (match && req.method === 'GET' && !match[2]) json(200, await get(match[1]));
      else if (match && req.method === 'DELETE' && !match[2]) json(200, await remove(match[1]));
      else if (match && req.method === 'GET' && match[2] === 'audio') {
        const result = await audio(match[1]);
        res.writeHead(200, { 'Content-Type': result.contentType, 'Content-Length': result.bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(result.bytes);
      } else if (match && req.method === 'POST' && match[2] === 'annotations') {
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_BODY) fail('corpus_payload_too_large', 413);
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { fail('corpus_invalid_json'); }
        json(200, await annotate(match[1], body));
      } else fail('corpus_not_found', 404);
    } catch (error) {
      // Neither paths nor user audio/text enter logs or HTTP error messages.
      json(error.status ?? 503, { error: error.status ? error.message : 'corpus_unavailable' });
    }
    return true;
  }

  return { get, list, annotate, remove, exportManifest, audio, handleHttp };
}

module.exports = { createCorpusApi };
