import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeEffortSplit,
  formatEffortSplitSection,
  persistEffortSplit,
  readEffortSplitRows,
  resolveThresholds,
  sharePct,
  thresholdsFromEnv,
  DEFAULT_PRIMARY_REPO,
  DEFAULT_SECONDARY_REPO,
} from './effort-split.js';
import {
  gatherAllRepoEffortMetrics,
  gatherRepoEffortMetrics,
  parsePaginatedJsonArray,
  type GhRunner,
} from './effort-split-gh.js';

/**
 * 2026-07-30 fixture from issue #1718:
 * - commits calendar-day 34 vs 8 → 81/19 (lucy/kookr)
 * - lines lucy +2951/-215 (=3166) vs kookr +4460/-349 (=4809) → ~40/60
 * Lines inversion must trigger a deviation warning (kookr 60% > 35%).
 */
const FIXTURE_2026_07_30 = {
  date: '2026-07-30',
  // End of the window so date key is 2026-07-30.
  now: new Date('2026-07-30T21:06:00.000Z'),
  repos: [
    {
      repo: 'jeanibarz/lucy',
      nonMergeCommits: 34,
      prsMerged: 16,
      linesChanged: 3166,
      additions: 2951,
      deletions: 215,
    },
    {
      repo: 'kookr-ai/kookr',
      nonMergeCommits: 8,
      prsMerged: 11,
      linesChanged: 4809,
      additions: 4460,
      deletions: 349,
    },
  ],
};

describe('sharePct / thresholds', () => {
  it('rounds to one decimal', () => {
    expect(sharePct(34, 42)).toBe(81);
    expect(sharePct(8, 42)).toBe(19);
    expect(sharePct(3166, 3166 + 4809)).toBe(39.7);
    expect(sharePct(4809, 3166 + 4809)).toBe(60.3);
    expect(sharePct(0, 0)).toBe(0);
  });

  it('default band is 5%–35% around the 20% secondary target', () => {
    const t = resolveThresholds();
    expect(t.secondaryTargetShare).toBe(0.2);
    expect(t.deviationPts).toBe(0.15);
    expect(t.secondaryMinShare).toBeCloseTo(0.05);
    expect(t.secondaryMaxShare).toBeCloseTo(0.35);
  });

  it('reads KOOKR_EFFORT_SPLIT_MIN/MAX from env (percent or fraction)', () => {
    expect(thresholdsFromEnv({ KOOKR_EFFORT_SPLIT_MIN: '5', KOOKR_EFFORT_SPLIT_MAX: '35' })).toEqual({
      secondaryTargetShare: 0.2,
      deviationPts: 0.15,
    });
    expect(thresholdsFromEnv({ KOOKR_EFFORT_SPLIT_MIN: '0.05', KOOKR_EFFORT_SPLIT_MAX: '0.35' })).toEqual({
      secondaryTargetShare: 0.2,
      deviationPts: 0.15,
    });
  });
});

describe('computeEffortSplit — 2026-07-30 numbers (issue #1718)', () => {
  it('reports 81/19 commits and ~40/60 lines with a lines deviation', () => {
    const report = computeEffortSplit({
      repos: FIXTURE_2026_07_30.repos,
      now: FIXTURE_2026_07_30.now,
      date: FIXTURE_2026_07_30.date,
    });

    expect(report.schemaVersion).toBe('effort-split.v1');
    expect(report.date).toBe('2026-07-30');
    expect(report.primaryRepo).toBe(DEFAULT_PRIMARY_REPO);
    expect(report.secondaryRepo).toBe(DEFAULT_SECONDARY_REPO);

    const commits = report.metrics.find((m) => m.metric === 'nonMergeCommits')!;
    expect(commits.byRepo['jeanibarz/lucy']!.sharePct).toBe(81);
    expect(commits.byRepo['kookr-ai/kookr']!.sharePct).toBe(19);
    expect(commits.byRepo['jeanibarz/lucy']!.count).toBe(34);
    expect(commits.byRepo['kookr-ai/kookr']!.count).toBe(8);

    const lines = report.metrics.find((m) => m.metric === 'linesChanged')!;
    // 3166/7975 ≈ 39.7, 4809/7975 ≈ 60.3 — issue quotes 40/60.
    expect(lines.byRepo['jeanibarz/lucy']!.sharePct).toBe(39.7);
    expect(lines.byRepo['kookr-ai/kookr']!.sharePct).toBe(60.3);

    // Commits at 19% are inside the 5–35 band; lines at 60% are not.
    expect(report.deviations.map((d) => d.metric)).toContain('linesChanged');
    expect(report.deviations.map((d) => d.metric)).not.toContain('nonMergeCommits');
    const linesDev = report.deviations.find((d) => d.metric === 'linesChanged')!;
    expect(linesDev.direction).toBe('above');
    expect(linesDev.message).toMatch(/lines changed/i);
    expect(linesDev.message).toMatch(/60\.3%/);
  });

  it('formats a Discord section with the table and an explicit lines warning', () => {
    const report = computeEffortSplit({
      repos: FIXTURE_2026_07_30.repos,
      now: FIXTURE_2026_07_30.now,
      date: FIXTURE_2026_07_30.date,
    });
    const section = formatEffortSplitSection(report);
    expect(section).toContain('Effort split vs 80/20');
    expect(section).toContain('jeanibarz/lucy');
    expect(section).toContain('kookr-ai/kookr');
    expect(section).toContain('34 (81%)');
    expect(section).toContain('8 (19%)');
    expect(section).toMatch(/3166 \(39\.7%\)/);
    expect(section).toMatch(/4809 \(60\.3%\)/);
    expect(section).toMatch(/⚠️/);
    expect(section).toMatch(/DEVIATION/i);
    expect(section).toMatch(/lines changed/i);
  });

  it('flags secondary share below the floor', () => {
    const report = computeEffortSplit({
      repos: [
        { repo: 'jeanibarz/lucy', nonMergeCommits: 100, prsMerged: 10, linesChanged: 1000 },
        { repo: 'kookr-ai/kookr', nonMergeCommits: 1, prsMerged: 10, linesChanged: 1000 },
      ],
      now: FIXTURE_2026_07_30.now,
    });
    // 1/101 ≈ 1% commits — below 5%.
    expect(report.deviations.some((d) => d.metric === 'nonMergeCommits' && d.direction === 'below')).toBe(
      true,
    );
  });

  it('emits no deviation when every metric is inside the band', () => {
    const report = computeEffortSplit({
      repos: [
        { repo: 'jeanibarz/lucy', nonMergeCommits: 80, prsMerged: 8, linesChanged: 800 },
        { repo: 'kookr-ai/kookr', nonMergeCommits: 20, prsMerged: 2, linesChanged: 200 },
      ],
      now: FIXTURE_2026_07_30.now,
    });
    expect(report.deviations).toEqual([]);
    expect(formatEffortSplitSection(report)).toMatch(/within band/);
  });
});

