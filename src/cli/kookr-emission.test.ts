import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMISSION_BUDGET_SCHEMA_VERSION } from '../core/emission-budget.js';
import { computeCiBlindDebt } from '../core/ci-blind-debt.js';
import { buildRetroVerifyEntry } from '../core/retro-verify-queue.js';
import { EnvironmentBlockerRegistry } from '../core/environment-blocker-registry.js';
import {
  parseBlockerKey,
  parseEmissionArgs,
  runEmissionCli,
  USAGE,
} from './kookr-emission.js';

function mkIo(opts: { retroVerifyDepth?: number } = {}) {
  const logs: string[] = [];
  const errs: string[] = [];
  const depth = opts.retroVerifyDepth ?? 0;
  const entries =
    depth > 0
      ? Array.from({ length: depth }, (_, i) =>
          buildRetroVerifyEntry({
            sha: `${'a'.repeat(39)}${i.toString(16)}`.slice(0, 40).padEnd(40, '0'),
            prNumber: i + 1,
            repo: 'jeanibarz/lucy',
            reason: 'verified-locally',
            createdAt: '2026-07-28T00:00:00.000Z',
          }),
        )
      : [];
  const debt = computeCiBlindDebt(entries, { now: new Date('2026-07-30T12:00:00.000Z') });
  return {
    out: { log: (...a: unknown[]) => logs.push(a.map(String).join(' ')) },
    err: { error: (...a: unknown[]) => errs.push(a.map(String).join(' ')) },
    logs,
    errs,
    // Isolate from the real ~/.kookr retro-verify spool so unit tests are hermetic.
    readRetroVerifyDepth: async () => ({ depth: debt.queueDepth, debt }),
  };
}

describe('parseEmissionArgs', () => {
  it('parses plan with repo and requested', () => {
    expect(parseEmissionArgs(['plan', '--repo', 'o/r', '--requested', '10', '--json'])).toMatchObject({
      verb: 'plan',
      repo: 'o/r',
      requested: 10,
      json: true,
    });
  });

  it('parses equals-form flags', () => {
    expect(parseEmissionArgs(['dedupe', '--repo=o/r', '--title=Hello world'])).toMatchObject({
      verb: 'dedupe',
      repo: 'o/r',
      title: 'Hello world',
    });
  });
});

