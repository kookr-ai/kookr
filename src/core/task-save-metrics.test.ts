import { describe, expect, test } from 'vitest';
import {
  TaskSaveMetricsRecorder,
  emptyTaskSaveMetricsSnapshot,
  type TaskSaveSample,
} from './task-save-metrics.js';

function sample(partial: Partial<TaskSaveSample> = {}): TaskSaveSample {
  return {
    serializeMs: 10,
    writeMs: 20,
    totalMs: 30,
    bytes: 1000,
    taskCount: 5,
    relationCount: 1,
    backend: 'json',
    ...partial,
  };
}

describe('TaskSaveMetricsRecorder', () => {
  test('records samples and exposes p95 + last bytes without env flags', () => {
    const recorder = new TaskSaveMetricsRecorder({ maxSamples: 16 });

    // 1..20 ms serialize — p95 of 20 samples ≈ index ceil(0.95*20)-1 = 18 → 19
    for (let i = 1; i <= 20; i += 1) {
      recorder.record(sample({
        serializeMs: i,
        writeMs: i * 2,
        totalMs: i * 3,
        bytes: 1000 + i,
        taskCount: i,
      }));
    }

    const snap = recorder.snapshot();
    expect(snap.schemaVersion).toBe('task-save-metrics.v1');
    expect(snap.maxSamples).toBe(16);
    expect(snap.sampleCount).toBe(16); // ring capped
    expect(snap.totalObservations).toBe(20);
    expect(snap.p95SerializeMs).toBeGreaterThan(0);
    expect(snap.p95WriteMs).toBeGreaterThan(0);
    expect(snap.p95TotalMs).toBeGreaterThan(0);
    expect(snap.last).toEqual({
      serializeMs: 20,
      writeMs: 40,
      totalMs: 60,
      bytes: 1020,
      taskCount: 20,
      relationCount: 1,
      backend: 'json',
    });
  });

  test('ring overwrites oldest samples when maxSamples is exceeded', () => {
    const recorder = new TaskSaveMetricsRecorder({ maxSamples: 3 });
    recorder.record(sample({ serializeMs: 1, bytes: 1 }));
    recorder.record(sample({ serializeMs: 2, bytes: 2 }));
    recorder.record(sample({ serializeMs: 3, bytes: 3 }));
    recorder.record(sample({ serializeMs: 100, bytes: 999 }));

    const snap = recorder.snapshot();
    expect(snap.sampleCount).toBe(3);
    expect(snap.totalObservations).toBe(4);
    expect(snap.last?.bytes).toBe(999);
    // Oldest (1) gone; remaining 2, 3, 100 → p95 picks high end
    expect(snap.p95SerializeMs).toBe(100);
  });

  test('ignores non-finite or negative values', () => {
    const recorder = new TaskSaveMetricsRecorder();
    recorder.record(sample({ serializeMs: Number.NaN }));
    recorder.record(sample({ writeMs: -1 }));
    recorder.record(sample({ bytes: Number.POSITIVE_INFINITY }));
    recorder.record(sample({ backend: 'not-real' as 'json' }));

    const snap = recorder.snapshot();
    expect(snap.sampleCount).toBe(0);
    expect(snap.totalObservations).toBe(0);
    expect(snap.last).toBeNull();
  });

  test('records sqlite backend samples', () => {
    const recorder = new TaskSaveMetricsRecorder();
    recorder.record(sample({
      backend: 'sqlite',
      serializeMs: 0,
      writeMs: 4.5,
      totalMs: 4.5,
      bytes: 42_000,
      taskCount: 3,
      relationCount: 0,
    }));

    const snap = recorder.snapshot();
    expect(snap.last?.backend).toBe('sqlite');
    expect(snap.last?.bytes).toBe(42_000);
    expect(snap.p95WriteMs).toBe(4.5);
  });

  test('reset clears samples and counters', () => {
    const recorder = new TaskSaveMetricsRecorder();
    recorder.record(sample());
    recorder.reset();
    const snap = recorder.snapshot();
    expect(snap.sampleCount).toBe(0);
    expect(snap.totalObservations).toBe(0);
    expect(snap.last).toBeNull();
    expect(snap.p95SerializeMs).toBe(0);
  });

  test('emptyTaskSaveMetricsSnapshot returns zeroed shape', () => {
    expect(emptyTaskSaveMetricsSnapshot()).toEqual({
      schemaVersion: 'task-save-metrics.v1',
      maxSamples: 0,
      sampleCount: 0,
      totalObservations: 0,
      p95SerializeMs: 0,
      p95WriteMs: 0,
      p95TotalMs: 0,
      last: null,
    });
  });
});
