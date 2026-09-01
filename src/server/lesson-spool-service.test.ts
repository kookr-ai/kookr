import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  appendLessonWrite,
  buildLessonEntry,
  MAX_LESSON_DRAIN_ATTEMPTS,
  readPendingLessons,
  readSpoolState,
} from '../core/lesson-write-spool.js';
import {
  listSignalFiles,
  operationalAlertToSignal,
  readSignal,
  writeOperatorSignal,
} from '../observability/signal-delivery/index.js';
import { LessonSpoolService, buildKbDegradedAlert } from './lesson-spool-service.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('LessonSpoolService', () => {
  test('TS-LESSON-002: drains a valid pending lesson when the probe reports healthy', async () => {
    const spoolDir = await mkdtemp(join(tmpdir(), 'kookr-spool-svc-'));
    tempDirs.push(spoolDir);
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
    expect(tick.drained).toEqual({
      attempted: 1,
      written: 1,
      failed: 0,
      deadLetteredCount: 0,
      remaining: 0,
    });
    expect(tick.state.lastPendingCount).toBe(0);
    expect(written).toEqual(['recover-me']);
    expect(await readPendingLessons(spoolDir)).toHaveLength(0);
  });

  test('TS-LESSON-005: reports a poison entry quarantined by the drain', async () => {
    const spoolDir = await mkdtemp(join(tmpdir(), 'kookr-spool-svc-'));
    tempDirs.push(spoolDir);
    await appendLessonWrite(
      spoolDir,
      {
        ...buildLessonEntry({ title: 'poison', body: 'body\n' }),
        attempts: MAX_LESSON_DRAIN_ATTEMPTS - 1,
      },
    );
    const log = vi.fn();
    const svc = new LessonSpoolService({
      spoolDir,
      probeKb: async () => 'healthy',
      writeFn: async () => ({ ok: false, error: 'input rejected' }),
      log,
    });

    const tick = await svc.tick();
    expect(tick.drained).toEqual({
      attempted: 1,
      written: 0,
      failed: 1,
      deadLetteredCount: 1,
      remaining: 0,
    });
    expect(tick.state.lastPendingCount).toBe(0);
    expect(await readPendingLessons(spoolDir)).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('deadLettered=1'));
  });

  test('fires prolonged degradation alert once past threshold', async () => {
    const spoolDir = await mkdtemp(join(tmpdir(), 'kookr-spool-svc-'));
    tempDirs.push(spoolDir);
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

  test('prolonged degradation spools operator signal via detectorBroadcast bridge (#1990)', async () => {
    const spoolDir = await mkdtemp(join(tmpdir(), 'kookr-spool-signal-'));
    const signalDir = await mkdtemp(join(tmpdir(), 'kookr-lesson-signal-'));
    tempDirs.push(spoolDir, signalDir);
    const pendingWrites: Promise<unknown>[] = [];
    let nowMs = Date.parse('2026-07-23T10:00:00.000Z');
    const thresholdMs = 2 * 60 * 60 * 1000;

    const detectorBroadcast = (msg: { type: string }) => {
      const input = operationalAlertToSignal(msg);
      if (input) pendingWrites.push(writeOperatorSignal(signalDir, input));
    };

    const svc = new LessonSpoolService({
      spoolDir,
      thresholdMs,
      probeKb: async () => 'degraded',
      writeFn: async () => ({ ok: false, error: 'still down' }),
      now: () => new Date(nowMs),
      emitAlert: detectorBroadcast,
      log: () => {},
    });

    await svc.tick();
    nowMs += thresholdMs + 1;
    const second = await svc.tick();
    expect(second.alertFired).toBe(true);
    await Promise.all(pendingWrites);

    const files = await listSignalFiles(signalDir);
    // signalFileName keeps `_` (only non [a-z0-9._-] collapse to `-`).
    expect(files).toContain('op-launch_dependency-kb-alert.json');
    const signal = await readSignal(signalDir, 'op-launch_dependency-kb-alert.json');
    expect(signal).toMatchObject({
      kind: 'alert',
      key: 'op:launch_dependency:kb:alert',
      source: 'launch_dependency_kb_degraded',
    });
    expect(signal?.title).toMatch(/KB launch dependency degraded/);
  });
});
