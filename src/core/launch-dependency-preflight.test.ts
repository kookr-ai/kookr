import { describe, expect, test } from 'vitest';
import {
  LaunchPreflightError,
  classifyKbDoctorOutput,
  formatLaunchPreflightError,
} from './launch-dependency-preflight.js';

describe('KB launch dependency preflight', () => {
  test('passes when kb doctor is ok or warn only', () => {
    expect(classifyKbDoctorOutput({
      status: 'warn',
      checks: [
        { name: 'layout', status: 'ok', detail: 'ok' },
        { name: 'staleness', status: 'warn', detail: '3 new files' },
        { name: 'backend', status: 'ok', detail: 'reachable' },
      ],
      backend: { healthy: true },
    })).toBeNull();
  });

  test('classifies backend reachability failures', () => {
    const finding = classifyKbDoctorOutput({
      status: 'error',
      checks: [
        { name: 'backend', status: 'error', detail: 'ECONNREFUSED http://localhost:11434' },
      ],
    });

    expect(finding).toEqual(expect.objectContaining({
      dependency: 'kb',
      category: 'server_reachability',
      summary: 'KB dependency preflight failed: backend',
    }));
  });

  test('classifies index/data failures', () => {
    const finding = classifyKbDoctorOutput({
      status: 'error',
      checks: [
        { name: 'index', status: 'error', detail: 'FAISS index has no chunks' },
      ],
    });

    expect(finding?.category).toBe('empty_index_data');
  });

  test('formats launch-preflight errors with operator action', () => {
    const error = new LaunchPreflightError([
      {
        dependency: 'kb',
        status: 'failed',
        category: 'configuration',
        summary: 'KB dependency preflight failed: active_model',
        detail: 'active model is missing',
        recommendedAction: 'Fix KB config.',
      },
    ]);

    expect(formatLaunchPreflightError(error.findings)).toContain('active_model');
    expect(error.message).toContain('Recommended action: Fix KB config.');
  });
});
