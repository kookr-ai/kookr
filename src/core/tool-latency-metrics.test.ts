import { describe, expect, test } from 'vitest';
import { ToolLatencyMetrics } from './tool-latency-metrics.js';

describe('ToolLatencyMetrics', () => {
  test('tracks total count and percentile latency from bounded samples', () => {
    const metrics = new ToolLatencyMetrics({ maxSamplesPerTool: 4 });

    for (const durationMs of [1, 2, 3, 4, 100]) {
      metrics.record({ toolName: 'Bash', durationMs });
    }

    expect(metrics.snapshot()).toEqual({
      schemaVersion: 'tool-latency-metrics.v1',
      maxTools: 64,
      maxSamplesPerTool: 4,
      toolCount: 1,
      droppedToolCount: 0,
      tools: [{
        toolName: 'Bash',
        count: 5,
        sampleCount: 4,
        p50Ms: 3,
        p95Ms: 100,
        p99Ms: 100,
      }],
    });
  });

  test('keys histograms by tool name and sorts by count then name', () => {
    const metrics = new ToolLatencyMetrics();

    metrics.record({ toolName: 'Read', durationMs: 10 });
    metrics.record({ toolName: 'Bash', durationMs: 30 });
    metrics.record({ toolName: 'Bash', durationMs: 50 });
    metrics.record({ toolName: 'Edit', durationMs: 20 });

    const snapshot = metrics.snapshot();
    expect(snapshot.tools.map((t) => t.toolName)).toEqual(['Bash', 'Edit', 'Read']);
    expect(snapshot.tools[0]).toEqual(expect.objectContaining({
      toolName: 'Bash',
      count: 2,
      p50Ms: 30,
      p95Ms: 50,
    }));
  });

  test('bounds tool cardinality and reports dropped new tool samples', () => {
    const metrics = new ToolLatencyMetrics({ maxTools: 1 });

    metrics.record({ toolName: 'Bash', durationMs: 1 });
    metrics.record({ toolName: 'Read', durationMs: 2 });
    metrics.record({ toolName: 'Edit', durationMs: 3 });

    const snapshot = metrics.snapshot();
    expect(snapshot.toolCount).toBe(1);
    expect(snapshot.droppedToolCount).toBe(2);
    expect(snapshot.tools).toEqual([expect.objectContaining({
      toolName: 'Bash',
      count: 1,
    })]);
  });

  test('ignores non-finite or negative durations and empty tool names', () => {
    const metrics = new ToolLatencyMetrics();

    metrics.record({ toolName: 'Bash', durationMs: Number.NaN });
    metrics.record({ toolName: 'Bash', durationMs: -1 });
    metrics.record({ toolName: '   ', durationMs: 10 });
    metrics.record({ toolName: 'Bash', durationMs: 12 });

    expect(metrics.snapshot().tools).toEqual([expect.objectContaining({
      toolName: 'Bash',
      count: 1,
      p50Ms: 12,
    })]);
  });
});
