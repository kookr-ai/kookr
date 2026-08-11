import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  formatConfigPreflightCliOutput,
  formatConfigPreflightIssue,
  hasFatalConfigPreflightIssues,
  runConfigPreflight,
  runStartupConfigPreflightOrExit,
} from './config-preflight.js';

const execFileAsync = promisify(execFile);

function makeAccess(executablePaths: string[]): (path: string, mode?: number) => Promise<void> {
  const executable = new Set(executablePaths);
  return async (path, mode) => {
    expect(mode).toBe(constants.X_OK);
    if (executable.has(path)) return;
    const err = new Error(`missing ${path}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  };
}

function makeStat(filePaths: string[]): (path: string) => Promise<{ isFile(): boolean }> {
  const files = new Set(filePaths);
  return async (path) => ({
    isFile: () => files.has(path),
  });
}

function makeAccessError(code: string): (path: string, mode?: number) => Promise<void> {
  return async () => {
    const err = new Error(code) as NodeJS.ErrnoException;
    err.code = code;
    throw err;
  };
}

describe('runConfigPreflight', () => {
  it('passes when default agent commands resolve on PATH', async () => {
    const result = await runConfigPreflight(
      { PATH: '/tools/bin' } as NodeJS.ProcessEnv,
      {
        cwd: '/repo',
        access: makeAccess(['/tools/bin/claude', '/tools/bin/codex']),
        stat: makeStat(['/tools/bin/claude', '/tools/bin/codex']),
      },
    );

    expect(result.issues).toEqual([]);
    expect(hasFatalConfigPreflightIssues(result)).toBe(false);
  });

  it('warns when a default optional agent command is not installed', async () => {
    const result = await runConfigPreflight(
      { PATH: '/tools/bin' } as NodeJS.ProcessEnv,
      {
        cwd: '/repo',
        access: makeAccess(['/tools/bin/claude']),
        stat: makeStat(['/tools/bin/claude']),
      },
    );

    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: 'warning',
        variable: 'KOOKR_CODEX_BIN',
        message: expect.stringContaining('default "codex"'),
      }),
    ]);
    expect(hasFatalConfigPreflightIssues(result)).toBe(false);
  });

  it('fails when an explicitly configured agent binary is missing', async () => {
    const result = await runConfigPreflight(
      {
        PATH: '/tools/bin',
        KOOKR_AGENT_BIN: '/missing/claude',
      } as NodeJS.ProcessEnv,
      {
        cwd: '/repo',
        access: makeAccess(['/tools/bin/codex']),
        stat: makeStat(['/tools/bin/codex']),
      },
    );

    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: 'fatal',
        variable: 'KOOKR_AGENT_BIN',
        message: expect.stringContaining('KOOKR_AGENT_BIN="/missing/claude"'),
      }),
    ]);
    expect(hasFatalConfigPreflightIssues(result)).toBe(true);
  });

  it('reports non-executable explicitly configured agent binaries distinctly', async () => {
    const result = await runConfigPreflight(
      {
        PATH: '/tools/bin',
        KOOKR_AGENT_BIN: '/tools/bin/claude',
      } as NodeJS.ProcessEnv,
      {
        cwd: '/repo',
        access: makeAccessError('EACCES'),
        stat: makeStat([]),
      },
    );

    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: 'fatal',
        variable: 'KOOKR_AGENT_BIN',
        message: expect.stringContaining('exists but is not executable'),
      }),
      expect.objectContaining({
        severity: 'warning',
        variable: 'KOOKR_CODEX_BIN',
      }),
    ]);
  });

  it('fails when an explicitly configured agent binary has surrounding whitespace', async () => {
    const result = await runConfigPreflight(
      {
        PATH: '/tools/bin',
        KOOKR_AGENT_BIN: ' /tools/bin/claude ',
      } as NodeJS.ProcessEnv,
      {
        cwd: '/repo',
        access: makeAccess(['/tools/bin/codex']),
        stat: makeStat(['/tools/bin/codex']),
      },
    );

    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: 'fatal',
        variable: 'KOOKR_AGENT_BIN',
        message: expect.stringContaining('leading or trailing whitespace'),
      }),
    ]);
  });

  it('fails when a resolved agent binary is an executable directory', async () => {
    const result = await runConfigPreflight(
      {
        PATH: '/tools/bin',
        KOOKR_AGENT_BIN: '/tmp',
      } as NodeJS.ProcessEnv,
      {
        cwd: '/repo',
        access: makeAccess(['/tmp', '/tools/bin/codex']),
        stat: makeStat(['/tools/bin/codex']),
      },
    );

    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: 'fatal',
        variable: 'KOOKR_AGENT_BIN',
        message: expect.stringContaining('/tmp is not a file'),
      }),
    ]);
  });

  it('resolves relative explicit binary paths against the server cwd', async () => {
    const access = vi.fn(makeAccess(['/repo/bin/claude', '/tools/bin/codex']));

    const result = await runConfigPreflight(
      {
        PATH: '/tools/bin',
        KOOKR_AGENT_BIN: './bin/claude',
      } as NodeJS.ProcessEnv,
      {
        cwd: '/repo',
        access,
        stat: makeStat(['/repo/bin/claude', '/tools/bin/codex']),
      },
    );

    expect(result.issues).toEqual([]);
    expect(access).toHaveBeenCalledWith('/repo/bin/claude', constants.X_OK);
  });

  it('fails on documented numeric env-var constraint violations', async () => {
    const result = await runConfigPreflight(
      {
        PATH: '/tools/bin',
        KOOKR_PORT: '70000',
        KOOKR_STT_PORT: 'abc',
        KOOKR_TTS_PORT: '1e3',
        KOOKR_REQUEST_BODY_LIMIT_BYTES: '0',
        KOOKR_NUDGE_MIN_TASK_AGE_MS: '-1',
        KOOKR_ALERT_CPU_PERCENT: '-0.1',
        KOOKR_ALERT_DATA_DIR_FREE_BYTES: '-1',
        KOOKR_ALERT_PROCESS_RSS_BYTES: 'not-a-number',
        KOOKR_ALERT_CIRCUIT_BREAKER_OPEN_MS: '1.5',
      } as NodeJS.ProcessEnv,
      {
        cwd: '/repo',
        access: makeAccess(['/tools/bin/claude', '/tools/bin/codex']),
        stat: makeStat(['/tools/bin/claude', '/tools/bin/codex']),
      },
    );

    expect(result.issues.map((issue) => issue.variable)).toEqual([
      'KOOKR_PORT',
      'KOOKR_STT_PORT',
      'KOOKR_TTS_PORT',
      'KOOKR_REQUEST_BODY_LIMIT_BYTES',
      'KOOKR_NUDGE_MIN_TASK_AGE_MS',
      'KOOKR_ALERT_CPU_PERCENT',
      'KOOKR_ALERT_PROCESS_RSS_BYTES',
      'KOOKR_ALERT_DATA_DIR_FREE_BYTES',
      'KOOKR_ALERT_CIRCUIT_BREAKER_OPEN_MS',
    ]);
    expect(result.issues.every((issue) => issue.severity === 'fatal')).toBe(true);
  });

  it('validates every documented numeric env-var constraint in the preflight table', async () => {
    const invalidValues: Record<string, string> = {
      KOOKR_PORT: '70000',
      KOOKR_STT_PORT: 'abc',
      KOOKR_TTS_PORT: '0',
      KOOKR_REQUEST_BODY_LIMIT_BYTES: '0',
      KOOKR_STARTUP_TIMEOUT_SECONDS: '-1',
      KOOKR_STARTUP_CHECK_INTERVAL_SECONDS: '1.5',
      KOOKR_STT_HEALTH_TIMEOUT_S: '0',
      KOOKR_SESSION_BRIDGE_OUTPUT_BATCH_MS: '-1',
      KOOKR_SESSION_BRIDGE_BACKPRESSURE_RETRY_MS: '0',
      KOOKR_SESSION_BRIDGE_BACKPRESSURE_SOFT_BYTES: 'NaN',
      KOOKR_SESSION_BRIDGE_OWNER_BACKPRESSURE_HARD_BYTES: 'Infinity',
      KOOKR_SESSION_BRIDGE_VIEWER_BACKPRESSURE_HARD_BYTES: '2.5',
      KOOKR_NUDGE_MIN_TASK_AGE_MS: '-1',
      KOOKR_LLM_TIMEOUT_MS: '0',
      KOOKR_ALERT_CPU_PERCENT: '-0.1',
      KOOKR_ALERT_MEMORY_PERCENT: '-1',
      KOOKR_ALERT_EVENT_LOOP_DELAY_MS: '-1',
      KOOKR_ALERT_PROCESS_RSS_BYTES: 'not-a-number',
      KOOKR_ALERT_DATA_DIR_FREE_PERCENT: '-1',
      KOOKR_ALERT_DATA_DIR_FREE_BYTES: '-1',
      KOOKR_ALERT_CIRCUIT_BREAKER_OPEN_MS: '1.5',
      KOOKR_ALERT_SUSTAIN_SAMPLES: '0',
      KOOKR_FINDING_REVIEW_DAILY_COST_CENTS: '-1',
      KOOKR_FINDING_REVIEW_MAX_CANDIDATES: '0',
      KOOKR_FINDING_REVIEW_TIMEOUT_MS: '-1',
      KOOKR_FINDING_REVIEW_SAMPLER_INTERVAL_MS: '0',
      KOOKR_FINDING_REVIEW_SAMPLER_MIN_AGE_MS: '-1',
      KOOKR_FINDING_REVIEW_SAMPLER_MIN_OBSERVATIONS: '0',
      KOOKR_FINDING_REVIEW_SAMPLER_MAX_PER_INTERVAL: '0',
      KOOKR_FINDING_REVIEW_SAMPLER_MAX_PER_DETECTOR: '-1',
      KOOKR_FINDING_REVIEW_SAMPLER_MAX_TOKENS_PER_CANDIDATE: '0',
      KOOKR_FINDING_REVIEW_SAMPLER_DAILY_TOKEN_BUDGET: '0',
      KOOKR_FINDING_REVIEW_SAMPLER_LEASE_MS: '0',
      KOOKR_FINDING_REVIEW_SAMPLER_MAX_ATTEMPTS: '0',
      KOOKR_FINDING_REVIEW_SAMPLER_RETRY_BASE_MS: '0',
      KOOKR_FINDING_REVIEW_SAMPLER_CANDIDATE_READ_LIMIT: '0',
    };

    const result = await runConfigPreflight(
      {
        PATH: '/tools/bin',
        ...invalidValues,
      } as NodeJS.ProcessEnv,
      {
        cwd: '/repo',
        access: makeAccess(['/tools/bin/claude', '/tools/bin/codex']),
        stat: makeStat(['/tools/bin/claude', '/tools/bin/codex']),
      },
    );

    expect(result.issues.map((issue) => issue.variable)).toEqual(Object.keys(invalidValues));
    expect(result.issues.every((issue) => issue.severity === 'fatal')).toBe(true);
  });

  it('fails early on unsupported KOOKR_BACKEND values', async () => {
    const result = await runConfigPreflight(
      {
        PATH: '/tools/bin',
        KOOKR_BACKEND: 'tmux',
      } as NodeJS.ProcessEnv,
      {
        cwd: '/repo',
        access: makeAccess(['/tools/bin/claude', '/tools/bin/codex']),
        stat: makeStat(['/tools/bin/claude', '/tools/bin/codex']),
      },
    );

    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: 'fatal',
        variable: 'KOOKR_BACKEND',
        message: expect.stringContaining('not supported'),
      }),
    ]);
  });

  it('fails on blocked KOOKR_STT_URL / KOOKR_TTS_URL values (#2057)', async () => {
    const result = await runConfigPreflight(
      {
        PATH: '/tools/bin',
        KOOKR_STT_URL: 'http://169.254.169.254/latest/meta-data/',
        KOOKR_TTS_URL: 'http://user:pass@127.0.0.1:8004',
      } as NodeJS.ProcessEnv,
      {
        cwd: '/repo',
        access: makeAccess(['/tools/bin/claude', '/tools/bin/codex']),
        stat: makeStat(['/tools/bin/claude', '/tools/bin/codex']),
      },
    );

    expect(result.issues.map((issue) => issue.variable)).toEqual([
      'KOOKR_STT_URL',
      'KOOKR_TTS_URL',
    ]);
    expect(result.issues.every((issue) => issue.severity === 'fatal')).toBe(true);
  });

  it('fails on blocked KOOKR_RELAY_URL values (#2107)', async () => {
    const result = await runConfigPreflight(
      {
        PATH: '/tools/bin',
        KOOKR_RELAY_URL: 'http://169.254.169.254/latest/meta-data/',
      } as NodeJS.ProcessEnv,
      {
        cwd: '/repo',
        access: makeAccess(['/tools/bin/claude', '/tools/bin/codex']),
        stat: makeStat(['/tools/bin/claude', '/tools/bin/codex']),
      },
    );

    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: 'fatal',
        variable: 'KOOKR_RELAY_URL',
        message: expect.stringContaining('metadata/link-local blocked'),
      }),
    ]);
  });

  it('accepts loopback and private-LAN KOOKR_RELAY_URL values (#2107)', async () => {
    const result = await runConfigPreflight(
      {
        PATH: '/tools/bin',
        KOOKR_RELAY_URL: 'http://192.168.1.50:4800',
      } as NodeJS.ProcessEnv,
      {
        cwd: '/repo',
        access: makeAccess(['/tools/bin/claude', '/tools/bin/codex']),
        stat: makeStat(['/tools/bin/claude', '/tools/bin/codex']),
      },
    );

    expect(result.issues.filter((issue) => issue.variable === 'KOOKR_RELAY_URL')).toEqual([]);
  });

  it('fails on blocked KOOKR_TELEGRAM_API_URL values (#2219)', async () => {
    const result = await runConfigPreflight(
      {
        PATH: '/tools/bin',
        KOOKR_TELEGRAM_API_URL: 'http://169.254.169.254/',
      } as NodeJS.ProcessEnv,
      {
        cwd: '/repo',
        access: makeAccess(['/tools/bin/claude', '/tools/bin/codex']),
        stat: makeStat(['/tools/bin/claude', '/tools/bin/codex']),
      },
    );

    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: 'fatal',
        variable: 'KOOKR_TELEGRAM_API_URL',
        message: expect.stringContaining('metadata/link-local blocked'),
      }),
    ]);
  });

  it('accepts loopback and private-LAN KOOKR_TELEGRAM_API_URL values (#2219)', async () => {
    const result = await runConfigPreflight(
      {
        PATH: '/tools/bin',
        KOOKR_TELEGRAM_API_URL: 'http://127.0.0.1:18080',
      } as NodeJS.ProcessEnv,
      {
        cwd: '/repo',
        access: makeAccess(['/tools/bin/claude', '/tools/bin/codex']),
        stat: makeStat(['/tools/bin/claude', '/tools/bin/codex']),
      },
    );

    expect(result.issues.filter((issue) => issue.variable === 'KOOKR_TELEGRAM_API_URL')).toEqual([]);
  });

  it('accepts loopback and private-LAN speech service URLs (#2057)', async () => {
    const result = await runConfigPreflight(
      {
        PATH: '/tools/bin',
        KOOKR_STT_URL: 'ws://127.0.0.1:8003',
        KOOKR_TTS_URL: 'http://192.168.1.50:8004',
      } as NodeJS.ProcessEnv,
      {
        cwd: '/repo',
        access: makeAccess(['/tools/bin/claude', '/tools/bin/codex']),
        stat: makeStat(['/tools/bin/claude', '/tools/bin/codex']),
      },
    );

    expect(result.issues.filter((issue) =>
      issue.variable === 'KOOKR_STT_URL' || issue.variable === 'KOOKR_TTS_URL',
    )).toEqual([]);
  });

  it('warns on documented precedence pairs that are both set', async () => {
    const result = await runConfigPreflight(
      {
        PATH: '/tools/bin',
        KOOKR_AUTO_CATCHUP: '1',
        KOOKR_NO_CATCHUP: '1',
        KOOKR_CONTEXT_ADVISORY_ENABLED: '1',
        KOOKR_CONTEXT_ADVISORY_DISABLED: '1',
      } as NodeJS.ProcessEnv,
      {
        cwd: '/repo',
        access: makeAccess(['/tools/bin/claude', '/tools/bin/codex']),
        stat: makeStat(['/tools/bin/claude', '/tools/bin/codex']),
      },
    );

    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: 'warning',
        variable: 'KOOKR_CONTEXT_ADVISORY_ENABLED/KOOKR_CONTEXT_ADVISORY_DISABLED',
      }),
      expect.objectContaining({
        severity: 'warning',
        variable: 'KOOKR_AUTO_CATCHUP/KOOKR_NO_CATCHUP',
      }),
    ]);
    expect(hasFatalConfigPreflightIssues(result)).toBe(false);
  });

  it('warns on the KOOKR_MANUAL_CATCHUP precedence pairs (#1900)', async () => {
    const result = await runConfigPreflight(
      {
        PATH: '/tools/bin',
        KOOKR_AUTO_CATCHUP: '1',
        KOOKR_MANUAL_CATCHUP: '1',
        KOOKR_NO_CATCHUP: '1',
      } as NodeJS.ProcessEnv,
      {
        cwd: '/repo',
        access: makeAccess(['/tools/bin/claude', '/tools/bin/codex']),
        stat: makeStat(['/tools/bin/claude', '/tools/bin/codex']),
      },
    );

    const variables = result.issues.map((issue) => issue.variable);
    expect(variables).toContain('KOOKR_AUTO_CATCHUP/KOOKR_NO_CATCHUP');
    expect(variables).toContain('KOOKR_MANUAL_CATCHUP/KOOKR_NO_CATCHUP');
    expect(variables).toContain('KOOKR_AUTO_CATCHUP/KOOKR_MANUAL_CATCHUP');
    expect(hasFatalConfigPreflightIssues(result)).toBe(false);
  });
});

describe('formatConfigPreflightIssue', () => {
  it('keeps the remediation attached to the issue', () => {
    expect(
      formatConfigPreflightIssue({
        severity: 'fatal',
        variable: 'KOOKR_PORT',
        message: 'KOOKR_PORT="bad" violates the documented constraint.',
        remediation: 'Set KOOKR_PORT to an integer port.',
      }),
    ).toBe(
      '[fatal] KOOKR_PORT="bad" violates the documented constraint.\n' +
        '  Fix: Set KOOKR_PORT to an integer port.',
    );
  });
});

describe('formatConfigPreflightCliOutput', () => {
  it('formats fatal and warning issues for doctor status mapping', () => {
    const output = formatConfigPreflightCliOutput({
      issues: [
        {
          severity: 'fatal',
          variable: 'KOOKR_PORT',
          message: 'bad port',
          remediation: 'fix port',
        },
        {
          severity: 'warning',
          variable: 'KOOKR_CODEX_BIN',
          message: 'missing codex',
          remediation: 'install codex',
        },
      ],
    });

    expect(output).toBe(
      'FAIL\tbad port Fix: fix port\n' +
        'WARN\tmissing codex Fix: install codex',
    );
  });
});

describe('runStartupConfigPreflightOrExit', () => {
  it('exits and prints fatal preflight issues before startup continues', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${String(code)}`);
    }) as never);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(
        runStartupConfigPreflightOrExit({
          PATH: '/tools/bin',
          KOOKR_AGENT_BIN: '/missing/claude',
        } as NodeJS.ProcessEnv),
      ).rejects.toThrow('process.exit:1');

      expect(error.mock.calls.join('\n')).toContain('Startup configuration preflight failed');
      expect(error.mock.calls.join('\n')).toContain('KOOKR_AGENT_BIN="/missing/claude"');
    } finally {
      exit.mockRestore();
      error.mockRestore();
      warn.mockRestore();
    }
  });
});

describe('startup and doctor wiring', () => {
  it('calls the startup preflight before resolving listen-port state', async () => {
    const source = await readFile(new URL('./start.ts', import.meta.url), 'utf8');

    expect(source).toContain("import { runStartupConfigPreflightOrExit } from './config-preflight.js';");
    expect(source.indexOf('await runStartupConfigPreflightOrExit(process.env);')).toBeGreaterThan(-1);
    expect(source.indexOf('await runStartupConfigPreflightOrExit(process.env);')).toBeLessThan(
      source.indexOf('resolveListenPort(process.env.KOOKR_PORT, HOST)'),
    );
  });

  it('doctor reports configured missing agent binaries as startup config failures', async () => {
    await expect(
      execFileAsync('bash', ['scripts/doctor.sh'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          KOOKR_AGENT_BIN: '/definitely/missing/kookr-claude',
        },
        timeout: 30_000,
      }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('startup config'),
    });
  }, 30_000);
});