describe('runEmissionCli', () => {
  it('prints help', async () => {
    const io = mkIo();
    const code = await runEmissionCli(['--help'], io);
    expect(code).toBe(0);
    expect(io.logs.join('\n')).toBe(USAGE);
  });

  it('plans with a mocked open list over the threshold', async () => {
    const io = mkIo();
    const open = Array.from({ length: 5 }, (_, i) => ({
      number: i + 1,
      title: `Issue ${i + 1}`,
      state: 'OPEN',
      url: `https://example/${i + 1}`,
    }));
    const code = await runEmissionCli(
      ['plan', '--repo', 'kookr-ai/kookr', '--requested', '10', '--json'],
      {
        ...io,
        runGh: (args) => {
          // plan: search total_count first, then issue list for sample/dedupe surface
          if (args[0] === 'api') return '65\n';
          expect(args[0]).toBe('issue');
          return JSON.stringify(open);
        },
      },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.plan.openBacklogCount).toBe(65);
    expect(payload.plan.allowedBudget).toBe(2);
    expect(payload.plan.action).toBe('constrain');
    expect(payload.plan.deferredCount).toBe(8);
    expect(payload.plan.overThreshold).toBe(true);
  });

  it('always logs a dedupe check line (stdout when not --json)', async () => {
    const io = mkIo();
    const code = await runEmissionCli(
      ['dedupe', '--repo', 'kookr-ai/kookr', '--title', 'Add dark mode toggle'],
      {
        ...io,
        runGh: () =>
          JSON.stringify([
            { number: 42, title: 'Add dark mode toggle', state: 'OPEN', url: 'https://x/42' },
          ]),
      },
    );
    expect(code).toBe(0);
    expect(io.logs[0]).toMatch(/^dedupe-check: DUPLICATE/);
    expect(io.logs[0]).toContain('#42');
  });

  it('with --json, emits one JSON on stdout and audit line on stderr', async () => {
    const io = mkIo();
    const code = await runEmissionCli(
      ['dedupe', '--repo', 'kookr-ai/kookr', '--title', 'Add dark mode toggle', '--json'],
      {
        ...io,
        runGh: () =>
          JSON.stringify([
            { number: 42, title: 'Add dark mode toggle', state: 'OPEN', url: 'https://x/42' },
          ]),
      },
    );
    expect(code).toBe(0);
    expect(io.errs[0]).toMatch(/^dedupe-check: DUPLICATE/);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.isDuplicate).toBe(true);
    expect(payload.match.number).toBe(42);
    expect(payload.logLine).toMatch(/DUPLICATE/);
  });

  it('returns 4 when gh fails', async () => {
    const io = mkIo();
    const code = await runEmissionCli(
      ['plan', '--repo', 'kookr-ai/kookr', '--requested', '1', '--json'],
      {
        ...io,
        runGh: () => {
          throw new Error('gh boom');
        },
      },
    );
    expect(code).toBe(4);
    expect(io.errs.join('\n')).toMatch(/gh boom/);
  });

  it('returns 2 on unknown verb', async () => {
    const io = mkIo();
    const code = await runEmissionCli(['explode', '--repo', 'o/r'], io);
    expect(code).toBe(2);
    expect(io.errs.join('\n')).toMatch(/unknown verb/);
  });

  it('metrics exposes netBacklogDelta7d', async () => {
    const io = mkIo();
    let call = 0;
    const code = await runEmissionCli(
      ['metrics', '--repo', 'kookr-ai/kookr', '--json'],
      {
        ...io,
        now: () => new Date('2026-07-27T12:00:00.000Z'),
        runGh: (args) => {
          // three search total_count calls
          call++;
          const q = args.find((a, i) => args[i - 1] === '-f' && a.startsWith('q=')) ?? '';
          if (q.includes('is:open')) return '83\n';
          if (q.includes('created:>=')) return '60\n';
          if (q.includes('closed:>=')) return '14\n';
          throw new Error(`unexpected gh args: ${args.join(' ')}`);
        },
      },
    );
    expect(code).toBe(0);
    expect(call).toBe(3);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.netBacklogDelta7d).toBe(46);
    expect(payload.opened7d).toBe(60);
    expect(payload.closed7d).toBe(14);
    expect(payload.openBacklogCount).toBe(83);
    expect(payload.emissionBudgetIfRequested10.allowedBudget).toBe(2);
  });

  it('defers by appending a JSONL line', async () => {
    const io = mkIo();
    const lines: Array<{ path: string; line: string }> = [];
    const code = await runEmissionCli(
      [
        'defer',
        '--repo',
        'kookr-ai/kookr',
        '--title',
        'Repository idea: deferred thing',
        '--source',
        'repository-idea-scout',
        '--json',
        '--kookr-dir',
        '/tmp/kookr-emission-test',
      ],
      {
        ...io,
        now: () => new Date('2026-07-27T00:00:00.000Z'),
        appendLine: (path, line) => lines.push({ path, line }),
      },
    );
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.path).toContain('deferred-ideas/kookr-ai-kookr.jsonl');
    const rec = JSON.parse(lines[0]!.line);
    expect(rec.title).toBe('Repository idea: deferred thing');
    expect(rec.source).toBe('repository-idea-scout');
  });

  it('returns 2 on missing required flags', async () => {
    const io = mkIo();
    const code = await runEmissionCli(['plan', '--repo', 'o/r'], io);
    expect(code).toBe(2);
    expect(io.errs.join('\n')).toMatch(/--requested/);
  });
});

