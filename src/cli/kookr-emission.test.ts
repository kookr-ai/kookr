import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMISSION_BUDGET_SCHEMA_VERSION,
  MAX_OPERATOR_OVERRIDE_COUNT,
  OPERATOR_OVERRIDE_SCHEMA_VERSION,
  emissionAuditPath,
  operatorOverrideStatePath,
} from '../core/emission-budget.js';
import { computeCiBlindDebt } from '../core/ci-blind-debt.js';
import { buildRetroVerifyEntry } from '../core/retro-verify-queue.js';
import { EnvironmentBlockerRegistry } from '../core/environment-blocker-registry.js';
import {
  parseBlockerKey,
  parseEmissionArgs,
  runEmissionCli,
  OPERATOR_OVERRIDE_AUTHORIZATION_ENV,
  OPERATOR_OVERRIDE_SECRET_ENV,
  USAGE,
} from './kookr-emission.js';

function mkIo(opts: { retroVerifyDepth?: number } = {}) {
  const logs: string[] = [];
  const errs: string[] = [];
  const auditLines: Array<{ path: string; line: string }> = [];
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
    auditLines,
    appendAudit: (path: string, line: string) => auditLines.push({ path, line }),
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
    expect(JSON.parse(io.auditLines[0]!.line)).toMatchObject({
      event: 'filing_attempt',
      outcome: 'duplicate',
      repo: 'kookr-ai/kookr',
      candidateTitle: 'Add dark mode toggle',
    });
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
    expect(JSON.parse(io.auditLines[0]!.line).outcome).toBe('duplicate');
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
    expect(JSON.parse(io.auditLines[0]!.line)).toMatchObject({
      event: 'filing_attempt',
      outcome: 'refused',
      candidateTitle: 'Repository idea: deferred thing',
    });
  });

  it('returns 2 on missing required flags', async () => {
    const io = mkIo();
    const code = await runEmissionCli(['plan', '--repo', 'o/r'], io);
    expect(code).toBe(2);
    expect(io.errs.join('\n')).toMatch(/--requested/);
  });
});

