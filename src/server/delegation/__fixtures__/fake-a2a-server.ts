import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A fake Hermes A2A worker for tests, reproducing the shapes MEASURED against a real
 * Hermes 0.22.7 agent (RFC `rfc-kookr-hermes-delegation`, "Measured behaviour"):
 *
 * - `message/send` blocks until the task is terminal, then answers with the task; the
 *   client-supplied `contextId` is echoed. A client that disconnects does not stop the task.
 * - `tasks/list` filters by `contextId`/`status`, returns `totalSize` and `nextPageToken`.
 * - `tasks/get` of an unknown id is HTTP 200 plus JSON-RPC error -32001.
 * - A wrong bearer token is HTTP 401 plus JSON-RPC error -32050.
 * - `tasks/subscribe` streams `artifactUpdate`/`statusUpdate` events as SSE, then closes.
 * - FAILED tasks carry text such as "[agent did not reply in time]".
 * - A worker restart loses all task state (`restart()`).
 *
 * It is a test double, not a protocol implementation: only what the delegation client uses.
 */

export type FakeState = 'completed' | 'failed' | 'input_required' | 'rejected' | 'canceled';

export type Plan =
  /** Finish after `delayMs` (default 0) and answer the held request with the terminal task. */
  | { kind: 'reply'; state?: FakeState; text: string; delayMs?: number }
  /** Destroy the connection at once; the task keeps running and finishes after `finishAfterMs`. */
  | { kind: 'drop'; finishAfterMs?: number; state?: FakeState; text: string }
  /** Never finish; the held request stays open until the client gives up. */
  | { kind: 'hang' };

export interface FakeTask {
  id: string;
  contextId: string;
  state: 'working' | FakeState;
  text: string;
  seq: number;
}

export interface RecordedRequest {
  method: string;
  authorized: boolean;
  /** Parsed `params` (never the Authorization header). */
  params: Record<string, unknown>;
}

const STATE_NAME: Record<string, string> = {
  working: 'TASK_STATE_WORKING',
  completed: 'TASK_STATE_COMPLETED',
  failed: 'TASK_STATE_FAILED',
  input_required: 'TASK_STATE_INPUT_REQUIRED',
  rejected: 'TASK_STATE_REJECTED',
  canceled: 'TASK_STATE_CANCELED',
};

export class FakeA2aServer {
  readonly tasks = new Map<string, FakeTask>();
  readonly requests: RecordedRequest[] = [];
  plan: (ctx: { text: string; contextId: string }) => Plan = () => ({ kind: 'reply', text: 'ok' });
  /** Extra latency added to every `tasks/list` answer. */
  listDelayMs = 0;
  /** Destroy the next N connections before reading them (a transport failure). */
  failNextConnections = 0;
  /** Answer `tasks/list` with a bare HTTP 500 (unexpected status). */
  listStatus500 = false;

  private server?: Server;
  private port = 0;
  private seq = 0;
  private waiters = new Map<string, Array<() => void>>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private sockets = new Set<import('node:net').Socket>();

  constructor(public token: string) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(port = 0): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  /** Stop listening and drop connections (the worker is unreachable). Task state is kept. */
  async stop(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = undefined;
  }

  /** Come back on the same port (after `stop()`), as a restarted worker would. */
  async resume(): Promise<void> {
    await this.start(this.port);
  }

  /** A worker restart: all task state is lost. */
  restart(): void {
    this.tasks.clear();
  }

  /** Finish a task from outside the request flow (used to simulate a task completing later). */
  finish(id: string, state: FakeState, text: string): void {
    const t = this.tasks.get(id);
    if (!t || t.state !== 'working') return;
    t.state = state;
    t.text = text;
    for (const w of this.waiters.get(id) ?? []) w();
    this.waiters.delete(id);
  }

  methodsSeen(): string[] {
    return this.requests.map((r) => r.method);
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private taskJson(t: FakeTask, withArtifacts = true): Record<string, unknown> {
    const status: Record<string, unknown> = { state: STATE_NAME[t.state], timestamp: new Date().toISOString() };
    if (t.text && t.state !== 'working') {
      status.message = { role: 'ROLE_AGENT', messageId: `m-${t.id}`, contextId: t.contextId, parts: [{ text: t.text, mediaType: 'text/plain' }] };
    }
    const task: Record<string, unknown> = { id: t.id, contextId: t.contextId, status };
    if (withArtifacts && t.state === 'completed' && t.text) {
      task.artifacts = [{ artifactId: `a-${t.id}`, parts: [{ text: t.text, mediaType: 'text/plain' }] }];
    }
    return task;
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
    res.end(data);
  }

  private rpcError(res: ServerResponse, id: unknown, code: number, message: string, http = 200): void {
    this.json(res, http, { jsonrpc: '2.0', id, error: { code, message } });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.failNextConnections > 0) {
      this.failNextConnections--;
      req.socket.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: { id?: unknown; method?: string; params?: Record<string, unknown> } = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return this.rpcError(res, null, -32700, 'parse error', 400);
    }
    const method = String(body.method ?? '');
    const params = body.params ?? {};
    const authorized = req.headers.authorization === `Bearer ${this.token}`;
    this.requests.push({ method, authorized, params });
    if (!authorized) return this.rpcError(res, null, -32050, 'unauthorized', 401);

    switch (method) {
      case 'message/send':
      case 'SendMessage':
        return this.send(req, res, body.id, params, method === 'SendMessage');
      case 'tasks/get': {
        const t = this.tasks.get(String(params.id ?? params.taskId ?? ''));
        if (!t) return this.rpcError(res, body.id, -32001, `task not found: ${String(params.id)}`);
        return this.json(res, 200, { jsonrpc: '2.0', id: body.id, result: this.taskJson(t) });
      }
      case 'tasks/list':
        return this.list(res, body.id, params);
      case 'tasks/cancel': {
        const t = this.tasks.get(String(params.id ?? ''));
        if (!t) return this.rpcError(res, body.id, -32001, 'task not found');
        this.finish(t.id, 'canceled', '');
        return this.json(res, 200, { jsonrpc: '2.0', id: body.id, result: this.taskJson(t) });
      }
      case 'tasks/subscribe':
        return this.subscribe(req, res, body.id, params);
      default:
        return this.rpcError(res, body.id, -32601, `method not found: ${method}`);
    }
  }

