import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildDoctorJsonReport,
  formatDoctorReport,
  GITHUB_SCANNER_BACKOFF_WARN_MS,
  runDoctorCli,
} from './kookr-doctor.js';
import type { AlertArtifact } from '../server/prod-smoke.js';
import type { GithubStatusSnapshot } from './kookr-github.js';

/** Stable happy-path check ids plus KB failure-mode ids that can replace `launch.kb`. */
const DOCUMENTED_DOCTOR_CHECK_IDS = [
  'runtime.node',
  'runtime.pnpm',
  'runtime.git',
  'runtime.dtach',
  'github.gh-auth',
  'github.scanner-backoff',
  'launch.kb',
  'launch.kb-doctor',
  'launch.kb-search',
  'agent.claude',
  'agent.codex',
  'agent.codex-plugin-dir',
  'ops.resource-watchdog',
  'ops.prod-smoke-tick',
  'ops.maintenance-prune',
] as const;

/** Env that silences all advisory ops WARNs (resource-watchdog + maintenance-prune). */
const opsOkEnv = {
  KOOKR_RESOURCE_WATCHDOG: '1',
  KOOKR_MAINTENANCE_PRUNE_INTERVAL_HOURS: '24',
} as const;

/** Hermetic seams so unit tests never touch the host ~/.kookr or live HTTP. */
const hermeticOps = {
  probeResourceWatchdogEnabled: async () => null as boolean | null,
  probeMaintenancePruneTimer: async () => null as { lastFiredAt: string | null } | null,
  probeGithubScannerStatus: async () => null as GithubStatusSnapshot | null,
  readProdSmokeTickAlert: () => null as AlertArtifact | null,
};

function githubStatusSnap(partial: Partial<GithubStatusSnapshot> = {}): GithubStatusSnapshot {
  return {
    active: true,
    stateFetchBackoffMs: 0,
    repoHealthBackoffMs: 0,
    trackedRefCount: 12,
    ...partial,
  };
}