describe('TS-EMISSION-006: audited single-use operator override (issue #2804)', () => {
  const now = new Date('2026-09-01T12:00:00.000Z');
  const invocationId = 'f56b65a4-d91f-45f2-a37d-5e2339728333';
  const secret = 'test-operator-secret-that-is-long-enough';

  function authorizedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      [OPERATOR_OVERRIDE_SECRET_ENV]: secret,
      [OPERATOR_OVERRIDE_AUTHORIZATION_ENV]: secret,
      ...extra,
    };
  }

  function overrideArgs(dir: string, extra: string[] = []): string[] {
    return [
      'override',
      '--repo', 'jeanibarz/maison',
      '--requested', '10',
      '--count', '7',
      '--reason', 'File the reviewed maintenance planning batch',
      '--expires-at', '2026-09-01T12:10:00.000Z',
      '--override-id', invocationId,
      '--kookr-dir', dir,
      '--json',
      ...extra,
    ];
  }

  function zeroDrainGh(openIssues: unknown[] = []) {
    return (args: string[]): string => {
      if (args[0] === 'api') {
        const q = args.find((a) => a.startsWith('q=')) ?? '';
        if (q.includes('is:closed')) return '0\n';
        if (q.includes('is:open')) return '4\n';
        return '0\n';
      }
      if (args[0] === 'issue') return JSON.stringify(openIssues);
      throw new Error(`unexpected gh args: ${args.join(' ')}`);
    };
  }

  function makeZeroDrainConfig(): string {
    const dir = mkdtempSync(join(tmpdir(), 'emission-override-'));
    writeFileSync(join(dir, 'project-configs.json'), JSON.stringify([{
      project: 'github.com/jeanibarz/maison',
      zeroDrainIssueLimit: 0,
    }]));
    return dir;
  }

  it('keeps plan fail-closed when no override is supplied', async () => {
    const dir = makeZeroDrainConfig();
    const io = mkIo();
    try {
      const code = await runEmissionCli([
        'plan',
        '--repo', 'jeanibarz/maison',
        '--requested', '10',
        '--kookr-dir', dir,
        '--json',
      ], {
        ...io,
        now: () => now,
        runGh: zeroDrainGh(),
      });
      expect(code).toBe(0);
      expect(JSON.parse(io.logs[0]!).plan).toMatchObject({
        allowedBudget: 0,
        action: 'refuse',
        operatorOverrideApplied: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('grants a bounded budget, persists the claim, and audits the decision', async () => {
    const dir = makeZeroDrainConfig();
    const io = mkIo();
    const { appendAudit: _omitAuditInjection, ...realAuditIo } = io;
    try {
      const code = await runEmissionCli(overrideArgs(dir), {
        ...realAuditIo,
        env: authorizedEnv(),
        now: () => now,
        runGh: zeroDrainGh(),
      });

      expect(code).toBe(0);
      const payload = JSON.parse(io.logs[0]!);
      expect(payload.plan).toMatchObject({
        operatorOverrideApplied: true,
        operatorOverrideCount: 7,
        operatorOverrideInvocationId: invocationId,
        allowedBudget: 7,
        deferredCount: 3,
      });
      expect(JSON.parse(readFileSync(operatorOverrideStatePath(dir, invocationId), 'utf8')))
        .toMatchObject({ status: 'granted', repo: 'jeanibarz/maison', effectiveCount: 7 });
      const rawAudit = readFileSync(emissionAuditPath(dir), 'utf8');
      expect(rawAudit).not.toContain(secret);
      const audit = rawAudit
        .trim().split('\n').map((line) => JSON.parse(line));
      expect(audit).toContainEqual(expect.objectContaining({
        event: 'operator_override',
        outcome: 'granted',
        invocationId,
        repo: 'jeanibarz/maison',
        reason: 'File the reviewed maintenance planning batch',
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid repo, reason, count, expiry, invocation id, and authorization before GitHub', async () => {
    const invalidCases: Array<{ label: string; args: string[]; env?: NodeJS.ProcessEnv }> = [
      { label: 'repo', args: ['--repo', '../escape'] },
      { label: 'reason', args: ['--reason', 'short'] },
      { label: 'count-zero', args: ['--count', '0'] },
      { label: 'count-cap', args: ['--count', String(MAX_OPERATOR_OVERRIDE_COUNT + 1)] },
      { label: 'expiry-past', args: ['--expires-at', '2026-09-01T11:59:59.000Z'] },
      { label: 'expiry-too-long', args: ['--expires-at', '2026-09-01T12:15:00.001Z'] },
      { label: 'expiry-invalid', args: ['--expires-at', 'tomorrow'] },
      { label: 'id', args: ['--override-id', '../same'] },
      {
        label: 'authorization',
        args: [],
        env: authorizedEnv({ [OPERATOR_OVERRIDE_AUTHORIZATION_ENV]: 'wrong-secret-value' }),
      },
    ];

    for (const testCase of invalidCases) {
      const dir = makeZeroDrainConfig();
      const io = mkIo();
      let queried = false;
      const args = overrideArgs(dir);
      for (let i = 0; i < testCase.args.length; i += 2) {
        const flag = testCase.args[i]!;
        const at = args.indexOf(flag);
        expect(at, testCase.label).toBeGreaterThanOrEqual(0);
        args[at + 1] = testCase.args[i + 1]!;
      }
      const code = await runEmissionCli(args, {
        ...io,
        env: testCase.env ?? authorizedEnv(),
        now: () => now,
        runGh: () => {
          queried = true;
          throw new Error('must not query GitHub');
        },
      });
      expect(code, testCase.label).toBe(2);
      expect(queried, testCase.label).toBe(false);
      expect(JSON.parse(io.auditLines[0]!.line), testCase.label).toMatchObject({
        event: 'operator_override',
        outcome: 'refused',
      });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects every missing required override input before GitHub', async () => {
    for (const flag of ['--repo', '--requested', '--count', '--reason', '--expires-at', '--override-id']) {
      const dir = makeZeroDrainConfig();
      const args = overrideArgs(dir);
      const at = args.indexOf(flag);
      args.splice(at, 2);
      const io = mkIo();
      let queried = false;
      const code = await runEmissionCli(args, {
        ...io,
        env: authorizedEnv(),
        now: () => now,
        runGh: () => {
          queried = true;
          throw new Error('must not query GitHub');
        },
      });
      expect(code, flag).toBe(2);
      expect(queried, flag).toBe(false);
      expect(JSON.parse(io.auditLines[0]!.line), flag).toMatchObject({
        event: 'operator_override',
        outcome: 'refused',
      });
      rmSync(dir, { recursive: true, force: true });
    }

    const dir = makeZeroDrainConfig();
    const io = mkIo();
    const env = authorizedEnv();
    delete env[OPERATOR_OVERRIDE_AUTHORIZATION_ENV];
    const code = await runEmissionCli(overrideArgs(dir), {
      ...io,
      env,
      now: () => now,
      runGh: () => { throw new Error('must not query GitHub'); },
    });
    expect(code).toBe(2);
    expect(JSON.parse(io.auditLines[0]!.line)).toMatchObject({
      outcome: 'refused',
      refusalCode: 'invalid_authorization',
    });
    rmSync(dir, { recursive: true, force: true });

    const unconfiguredDir = makeZeroDrainConfig();
    const unconfiguredIo = mkIo();
    const unconfiguredEnv = authorizedEnv();
    delete unconfiguredEnv[OPERATOR_OVERRIDE_SECRET_ENV];
    const unconfiguredCode = await runEmissionCli(overrideArgs(unconfiguredDir), {
      ...unconfiguredIo,
      env: unconfiguredEnv,
      now: () => now,
      runGh: () => { throw new Error('must not query GitHub'); },
    });
    expect(unconfiguredCode).toBe(2);
    expect(JSON.parse(unconfiguredIo.auditLines[0]!.line)).toMatchObject({
      outcome: 'refused',
      refusalCode: 'authorization_not_configured',
    });
    expect(existsSync(operatorOverrideStatePath(unconfiguredDir, invocationId))).toBe(false);
    rmSync(unconfiguredDir, { recursive: true, force: true });
  });

  it('rejects concurrent and replayed use of the same invocation id', async () => {
    const dir = makeZeroDrainConfig();
    try {
      const io1 = mkIo();
      const io2 = mkIo();
      const [first, concurrent] = await Promise.all([
        runEmissionCli(overrideArgs(dir), {
          ...io1,
          env: authorizedEnv(),
          now: () => now,
          runGh: zeroDrainGh(),
        }),
        runEmissionCli(overrideArgs(dir), {
          ...io2,
          env: authorizedEnv(),
          now: () => now,
          runGh: zeroDrainGh(),
        }),
      ]);
      expect([first, concurrent].sort()).toEqual([0, 2]);

      const replayIo = mkIo();
      const replay = await runEmissionCli(overrideArgs(dir), {
        ...replayIo,
        env: authorizedEnv(),
        now: () => now,
        runGh: zeroDrainGh(),
      });
      expect(replay).toBe(2);
      expect(replayIo.errs.join('\n')).toMatch(/already claimed|replay/i);
      expect(JSON.parse(replayIo.auditLines[0]!.line)).toMatchObject({
        event: 'operator_override',
        outcome: 'refused',
        refusalCode: 'invocation_replay',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('burns the claim on a failed live query and refuses the replay', async () => {
    const dir = makeZeroDrainConfig();
    try {
      const firstIo = mkIo();
      const first = await runEmissionCli(overrideArgs(dir), {
        ...firstIo,
        env: authorizedEnv(),
        now: () => now,
        runGh: () => { throw new Error('GitHub unavailable'); },
      });
      expect(first).toBe(4);

      const replayIo = mkIo();
      const replay = await runEmissionCli(overrideArgs(dir), {
        ...replayIo,
        env: authorizedEnv(),
        now: () => now,
        runGh: zeroDrainGh(),
      });
      expect(replay).toBe(2);
      expect(replayIo.errs.join('\n')).toMatch(/already claimed|replay/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps dedupe mandatory and auditable for override-linked candidates', async () => {
    const dir = makeZeroDrainConfig();
    try {
      const grantIo = mkIo();
      expect(await runEmissionCli(overrideArgs(dir), {
        ...grantIo,
        env: authorizedEnv(),
        now: () => now,
        runGh: zeroDrainGh(),
      })).toBe(0);

      const dedupeIo = mkIo();
      const code = await runEmissionCli([
        'dedupe',
        '--repo', 'jeanibarz/maison',
        '--title', 'Existing maintenance plan',
        '--override-id', invocationId,
        '--kookr-dir', dir,
        '--json',
      ], {
        ...dedupeIo,
        now: () => now,
        runGh: zeroDrainGh([{
          number: 44,
          title: 'Existing maintenance plan',
          state: 'OPEN',
          url: 'https://example.test/issues/44',
        }]),
      });

      expect(code).toBe(0);
      expect(JSON.parse(dedupeIo.logs[0]!).isDuplicate).toBe(true);
      expect(JSON.parse(dedupeIo.auditLines[0]!.line)).toMatchObject({
        event: 'filing_attempt',
        outcome: 'duplicate',
        invocationId,
        matchNumber: 44,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('expires automatically before a later override-linked dedupe attempt', async () => {
    const dir = makeZeroDrainConfig();
    try {
      const grantIo = mkIo();
      expect(await runEmissionCli(overrideArgs(dir), {
        ...grantIo,
        env: authorizedEnv(),
        now: () => now,
        runGh: zeroDrainGh(),
      })).toBe(0);

      const dedupeIo = mkIo();
      let queried = false;
      const code = await runEmissionCli([
        'dedupe', '--repo', 'jeanibarz/maison', '--title', 'Later candidate',
        '--override-id', invocationId, '--kookr-dir', dir, '--json',
      ], {
        ...dedupeIo,
        now: () => new Date('2026-09-01T12:10:00.000Z'),
        runGh: () => {
          queried = true;
          return '[]';
        },
      });
      expect(code).toBe(2);
      expect(queried).toBe(false);
      expect(JSON.parse(dedupeIo.auditLines[0]!.line)).toMatchObject({
        outcome: 'refused',
        refusalCode: 'expired',
        invocationId,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an override that is not an explicit zero-drain refusal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'emission-override-unlimited-'));
    const io = mkIo();
    try {
      const code = await runEmissionCli(overrideArgs(dir), {
        ...io,
        env: authorizedEnv(),
        now: () => now,
        runGh: zeroDrainGh(),
      });
      expect(code).toBe(2);
      expect(io.errs.join('\n')).toMatch(/explicit zero-drain refusal/i);
      expect(JSON.parse(io.auditLines[0]!.line)).toMatchObject({
        event: 'operator_override',
        outcome: 'refused',
        refusalCode: 'override_not_applicable',
        invocationId,
      });
      expect(JSON.parse(readFileSync(operatorOverrideStatePath(dir, invocationId), 'utf8')))
        .toMatchObject({ status: 'refused', refusalCode: 'override_not_applicable' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a granted override when retro-verify still withholds emission', async () => {
    const dir = makeZeroDrainConfig();
    const io = mkIo({ retroVerifyDepth: 1 });
    try {
      const code = await runEmissionCli(overrideArgs(dir), {
        ...io,
        env: authorizedEnv(),
        now: () => now,
        runGh: zeroDrainGh(),
      });
      expect(code).toBe(2);
      expect(io.errs.join('\n')).toMatch(/stricter emission gate/i);
      expect(JSON.parse(io.auditLines[0]!.line)).toMatchObject({
        event: 'operator_override',
        outcome: 'refused',
        refusalCode: 'stricter_gate_refusal',
        invocationId,
      });
      expect(JSON.parse(readFileSync(operatorOverrideStatePath(dir, invocationId), 'utf8')))
        .toMatchObject({ status: 'refused', refusalCode: 'stricter_gate_refusal' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats a granted override with an unparsable expiry as expired', async () => {
    const dir = makeZeroDrainConfig();
    try {
      mkdirSync(join(dir, 'playbook-state', 'emission-metrics', 'operator-overrides'), { recursive: true });
      writeFileSync(operatorOverrideStatePath(dir, invocationId), `${JSON.stringify({
        schemaVersion: OPERATOR_OVERRIDE_SCHEMA_VERSION,
        invocationId,
        repo: 'jeanibarz/maison',
        requestedBudget: 10,
        count: 7,
        reason: 'File the reviewed maintenance planning batch',
        expiresAt: 'not-a-date',
        invokedAt: now.toISOString(),
        status: 'granted',
        effectiveCount: 7,
      })}\n`);
      const io = mkIo();
      let queried = false;
      const code = await runEmissionCli([
        'dedupe', '--repo', 'jeanibarz/maison', '--title', 'Later candidate',
        '--override-id', invocationId, '--kookr-dir', dir, '--json',
      ], {
        ...io,
        now: () => now,
        runGh: () => {
          queried = true;
          return '[]';
        },
      });
      expect(code).toBe(2);
      expect(queried).toBe(false);
      expect(JSON.parse(io.auditLines[0]!.line)).toMatchObject({
        outcome: 'refused',
        refusalCode: 'expired',
        invocationId,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('audits a deferred candidate with the override invocation id', async () => {
    const dir = makeZeroDrainConfig();
    try {
      expect(await runEmissionCli(overrideArgs(dir), {
        ...mkIo(),
        env: authorizedEnv(),
        now: () => now,
        runGh: zeroDrainGh(),
      })).toBe(0);

      const deferIo = mkIo();
      const code = await runEmissionCli([
        'defer',
        '--repo', 'jeanibarz/maison',
        '--title', 'Overflow maintenance candidate',
        '--source', 'github-issue-workflow',
        '--reason', 'over emission budget',
        '--override-id', invocationId,
        '--kookr-dir', dir,
        '--json',
      ], deferIo);
      expect(code).toBe(0);
      expect(JSON.parse(deferIo.auditLines[0]!.line)).toMatchObject({
        event: 'filing_attempt',
        outcome: 'refused',
        refusalCode: 'deferred',
        invocationId,
        candidateTitle: 'Overflow maintenance candidate',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the audit record cannot be written', async () => {
    const dir = makeZeroDrainConfig();
    const io = mkIo();
    try {
      const code = await runEmissionCli(overrideArgs(dir), {
        ...io,
        env: authorizedEnv(),
        now: () => now,
        runGh: zeroDrainGh(),
        appendAudit: () => { throw new Error('audit disk full'); },
      });
      expect(code).toBe(4);
      expect(io.errs.join('\n')).toMatch(/audit disk full/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    rmSync(configDir, { recursive: true, force: true });
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

  it('TS-EMISSION-003: refuses to plan when the project settings file is unreadable', async () => {
    const io = mkIo();
    const configDir = mkdtempSync(join(tmpdir(), 'emission-config-unreadable-'));
    // A present-but-unreadable policy file (a directory triggers EISDIR on read)
    // must abort, not fail open to the unlimited default.
    mkdirSync(join(configDir, 'project-configs.json'));
    const code = await runEmissionCli(
      [
        'plan', '--repo', 'jeanibarz/maison', '--requested', '10', '--json',
        '--kookr-dir', configDir,
      ],
      { ...io, runGh: planGh(0, 0, [], 'jeanibarz/maison') },
    );
    expect(code).toBe(2);
    expect(io.errs.join('\n')).toMatch(/cannot read project settings/);
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
