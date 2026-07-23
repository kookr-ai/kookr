import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  appendLessonWrite,
  buildLessonEntry,
  readPendingLessons,
  readSpoolState,
} from '../core/lesson-write-spool.js';
import { LessonSpoolService, buildKbDegradedAlert } from './lesson-spool-service.js';

describe('LessonSpoolService', () => {
  test('drains spool when probe reports healthy', async () => {
    const spoolDir = await mkdtemp(join(tmpdir(), 'kookr-spool-svc-'));
    await appendLessonWrite(
      spoolDir,
      buildLessonEntry({ title: 'recover-me', body: 'body\n' }),
    );
    const written: string[] = [];
    const svc = new LessonSpoolService({
      spoolDir,
      probeKb: async () => 'healthy',
      writeFn: async (entry) => {
        written.push(entry.title);
        return { ok: true };
      },
      log: () => {},
    });

    const tick = await svc.tick();
    expect(tick.status).toBe('healthy');
    expect(tick.drained?.written).toBe(1);
    expect(written).toEqual(['recover-me']);
    expect(await readPendingLessons(spoolDir)).toHaveLength(0);
  });

  test('fires prolonged degradation alert once past threshold', async () => {
    const spoolDir = await mkdtemp(join(tmpdir(), 'kookr-spool-svc-'));
    const alerts: unknown[] = [];
    let nowMs = Date.parse('2026-07-23T10:00:00.000Z');
    const thresholdMs = 2 * 60 * 60 * 1000;

    const svc = new LessonSpoolService({
      spoolDir,
      thresholdMs,
      probeKb: async () => 'degraded',
      writeFn: async () => ({ ok: false, error: 'still down' }),
      now: () => new Date(nowMs),
      emitAlert: (a) => alerts.push(a),
      log: () => {},
    });

    const first = await svc.tick();
    expect(first.alertFired).toBe(false);
    expect(first.state.kbDegradedSince).toBe('2026-07-23T10:00:00.000Z');

    nowMs += thresholdMs + 1;
    const second = await svc.tick();
    expect(second.alertFired).toBe(true);
    expect(alerts).toHaveLength(1);
    expect((alerts[0] as { summary: string }).summary).toMatch(/KB launch dependency degraded/);

    nowMs += 60_000;
    const third = await svc.tick();
    expect(third.alertFired).toBe(false);
    expect(alerts).toHaveLength(1);

    // Recovery clears streak.
    const healthySvc = new LessonSpoolService({
      spoolDir,
      thresholdMs,
      probeKb: async () => 'healthy',
      writeFn: async () => ({ ok: true }),
      now: () => new Date(nowMs + 1000),
      emitAlert: (a) => alerts.push(a),
      log: () => {},
    });
    const recovered = await healthySvc.tick();
    expect(recovered.state.kbDegradedSince).toBeNull();
    expect(recovered.state.alertFiredAt).toBeNull();
    const state = await readSpoolState(spoolDir);
    expect(state.lastProbeStatus).toBe('healthy');
  });

  test('buildKbDegradedAlert shape', () => {
    const alert = buildKbDegradedAlert({
      degradedSince: '2026-07-22T10:08:00.000Z',
      degradedForHours: 24,
      pendingCount: 3,
      thresholdHours: 2,
    });
    expect(alert.type).toBe('alert');
    expect(alert.severity).toBe('warning');
    expect(alert.operationalAlert?.key).toBe('launch_dependency:kb');
    expect(alert.details).toMatch(/3 lesson write/);
  });
});

void vi;
