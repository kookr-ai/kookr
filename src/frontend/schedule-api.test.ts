import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createSchedule,
  deleteSchedule,
  listPlaybooksForCwd,
  listSchedules,
  previewScheduleCron,
  runScheduleNow,
  setScheduleEnabled,
} from './schedule-api.js';

describe('schedule api client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('loads schedules through the schedules endpoint', async () => {
    const response = {
      revision: 2,
      schedules: [],
      status: {
        timezone: 'UTC',
        catchUpMode: 'auto',
        catchUpEnabled: true,
        schedulerHealthy: true,
      },
    };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => response }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listSchedules()).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith('/api/schedules', undefined);
  });

  test('loads playbooks with an encoded cwd query', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => [] }));
    vi.stubGlobal('fetch', fetchMock);

    await listPlaybooksForCwd('/repo with spaces');

    expect(fetchMock).toHaveBeenCalledWith('/api/playbooks?cwd=%2Frepo%20with%20spaces', undefined);
  });

  test('previews schedule cron and returns null for validation failures', async () => {
    const preview = { cronDescription: 'Daily', nextRuns: [], timezone: 'UTC' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => preview })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'bad cron' }) });
    vi.stubGlobal('fetch', fetchMock);

    await expect(previewScheduleCron('0 9 * * *')).resolves.toEqual(preview);
    await expect(previewScheduleCron('bad')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/schedules/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cron: '0 9 * * *' }),
    });
  });

  test('creates schedules with typed payload and preserves validation body on failure', async () => {
    const schedule = { id: 'schedule-1' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => schedule })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'Invalid schedule', fieldErrors: { cron: 'Bad cron' } }),
      });
    vi.stubGlobal('fetch', fetchMock);
    const input = {
      name: 'Nightly',
      cron: '0 9 * * *',
      cwd: '/repo',
      enabled: true,
      agentType: 'claude-code' as const,
      playbook: { path: 'triage.md', parameters: { scope: 'open' } },
    };

    await expect(createSchedule(input)).resolves.toEqual(schedule);
    await expect(createSchedule(input)).rejects.toEqual({
      error: 'Invalid schedule',
      fieldErrors: { cron: 'Bad cron' },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  });

  test('updates, runs, and deletes schedules using encoded ids', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await setScheduleEnabled('schedule/1', false);
    await runScheduleNow('schedule/1');
    await deleteSchedule('schedule/1');

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/schedules/schedule%2F1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/schedules/schedule%2F1/run', { method: 'POST' });
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/schedules/schedule%2F1', { method: 'DELETE' });
  });

  test('preserves action error bodies for mutation failures', async () => {
    const actionError = { error: 'Scheduling not configured' };
    const fetchMock = vi.fn(async () => ({ ok: false, json: async () => actionError }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(runScheduleNow('schedule-1')).rejects.toEqual(actionError);
  });
});