describe('persistEffortSplit — one row/day, same-day overwrite', () => {
  it('writes a JSONL row and overwrites on same-day re-run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-effort-split-'));
    const path = join(dir, 'effort-split.jsonl');

    const first = computeEffortSplit({
      repos: FIXTURE_2026_07_30.repos,
      now: FIXTURE_2026_07_30.now,
      date: '2026-07-30',
    });
    const r1 = await persistEffortSplit(path, first);
    expect(r1.overwritten).toBe(false);

    const second = computeEffortSplit({
      repos: [
        { repo: 'jeanibarz/lucy', nonMergeCommits: 1, prsMerged: 1, linesChanged: 10 },
        { repo: 'kookr-ai/kookr', nonMergeCommits: 1, prsMerged: 1, linesChanged: 10 },
      ],
      now: FIXTURE_2026_07_30.now,
      date: '2026-07-30',
    });
    const r2 = await persistEffortSplit(path, second);
    expect(r2.overwritten).toBe(true);

    const rows = await readEffortSplitRows(path);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.date).toBe('2026-07-30');
    expect(rows[0]!.repos[0]!.nonMergeCommits).toBe(1);

    // Different day appends.
    const nextDay = computeEffortSplit({
      repos: FIXTURE_2026_07_30.repos,
      now: new Date('2026-07-31T12:00:00.000Z'),
      date: '2026-07-31',
    });
    await persistEffortSplit(path, nextDay);
    const both = await readEffortSplitRows(path);
    expect(both.map((r) => r.date)).toEqual(['2026-07-30', '2026-07-31']);

    // File is valid JSONL (one object per line).
    const raw = await readFile(path, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('tolerates a missing file and corrupt lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-effort-split-'));
    const path = join(dir, 'missing.jsonl');
    expect(await readEffortSplitRows(path)).toEqual([]);

    const dirty = join(dir, 'dirty.jsonl');
    await writeFile(
      dirty,
      'not-json\n{"date":"2026-07-01","schemaVersion":"effort-split.v1"}\n{bad\n',
      'utf8',
    );
    const rows = await readEffortSplitRows(dirty);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.date).toBe('2026-07-01');
  });
});

