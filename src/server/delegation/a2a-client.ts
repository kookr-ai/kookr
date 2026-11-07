/**
 * A2A (agent-to-agent protocol) JSON-RPC client for Hermes workers.
 *
 * This is the ONLY file in `src/server/delegation/` that knows A2A vocabulary
 * (`message/send`, `TASK_STATE_*`, `-32001`, `contextId`...). Everything it returns is
 * a small normalized outcome (`accepted`, `completed`, `needs_input`, `worker_failed`,
 * `rejected`, `cancelled`, `not_found`, `unreachable`, `auth`, `error`), so the service
 * never has to know how Hermes spells things. The fake A2A server used in tests is the seam.
 *
 * Rules that come from measuring Hermes (RFC "Measured behaviour"):
 * - Dispatch uses `message/send` ONLY. `message/stream` is never used: Hermes finalizes the
 *   task as FAILED "[client disconnected]" if the stream connection drops, which a Kookr
 *   restart would cause for every in-flight job. A dropped `message/send` is harmless.
 * - `tasks/subscribe` re-attaches to a running task and is safe to drop.
 * - An unknown task id is HTTP 200 plus JSON-RPC error `-32001`; an unreachable worker is a
 *   transport error. The two are reported differently (`not_found` vs `unreachable`).
 * - `tasks/cancel` only flips bookkeeping; it is implemented but unused in slice 1a.
 * - The bearer token is passed per call by the caller (re-read from its file each time) and
 *   is never stored, logged, or included in an outcome.
 */

/** Largest text returned to the service: 64 KB, cut on a character boundary. */
export const RESULT_TEXT_CAP_BYTES = 64 * 1024;
/** Largest HTTP body this client will read from a worker. */
const MAX_RESPONSE_BYTES = 1024 * 1024;
const A2A_VERSION = '1.0';

export interface A2aEndpoint {
  /** Operator-supplied worker URL (never taken from the agent card). */
  url: string;
  token: string;
}

export interface CallOptions {
  /** Per-call timeout; a timeout is reported as `unreachable`. */
  timeoutMs: number;
  /** Caller cancellation (deadline, shutdown). Reported as `unreachable` with error `aborted`. */
  signal?: AbortSignal;
}

/** A task as the worker last described it, in Kookr's vocabulary. */
export type TaskOutcome =
  | { kind: 'accepted'; taskId: string; phase: 'submitted' | 'working' }
  | { kind: 'completed'; taskId: string; text: string; truncated: boolean }
  | { kind: 'needs_input'; taskId: string; text: string; truncated: boolean }
  | { kind: 'worker_failed'; taskId: string; text: string; truncated: boolean }
  | { kind: 'rejected'; taskId: string; text: string; truncated: boolean }
  | { kind: 'cancelled'; taskId: string; text: string; truncated: boolean };

export type A2aFailure =
  | { kind: 'not_found' }
  | { kind: 'unreachable'; error: string }
  | { kind: 'auth' }
  /** Protocol violation, rate limit, unexpected HTTP status or unknown JSON-RPC error. */
  | { kind: 'error'; message: string; /** The reply exceeded the size limit (not a transport problem). */ tooLarge?: true };

export type A2aOutcome = TaskOutcome | A2aFailure;

export type ListOutcome = { kind: 'tasks'; tasks: TaskOutcome[]; totalSize: number } | A2aFailure;

export interface SendArgs {
  contextId: string;
  messageId: string;
  text: string;
}

export interface A2aClient {
  /** Dispatch a job. Blocks (up to `timeoutMs`) until the worker answers, normally with a terminal task. */
  send(ep: A2aEndpoint, args: SendArgs, opts: CallOptions): Promise<A2aOutcome>;
  /** Find the task(s) the worker created for a Kookr-minted contextId, newest first. */
  listByContext(ep: A2aEndpoint, contextId: string, opts: CallOptions): Promise<ListOutcome>;
  get(ep: A2aEndpoint, taskId: string, opts: CallOptions): Promise<A2aOutcome>;
  /** Re-attach to a task and read its final result from the event stream. */
  subscribe(ep: A2aEndpoint, taskId: string, opts: CallOptions): Promise<A2aOutcome>;
  /** Bookkeeping-only cancel (work keeps running on Hermes). Unused in slice 1a. */
  cancel(ep: A2aEndpoint, taskId: string, opts: CallOptions): Promise<A2aOutcome>;
}

