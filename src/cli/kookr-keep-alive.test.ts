import { describe, it, expect, vi } from 'vitest';
import {
  parseKeepAliveArgs,
  runKeepAliveCli,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_USER_ERROR,
} from './kookr-keep-alive.js';

describe('parseKeepAliveArgs (issue #4241)', () => {
  it('parses the task, the duration and the reason', () => {
    expect(parseKeepAliveArgs(['a1b2c3d4', '--for', '30m', '--reason', 'waiting on CI']))
      .toEqual({ taskRef: 'a1b2c3d4', forMs: 30 * 60_000, reason: 'waiting on CI', json: false, help: false });
    expect(parseKeepAliveArgs(['--for=1h', '--reason=x', 'id', '--json']))
      .toMatchObject({ taskRef: 'id', forMs: 3_600_000, reason: 'x', json: true });
  });

  it('rejects a bad duration, a missing value, an unknown option and extra positionals', () => {
    expect(parseKeepAliveArgs(['id', '--for', 'soon']).error).toContain('--for must be a duration');
    expect(parseKeepAliveArgs(['id', '--reason']).error).toBe('option --reason requires a value');
    expect(parseKeepAliveArgs(['id', '--bogus']).error).toBe('unknown option: --bogus');
    expect(parseKeepAliveArgs(['a', 'b']).error).toBe('exactly one <taskId> is expected');
  });
});

describe('runKeepAliveCli', () => {
  const io = (status: number, body: unknown, env: NodeJS.ProcessEnv = {}) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
    const out = { log: vi.fn() };
    const err = { error: vi.fn() };
    return { fetchImpl, out, err, env: { KOOKR_API_BASE_URL: 'http://kookr.test', ...env } };
  };

  it('sends the caller task id and reports the new deadline', async () => {
    const deps = io(200, { taskId: 'worker-1', deadlineAt: '2026-08-03T12:30:00.000Z', remainingKeepAlives: 2 }, { KOOKR_TASK_ID: 'lead-1' });
    const code = await runKeepAliveCli(['worker-1', '--for', '30m', '--reason', 'waiting on CI'], deps as any);
    expect(code).toBe(EXIT_OK);
    const [url, init] = deps.fetchImpl.mock.calls[0];
    expect(url).toBe('http://kookr.test/api/tasks/worker-1/keep-alive');
    expect(JSON.parse(init.body)).toEqual({ forMs: 1_800_000, reason: 'waiting on CI', callerTaskId: 'lead-1' });
    expect(deps.out.log).toHaveBeenCalledWith(
      'Kept task worker-1 alive until 2026-08-03T12:30:00.000Z (2 keep-alive(s) left in this cycle).',
    );
  });

  it('omits the caller id for the operator', async () => {
    const deps = io(200, { taskId: 'w', deadlineAt: 'x' });
    await runKeepAliveCli(['w', '--for', '10m', '--reason', 'r'], deps as any);
    expect(JSON.parse(deps.fetchImpl.mock.calls[0][1].body)).not.toHaveProperty('callerTaskId');
  });

  it('maps a refusal to exit 6 with the server message', async () => {
    const deps = io(403, { error: 'Task other is not the parent of task w.', code: 'not_parent' }, { KOOKR_TASK_ID: 'other' });
    const code = await runKeepAliveCli(['w', '--for', '10m', '--reason', 'r', '--json'], deps as any);
    expect(code).toBe(EXIT_REFUSED);
    expect(JSON.parse(deps.out.log.mock.calls[0][0])).toMatchObject({ ok: false, code: 'not_parent' });
  });

  it('requires --for and --reason', async () => {
    const deps = io(200, {});
    expect(await runKeepAliveCli(['w', '--reason', 'r'], deps as any)).toBe(EXIT_USER_ERROR);
    expect(await runKeepAliveCli(['w', '--for', '10m'], deps as any)).toBe(EXIT_USER_ERROR);
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });
});
