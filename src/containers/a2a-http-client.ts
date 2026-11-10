import type { A2aClientPort, A2aTaskState } from './ports.js';

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const STATES: Record<string, A2aTaskState> = {
  TASK_STATE_SUBMITTED: 'SUBMITTED',
  TASK_STATE_WORKING: 'WORKING',
  TASK_STATE_INPUT_REQUIRED: 'INPUT_REQUIRED',
  TASK_STATE_COMPLETED: 'COMPLETED',
  TASK_STATE_FAILED: 'FAILED',
  TASK_STATE_CANCELED: 'CANCELED',
};

export function mapA2aState(raw: unknown): A2aTaskState {
  return typeof raw === 'string' ? (STATES[raw] ?? 'UNKNOWN') : 'UNKNOWN';
}

interface WireTask { id?: string; contextId?: string; status?: { state?: string } }

/**
 * HTTP+JSON client for the worker's `opencode-a2a` wrapper (A2A 1.0). It owns the wire format and the F5 workaround
 * (RFC #3541): `cancelTask` always re-reads the task after the cancel call returns, so a CANCELED that a later
 * stream close flips to FAILED is observed here, not by the caller.
 *
 * Endpoints are always loopback URLs Kookr built from a Docker-reported port, never worker-supplied.
 */
export class A2aHttpClient implements A2aClientPort {
  constructor(private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike) {}

  private async call(url: string, token: string | undefined, timeoutMs: number, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: init.method ?? 'GET',
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`a2a ${init.method ?? 'GET'} ${new URL(url).pathname} -> HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async health(endpoint: string, timeoutMs: number): Promise<'ok' | 'degraded'> {
    // The wrapper's /health is authenticated; the public agent card proves the process is serving.
    const card = await this.call(`${endpoint}/.well-known/agent-card.json`, undefined, timeoutMs);
    return card && typeof card === 'object' ? 'ok' : 'degraded';
  }

  async currentTask(endpoint: string, token: string, timeoutMs: number): Promise<{ taskId: string; state: A2aTaskState } | undefined> {
    const body = (await this.call(`${endpoint}/tasks`, token, timeoutMs)) as { tasks?: WireTask[] };
    const tasks = (body.tasks ?? []).filter((t): t is WireTask & { id: string } => typeof t.id === 'string');
    if (tasks.length === 0) return undefined;
    // A worker runs one conversation; a working task wins, else the last listed.
    const pick = tasks.find((t) => mapA2aState(t.status?.state) === 'WORKING') ?? tasks[tasks.length - 1]!;
    return { taskId: pick.id, state: mapA2aState(pick.status?.state) };
  }

  async taskState(endpoint: string, token: string, timeoutMs: number): Promise<A2aTaskState> {
    return (await this.currentTask(endpoint, token, timeoutMs))?.state ?? 'UNKNOWN';
  }

  async sendMessage(endpoint: string, token: string, msg: { text: string; contextId?: string }, timeoutMs: number) {
    const body = {
      message: {
        messageId: `kookr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        ...(msg.contextId ? { contextId: msg.contextId } : {}),
        role: 'ROLE_USER',
        parts: [{ text: msg.text }],
      },
      configuration: { returnImmediately: true },
    };
    const res = (await this.call(`${endpoint}/message:send`, token, timeoutMs, { method: 'POST', body })) as { task?: WireTask };
    const t = res.task;
    if (!t?.id || !t.contextId) throw new Error('a2a message:send returned no task');
    return { taskId: t.id, contextId: t.contextId, state: mapA2aState(t.status?.state) };
  }

  async cancelTask(endpoint: string, token: string, taskId: string, timeoutMs: number): Promise<A2aTaskState> {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(taskId)) throw new Error('invalid a2a task id');
    await this.call(`${endpoint}/tasks/${taskId}:cancel`, token, timeoutMs, { method: 'POST' });
    const after = (await this.call(`${endpoint}/tasks/${taskId}`, token, timeoutMs)) as WireTask;
    return mapA2aState(after.status?.state);
  }
}
