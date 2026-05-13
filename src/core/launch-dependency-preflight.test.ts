import { describe, expect, test } from 'vitest';
import {
  LaunchPreflightError,
  classifyKbDoctorCommandResult,
  classifyKbDoctorOutput,
  classifyKbSearchSmokeResult,
  formatLaunchPreflightError,
  redactDiagnosticText,
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

  test('parses non-zero kb doctor JSON before falling back to process stderr heuristics', () => {
    const finding = classifyKbDoctorCommandResult({
      exitCode: 1,
      stdout: JSON.stringify({
        schema_version: 'kb-canonical.v1',
        status: 'error',
        checks: [
          { name: 'index', status: 'error', detail: 'FAISS index has no chunks' },
        ],
      }),
      stderr: 'Error in /home/jean/git/knowledge-base-mcp-server/src/index.ts',
    });

    expect(finding?.category).toBe('empty_index_data');
    expect(finding?.summary).toBe('KB dependency preflight failed: index');
  });

  test('classifies kb search smoke failures separately from doctor failures', () => {
    const finding = classifyKbSearchSmokeResult({
      exitCode: 1,
      stdout: JSON.stringify({
        error: { message: "Cannot read properties of undefined (reading 'faiss_search_ms')" },
      }),
      stderr: 'Loading FAISS index from /home/jean/knowledge_bases/.faiss',
    });

    expect(finding).toEqual(expect.objectContaining({
      dependency: 'kb',
      category: 'query_runtime_failure',
      summary: 'KB dependency preflight search smoke failed',
    }));
    expect(finding?.detail).toContain('faiss_search_ms');
    expect(finding?.detail).not.toContain('/home/jean');
  });

  test('redacts and bounds diagnostic snippets', () => {
    const redacted = redactDiagnosticText(
      '/home/jean/.config/kb token=sk-secret password=hunter2 '.repeat(30),
      120,
    );

    expect(redacted).not.toContain('/home/jean');
    expect(redacted).not.toContain('sk-secret');
    expect(redacted).not.toContain('hunter2');
    expect(redacted.length).toBeLessThanOrEqual(120);
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
