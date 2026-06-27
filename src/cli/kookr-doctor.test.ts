import { describe, expect, it, vi } from 'vitest';
import { buildDoctorJsonReport, runDoctorCli } from './kookr-doctor.js';

function commandRunner(fixtures: Record<string, { stdout?: string; stderr?: string; exitCode?: number }>) {
  return vi.fn(async (file: string, args: readonly string[]) => {
    const key = JSON.stringify([file, args]);
    const result = fixtures[key];
    if (!result) return { stdout: '', stderr: `missing fixture for ${key}`, exitCode: 1 };
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.exitCode ?? 0 };
  });
}

function happyFixtures() {
  return {
    [JSON.stringify(['node', ['--version']])]: { stdout: 'v24.11.1\n' },
    [JSON.stringify(['pnpm', ['--version']])]: { stdout: '10.33.0\n' },
    [JSON.stringify(['git', ['--version']])]: { stdout: 'git version 2.50.1\n' },
    [JSON.stringify(['gh', ['auth', 'status']])]: { stdout: 'Logged in\n' },
    [JSON.stringify(['dtach', ['-V']])]: { stdout: 'dtach - version 0.9\n' },
    [JSON.stringify(['kb', ['doctor', '--format=json']])]: {
      stdout: JSON.stringify({ status: 'ok', checks: [{ name: 'backend', status: 'ok' }] }),
    },
    [JSON.stringify(['kb', ['search', 'kookr launch dependency smoke', '--k=1', '--format=json']])]: {
      stdout: JSON.stringify({ results: [] }),
    },
    [JSON.stringify(['claude', ['--version']])]: { stdout: '1.2.3\n' },
    [JSON.stringify(['codex', ['--version']])]: { stdout: 'codex 0.9.0\n' },
    [JSON.stringify(['codex', ['--help']])]: { stdout: 'Usage: codex --plugin-dir <path>\n' },
  };
}

describe('kookr doctor --json', () => {
  it('emits a passing JSON report for required launch prerequisites', async () => {
    const run = commandRunner(happyFixtures());

    const report = await buildDoctorJsonReport({
      env: {},
      commandRunner: run,
      access: async () => {},
      now: () => new Date('2026-06-21T07:30:00.000Z'),
    });

    expect(report).toMatchObject({
      ok: true,
      status: 'ok',
      generatedAt: '2026-06-21T07:30:00.000Z',
    });
    expect(report.checks.map((check) => check.id)).toEqual(expect.arrayContaining([
      'runtime.node',
      'runtime.pnpm',
      'runtime.git',
      'runtime.dtach',
      'github.gh-auth',
      'launch.kb',
      'agent.claude',
      'agent.codex',
      'agent.codex-plugin-dir',
    ]));
    expect(report.checks.every((check) => check.status === 'ok')).toBe(true);
  });

  it('keeps KB doctor failures advisory and uses the launch dependency taxonomy', async () => {
    const run = commandRunner({
      ...happyFixtures(),
      [JSON.stringify(['kb', ['doctor', '--format=json']])]: {
        exitCode: 1,
        stdout: JSON.stringify({
          status: 'error',
          checks: [{ name: 'index', status: 'error', detail: 'FAISS index has no chunks' }],
        }),
      },
    });

    const report = await buildDoctorJsonReport({ env: {}, commandRunner: run, access: async () => {} });
    const kb = report.checks.find((check) => check.id === 'launch.kb-doctor');

    expect(report.ok).toBe(true);
    expect(report.status).toBe('warn');
    expect(kb).toMatchObject({
      status: 'warn',
      required: false,
      summary: 'KB dependency preflight failed: index',
    });
    expect(kb?.recommendedAction).toContain('knowledge-base index');
  });

  it('fails when required runtime checks fail', async () => {
    const run = commandRunner({
      ...happyFixtures(),
      [JSON.stringify(['node', ['--version']])]: { stdout: 'v20.0.0\n' },
    });

    const report = await buildDoctorJsonReport({ env: {}, commandRunner: run, access: async () => {} });

    expect(report.ok).toBe(false);
    expect(report.status).toBe('fail');
    expect(report.checks.find((check) => check.id === 'runtime.node')).toMatchObject({
      status: 'fail',
      required: true,
    });
  });

  it('accepts system dtach when the vendored binary is unavailable', async () => {
    const run = commandRunner(happyFixtures());

    const report = await buildDoctorJsonReport({
      env: {},
      commandRunner: run,
      access: async () => {
        throw new Error('missing vendored dtach');
      },
    });

    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.id === 'runtime.dtach')).toMatchObject({
      status: 'ok',
      summary: 'system dtach is available on PATH',
    });
  });

  it('prints JSON and returns an exit code based on required failures', async () => {
    const run = commandRunner(happyFixtures());
    const logs: string[] = [];
    const errors: string[] = [];

    const code = await runDoctorCli(['--json'], {
      env: {},
      commandRunner: run,
      access: async () => {},
      out: {
        log: (msg: string) => logs.push(msg),
        error: (msg: string) => errors.push(msg),
      },
    });

    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(JSON.parse(logs[0]!)).toMatchObject({ ok: true, status: 'ok' });
  });

  it('returns exit code 1 and JSON fail status when a required check fails', async () => {
    const run = commandRunner({
      ...happyFixtures(),
      [JSON.stringify(['node', ['--version']])]: { stdout: 'v20.0.0\n' },
    });
    const logs: string[] = [];

    const code = await runDoctorCli(['--json'], {
      env: {},
      commandRunner: run,
      access: async () => {},
      out: {
        log: (msg: string) => logs.push(msg),
        error: () => {},
      },
    });

    expect(code).toBe(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({ ok: false, status: 'fail' });
  });
});
