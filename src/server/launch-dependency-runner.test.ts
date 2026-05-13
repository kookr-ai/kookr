import { beforeEach, describe, expect, test, vi } from 'vitest';

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

import { runLaunchDependencyPreflights } from './launch-dependency-runner.js';

function mockCommand(
  handler: (file: string, args: string[]) => { stdout?: string; stderr?: string; exitCode?: number },
) {
  mockExecFile.mockImplementation((file: string, args: string[], _opts: unknown, cb: Function) => {
    const result = handler(file, args);
    if (result.exitCode && result.exitCode !== 0) {
      const error = new Error(`${file} exited ${result.exitCode}`) as NodeJS.ErrnoException;
      error.code = result.exitCode as unknown as string;
      cb(error, result.stdout ?? '', result.stderr ?? '');
      return;
    }
    cb(null, result.stdout ?? '', result.stderr ?? '');
  });
}

describe('launch dependency runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('parses non-zero kb doctor JSON before falling back to stderr heuristics', async () => {
    mockCommand((_file, args) => {
      expect(args).toEqual(['doctor', '--format=json']);
      return {
        exitCode: 1,
        stdout: JSON.stringify({
          status: 'error',
          checks: [
            { name: 'index', status: 'error', detail: 'FAISS index has no chunks' },
          ],
        }),
        stderr: 'Error in /home/jean/git/knowledge-base-mcp-server/src/index.ts',
      };
    });

    const findings = await runLaunchDependencyPreflights(['kb']);

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(findings[0]).toEqual(expect.objectContaining({
      dependency: 'kb',
      category: 'empty_index_data',
      summary: 'KB dependency preflight failed: index',
    }));
  });

  test('runs bounded read-only kb search smoke after doctor passes', async () => {
    mockCommand((_file, args) => {
      if (args[0] === 'doctor') {
        return {
          stdout: JSON.stringify({
            status: 'warn',
            checks: [
              { name: 'index', status: 'ok', detail: 'index.v0' },
              { name: 'backend', status: 'ok', detail: 'reachable' },
            ],
          }),
        };
      }
      expect(args).toEqual(['search', 'kookr launch dependency smoke', '--k=1', '--format=json']);
      return {
        exitCode: 1,
        stdout: JSON.stringify({
          error: { message: "Cannot read properties of undefined (reading 'faiss_search_ms')" },
        }),
      };
    });

    const findings = await runLaunchDependencyPreflights(['kb']);

    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(findings[0]).toEqual(expect.objectContaining({
      dependency: 'kb',
      category: 'query_runtime_failure',
      summary: 'KB dependency preflight search smoke failed',
    }));
    expect(findings[0]?.detail).toContain('faiss_search_ms');
  });

  test('passes when doctor and search smoke both pass', async () => {
    mockCommand((_file, args) => {
      if (args[0] === 'doctor') {
        return {
          stdout: JSON.stringify({
            status: 'warn',
            checks: [
              { name: 'staleness', status: 'warn', detail: 'new files' },
              { name: 'backend', status: 'ok', detail: 'reachable' },
            ],
          }),
        };
      }
      return { stdout: JSON.stringify({ results: [] }) };
    });

    await expect(runLaunchDependencyPreflights(['kb'])).resolves.toEqual([]);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });
});
