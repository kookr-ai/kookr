import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildDoctorJsonReport, formatDoctorReport, runDoctorCli } from './kookr-doctor.js';

/** Stable happy-path check ids plus KB failure-mode ids that can replace `launch.kb`. */
const DOCUMENTED_DOCTOR_CHECK_IDS = [
  'runtime.node',
  'runtime.pnpm',
  'runtime.git',
  'runtime.dtach',
  'github.gh-auth',
  'launch.kb',
  'launch.kb-doctor',
  'launch.kb-search',
  'agent.claude',
  'agent.codex',
  'agent.codex-plugin-dir',
  'ops.resource-watchdog',
] as const;

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
  it('emits a passing JSON report for required launch prerequisites (watchdog advisory when off)', async () => {
    const run = commandRunner(happyFixtures());

    const report = await buildDoctorJsonReport({
      env: {},
      commandRunner: run,
      access: async () => {},
      now: () => new Date('2026-06-21T07:30:00.000Z'),
      // Hermetic: no live server probe (env-only path).
      probeResourceWatchdogEnabled: async () => null,
    });

    expect(report).toMatchObject({
      ok: true,
      // Resource watchdog is off by default → advisory warn, not a hard failure.
      status: 'warn',
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
      'ops.resource-watchdog',
    ]));
    expect(report.checks.filter((c) => c.id !== 'ops.resource-watchdog').every((c) => c.status === 'ok')).toBe(true);
    expect(report.checks.find((c) => c.id === 'ops.resource-watchdog')).toMatchObject({
      status: 'warn',
      required: false,
      summary: 'host-pressure auto-investigation is disabled',
    });
  });

  it('reports ops.resource-watchdog ok when KOOKR_RESOURCE_WATCHDOG is truthy', async () => {
    const run = commandRunner(happyFixtures());

    const report = await buildDoctorJsonReport({
      env: { KOOKR_RESOURCE_WATCHDOG: '1' },
      commandRunner: run,
      access: async () => {},
      probeResourceWatchdogEnabled: async () => null,
    });

    expect(report).toMatchObject({ ok: true, status: 'ok' });
    expect(report.checks.find((c) => c.id === 'ops.resource-watchdog')).toMatchObject({
      status: 'ok',
      required: false,
      summary: expect.stringContaining('enabled'),
    });
  });

  it('prefers live /api/health resourceWatchdog.enabled over the env flag', async () => {
    const run = commandRunner(happyFixtures());

    const disabledLive = await buildDoctorJsonReport({
      env: { KOOKR_RESOURCE_WATCHDOG: '1' },
      commandRunner: run,
      access: async () => {},
      probeResourceWatchdogEnabled: async () => false,
    });
    expect(disabledLive.ok).toBe(true);
    expect(disabledLive.status).toBe('warn');
    expect(disabledLive.checks.find((c) => c.id === 'ops.resource-watchdog')).toMatchObject({
      status: 'warn',
      required: false,
      detail: expect.stringContaining('resourceWatchdog.enabled=false'),
    });

    const enabledLive = await buildDoctorJsonReport({
      env: {},
      commandRunner: run,
      access: async () => {},
      probeResourceWatchdogEnabled: async () => true,
    });
    expect(enabledLive.ok).toBe(true);
    expect(enabledLive.status).toBe('ok');
    expect(enabledLive.checks.find((c) => c.id === 'ops.resource-watchdog')).toMatchObject({
      status: 'ok',
      summary: expect.stringContaining('resourceWatchdog.enabled=true'),
    });
  });

  it('keeps resource-watchdog advisory: warn does not fail exit / ok', async () => {
    const run = commandRunner(happyFixtures());
    const logs: string[] = [];

    const code = await runDoctorCli(['--json'], {
      env: {},
      commandRunner: run,
      access: async () => {},
      probeResourceWatchdogEnabled: async () => null,
      out: {
        log: (msg: string) => logs.push(msg),
        error: () => {},
      },
    });

    expect(code).toBe(0);
    const body = JSON.parse(logs[0]!);
    expect(body).toMatchObject({ ok: true, status: 'warn' });
    expect(body.checks.find((c: { id: string }) => c.id === 'ops.resource-watchdog')).toMatchObject({
      status: 'warn',
      required: false,
    });
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

    const report = await buildDoctorJsonReport({
      env: { KOOKR_RESOURCE_WATCHDOG: '1' },
      commandRunner: run,
      access: async () => {},
      probeResourceWatchdogEnabled: async () => null,
    });
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

    const report = await buildDoctorJsonReport({
      env: { KOOKR_RESOURCE_WATCHDOG: '1' },
      commandRunner: run,
      access: async () => {},
      probeResourceWatchdogEnabled: async () => null,
    });

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
      env: { KOOKR_RESOURCE_WATCHDOG: '1' },
      commandRunner: run,
      access: async () => {
        throw new Error('missing vendored dtach');
      },
      probeResourceWatchdogEnabled: async () => null,
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
      env: { KOOKR_RESOURCE_WATCHDOG: '1' },
      commandRunner: run,
      access: async () => {},
      probeResourceWatchdogEnabled: async () => null,
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
      env: { KOOKR_RESOURCE_WATCHDOG: '1' },
      commandRunner: run,
      access: async () => {},
      probeResourceWatchdogEnabled: async () => null,
      out: {
        log: (msg: string) => logs.push(msg),
        error: () => {},
      },
    });

    expect(code).toBe(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({ ok: false, status: 'fail' });
  });

  it('documents every doctor check id in docs/reference/cli.md (anti-drift)', async () => {
    const cliMd = readFileSync(join(process.cwd(), 'docs/reference/cli.md'), 'utf8');
    expect(cliMd).toContain('## `kookr doctor`');

    const run = commandRunner(happyFixtures());
    const report = await buildDoctorJsonReport({
      env: { KOOKR_RESOURCE_WATCHDOG: '1' },
      commandRunner: run,
      access: async () => {},
      probeResourceWatchdogEnabled: async () => null,
    });

    for (const check of report.checks) {
      expect(cliMd, `missing doctor check id ${check.id} in docs/reference/cli.md`).toContain(check.id);
    }
    for (const id of DOCUMENTED_DOCTOR_CHECK_IDS) {
      expect(cliMd, `missing documented doctor check id ${id} in docs/reference/cli.md`).toContain(id);
    }
  });
});