/** Advisory ops check ids that are off-by-default and emit WARN with empty env. */
const ADVISORY_OFF_BY_DEFAULT = new Set(['ops.resource-watchdog', 'ops.maintenance-prune']);

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
  it('emits a passing JSON report for required launch prerequisites (ops advisory when off)', async () => {
    const run = commandRunner(happyFixtures());

    const report = await buildDoctorJsonReport({
      env: {},
      commandRunner: run,
      access: async () => {},
      now: () => new Date('2026-06-21T07:30:00.000Z'),
      // Hermetic: no live server probe (env-only path).
      ...hermeticOps,
    });

    expect(report).toMatchObject({
      ok: true,
      // Resource watchdog + maintenance prune are off by default → advisory warn.
      status: 'warn',
      generatedAt: '2026-06-21T07:30:00.000Z',
    });
    expect(report.checks.map((check) => check.id)).toEqual(expect.arrayContaining([
      'runtime.node',
      'runtime.pnpm',
      'runtime.git',
      'runtime.dtach',
      'github.gh-auth',
      'github.scanner-backoff',
      'launch.kb',
      'agent.claude',
      'agent.codex',
      'agent.codex-plugin-dir',
      'ops.resource-watchdog',
      'ops.prod-smoke-tick',
      'ops.maintenance-prune',
    ]));
    expect(
      report.checks
        .filter((c) => !ADVISORY_OFF_BY_DEFAULT.has(c.id))
        .every((c) => c.status === 'ok'),
    ).toBe(true);
    expect(report.checks.find((c) => c.id === 'github.scanner-backoff')).toMatchObject({
      status: 'ok',
      required: false,
      summary: expect.stringContaining('probe skipped'),
    });
    expect(report.checks.find((c) => c.id === 'ops.prod-smoke-tick')).toMatchObject({
      status: 'ok',
      required: false,
    });
    expect(report.checks.find((c) => c.id === 'ops.resource-watchdog')).toMatchObject({
      status: 'warn',
      required: false,
      summary: 'host-pressure auto-investigation is disabled',
    });
    expect(report.checks.find((c) => c.id === 'ops.maintenance-prune')).toMatchObject({
      status: 'warn',
      required: false,
      summary: 'scheduled data-dir prune is disabled',
    });
  });

  it('WARNs on github.scanner-backoff when stateFetchBackoffMs is multi-minute (issue #2098)', async () => {
    const run = commandRunner(happyFixtures());

    const report = await buildDoctorJsonReport({
      env: { ...opsOkEnv },
      commandRunner: run,
      access: async () => {},
      ...hermeticOps,
      probeGithubScannerStatus: async () => githubStatusSnap({
        stateFetchBackoffMs: 180_000,
        trackedRefCount: 1093,
        repoHealthBackoffMs: 12_000,
      }),
    });

    expect(report.ok).toBe(true);
    expect(report.status).toBe('warn');
    const check = report.checks.find((c) => c.id === 'github.scanner-backoff');
    expect(check).toMatchObject({
      status: 'warn',
      required: false,
      summary: expect.stringContaining('trackedRefCount=1093'),
    });
    expect(check?.summary).toMatch(/remaining≈180s/);
    expect(check?.detail).toContain('stateFetchBackoffMs=180000');
    expect(check?.detail).toContain('repoHealthBackoffMs=12000');
    expect(check?.recommendedAction).toContain('gh api rate_limit');
  });

  it('stays OK for github.scanner-backoff when backoff is zero or below threshold (issue #2098)', async () => {
    const run = commandRunner(happyFixtures());

    const zero = await buildDoctorJsonReport({
      env: { ...opsOkEnv },
      commandRunner: run,
      access: async () => {},
      ...hermeticOps,
      probeGithubScannerStatus: async () => githubStatusSnap({ stateFetchBackoffMs: 0, trackedRefCount: 4 }),
    });
    expect(zero.status).toBe('ok');
    expect(zero.checks.find((c) => c.id === 'github.scanner-backoff')).toMatchObject({
      status: 'ok',
      required: false,
      summary: expect.stringContaining('no state-fetch rate-limit backoff'),
    });

    const brief = await buildDoctorJsonReport({
      env: { ...opsOkEnv },
      commandRunner: run,
      access: async () => {},
      ...hermeticOps,
      probeGithubScannerStatus: async () => githubStatusSnap({
        stateFetchBackoffMs: GITHUB_SCANNER_BACKOFF_WARN_MS - 1,
        trackedRefCount: 8,
      }),
    });
    expect(brief.status).toBe('ok');
    expect(brief.checks.find((c) => c.id === 'github.scanner-backoff')).toMatchObject({
      status: 'ok',
      summary: expect.stringContaining('below'),
    });
  });

  it('keeps github.scanner-backoff green when the probe is unavailable (hermetic offline)', async () => {
    const run = commandRunner(happyFixtures());

    const report = await buildDoctorJsonReport({
      env: { ...opsOkEnv },
      commandRunner: run,
      access: async () => {},
      ...hermeticOps,
      probeGithubScannerStatus: async () => null,
    });

    expect(report).toMatchObject({ ok: true, status: 'ok' });
    expect(report.checks.find((c) => c.id === 'github.scanner-backoff')).toMatchObject({
      status: 'ok',
      required: false,
      summary: expect.stringContaining('probe skipped'),
    });
  });

  it('reports ops.resource-watchdog ok when KOOKR_RESOURCE_WATCHDOG is truthy', async () => {
    const run = commandRunner(happyFixtures());

    const report = await buildDoctorJsonReport({
      env: { ...opsOkEnv },
      commandRunner: run,
      access: async () => {},
      ...hermeticOps,
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
      env: { ...opsOkEnv },
      commandRunner: run,
      access: async () => {},
      ...hermeticOps,
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
      env: { KOOKR_MAINTENANCE_PRUNE_INTERVAL_HOURS: '24' },
      commandRunner: run,
      access: async () => {},
      ...hermeticOps,
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
      ...hermeticOps,
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

  it('WARNs on ops.maintenance-prune when interval is 0/unset (issue #2080)', async () => {
    const run = commandRunner(happyFixtures());

    const unset = await buildDoctorJsonReport({
      env: { KOOKR_RESOURCE_WATCHDOG: '1' },
      commandRunner: run,
      access: async () => {},
      ...hermeticOps,
    });
    expect(unset.ok).toBe(true);
    expect(unset.status).toBe('warn');
    expect(unset.checks.find((c) => c.id === 'ops.maintenance-prune')).toMatchObject({
      status: 'warn',
      required: false,
      summary: 'scheduled data-dir prune is disabled',
      recommendedAction: expect.stringContaining('KOOKR_MAINTENANCE_PRUNE_INTERVAL_HOURS=24'),
    });

    const zero = await buildDoctorJsonReport({
      env: { KOOKR_RESOURCE_WATCHDOG: '1', KOOKR_MAINTENANCE_PRUNE_INTERVAL_HOURS: '0' },
      commandRunner: run,
      access: async () => {},
      ...hermeticOps,
    });
    expect(zero.checks.find((c) => c.id === 'ops.maintenance-prune')).toMatchObject({
      status: 'warn',
      summary: 'scheduled data-dir prune is disabled',
    });
  });

  it('reports ops.maintenance-prune ok when interval > 0 (issue #2080)', async () => {
    const run = commandRunner(happyFixtures());

    const report = await buildDoctorJsonReport({
      env: { ...opsOkEnv },
      commandRunner: run,
      access: async () => {},
      ...hermeticOps,
    });

    expect(report).toMatchObject({ ok: true, status: 'ok' });
    expect(report.checks.find((c) => c.id === 'ops.maintenance-prune')).toMatchObject({
      status: 'ok',
      required: false,
      summary: expect.stringContaining('scheduled every 24h'),
    });
  });

  it('enriches ops.maintenance-prune ok with timer-health lastFiredAt when probed', async () => {
    const run = commandRunner(happyFixtures());

    const withFire = await buildDoctorJsonReport({
      env: { ...opsOkEnv },
      commandRunner: run,
      access: async () => {},
      ...hermeticOps,
      probeMaintenancePruneTimer: async () => ({ lastFiredAt: '2026-08-04T12:00:00.000Z' }),
    });
    expect(withFire.checks.find((c) => c.id === 'ops.maintenance-prune')).toMatchObject({
      status: 'ok',
      summary: expect.stringContaining('lastFiredAt=2026-08-04T12:00:00.000Z'),
    });

    const notYet = await buildDoctorJsonReport({
      env: { ...opsOkEnv },
      commandRunner: run,
      access: async () => {},
      ...hermeticOps,
      probeMaintenancePruneTimer: async () => ({ lastFiredAt: null }),
    });
    expect(notYet.checks.find((c) => c.id === 'ops.maintenance-prune')).toMatchObject({
      status: 'ok',
      summary: expect.stringContaining('not fired yet'),
    });
  });

  it('WARNs on ops.prod-smoke-tick when alert artifact has consecutiveFailures (issue #2035)', async () => {
    const run = commandRunner(happyFixtures());
    const alert: AlertArtifact = {
      schemaVersion: 'prod-smoke-alert.v1',
      status: 'alert',
      generatedAt: '2026-08-04T02:10:11.278Z',
      firstFailedAt: '2026-07-28T15:45:37.810Z',
      consecutiveFailures: 113,
      failingChecks: ['version-probe'],
      checks: [
        { name: 'ready', ok: true, detail: 'ok' },
        { name: 'version-probe', ok: false, detail: 'invalid adapter version' },
      ],
    };

    const report = await buildDoctorJsonReport({
      env: { ...opsOkEnv, KOOKR_DIR: '/tmp/kookr-doctor-smoke-fixture' },
      commandRunner: run,
      access: async () => {},
      ...hermeticOps,
      readProdSmokeTickAlert: (path) => {
        expect(path).toBe(join('/tmp/kookr-doctor-smoke-fixture', 'prod-smoke-tick-alert.json'));
        return alert;
      },
    });

    expect(report.ok).toBe(true);
    expect(report.status).toBe('warn');
    expect(report.checks.find((c) => c.id === 'ops.prod-smoke-tick')).toMatchObject({
      status: 'warn',
      required: false,
      summary: expect.stringContaining('consecutiveFailures=113'),
    });
    expect(report.checks.find((c) => c.id === 'ops.prod-smoke-tick')?.summary).toContain(
      'failingChecks=[version-probe]',
    );
  });

  it('does not WARN when prod-smoke-tick artifact is missing or status=ok', async () => {
    const run = commandRunner(happyFixtures());

    const missing = await buildDoctorJsonReport({
      env: { ...opsOkEnv },
      commandRunner: run,
      access: async () => {},
      ...hermeticOps,
      readProdSmokeTickAlert: () => null,
    });
    expect(missing.status).toBe('ok');
    expect(missing.checks.find((c) => c.id === 'ops.prod-smoke-tick')).toMatchObject({
      status: 'ok',
      summary: expect.stringContaining('no alert artifact'),
    });

    const healthy: AlertArtifact = {
      schemaVersion: 'prod-smoke-alert.v1',
      status: 'ok',
      generatedAt: '2026-08-04T02:10:11.278Z',
      consecutiveFailures: 0,
      failingChecks: [],
      checks: [{ name: 'ready', ok: true, detail: 'ok' }],
    };
    const okReport = await buildDoctorJsonReport({
      env: { ...opsOkEnv },
      commandRunner: run,
      access: async () => {},
      ...hermeticOps,
      readProdSmokeTickAlert: () => healthy,
    });
    expect(okReport.status).toBe('ok');
    expect(okReport.checks.find((c) => c.id === 'ops.prod-smoke-tick')).toMatchObject({
      status: 'ok',
      summary: expect.stringContaining('status=ok'),
    });
  });

  it('reads a real temp alert fixture from disk (no injected reader)', async () => {
    const run = commandRunner(happyFixtures());
    const dir = mkdtempSync(join(tmpdir(), 'kookr-doctor-smoke-'));
    const alertPath = join(dir, 'prod-smoke-tick-alert.json');
    const artifact: AlertArtifact = {
      schemaVersion: 'prod-smoke-alert.v1',
      status: 'alert',
      generatedAt: '2026-08-01T00:00:00.000Z',
      firstFailedAt: '2026-07-28T00:00:00.000Z',
      consecutiveFailures: 42,
      failingChecks: ['health', 'tasks-latency'],
      checks: [
        { name: 'health', ok: false, detail: 'timeout' },
        { name: 'tasks-latency', ok: false, detail: 'slow' },
      ],
    };
    writeFileSync(alertPath, `${JSON.stringify(artifact, null, 2)}\n`);

    const report = await buildDoctorJsonReport({
      env: { ...opsOkEnv, KOOKR_DIR: dir },
      commandRunner: run,
      access: async () => {},
      probeResourceWatchdogEnabled: async () => null,
      probeMaintenancePruneTimer: async () => null,
      probeGithubScannerStatus: async () => null,
      // intentionally no readProdSmokeTickAlert — exercises default disk path
    });

    expect(report.status).toBe('warn');
    const smoke = report.checks.find((c) => c.id === 'ops.prod-smoke-tick');
    expect(smoke).toMatchObject({
      status: 'warn',
      required: false,
    });
    expect(smoke?.summary).toContain('consecutiveFailures=42');
    expect(smoke?.summary).toContain('failingChecks=[health, tasks-latency]');
  });

  it('exits non-zero on advisory WARN only when --strict is set', async () => {
    const run = commandRunner(happyFixtures());
    const alert: AlertArtifact = {
      schemaVersion: 'prod-smoke-alert.v1',
      status: 'alert',
      generatedAt: '2026-08-04T02:10:11.278Z',
      consecutiveFailures: 5,
      failingChecks: ['ready'],
      checks: [{ name: 'ready', ok: false, detail: 'down' }],
    };
    const deps = {
      env: { ...opsOkEnv },
      commandRunner: run,
      access: async () => {},
      ...hermeticOps,
      readProdSmokeTickAlert: () => alert,
      out: { log: () => {}, error: () => {} },
    };

    expect(await runDoctorCli(['--json'], deps)).toBe(0);
    expect(await runDoctorCli(['--json', '--strict'], deps)).toBe(1);
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
      env: { ...opsOkEnv },
      commandRunner: run,
      access: async () => {},
      ...hermeticOps,
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
      env: { ...opsOkEnv },
      commandRunner: run,
      access: async () => {},
      ...hermeticOps,
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
      env: { ...opsOkEnv },
      commandRunner: run,
      access: async () => {
        throw new Error('missing vendored dtach');
      },
      ...hermeticOps,
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
      env: { ...opsOkEnv },
      commandRunner: run,
      access: async () => {},
      ...hermeticOps,
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
      env: { ...opsOkEnv },
      commandRunner: run,
      access: async () => {},
      ...hermeticOps,
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
      env: { ...opsOkEnv },
      commandRunner: run,
      access: async () => {},
      ...hermeticOps,
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
      env: { ...opsOkEnv },
      commandRunner: run,
      access: async () => {},
      now: () => new Date('2026-06-21T07:30:00.000Z'),
      ...hermeticOps,
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
      env: { ...opsOkEnv },
      commandRunner: run,
      access: async () => {},
      ...hermeticOps,
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
      env: { ...opsOkEnv },
      commandRunner: run,
      access: async () => {},
      ...hermeticOps,
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