  private send(req: IncomingMessage, res: ServerResponse, rpcId: unknown, params: Record<string, unknown>, wrap: boolean): void {
    const message = (params.message ?? {}) as { contextId?: string; parts?: Array<{ text?: string }> };
    const text = (message.parts ?? []).map((p) => p.text ?? '').join('\n');
    const contextId = message.contextId ?? `ctx-${++this.seq}`;
    const task: FakeTask = { id: `task-${++this.seq}-${Math.random().toString(16).slice(2, 8)}`, contextId, state: 'working', text: '', seq: this.seq };
    this.tasks.set(task.id, task);
    const plan = this.plan({ text, contextId });
    let clientGone = false;
    res.on('close', () => { clientGone = true; });
    const answer = () => {
      if (clientGone || res.writableEnded) return;
      const result = wrap ? { task: this.taskJson(task) } : this.taskJson(task);
      this.json(res, 200, { jsonrpc: '2.0', id: rpcId, result });
    };
    if (plan.kind === 'hang') return;
    if (plan.kind === 'drop') {
      this.later(plan.finishAfterMs ?? 0, () => this.finish(task.id, plan.state ?? 'completed', plan.text));
      req.socket.destroy();
      return;
    }
    const waiters = this.waiters.get(task.id) ?? [];
    waiters.push(answer);
    this.waiters.set(task.id, waiters);
    this.later(plan.delayMs ?? 0, () => this.finish(task.id, plan.state ?? 'completed', plan.text));
  }

  private list(res: ServerResponse, rpcId: unknown, params: Record<string, unknown>): void {
    const respond = () => {
      if (this.listStatus500) return this.json(res, 500, { error: 'boom' });
      const contextId = String(params.contextId ?? '');
      const status = String(params.status ?? '');
      const pageSize = Math.max(1, Math.min(Number(params.pageSize ?? 50) || 50, 100));
      const offset = Math.max(0, Number(params.pageToken ?? 0) || 0);
      const all = [...this.tasks.values()]
        .filter((t) => (!contextId || t.contextId === contextId) && (!status || STATE_NAME[t.state] === status))
        .sort((a, b) => b.seq - a.seq);
      const page = all.slice(offset, offset + pageSize);
      const next = offset + pageSize < all.length ? String(offset + pageSize) : '';
      this.json(res, 200, {
        jsonrpc: '2.0',
        id: rpcId,
        result: { tasks: page.map((t) => this.taskJson(t, Boolean(params.includeArtifacts))), nextPageToken: next, pageSize, totalSize: all.length },
      });
    };
    if (this.listDelayMs > 0) this.later(this.listDelayMs, respond);
    else respond();
  }

  private subscribe(req: IncomingMessage, res: ServerResponse, rpcId: unknown, params: Record<string, unknown>): void {
    const task = this.tasks.get(String(params.id ?? params.taskId ?? ''));
    if (!task) return this.rpcError(res, rpcId, -32001, 'task not found');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const emit = () => {
      if (res.writableEnded) return;
      const env = (result: unknown) => `data: ${JSON.stringify({ jsonrpc: '2.0', id: rpcId, result })}\n\n`;
      const completed = task.state === 'completed' && task.text;
      if (completed) {
        res.write(env({ artifactUpdate: { taskId: task.id, contextId: task.contextId, artifact: { artifactId: 'a', parts: [{ text: task.text, mediaType: 'text/plain' }] } } }));
      }
      const status: Record<string, unknown> = { state: STATE_NAME[task.state], timestamp: new Date().toISOString() };
      if (!completed && task.text) status.message = { role: 'ROLE_AGENT', parts: [{ text: task.text }] };
      res.write(env({ statusUpdate: { taskId: task.id, contextId: task.contextId, status } }));
      res.write(': done\n\n');
      res.end();
    };
    if (task.state !== 'working') return emit();
    const waiters = this.waiters.get(task.id) ?? [];
    waiters.push(emit);
    this.waiters.set(task.id, waiters);
    req.on('close', () => {
      this.waiters.set(task.id, (this.waiters.get(task.id) ?? []).filter((w) => w !== emit));
    });
  }
}