describe('runEmissionCli drain coupling (issue #1657)', () => {
  // The drain query MUST be keyed on the target repo (`repo:<targetRepo>`), never
  // the emitting actor's home repo — that is the whole point of #1657. `expectRepo`
  // asserts the keying at the query level so a regression to the wrong repo fails.
  function planGh(
    openCount: number,
    closedCount: number,
    open: unknown[] = [],
    expectRepo?: string,
  ) {
    return (args: string[]): string => {
      if (args[0] === 'api') {
        // The query is passed as an `-f q=<query>` token.
        const q = args.find((a) => a.startsWith('q=')) ?? '';
        if (q.includes('is:closed')) {
          if (expectRepo) expect(q).toContain(`repo:${expectRepo}`);
          return `${closedCount}\n`;
        }
        if (q.includes('is:open')) return `${openCount}\n`;
        return '0\n';
      }
      if (args[0] === 'issue') return JSON.stringify(open);
      throw new Error(`unexpected gh args: ${args.join(' ')}`);
    };
  }

  it('caps allowedBudget by the target repo drain rate (low-drain repo)', async () => {
    const io = mkIo();
    // backlog 52 (< 60 threshold) but only 1 issue drained this window. The drain
    // query is asserted (via expectRepo) to target lucy, not the emitting actor.
    const code = await runEmissionCli(
      ['plan', '--repo', 'jeanibarz/lucy', '--requested', '10', '--json'],
      { ...io, runGh: planGh(52, 1, [], 'jeanibarz/lucy') },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.plan.openBacklogCount).toBe(52);
    expect(payload.plan.overThreshold).toBe(false);
    expect(payload.plan.drainCoupled).toBe(true);
    expect(payload.plan.drainCount).toBe(1);
    expect(payload.plan.drainCap).toBe(1);
    expect(payload.plan.allowedBudget).toBe(1);
    expect(payload.plan.deferredCount).toBe(9);
    expect(payload.plan.action).toBe('constrain');
  });

  it('TS-EMISSION-003: leaves an empty target repo unlimited when no ceiling is configured', async () => {
    const io = mkIo();
    const configDir = mkdtempSync(join(tmpdir(), 'emission-config-unlimited-default-'));
    const code = await runEmissionCli(
      [
        'plan', '--repo', 'jeanibarz/maison', '--requested', '10', '--json',
        '--kookr-dir', configDir,
      ],
      { ...io, runGh: planGh(0, 0, [], 'jeanibarz/maison') },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.zeroDrainIssueLimit).toBe(-1);
    expect(payload.plan.openBacklogCount).toBe(0);
    expect(payload.plan.drainCount).toBe(0);
    expect(payload.plan.drainCap).toBeUndefined();
    expect(payload.plan.allowedBudget).toBe(10);
    expect(payload.plan.deferredCount).toBe(0);
    expect(payload.plan.action).toBe('allow');
  });

  it('TS-EMISSION-003: defaults an unset repository allowance to the deployment ceiling', async () => {
    const io = mkIo();
    const configDir = mkdtempSync(join(tmpdir(), 'emission-config-default-cap-'));
    const code = await runEmissionCli(
      [
        'plan', '--repo', 'jeanibarz/maison', '--requested', '10', '--json',
        '--kookr-dir', configDir,
      ],
      {
        ...io,
        env: { KOOKR_MAX_ZERO_DRAIN_ISSUE_LIMIT: '3' },
        runGh: planGh(0, 0, [], 'jeanibarz/maison'),
      },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.zeroDrainIssueLimit).toBe(3);
    expect(payload.plan.drainCap).toBe(3);
    expect(payload.plan.allowedBudget).toBe(3);
    expect(payload.plan.deferredCount).toBe(7);
  });

  it('uses the repository zero-drain issue limit without an operator justification', async () => {
    const io = mkIo();
    const configDir = mkdtempSync(join(tmpdir(), 'emission-config-'));
    writeFileSync(join(configDir, 'project-configs.json'), JSON.stringify([{
      project: 'github.com/jeanibarz/maison',
      zeroDrainIssueLimit: 1000,
    }]));
    const code = await runEmissionCli(
      [
        'plan', '--repo', 'jeanibarz/maison', '--requested', '1000', '--json',
        '--kookr-dir', configDir,
      ],
      {
        ...io,
        runGh: planGh(0, 0, [], 'jeanibarz/maison'),
      },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.zeroDrainIssueLimit).toBe(1000);
    expect(payload.plan.drainCap).toBe(1000);
    expect(payload.plan.allowedBudget).toBe(1000);
  });

  it('TS-EMISSION-003: honors an explicit zero as refusal', async () => {
    const io = mkIo();
    const configDir = mkdtempSync(join(tmpdir(), 'emission-config-zero-'));
    writeFileSync(join(configDir, 'project-configs.json'), JSON.stringify([{
      project: 'github.com/jeanibarz/maison',
      zeroDrainIssueLimit: 0,
    }]));
    const code = await runEmissionCli(
      [
        'plan', '--repo', 'jeanibarz/maison', '--requested', '10', '--json',
        '--kookr-dir', configDir,
      ],
      { ...io, runGh: planGh(0, 0, [], 'jeanibarz/maison') },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.zeroDrainIssueLimit).toBe(0);
    expect(payload.plan.allowedBudget).toBe(0);
    expect(payload.plan.action).toBe('refuse');
  });

  it('TS-EMISSION-003: matches mixed-case stored project IDs before applying the default', async () => {
    const io = mkIo();
    const configDir = mkdtempSync(join(tmpdir(), 'emission-config-case-'));
    writeFileSync(join(configDir, 'project-configs.json'), JSON.stringify([{
      project: 'github.com/JeanIbarz/Maison',
      zeroDrainIssueLimit: 0,
    }]));
    const code = await runEmissionCli(
      [
        'plan', '--repo', 'jeanibarz/maison', '--requested', '10', '--json',
        '--kookr-dir', configDir,
      ],
      { ...io, runGh: planGh(0, 0, [], 'jeanibarz/maison') },
    );
    expect(code).toBe(0);
    expect(JSON.parse(io.logs[0]!).plan.action).toBe('refuse');
  });

  it('TS-EMISSION-003: refuses to plan from corrupt project settings', async () => {
    const io = mkIo();
    const configDir = mkdtempSync(join(tmpdir(), 'emission-config-corrupt-'));
    writeFileSync(join(configDir, 'project-configs.json'), '{not-json');
    const code = await runEmissionCli(
      [
        'plan', '--repo', 'jeanibarz/maison', '--requested', '10', '--json',
        '--kookr-dir', configDir,
      ],
      { ...io, runGh: planGh(0, 0, [], 'jeanibarz/maison') },
    );
    expect(code).toBe(2);
    expect(io.errs.join('\n')).toMatch(/invalid JSON in project settings/);
  });

  it.each([
    ['a non-array document', '{}', /must contain an array/],
    [
      'an invalid matching allowance',
      JSON.stringify([{ project: 'github.com/jeanibarz/maison', zeroDrainIssueLimit: -2 }]),
      /invalid project zeroDrainIssueLimit/,
    ],
  ])('TS-EMISSION-003: refuses to plan from %s', async (_label, contents, errorPattern) => {
    const io = mkIo();
    const configDir = mkdtempSync(join(tmpdir(), 'emission-config-invalid-policy-'));
    writeFileSync(join(configDir, 'project-configs.json'), contents);
    const code = await runEmissionCli(
      [
        'plan', '--repo', 'jeanibarz/maison', '--requested', '10', '--json',
        '--kookr-dir', configDir,
      ],
      { ...io, runGh: planGh(0, 0, [], 'jeanibarz/maison') },
    );
    expect(code).toBe(2);
    expect(io.errs.join('\n')).toMatch(errorPattern);
  });

  it('TS-EMISSION-003: rejects a persisted unlimited override under a deployment ceiling', async () => {
    const io = mkIo();
    const configDir = mkdtempSync(join(tmpdir(), 'emission-config-unlimited-cap-'));
    writeFileSync(join(configDir, 'project-configs.json'), JSON.stringify([{
      project: 'github.com/jeanibarz/maison',
      zeroDrainIssueLimit: -1,
    }]));
    const code = await runEmissionCli(
      ['plan', '--repo', 'jeanibarz/maison', '--requested', '10', '--kookr-dir', configDir],
      { ...io, env: { KOOKR_MAX_ZERO_DRAIN_ISSUE_LIMIT: '3' } },
    );
    expect(code).toBe(2);
    expect(io.errs.join('\n')).toMatch(/exceeds 3/);
  });

  it('rejects a repository setting above the deployment-provided ceiling', async () => {
    const io = mkIo();
    const configDir = mkdtempSync(join(tmpdir(), 'emission-config-cap-'));
    writeFileSync(join(configDir, 'project-configs.json'), JSON.stringify([{
      project: 'github.com/jeanibarz/maison',
      zeroDrainIssueLimit: 1000,
    }]));
    const code = await runEmissionCli(
      ['plan', '--repo', 'jeanibarz/maison', '--requested', '1000', '--kookr-dir', configDir],
      { ...io, env: { KOOKR_MAX_ZERO_DRAIN_ISSUE_LIMIT: '500' } },
    );
    expect(code).toBe(2);
    expect(io.errs.join('\n')).toMatch(/exceeds 500/);
  });

  it('uses the active non-default port namespace when no state root is supplied', async () => {
    const home = mkdtempSync(join(tmpdir(), 'emission-home-'));
    const portDir = join(home, '.kookr-4801');
    mkdirSync(portDir, { recursive: true });
    writeFileSync(join(portDir, 'project-configs.json'), JSON.stringify([{
      project: 'github.com/jeanibarz/maison',
      zeroDrainIssueLimit: 1000,
    }]));
    const io = mkIo();
    const code = await runEmissionCli(
      ['plan', '--repo', 'jeanibarz/maison', '--requested', '1000', '--json'],
      {
        ...io,
        env: { HOME: home, KOOKR_PORT: '4801' },
        runGh: planGh(0, 0, [], 'jeanibarz/maison'),
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(io.logs[0]!).plan.allowedBudget).toBe(1000);
  });

  it('honors an explicitly supplied state root even on a non-default port', async () => {
    const home = mkdtempSync(join(tmpdir(), 'emission-explicit-home-'));
    const explicitDir = mkdtempSync(join(tmpdir(), 'emission-explicit-dir-'));
    writeFileSync(join(explicitDir, 'project-configs.json'), JSON.stringify([{
      project: 'github.com/jeanibarz/maison',
      zeroDrainIssueLimit: 1000,
    }]));
    const io = mkIo();
    const code = await runEmissionCli(
      ['plan', '--repo', 'jeanibarz/maison', '--requested', '1000', '--json', '--kookr-dir', explicitDir],
      {
        ...io,
        env: { HOME: home, KOOKR_PORT: '4801' },
        runGh: planGh(0, 0, [], 'jeanibarz/maison'),
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(io.logs[0]!).plan.allowedBudget).toBe(1000);
  });

  it('refuses the plan when the drain search throws', async () => {
    const io = mkIo();
    // The open-backlog query succeeds but the is:closed drain query throws; the
    // plan must fail closed rather than fall back to an uncoupled budget.
    const runGh = (args: string[]): string => {
      if (args[0] === 'api') {
        const q = args.find((a) => a.startsWith('q=')) ?? '';
        if (q.includes('is:closed')) throw new Error('search API 503');
        if (q.includes('is:open')) return '40\n';
        return '0\n';
      }
      if (args[0] === 'issue') return '[]';
      throw new Error(`unexpected gh args: ${args.join(' ')}`);
    };
    const code = await runEmissionCli(
      ['plan', '--repo', 'jeanibarz/lucy', '--requested', '10', '--json'],
      { ...io, runGh },
    );
    expect(code).toBe(4);
    expect(io.errs.join('\n')).toMatch(/drain count unavailable.*refusing/i);
  });
});

describe('runEmissionCli retro-verify / ci_blind_debt (issue #1703)', () => {
  function planGh(openCount: number, closedCount: number) {
    return (args: string[]) => {
      if (args[0] === 'api') {
        const q = args.find((a) => a.startsWith('q=')) ?? '';
        if (q.includes('is:closed')) return `${closedCount}\n`;
        if (q.includes('is:open')) return `${openCount}\n`;
        return '0\n';
      }
      if (args[0] === 'issue') return '[]';
      throw new Error(`unexpected gh args: ${args.join(' ')}`);
    };
  }

  it('withholds the emission budget when retro-verify depth exceeds the threshold', async () => {
    // Acceptance criterion: emission budget is withheld while retro-verify
    // depth exceeds a threshold (default 0 ⇒ any debt refuses).
    const io = mkIo({ retroVerifyDepth: 4 });
    const code = await runEmissionCli(
      ['plan', '--repo', 'jeanibarz/lucy', '--requested', '10', '--json'],
      { ...io, runGh: planGh(10, 5) },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.plan.schemaVersion).toBe(EMISSION_BUDGET_SCHEMA_VERSION);
    expect(payload.plan.retroVerifyCoupled).toBe(true);
    expect(payload.plan.retroVerifyDepth).toBe(4);
    expect(payload.plan.retroVerifyWithheld).toBe(true);
    expect(payload.plan.allowedBudget).toBe(0);
    expect(payload.plan.action).toBe('refuse');
    expect(payload.ci_blind_debt.queueDepth).toBe(4);
    expect(payload.ciBlindDebt.blindMergeCount).toBe(4);
    expect(payload.burstDrainFirst).toBe(true);
    expect(payload.note).toMatch(/kookr retro-verify drain/);
  });

  it('allows emission when the retro-verify queue is empty', async () => {
    const io = mkIo({ retroVerifyDepth: 0 });
    const code = await runEmissionCli(
      ['plan', '--repo', 'jeanibarz/lucy', '--requested', '10', '--json'],
      { ...io, runGh: planGh(10, 5) },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.plan.retroVerifyWithheld).toBe(false);
    expect(payload.plan.allowedBudget).toBe(5); // drain-coupled: closed=5
    expect(payload.ci_blind_debt.queueDepth).toBe(0);
    expect(payload.burstDrainFirst).toBe(false);
  });

  it('includes ci_blind_debt on metrics for the daily report', async () => {
    const io = mkIo({ retroVerifyDepth: 2 });
    const code = await runEmissionCli(
      ['metrics', '--repo', 'jeanibarz/lucy', '--json'],
      {
        ...io,
        runGh: (args) => {
          if (args[0] === 'api') {
            const q = args.find((a) => a.startsWith('q=')) ?? '';
            if (q.includes('is:open')) return '20\n';
            if (q.includes('created:')) return '5\n';
            if (q.includes('closed:')) return '3\n';
            return '0\n';
          }
          throw new Error(`unexpected gh args: ${args.join(' ')}`);
        },
      },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.ci_blind_debt.queueDepth).toBe(2);
    expect(payload.ciBlindDebt.blindMergeCount).toBe(2);
    expect(payload.emissionBudgetIfRequested10.retroVerifyWithheld).toBe(true);
    expect(payload.emissionBudgetIfRequested10.allowedBudget).toBe(0);
  });

  it('disables the ci_blind_debt gate with --no-retro-verify-coupling', async () => {
    const io = mkIo({ retroVerifyDepth: 99 });
    const code = await runEmissionCli(
      [
        'plan',
        '--repo',
        'jeanibarz/lucy',
        '--requested',
        '10',
        '--no-retro-verify-coupling',
        '--json',
      ],
      { ...io, runGh: planGh(10, 5) },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.plan.retroVerifyCoupled).toBe(false);
    expect(payload.ci_blind_debt).toBeUndefined();
    expect(payload.plan.allowedBudget).toBe(5);
  });
});

describe('runEmissionCli version (issue #1657)', () => {
  it('reports OK when the running version matches origin/main', async () => {
    const io = mkIo();
    const gitArgs: string[][] = [];
    const code = await runEmissionCli(['version', '--json'], {
      ...io,
      // Echo the *live* running version back as the reference so this OK case
      // keeps tracking the constant across future schema bumps (not a pinned
      // literal that flips to lagging on the next bump).
      runGit: (args: string[]) => {
        gitArgs.push(args);
        return `export const EMISSION_BUDGET_SCHEMA_VERSION = '${EMISSION_BUDGET_SCHEMA_VERSION}' as const;`;
      },
    });
    expect(code).toBe(0);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.ok).toBe(true);
    expect(payload.lagging).toBe(false);
    expect(io.errs.join('\n')).toMatch(/emission-version: OK/);
    // The verb must read the schema source from origin/main, not a stale ref.
    expect(gitArgs[0]).toContain('show');
    expect(gitArgs[0]).toContain('origin/main:src/core/emission-budget.ts');
  });

  it('flags an anomaly when origin/main is ahead of the running version', async () => {
    const io = mkIo();
    const code = await runEmissionCli(['version', '--json'], {
      ...io,
      runGit: () =>
        `export const EMISSION_BUDGET_SCHEMA_VERSION = 'emission-budget.v999' as const;`,
    });
    expect(code).toBe(0);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.lagging).toBe(true);
    expect(payload.reference).toBe('emission-budget.v999');
    expect(io.errs.join('\n')).toMatch(/ANOMALY/);
  });

  it('cannot verify when git fails', async () => {
    const io = mkIo();
    const code = await runEmissionCli(['version'], {
      ...io,
      runGit: () => {
        throw new Error('no origin');
      },
    });
    expect(code).toBe(0);
    expect(io.logs.join('\n')).toMatch(/cannot verify/i);
  });
});