describe('gh gatherer (mocked — never touches contribution ledger)', () => {
  it('parses paginated commit arrays', () => {
    expect(parsePaginatedJsonArray('[{"sha":"a","parents":[]}]')).toHaveLength(1);
    expect(
      parsePaginatedJsonArray('[{"sha":"a"}]\n[{"sha":"b"}]'),
    ).toEqual([{ sha: 'a' }, { sha: 'b' }]);
    expect(
      parsePaginatedJsonArray('[{"sha":"a"}][{"sha":"b"}]'),
    ).toEqual([{ sha: 'a' }, { sha: 'b' }]);
  });

  it('aggregates non-merge commits, PRs, and lines from mocked gh output', async () => {
    // Reproduce the 2026-07-30 shape with synthetic gh payloads so the gatherer
    // + compute path lands on 81/19 commits and ~40/60 lines.
    const sinceIso = '2026-07-29T21:06:00.000Z';
    const untilIso = '2026-07-30T21:06:00.000Z';

    const runGh: GhRunner = async (args) => {
      const joined = args.join(' ');
      if (joined.includes('pr list') && joined.includes('jeanibarz/lucy')) {
        return JSON.stringify([
          // 16 PRs, total +2951/-215
          ...Array.from({ length: 16 }, (_, i) => ({
            number: 1800 + i,
            additions: i === 0 ? 2951 : 0,
            deletions: i === 0 ? 215 : 0,
            mergedAt: '2026-07-30T12:00:00Z',
          })),
        ]);
      }
      if (joined.includes('pr list') && joined.includes('kookr-ai/kookr')) {
        return JSON.stringify([
          ...Array.from({ length: 11 }, (_, i) => ({
            number: 1600 + i,
            additions: i === 0 ? 4460 : 0,
            deletions: i === 0 ? 349 : 0,
            mergedAt: '2026-07-30T12:00:00Z',
          })),
        ]);
      }
      if (joined.includes('repos/jeanibarz/lucy/commits')) {
        // 34 non-merge + 12 merge (the structural bias called out in the issue)
        const nonMerge = Array.from({ length: 34 }, (_, i) => ({
          sha: `lucy-nm-${i}`,
          parents: [{ sha: 'p' }],
          commit: { committer: { date: '2026-07-30T10:00:00Z' } },
        }));
        const merges = Array.from({ length: 12 }, (_, i) => ({
          sha: `lucy-m-${i}`,
          parents: [{ sha: 'a' }, { sha: 'b' }],
          commit: { committer: { date: '2026-07-30T10:00:00Z' } },
        }));
        return JSON.stringify([...nonMerge, ...merges]);
      }
      if (joined.includes('repos/kookr-ai/kookr/commits')) {
        return JSON.stringify(
          Array.from({ length: 8 }, (_, i) => ({
            sha: `kookr-nm-${i}`,
            parents: [{ sha: 'p' }],
            commit: { committer: { date: '2026-07-30T10:00:00Z' } },
          })),
        );
      }
      throw new Error(`unexpected gh args: ${joined}`);
    };

    const repos = await gatherAllRepoEffortMetrics(['jeanibarz/lucy', 'kookr-ai/kookr'], {
      sinceIso,
      untilIso,
      runGh,
    });
    const report = computeEffortSplit({
      repos,
      now: new Date(untilIso),
      date: '2026-07-30',
    });

    expect(repos.find((r) => r.repo === 'jeanibarz/lucy')).toMatchObject({
      nonMergeCommits: 34,
      prsMerged: 16,
      linesChanged: 3166,
    });
    expect(repos.find((r) => r.repo === 'kookr-ai/kookr')).toMatchObject({
      nonMergeCommits: 8,
      prsMerged: 11,
      linesChanged: 4809,
    });

    const commits = report.metrics.find((m) => m.metric === 'nonMergeCommits')!;
    expect(commits.byRepo['jeanibarz/lucy']!.sharePct).toBe(81);
    expect(commits.byRepo['kookr-ai/kookr']!.sharePct).toBe(19);

    const lines = report.metrics.find((m) => m.metric === 'linesChanged')!;
    expect(lines.byRepo['jeanibarz/lucy']!.sharePct).toBe(39.7);
    expect(lines.byRepo['kookr-ai/kookr']!.sharePct).toBe(60.3);
    expect(report.deviations.some((d) => d.metric === 'linesChanged')).toBe(true);

    // Sanity: gatherer never received a contribution-ledger path.
    // (enforced by the mock only accepting gh args)
  });

  it('filters out commits/PRs outside the window', async () => {
    const runGh: GhRunner = async (args) => {
      if (args.includes('pr')) {
        return JSON.stringify([
          { number: 1, additions: 10, deletions: 0, mergedAt: '2026-07-30T12:00:00Z' },
          { number: 2, additions: 99, deletions: 0, mergedAt: '2026-07-28T12:00:00Z' }, // too old
          { number: 3, additions: 99, deletions: 0, mergedAt: '2026-07-31T12:00:00Z' }, // too new
        ]);
      }
      return JSON.stringify([
        {
          sha: 'in',
          parents: [{ sha: 'p' }],
          commit: { committer: { date: '2026-07-30T12:00:00Z' } },
        },
        {
          sha: 'out',
          parents: [{ sha: 'p' }],
          commit: { committer: { date: '2026-07-28T12:00:00Z' } },
        },
      ]);
    };
    const m = await gatherRepoEffortMetrics('acme/repo', {
      sinceIso: '2026-07-29T21:06:00.000Z',
      untilIso: '2026-07-30T21:06:00.000Z',
      runGh,
    });
    expect(m.prsMerged).toBe(1);
    expect(m.linesChanged).toBe(10);
    expect(m.nonMergeCommits).toBe(1);
  });
});
