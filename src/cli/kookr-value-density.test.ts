import { describe, expect, it } from 'vitest';
import {
  parseValueDensityArgs,
  runValueDensityCli,
  listMergedPrsInWindow,
  ValueDensityUsageError,
} from './kookr-value-density.js';

function capture() {
  const lines: string[] = [];
  const errs: string[] = [];
  return {
    lines,
    errs,
    out: { log: (...a: unknown[]) => lines.push(a.map(String).join(' ')) },
    err: { error: (...a: unknown[]) => errs.push(a.map(String).join(' ')) },
  };
}

describe('parseValueDensityArgs', () => {
  it('parses classify flags', () => {
    const a = parseValueDensityArgs([
      'classify',
      '--title',
      'arch: share x',
      '--labels',
      'architecture,refactor',
      '--json',
    ]);
    expect(a.verb).toBe('classify');
    expect(a.title).toBe('arch: share x');
    expect(a.labels).toEqual(['architecture', 'refactor']);
    expect(a.json).toBe(true);
  });

  it('rejects unknown flags', () => {
    expect(() => parseValueDensityArgs(['classify', '--nope'])).toThrow(
      ValueDensityUsageError,
    );
  });
});

describe('runValueDensityCli classify / admit', () => {
  it('classifies a cosmetic arch title', async () => {
    const c = capture();
    const code = await runValueDensityCli(
      ['classify', '--title', 'arch: share cleanHtmlText', '--json'],
      { out: c.out, err: c.err },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(c.lines[0]!);
    expect(payload.classification.workClass).toBe('refactor');
    expect(payload.classification.cosmetic).toBe(true);
  });

  it('declines cosmetic admit without drift score', async () => {
    const c = capture();
    const code = await runValueDensityCli(
      [
        'admit',
        '--title',
        'arch: share isoNow',
        '--refactor-count',
        '0',
        '--json',
      ],
      { out: c.out, err: c.err },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(c.lines[0]!);
    expect(payload.verdict.action).toBe('decline');
    expect(payload.verdict.reasonCode).toBe('cosmetic_subthreshold');
  });

  it('admits a feat under any refactor count', async () => {
    const c = capture();
    const code = await runValueDensityCli(
      [
        'admit',
        '--title',
        'feat: SEC-anchor probe',
        '--refactor-count',
        '99',
        '--json',
      ],
      { out: c.out, err: c.err },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(c.lines[0]!);
    expect(payload.verdict.action).toBe('admit');
  });

  it('honors --max-refactor and --min-drift-delta CLI knobs', async () => {
    const c = capture();
    const cap = await runValueDensityCli(
      [
        'admit',
        '--title',
        'refactor: split launch-service into use-cases',
        '--refactor-count',
        '2',
        '--max-refactor',
        '2',
        '--json',
      ],
      { out: c.out, err: c.err },
    );
    expect(cap).toBe(0);
    expect(JSON.parse(c.lines[0]!).verdict.reasonCode).toBe('refactor_cap_reached');

    c.lines.length = 0;
    const low = await runValueDensityCli(
      [
        'admit',
        '--title',
        'arch: share isoNow',
        '--refactor-count',
        '0',
        '--drift-score-delta',
        '0.5',
        '--min-drift-delta',
        '1.0',
        '--json',
      ],
      { out: c.out, err: c.err },
    );
    expect(low).toBe(0);
    expect(JSON.parse(c.lines[0]!).verdict.reasonCode).toBe('drift_score_below_min');
  });

  it('requires --refactor-count for admit', async () => {
    const c = capture();
    const code = await runValueDensityCli(
      ['admit', '--title', 'refactor: x'],
      { out: c.out, err: c.err },
    );
    expect(code).toBe(2);
    expect(c.errs.join(' ')).toMatch(/refactor-count/);
  });
});

describe('runValueDensityCli composition + decline', () => {
  it('computes composition from injected gh and persists', async () => {
    const c = capture();
    const appended: Array<{ path: string; line: string }> = [];
    const ghPayload = JSON.stringify([
      { title: 'feat: A', labels: [{ name: 'enhancement' }] },
      { title: 'refactor: share x', labels: [] },
      { title: 'arch: share y', labels: [{ name: 'architecture' }] },
      {
        title: 'feat: SEC probe',
        labels: [{ name: 'product-metric' }],
      },
    ]);
    const code = await runValueDensityCli(
      [
        'composition',
        '--repo',
        'jeanibarz/lucy',
        '--window-hours',
        '24',
        '--kookr-dir',
        '/tmp/vd-test',
        '--json',
      ],
      {
        out: c.out,
        err: c.err,
        now: () => new Date('2026-08-01T17:00:00Z'),
        runGh: () => ghPayload,
        appendLine: (path, line) => appended.push({ path, line }),
      },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(c.lines[0]!);
    expect(payload.report.total).toBe(4);
    expect(payload.report.refactorCount).toBe(2);
    expect(payload.report.valueAdvancingCount).toBe(2);
    expect(payload.line).toMatch(/jeanibarz\/lucy/);
    expect(appended).toHaveLength(1);
    expect(appended[0]!.path).toContain('value-density/composition');
  });

  it('returns 4 when gh fails', async () => {
    const c = capture();
    const code = await runValueDensityCli(
      ['composition', '--repo', 'jeanibarz/lucy', '--no-persist'],
      {
        out: c.out,
        err: c.err,
        runGh: () => {
          throw new Error('boom');
        },
      },
    );
    expect(code).toBe(4);
  });

  it('appends a decline record', async () => {
    const c = capture();
    const appended: Array<{ path: string; line: string }> = [];
    const code = await runValueDensityCli(
      [
        'decline',
        '--repo',
        'jeanibarz/lucy',
        '--title',
        'arch: share cleanHtmlText',
        '--source',
        'architecture-health-check',
        '--reason-code',
        'cosmetic_subthreshold',
        '--reason',
        'cosmetic refactor declined',
        '--kookr-dir',
        '/tmp/vd-test',
        '--json',
      ],
      {
        out: c.out,
        err: c.err,
        now: () => new Date('2026-08-01T17:00:00Z'),
        appendLine: (path, line) => appended.push({ path, line }),
      },
    );
    expect(code).toBe(0);
    expect(appended).toHaveLength(1);
    expect(appended[0]!.path).toContain('value-density/declined');
    const rec = JSON.parse(appended[0]!.line);
    expect(rec.reasonCode).toBe('cosmetic_subthreshold');
    expect(rec.reason).toBe('cosmetic refactor declined');
    expect(rec.title).toBe('arch: share cleanHtmlText');
    expect(rec.source).toBe('architecture-health-check');
    expect(rec.cosmetic).toBe(true);
  });
});

describe('listMergedPrsInWindow', () => {
  it('maps gh json to work items', () => {
    const items = listMergedPrsInWindow(
      () =>
        JSON.stringify([
          { title: 'feat: a', labels: [{ name: 'x' }] },
          { title: 'fix: b', labels: ['y'] },
        ]),
      'o/r',
      '2026-08-01',
    );
    expect(items).toEqual([
      { title: 'feat: a', labels: ['x'] },
      { title: 'fix: b', labels: ['y'] },
    ]);
  });
});