export interface A2aClientOptions {
  fetch?: typeof fetch;
}

export function createA2aClient(options: A2aClientOptions = {}): A2aClient {
  const doFetch = options.fetch ?? fetch;
  let nextId = 1;

  async function post(
    ep: A2aEndpoint,
    method: string,
    params: Record<string, unknown>,
    opts: CallOptions,
  ): Promise<{ res: Response; signal: AbortSignal } | A2aFailure> {
    const signal = combineSignals(opts.signal, AbortSignal.timeout(opts.timeoutMs));
    try {
      const res = await doFetch(ep.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${ep.token}`,
          'a2a-version': A2A_VERSION,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
        signal,
        redirect: 'error',
      });
      return { res, signal };
    } catch (err) {
      return { kind: 'unreachable', error: describeTransportError(err, opts.signal) };
    }
  }

  async function call(
    ep: A2aEndpoint,
    method: string,
    params: Record<string, unknown>,
    opts: CallOptions,
  ): Promise<{ result: unknown } | A2aFailure> {
    const sent = await post(ep, method, params, opts);
    if ('kind' in sent) return sent;
    const { res } = sent;
    if (res.status === 401 || res.status === 403) {
      await drain(res);
      return { kind: 'auth' };
    }
    let text: string;
    try {
      text = await readCapped(res, MAX_RESPONSE_BYTES);
    } catch (err) {
      return readFailure(err, opts.signal);
    }
    const body = parseJson(text);
    const rpcError = jsonRpcError(body);
    if (rpcError) return mapRpcError(rpcError.code, rpcError.message);
    if (!res.ok) return { kind: 'error', message: `worker returned HTTP ${res.status}` };
    if (!isRecord(body) || !('result' in body)) return { kind: 'error', message: 'worker response is not a JSON-RPC result' };
    return { result: body.result };
  }

  return {
    async send(ep, args, opts) {
      const r = await call(
        ep,
        'message/send',
        {
          message: {
            messageId: args.messageId,
            role: 'ROLE_USER',
            contextId: args.contextId,
            parts: [{ text: args.text, mediaType: 'text/plain' }],
          },
        },
        opts,
      );
      if ('kind' in r) return r;
      const task = unwrapTask(r.result);
      if (!task) return { kind: 'error', message: 'message/send did not return a task' };
      if (typeof task.contextId === 'string' && task.contextId !== args.contextId) {
        return { kind: 'error', message: 'worker answered for a different contextId' };
      }
      return normalizeTask(task);
    },

    async listByContext(ep, contextId, opts) {
      const tasks: TaskOutcome[] = [];
      let pageToken = '';
      let totalSize = 0;
      for (let page = 0; page < 5; page++) {
        const r = await call(
          ep,
          'tasks/list',
          { contextId, pageSize: 20, includeArtifacts: true, ...(pageToken ? { pageToken } : {}) },
          opts,
        );
        if ('kind' in r) return r;
        if (!isRecord(r.result) || !Array.isArray(r.result.tasks)) {
          return { kind: 'error', message: 'tasks/list did not return a task list' };
        }
        for (const t of r.result.tasks) {
          if (!isRecord(t)) continue;
          // The server filters by contextId; double-check so a lax server cannot mix contexts.
          if (typeof t.contextId === 'string' && t.contextId !== contextId) continue;
          const n = normalizeTask(t);
          if ('taskId' in n) tasks.push(n);
        }
        totalSize = typeof r.result.totalSize === 'number' ? r.result.totalSize : tasks.length;
        pageToken = typeof r.result.nextPageToken === 'string' ? r.result.nextPageToken : '';
        if (!pageToken) break;
      }
      return { kind: 'tasks', tasks, totalSize };
    },

    async get(ep, taskId, opts) {
      const r = await call(ep, 'tasks/get', { id: taskId }, opts);
      if ('kind' in r) return r;
      const task = unwrapTask(r.result);
      return task ? normalizeTask(task) : { kind: 'error', message: 'tasks/get did not return a task' };
    },

    async cancel(ep, taskId, opts) {
      const r = await call(ep, 'tasks/cancel', { id: taskId }, opts);
      if ('kind' in r) return r;
      const task = unwrapTask(r.result);
      return task ? normalizeTask(task) : { kind: 'error', message: 'tasks/cancel did not return a task' };
    },

    async subscribe(ep, taskId, opts) {
      const sent = await post(ep, 'tasks/subscribe', { id: taskId }, opts);
      if ('kind' in sent) return sent;
      const { res } = sent;
      if (res.status === 401 || res.status === 403) {
        await drain(res);
        return { kind: 'auth' };
      }
      let text: string;
      try {
        // The stream ends when the task reaches a terminal state (or the worker closes it).
        text = await readCapped(res, MAX_RESPONSE_BYTES);
      } catch (err) {
        return readFailure(err, opts.signal);
      }
      return parseSubscribeBody(text, res.ok, res.status, taskId);
    },
  };
}

// ---------------------------------------------------------------------------
// Normalization (the only place A2A state names appear)
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function jsonRpcError(body: unknown): { code: number; message: string } | undefined {
  if (!isRecord(body) || !isRecord(body.error)) return undefined;
  return {
    code: typeof body.error.code === 'number' ? body.error.code : 0,
    message: typeof body.error.message === 'string' ? body.error.message : 'unknown error',
  };
}

/** JSON-RPC error code mapping. -32001 TaskNotFound; -32050/-32052 unauthorized/untrusted peer. */
function mapRpcError(code: number, message: string): A2aFailure {
  if (code === -32001) return { kind: 'not_found' };
  if (code === -32050 || code === -32052) return { kind: 'auth' };
  if (code === -32051) return { kind: 'error', message: 'worker rate limit exceeded' };
  return { kind: 'error', message: `worker JSON-RPC error ${code}: ${message.slice(0, 200)}` };
}

function unwrapTask(result: unknown): Json | undefined {
  if (!isRecord(result)) return undefined;
  if (isRecord(result.task)) return result.task;
  if (isRecord(result.status) && typeof result.id === 'string') return result;
  return undefined;
}

type Phase = 'submitted' | 'working' | 'input_required' | 'completed' | 'failed' | 'rejected' | 'cancelled';

/** `TASK_STATE_INPUT_REQUIRED`, `input-required`, `CANCELED`... all map to one phase. */
function phaseOf(state: unknown): Phase | undefined {
  if (typeof state !== 'string') return undefined;
  const s = state.replace(/^TASK_STATE_/i, '').toLowerCase().replace(/-/g, '_');
  switch (s) {
    case 'submitted':
    case 'working':
    case 'input_required':
    case 'completed':
    case 'failed':
    case 'rejected':
      return s;
    case 'canceled':
    case 'cancelled':
      return 'cancelled';
    default:
      return undefined;
  }
}

function textOfParts(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => (isRecord(p) && typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** Text of a completed task: artifacts first, then the status message. */
function taskText(task: Json, preferArtifacts: boolean): string {
  const status = isRecord(task.status) ? task.status : {};
  const fromStatus = isRecord(status.message) ? textOfParts(status.message.parts) : '';
  const fromArtifacts = Array.isArray(task.artifacts)
    ? task.artifacts.map((a) => (isRecord(a) ? textOfParts(a.parts) : '')).filter(Boolean).join('\n')
    : '';
  return (preferArtifacts ? fromArtifacts || fromStatus : fromStatus || fromArtifacts).trim();
}

export function capText(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= RESULT_TEXT_CAP_BYTES) return { text, truncated: false };
  const cut = Buffer.from(text, 'utf8').subarray(0, RESULT_TEXT_CAP_BYTES).toString('utf8').replace(/�+$/u, '');
  return { text: cut, truncated: true };
}

function normalizeTask(task: Json): A2aOutcome {
  const taskId = typeof task.id === 'string' ? task.id : '';
  const status = isRecord(task.status) ? task.status : undefined;
  if (!taskId || !status) return { kind: 'error', message: 'worker returned a malformed task' };
  const phase = phaseOf(status.state);
  if (!phase) return { kind: 'error', message: 'worker returned an unknown task state' };
  if (phase === 'submitted' || phase === 'working') return { kind: 'accepted', taskId, phase };
  const { text, truncated } = capText(taskText(task, phase === 'completed'));
  switch (phase) {
    case 'completed':
      return { kind: 'completed', taskId, text, truncated };
    case 'input_required':
      return { kind: 'needs_input', taskId, text, truncated };
    case 'failed':
      return { kind: 'worker_failed', taskId, text, truncated };
    case 'rejected':
      return { kind: 'rejected', taskId, text, truncated };
    case 'cancelled':
      return { kind: 'cancelled', taskId, text, truncated };
  }
}

/**
 * Parse the body of a `tasks/subscribe` answer. It is normally a Server-Sent Events
 * stream of JSON-RPC envelopes (`artifactUpdate`, `statusUpdate`, `task`); an unknown
 * task id arrives as a plain JSON-RPC error with HTTP 200.
 */
function parseSubscribeBody(text: string, ok: boolean, status: number, taskId: string): A2aOutcome {
  const whole = parseJson(text);
  const wholeErr = jsonRpcError(whole);
  if (wholeErr) return mapRpcError(wholeErr.code, wholeErr.message);
  if (!ok) return { kind: 'error', message: `worker returned HTTP ${status}` };

  let phase: Phase | undefined;
  let statusText = '';
  const artifactChunks: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = parseJson(line.slice(5).trim());
    if (payload === undefined) continue;
    const err = jsonRpcError(payload);
    if (err) return mapRpcError(err.code, err.message);
    const result = isRecord(payload) && isRecord(payload.result) ? payload.result : isRecord(payload) ? payload : {};
    if (isRecord(result.task)) {
      const p = phaseOf(isRecord(result.task.status) ? result.task.status.state : undefined);
      if (p) phase = p;
      const t = taskText(result.task, true);
      if (t) statusText = t;
    }
    if (isRecord(result.statusUpdate)) {
      const st = isRecord(result.statusUpdate.status) ? result.statusUpdate.status : {};
      const p = phaseOf(st.state);
      if (p) phase = p;
      const t = isRecord(st.message) ? textOfParts(st.message.parts) : '';
      if (t) statusText = t;
    }
    if (isRecord(result.artifactUpdate) && isRecord(result.artifactUpdate.artifact)) {
      const t = textOfParts(result.artifactUpdate.artifact.parts);
      if (t) artifactChunks.push(t);
    }
  }
  if (!phase) return { kind: 'error', message: 'task event stream ended without a state' };
  if (phase === 'submitted' || phase === 'working') return { kind: 'accepted', taskId, phase };
  const body = (phase === 'completed' && artifactChunks.length > 0 ? artifactChunks.join('') : statusText).trim();
  const { text: capped, truncated } = capText(body);
  switch (phase) {
    case 'completed':
      return { kind: 'completed', taskId, text: capped, truncated };
    case 'input_required':
      return { kind: 'needs_input', taskId, text: capped, truncated };
    case 'failed':
      return { kind: 'worker_failed', taskId, text: capped, truncated };
    case 'rejected':
      return { kind: 'rejected', taskId, text: capped, truncated };
    case 'cancelled':
      return { kind: 'cancelled', taskId, text: capped, truncated };
  }
}

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------

function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  return a ? AbortSignal.any([a, b]) : b;
}

/** A short, secret-free description of a transport failure. */
/** A body-read failure: an over-limit reply is a content problem (not "unreachable"); anything else is transport. */
function readFailure(err: unknown, signal: AbortSignal | undefined): A2aFailure {
  if ((err as { code?: string } | undefined)?.code === 'response_too_large') {
    return { kind: 'error', message: 'worker reply exceeded the size limit', tooLarge: true };
  }
  return { kind: 'unreachable', error: describeTransportError(err, signal) };
}

function describeTransportError(err: unknown, callerSignal?: AbortSignal): string {
  if (callerSignal?.aborted) return 'aborted';
  const e = err as { name?: string; cause?: { code?: string }; code?: string } | undefined;
  if (e?.name === 'TimeoutError') return 'timeout';
  if (e?.name === 'AbortError') return 'aborted';
  return e?.cause?.code ?? e?.code ?? 'transport_error';
}

async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* ignore */
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw Object.assign(new Error('response too large'), { code: 'response_too_large' });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}
