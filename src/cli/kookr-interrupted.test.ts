import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { InterruptedTasksService } from '../server/interrupted-tasks/interrupted-tasks-service.js';
import { registerInterruptedTasksRoutes } from '../server/routes/interrupted-tasks-routes.js';
import type { Task } from '../core/tasks.js';
import { parseInterruptedArgs, runInterruptedCli } from './kookr-interrupted.js';

/**
 * The CLI end to end: `runInterruptedCli` → the real routes → a real service
 * writing a real batch file. Only the Reopen command is faked.
 */
let dir: string;
let service: InterruptedTasksService;
let reopened: string[];
let tasks: Map<string, Partial<Task>>;
let fetchImpl: typeof fetch;
let lines: string[];
let errors: string[];

const env = { KOOKR_API_BASE_URL: 'http://kookr.test' } as NodeJS.ProcessEnv;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kookr-interrupted-cli-'));
  reopened = [];
  lines = [];
  errors = [];
  tasks = new Map<string, Partial<Task>>([
    // A stopped task whose conversation can be resumed (no transcript path recorded: resumes by id).
    ['t-stopped', { id: 't-stopped', name: 'Stopped task', status: 'terminated', agentType: 'claude-code', sessions: [{ claudeSessionId: 'c1' }] as Task['sessions'] }],
    // A stopped task that never reported a conversation.
    ['t-fresh', { id: 't-fresh', name: 'Fresh task', status: 'terminated', agentType: 'claude-code', sessions: [] }],
    ['t-running', { id: 't-running', name: 'Running task', status: 'inProgress', agentType: 'claude-code', sessions: [] }],
  ]);
  service = new InterruptedTasksService({
    filePath: join(dir, 'interrupted-tasks.json'),
    timeoutMs: 10 * 60_000,
    reopenTask: async (taskId) => {
      reopened.push(taskId);
      return { ok: true, mode: taskId === 't-fresh' ? 'not_resumable' : 'resume' };
    },
    isTaskTerminal: (taskId) => tasks.get(taskId)?.status === 'terminated',
    log: () => undefined,
  });
  await service.start();
  const app = new Hono();
  registerInterruptedTasksRoutes(app, { service, taskStore: { getTask: (id: string) => tasks.get(id) as Task | undefined } });
  fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(String(input), init))) as typeof fetch;
});

afterEach(async () => {
  service.stop();
  await rm(dir, { recursive: true, force: true });
});

const run = (...argv: string[]) => runInterruptedCli(argv, {
  env,
  fetchImpl,
  out: { log: (m: unknown) => lines.push(String(m)) },
  err: { error: (m: unknown) => errors.push(String(m)) },
  now: () => Date.now(),
});

describe('kookr interrupted', () => {
  test('ask parks stopped tasks, refuses a running one, and says what each would do', async () => {
    expect(await run('ask', 't-stopped', 't-fresh', 't-running')).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('t-stopped  Stopped task: would continue its conversation');
    expect(text).toMatch(/t-fresh {2}Fresh task: no conversation to resume/);
    expect(text).toContain('not added: t-running (task is inProgress, not stopped)');
    expect(reopened).toEqual([]);
    expect(service.pending()?.tasks.map((t) => t.taskId)).toEqual(['t-stopped', 't-fresh']);
  });

  test('decide resume relaunches only the task with a conversation', async () => {
    await run('ask', 't-stopped', 't-fresh');
    lines = [];
    expect(await run('decide', 'resume')).toBe(0);
    expect(reopened).toEqual(['t-stopped']);
    expect(lines.join('\n')).toContain('decided "resume" by operator');
  });

  test('decide resume_all also restarts the task without one', async () => {
    await run('ask', 't-stopped', 't-fresh');
    expect(await run('decide', 'resume_all', '--json')).toBe(0);
    expect(reopened).toEqual(['t-stopped', 't-fresh']);
    const envelope = JSON.parse(lines.at(-1)!) as { ok: boolean; details: { batch: { state: string } } };
    expect(envelope.ok).toBe(true);
    expect(envelope.details.batch.state).toBe('decided');
  });

  test('decide with nothing pending is a user error', async () => {
    expect(await run('decide', 'leave')).toBe(2);
    expect(errors.join('\n')).toContain('no batch is waiting for a decision');
  });

  test('status lists batches as JSON', async () => {
    await run('ask', 't-stopped');
    lines = [];
    expect(await run('status', '--json')).toBe(0);
    const envelope = JSON.parse(lines[0]!) as { details: { batches: unknown[] } };
    expect(envelope.details.batches).toHaveLength(1);
  });

  test('ask with only unknown tasks reports the refusal', async () => {
    expect(await run('ask', 'nope')).toBe(2);
    expect(errors.join('\n')).toContain('no task can be parked');
  });
});

describe('parseInterruptedArgs', () => {
  test('rejects a bad choice, a missing task id, and an unknown verb', () => {
    expect(parseInterruptedArgs(['decide', 'maybe']).kind).toBe('error');
    expect(parseInterruptedArgs(['ask']).kind).toBe('error');
    expect(parseInterruptedArgs(['frobnicate']).kind).toBe('error');
    expect(parseInterruptedArgs([]).kind).toBe('help');
    expect(parseInterruptedArgs(['decide', 'leave', '--batch', 'b1'])).toEqual({ kind: 'decide', json: false, choice: 'leave', batchId: 'b1' });
  });
});