describe('kookr doctor (human)', () => {
  it('formatDoctorReport renders aligned status rows and recommended actions', () => {
    const text = formatDoctorReport({
      ok: false,
      status: 'fail',
      generatedAt: '2026-06-21T07:30:00.000Z',
      checks: [
        {
          id: 'runtime.node',
          label: 'Node.js',
          category: 'runtime',
          status: 'fail',
          required: true,
          summary: 'Node.js v20.0.0 is below the required >= 22',
          recommendedAction: 'Install Node.js >= 22.',
        },
        {
          id: 'github.gh-auth',
          label: 'GitHub auth',
          category: 'github',
          status: 'warn',
          required: false,
          summary: 'gh authentication is unavailable or not configured',
          detail: 'not logged in',
          recommendedAction: 'Run `gh auth login` if you want GitHub PR/issue monitoring and automation.',
        },
        {
          id: 'runtime.git',
          label: 'git',
          category: 'runtime',
          status: 'ok',
          required: true,
          summary: 'git version 2.50.1',
        },
      ],
    });

    expect(text).toContain('Kookr doctor — launch preflight');
    expect(text).toMatch(/Node\.js\s+FAIL\s+Node\.js v20\.0\.0 is below the required >= 22/);
    expect(text).toMatch(/GitHub auth\s+WARN\s+gh authentication is unavailable or not configured/);
    expect(text).toContain('not logged in');
    expect(text).toMatch(/git\s+OK\s+git version 2\.50\.1/);
    expect(text).toContain('Recommended actions:');
    expect(text).toContain('Install Node.js >= 22.');
    expect(text).toContain('Run `gh auth login`');
    expect(text).toContain('Overall: FAIL (required checks failed)');
  });

  it('prints a human table without --json and returns the aggregated exit code', async () => {
    const run = commandRunner(happyFixtures());
    const logs: string[] = [];
    const errors: string[] = [];

    const code = await runDoctorCli([], {
      env: { KOOKR_RESOURCE_WATCHDOG: '1' },
      commandRunner: run,
      access: async () => {},
      now: () => new Date('2026-06-21T07:30:00.000Z'),
      probeResourceWatchdogEnabled: async () => null,
      out: {
        log: (msg: string) => logs.push(msg),
        error: (msg: string) => errors.push(msg),
      },
    });

    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('Kookr doctor — launch preflight');
    expect(logs[0]).toMatch(/Node\.js\s+OK\s+/);
    expect(logs[0]).toContain('Overall: OK');
    // Human path must not emit JSON
    expect(() => JSON.parse(logs[0]!)).toThrow();
  });

  it('human path returns exit code 1 when a required check fails', async () => {
    const run = commandRunner({
      ...happyFixtures(),
      [JSON.stringify(['node', ['--version']])]: { stdout: 'v20.0.0\n' },
    });
    const logs: string[] = [];

    const code = await runDoctorCli([], {
      env: { KOOKR_RESOURCE_WATCHDOG: '1' },
      commandRunner: run,
      access: async () => {},
      probeResourceWatchdogEnabled: async () => null,
      out: {
        log: (msg: string) => logs.push(msg),
        error: () => {},
      },
    });

    expect(code).toBe(1);
    expect(logs[0]).toContain('Overall: FAIL');
    expect(logs[0]).toMatch(/Node\.js\s+FAIL\s+/);
  });

  it('does not redirect humans to pnpm doctor anymore', async () => {
    const run = commandRunner(happyFixtures());
    const logs: string[] = [];
    const errors: string[] = [];

    await runDoctorCli([], {
      env: { KOOKR_RESOURCE_WATCHDOG: '1' },
      commandRunner: run,
      access: async () => {},
      probeResourceWatchdogEnabled: async () => null,
      out: {
        log: (msg: string) => logs.push(msg),
        error: (msg: string) => errors.push(msg),
      },
    });

    expect(errors.join('\n')).not.toContain('requires --json');
    expect(errors.join('\n')).not.toContain('pnpm doctor');
    expect(logs.join('\n')).not.toContain('requires --json');
  });
});
