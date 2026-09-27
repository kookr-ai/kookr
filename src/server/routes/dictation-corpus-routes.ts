import type { Hono } from 'hono';
import type { Context } from 'hono';
import type { TaskStore } from '../../core/tasks.js';
import type { TaskStateSaveSchedulerLike } from '../task-state-save-scheduler.js';
import { validateSpeechServiceUrl } from '../speech-service-url.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ANNOTATION_BYTES = 128 * 1024;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const DEADLINE_MS = 10_000;

interface CorpusRouteDeps {
  sttUrl?: string;
  taskStore: TaskStore;
  taskStateSaveScheduler?: TaskStateSaveSchedulerLike;
}

class BodyTooLarge extends Error {}

/** Bound streamed bodies too: Content-Length alone is not a trustworthy limit. */
async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new BodyTooLarge();
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

/**
 * Keep audio and annotations in the recognizer's existing archive. The browser
 * reaches it through the dashboard's owner authentication and CSRF boundary;
 * no caller can choose an upstream origin or send browser credentials onward.
 */
export function registerDictationCorpusRoutes(app: Hono, deps: CorpusRouteDeps): void {
  const prefix = '/api/stt/corpus';
  app.use(`${prefix}/*`, async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    await next();
  });

  app.get(`${prefix}/submissions/:submissionId/task`, async (c) => {
    const submissionId = c.req.param('submissionId');
    if (!UUID.test(submissionId)) return c.json({ error: 'invalid_submission_id' }, 400);
    const task = deps.taskStore.findTaskByDictationSubmission(submissionId);
    if (task && deps.taskStateSaveScheduler) {
      try { await deps.taskStateSaveScheduler.flush('flush', { force: true }); }
      catch { return c.json({ error: 'corpus_task_receipt_pending' }, 503); }
    }
    return c.json({ taskId: task?.id ?? null });
  });

  async function proxy(c: Context, path: string, body?: string): Promise<Response> {
    const isCapabilities = path === '/corpus/capabilities';
    const unavailable = (reason: string, status: 200 | 501 | 503) => c.json({
      schemaVersion: 1, supported: false, enabled: false, reason,
    }, status);
    if (!deps.sttUrl) return unavailable('disabled', isCapabilities ? 200 : 503);
    if (!validateSpeechServiceUrl(deps.sttUrl).ok) return unavailable('invalid-stt-url', isCapabilities ? 200 : 503);
    const configured = new URL(deps.sttUrl);
    configured.protocol = configured.protocol === 'wss:' ? 'https:' : configured.protocol === 'ws:' ? 'http:' : configured.protocol;
    const origin = configured.origin;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEADLINE_MS);
    const headers = { 'x-kookr-corpus': '1' };
    try {
      // Probe before sending any private annotation to external/old services.
      const capabilityResponse = await fetch(`${origin}/corpus/capabilities`, {
        headers, redirect: 'error', signal: controller.signal,
      });
      if (!capabilityResponse.ok) {
        await capabilityResponse.body?.cancel();
        return unavailable('unsupported', isCapabilities ? 200 : 501);
      }
      const capabilityBytes = await readBounded(capabilityResponse.body, 4096);
      let capability: unknown;
      try { capability = JSON.parse(new TextDecoder().decode(capabilityBytes)); }
      catch { return unavailable('unsupported', isCapabilities ? 200 : 501); }
      if (typeof capability !== 'object' || capability === null
        || !('schemaVersion' in capability) || capability.schemaVersion !== 1
        || !('supported' in capability) || capability.supported !== true
        || !('enabled' in capability) || typeof capability.enabled !== 'boolean') {
        return unavailable('unsupported', isCapabilities ? 200 : 501);
      }
      if (isCapabilities) return c.json({ schemaVersion: 1, supported: true, enabled: capability.enabled });
      // Disabled capture can still expose previously retained examples for review.
      const response = await fetch(`${origin}${path}`, {
        method: c.req.method,
        headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body }),
        redirect: 'error', signal: controller.signal,
      });
      const audio = path.endsWith('/audio') && response.ok;
      const bytes = await readBounded(response.body, audio ? MAX_AUDIO_BYTES : MAX_JSON_BYTES);
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
      if (audio && !['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/webm', 'audio/ogg', 'audio/mp4', 'application/octet-stream'].includes(contentType ?? '')) {
        return c.json({ error: 'corpus_invalid_response' }, 502);
      }
      if (!audio) {
        try { JSON.parse(new TextDecoder().decode(bytes)); }
        catch { return c.json({ error: 'corpus_invalid_response' }, 502); }
      }
      return new Response(bytes, {
        status: response.status,
        headers: {
          'Content-Type': audio ? contentType! : 'application/json',
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (error) {
      return c.json({ error: error instanceof BodyTooLarge ? 'corpus_response_too_large' : 'corpus_unavailable' }, 503);
    } finally { clearTimeout(timeout); }
  }

  app.get(`${prefix}/capabilities`, (c) => proxy(c, '/corpus/capabilities'));
  app.get(`${prefix}/records`, async (c) => {
    const params = new URLSearchParams();
    for (const [name, maximum] of [['offset', 100_000], ['limit', 200]] as const) {
      const value = c.req.query(name);
      if (value === undefined) continue;
      if (!/^\d{1,6}$/.test(value) || Number(value) > maximum || (name === 'limit' && Number(value) < 1)) {
        return c.json({ error: 'invalid_pagination' }, 400);
      }
      params.set(name, value);
    }
    return proxy(c, `/corpus/records${params.size ? `?${params}` : ''}`);
  });
  app.get(`${prefix}/export`, (c) => proxy(c, '/corpus/export'));
  app.get(`${prefix}/records/:id`, async (c) => {
    const id = c.req.param('id');
    return UUID.test(id) ? proxy(c, `/corpus/records/${id}`) : c.json({ error: 'invalid_recording_id' }, 400);
  });
  app.get(`${prefix}/records/:id/audio`, async (c) => {
    const id = c.req.param('id');
    return UUID.test(id) ? proxy(c, `/corpus/records/${id}/audio`) : c.json({ error: 'invalid_recording_id' }, 400);
  });
  app.delete(`${prefix}/records/:id`, async (c) => {
    const id = c.req.param('id');
    return UUID.test(id) ? proxy(c, `/corpus/records/${id}`) : c.json({ error: 'invalid_recording_id' }, 400);
  });
  app.post(`${prefix}/records/:id/annotations`, async (c) => {
    const id = c.req.param('id');
    if (!UUID.test(id)) return c.json({ error: 'invalid_recording_id' }, 400);
    let body: string;
    let annotation: unknown;
    try {
      body = new TextDecoder().decode(await readBounded(c.req.raw.body, MAX_ANNOTATION_BYTES));
      annotation = JSON.parse(body);
    } catch (error) {
      return c.json({ error: error instanceof BodyTooLarge ? 'corpus_payload_too_large' : 'invalid_annotation' }, error instanceof BodyTooLarge ? 413 : 400);
    }
    if (typeof annotation !== 'object' || annotation === null || !('kind' in annotation)) {
      return c.json({ error: 'invalid_annotation' }, 400);
    }
    if (annotation.kind === 'task') {
      const submissionId = 'submissionId' in annotation ? annotation.submissionId : undefined;
      const taskId = 'taskId' in annotation ? annotation.taskId : undefined;
      if (typeof submissionId !== 'string' || !UUID.test(submissionId)
        || typeof taskId !== 'string' || deps.taskStore.findTaskByDictationSubmission(submissionId)?.id !== taskId) {
        return c.json({ error: 'corpus_task_not_acknowledged' }, 409);
      }
      if (deps.taskStateSaveScheduler) {
        try { await deps.taskStateSaveScheduler.flush('flush', { force: true }); }
        catch { return c.json({ error: 'corpus_task_receipt_pending' }, 503); }
      }
    }
    return proxy(c, `/corpus/records/${id}/annotations`, body);
  });
}