describe('parseBlockerKey', () => {
  it('splits type:scope on the first colon', () => {
    expect(parseBlockerKey('ci-billing:github-actions')).toEqual({
      type: 'ci-billing',
      scope: 'github-actions',
    });
  });

  it('returns null for a malformed key', () => {
    expect(parseBlockerKey('no-colon')).toBeNull();
    expect(parseBlockerKey(':scope')).toBeNull();
    expect(parseBlockerKey('type:')).toBeNull();
  });
});

describe('runEmissionCli tolerance-machinery cap (issue #1702)', () => {
  const planGh =
    (open: number, closed: number) =>
    (args: string[]): string => {
      if (args[0] === 'api') {
        const q = args.find((a) => a.startsWith('q=')) ?? '';
        if (q.includes('is:closed')) return `${closed}\n`;
        if (q.includes('is:open')) return `${open}\n`;
        return '0\n';
      }
      if (args[0] === 'issue') return '[]';
      throw new Error(`unexpected gh args: ${args.join(' ')}`);
    };

  it('refuses new tolerance machinery when the blocker already has a regime', async () => {
    const io = mkIo();
    const code = await runEmissionCli(
      [
        'plan',
        '--repo',
        'jeanibarz/lucy',
        '--requested',
        '3',
        '--tolerance-blocker',
        'ci-billing:github-actions',
        '--json',
      ],
      {
        ...io,
        runGh: planGh(10, 5),
        readToleranceRegime: async (key) => key === 'ci-billing:github-actions',
      },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.plan.toleranceRegimeCoupled).toBe(true);
    expect(payload.plan.toleranceRegimeBlocked).toBe(true);
    expect(payload.plan.toleranceRegimeBlockerKey).toBe('ci-billing:github-actions');
    expect(payload.plan.allowedBudget).toBe(0);
    expect(payload.plan.action).toBe('refuse');
    expect(payload.note).toMatch(/tolerance regime/i);
  });

  it('allows the run when the blocker has no regime yet', async () => {
    const io = mkIo();
    const code = await runEmissionCli(
      [
        'plan',
        '--repo',
        'jeanibarz/lucy',
        '--requested',
        '3',
        '--tolerance-blocker',
        'ci-billing:github-actions',
        '--json',
      ],
      {
        ...io,
        runGh: planGh(10, 5),
        readToleranceRegime: async () => false,
      },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.plan.toleranceRegimeCoupled).toBe(true);
    expect(payload.plan.toleranceRegimeBlocked).toBe(false);
    expect(payload.plan.allowedBudget).toBeGreaterThan(0);
  });

  it('does not consult the gate when --tolerance-blocker is omitted', async () => {
    const io = mkIo();
    let consulted = false;
    const code = await runEmissionCli(
      ['plan', '--repo', 'jeanibarz/lucy', '--requested', '3', '--json'],
      {
        ...io,
        runGh: planGh(10, 5),
        readToleranceRegime: async () => {
          consulted = true;
          return true;
        },
      },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(io.logs[0]!);
    expect(consulted).toBe(false);
    expect(payload.plan.toleranceRegimeCoupled).toBe(false);
  });

  it('reads the real env-blocker registry from --kookr-dir (no injection)', async () => {
    // Exercises the non-injected loadToleranceRegimeActive glue end-to-end:
    // parse key → construct registry → load() → hasRegime.
    const dir = mkdtempSync(join(tmpdir(), 'emission-tolerance-e2e-'));
    try {
      const registry = new EnvironmentBlockerRegistry(dir);
      await registry.register({ type: 'ci-billing', scope: 'github-actions', requiresHuman: true });
      await registry.recordRegimeEntry('ci-billing', 'github-actions', '#1688');

      const io = mkIo();
      const code = await runEmissionCli(
        [
          'plan',
          '--repo',
          'jeanibarz/lucy',
          '--requested',
          '3',
          '--tolerance-blocker',
          'ci-billing:github-actions',
          '--kookr-dir',
          dir,
          '--json',
        ],
        { ...io, runGh: planGh(10, 5) }, // no readToleranceRegime → real disk read
      );
      expect(code).toBe(0);
      const payload = JSON.parse(io.logs[0]!);
      expect(payload.plan.toleranceRegimeBlocked).toBe(true);
      expect(payload.plan.allowedBudget).toBe(0);

      // A blocker without a recorded regime is not blocked (real read, fail-open).
      const io2 = mkIo();
      await runEmissionCli(
        [
          'plan',
          '--repo',
          'jeanibarz/lucy',
          '--requested',
          '3',
          '--tolerance-blocker',
          'search-quota:brave',
          '--kookr-dir',
          dir,
          '--json',
        ],
        { ...io2, runGh: planGh(10, 5) },
      );
      const payload2 = JSON.parse(io2.logs[0]!);
      expect(payload2.plan.toleranceRegimeCoupled).toBe(true);
      expect(payload2.plan.toleranceRegimeBlocked).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
