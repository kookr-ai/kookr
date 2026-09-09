import { beforeEach, describe, expect, test, vi } from 'vitest';

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

import {
  resetKbPreflightCacheForTests,
  runLaunchDependencyPreflights,
} from './launch-dependency-runner.js';

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
    resetKbPreflightCacheForTests();
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

  test('classifies a real child-process timeout as unknown health', async () => {
    mockExecFile.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: Function) => {
      const error = Object.assign(new Error('Command timed out'), {
        code: 'ETIMEDOUT',
        killed: true,
      });
      cb(error, '', 'timed out after 5000ms');
    });

    const findings = await runLaunchDependencyPreflights(['kb']);

    expect(findings).toEqual([
      expect.objectContaining({ dependency: 'kb', category: 'unknown' }),
    ]);
  });

  describe('preflight result TTL cache (issue #3074)', () => {
    const TTL_MS = 3_000;

    // A failing `kb doctor` short-circuits before the search smoke, so exactly
    // one `kb` exec happens per probe — the cleanest way to assert "at most
    // once" reuse without conflating doctor + search calls.
    function mockFailingDoctor(): void {
      mockCommand((_file, args) => {
        expect(args[0]).toBe('doctor');
        return {
          exitCode: 1,
          stdout: JSON.stringify({
            status: 'error',
            checks: [{ name: 'index', status: 'error', detail: 'FAISS index has no chunks' }],
          }),
        };
      });
    }

    test('reuses a single probe across two launches within the TTL', async () => {
      mockFailingDoctor();

      const first = await runLaunchDependencyPreflights(['kb']);
      const second = await runLaunchDependencyPreflights(['kb']);

      expect(mockExecFile).toHaveBeenCalledTimes(1);
      expect(first[0]).toEqual(expect.objectContaining({ dependency: 'kb', category: 'empty_index_data' }));
      expect(second).toEqual(first);
    });

    test('collapses concurrent launches onto one in-flight probe', async () => {
      mockFailingDoctor();

      const [first, second] = await Promise.all([
        runLaunchDependencyPreflights(['kb']),
        runLaunchDependencyPreflights(['kb']),
      ]);

      expect(mockExecFile).toHaveBeenCalledTimes(1);
      expect(first[0]).toEqual(expect.objectContaining({ dependency: 'kb', category: 'empty_index_data' }));
      expect(second).toEqual(first);
    });

    test('re-probes once the TTL elapses', async () => {
      vi.useFakeTimers();
      try {
        mockFailingDoctor();

        await runLaunchDependencyPreflights(['kb']);
        expect(mockExecFile).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(TTL_MS + 1);

        await runLaunchDependencyPreflights(['kb']);
        expect(mockExecFile).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    test('reflects a dependency-state change within one TTL window', async () => {
      vi.useFakeTimers();
      try {
        let degraded = false;
        mockCommand((_file, args) => {
          if (args[0] === 'doctor') {
            return degraded
              ? {
                  exitCode: 1,
                  stdout: JSON.stringify({
                    status: 'error',
                    checks: [{ name: 'index', status: 'error', detail: 'FAISS index has no chunks' }],
                  }),
                }
              : {
                  stdout: JSON.stringify({
                    status: 'ok',
                    checks: [{ name: 'backend', status: 'ok', detail: 'reachable' }],
                  }),
                };
          }
          return { stdout: JSON.stringify({ results: [] }) };
        });

        await expect(runLaunchDependencyPreflights(['kb'])).resolves.toEqual([]);

        // Dependency degrades; the cached healthy result must not outlive the TTL.
        degraded = true;
        vi.advanceTimersByTime(TTL_MS + 1);

        const afterChange = await runLaunchDependencyPreflights(['kb']);
        expect(afterChange[0]).toEqual(
          expect.objectContaining({ dependency: 'kb', category: 'empty_index_data' }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    test('re-probes at exactly the TTL boundary (now === expiresAt)', async () => {
      vi.useFakeTimers();
      try {
        mockFailingDoctor();

        await runLaunchDependencyPreflights(['kb']);
        expect(mockExecFile).toHaveBeenCalledTimes(1);

        // The reuse gate is `now < expiresAt`, so the entry is already expired
        // at exactly its expiry — advancing by the full TTL (not TTL+1) must
        // re-probe. Guards against an accidental `<=` regression.
        vi.advanceTimersByTime(TTL_MS);

        await runLaunchDependencyPreflights(['kb']);
        expect(mockExecFile).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    test('reuses a cached unknown finding, keeping fail-open admission unchanged', async () => {
      // The motivating scenario (issue #3074): during a KB outage the probe
      // times out and yields an `unknown` finding. Admission fails open on
      // `unknown`, and the fix must reuse that same finding rather than
      // re-probing per launch — so the cached value stays byte-for-byte the
      // `unknown` finding admission already handled.
      mockExecFile.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: Function) => {
        const error = Object.assign(new Error('Command timed out'), {
          code: 'ETIMEDOUT',
          killed: true,
        });
        cb(error, '', 'timed out after 5000ms');
      });

      const first = await runLaunchDependencyPreflights(['kb']);
      const second = await runLaunchDependencyPreflights(['kb']);

      expect(mockExecFile).toHaveBeenCalledTimes(1);
      expect(first[0]).toEqual(expect.objectContaining({ dependency: 'kb', category: 'unknown' }));
      expect(second).toEqual(first);
    });

    test('does not cache a probe that threw; the next launch re-probes', async () => {
      // A failing `kb doctor` is classified into a finding (and cached), but a
      // thrown search exec (e.g. `kb` disappearing mid-probe as ENOENT) rejects
      // the whole probe. That rejection must not be cached, so the next launch
      // re-probes rather than reusing an unclassified failure.
      mockExecFile.mockImplementation((_file: string, args: string[], _opts: unknown, cb: Function) => {
        if (args[0] === 'doctor') {
          cb(null, JSON.stringify({ status: 'ok', checks: [{ name: 'backend', status: 'ok' }] }), '');
          return;
        }
        const error = Object.assign(new Error('spawn kb ENOENT'), { code: 'ENOENT' });
        cb(error, '', '');
      });

      await expect(runLaunchDependencyPreflights(['kb'])).rejects.toThrow();
      const afterFirst = mockExecFile.mock.calls.length;

      await expect(runLaunchDependencyPreflights(['kb'])).rejects.toThrow();
      expect(mockExecFile.mock.calls.length).toBeGreaterThan(afterFirst);
    });
  });
});
