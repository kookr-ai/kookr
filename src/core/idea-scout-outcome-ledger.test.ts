import { describe, test, expect } from 'vitest';
import {
  aggregateDimensionConversion,
  classifyIdeaOutcome,
  conversionSortCredit,
  DEFAULT_CONVERSION_CREDIT_CAP,
  DEFAULT_MIN_SAMPLES_FOR_CONVERSION_WEIGHT,
  DEFAULT_OPEN_AGED_DAYS,
  emptyIdeaOutcomeLedger,
  formatConversionSummaryLine,
  isValidIdeaOutcomeLedger,
  orderDimensionsByCoverageAndConversion,
  rotationSortKey,
  type IdeaOutcomeEntry,
} from './idea-scout-outcome-ledger.js';

describe('idea-scout outcome ledger (issue #1758)', () => {
  describe('classifyIdeaOutcome', () => {
    test('merged join-key PR wins even when the idea issue is still open', () => {
      expect(
        classifyIdeaOutcome({
          issueState: 'open',
          hasMergedPr: true,
          ageDays: 3,
        }),
      ).toBe('merged-pr');
    });

    test('closed without a merged join PR is closed-unimplemented', () => {
      expect(
        classifyIdeaOutcome({
          issueState: 'closed',
          hasMergedPr: false,
          ageDays: 2,
        }),
      ).toBe('closed-unimplemented');
    });

    test('open past the age threshold is open-aged', () => {
      expect(
        classifyIdeaOutcome({
          issueState: 'open',
          hasMergedPr: false,
          ageDays: DEFAULT_OPEN_AGED_DAYS,
        }),
      ).toBe('open-aged');
      expect(
        classifyIdeaOutcome({
          issueState: 'open',
          hasMergedPr: false,
          ageDays: DEFAULT_OPEN_AGED_DAYS - 1,
        }),
      ).toBe('open');
    });

    test('openAgedDays is overridable', () => {
      expect(
        classifyIdeaOutcome({
          issueState: 'open',
          hasMergedPr: false,
          ageDays: 7,
          openAgedDays: 7,
        }),
      ).toBe('open-aged');
    });
  });

  describe('aggregateDimensionConversion', () => {
    const ideas: Pick<IdeaOutcomeEntry, 'dimension' | 'outcome'>[] = [
      { dimension: 'reliability', outcome: 'merged-pr' },
      { dimension: 'reliability', outcome: 'open' },
      { dimension: 'reliability', outcome: 'merged-pr' },
      { dimension: 'testing', outcome: 'closed-unimplemented' },
      { dimension: 'testing', outcome: 'open-aged' },
      { dimension: 'ux', outcome: 'open' },
    ];

    test('rolls up counts and rates per dimension in first-seen order', () => {
      const stats = aggregateDimensionConversion(ideas);
      expect(stats.map((s) => s.dimension)).toEqual(['reliability', 'testing', 'ux']);
      expect(stats[0]).toMatchObject({
        published: 3,
        merged: 2,
        open: 1,
        conversionRate: 2 / 3,
      });
      expect(stats[1]).toMatchObject({
        published: 2,
        closedUnimplemented: 1,
        openAged: 1,
        conversionRate: 0,
      });
      expect(stats[2]).toMatchObject({ published: 1, open: 1, conversionRate: 0 });
    });

    test('empty input yields an empty rollup', () => {
      expect(aggregateDimensionConversion([])).toEqual([]);
    });
  });

  describe('conversionSortCredit and rotation ordering', () => {
    test('credit is zero below the min-sample floor', () => {
      expect(
        conversionSortCredit({
          published: DEFAULT_MIN_SAMPLES_FOR_CONVERSION_WEIGHT - 1,
          conversionRate: 1,
        }),
      ).toBe(0);
    });

    test('full conversion at the sample floor earns the full (capped) credit', () => {
      expect(
        conversionSortCredit({
          published: DEFAULT_MIN_SAMPLES_FOR_CONVERSION_WEIGHT,
          conversionRate: 1,
        }),
      ).toBe(DEFAULT_CONVERSION_CREDIT_CAP);
    });

    test('credit never exceeds the cap even with weight > 1', () => {
      expect(
        conversionSortCredit(
          { published: 10, conversionRate: 1 },
          { weight: 5, cap: DEFAULT_CONVERSION_CREDIT_CAP },
        ),
      ).toBe(DEFAULT_CONVERSION_CREDIT_CAP);
    });

    test('partial conversion scales the credit linearly before the cap', () => {
      expect(
        conversionSortCredit({ published: 4, conversionRate: 0.5 }, { weight: 1, cap: 1 }),
      ).toBe(0.5);
    });

    test('rotationSortKey subtracts credit from coveredCount', () => {
      expect(rotationSortKey(5, 1)).toBe(4);
      expect(rotationSortKey(0, 1)).toBe(-1);
    });

    test('high-converting dimensions sort earlier but coverage still dominates', () => {
      // coverage: reliability=5, testing=3, ux=3
      // conversion: reliability 100% (5/5) → credit 1 → key 4
      //             testing 0% (3/3) → credit 0 → key 3
      //             ux no samples → credit 0 → key 3
      // Order: testing, ux (tie → input order), reliability
      // Even full conversion cannot leap past a dimension two counts behind.
      const ordered = orderDimensionsByCoverageAndConversion(
        ['reliability', 'testing', 'ux', 'security'],
        {
          reliability: { coveredCount: 5 },
          testing: { coveredCount: 3 },
          ux: { coveredCount: 3 },
          security: { coveredCount: 0 },
        },
        {
          reliability: { published: 5, conversionRate: 1 },
          testing: { published: 3, conversionRate: 0 },
          ux: { published: 0, conversionRate: 0 },
          security: { published: 0, conversionRate: 0 },
        },
      );
      expect(ordered[0]).toBe('security'); // zero coverage still first
      expect(ordered.slice(1, 3)).toEqual(['testing', 'ux']);
      expect(ordered[3]).toBe('reliability');
    });

    test('conversion cannot reintroduce starvation: credit-capped dimension stays behind lower coverage', () => {
      // A fully converting dim with coveredCount=4 (key≥3) cannot leap past
      // coveredCount=2 with zero conversion (key=2).
      const ordered = orderDimensionsByCoverageAndConversion(
        ['hot', 'cold'],
        { hot: { coveredCount: 4 }, cold: { coveredCount: 2 } },
        {
          hot: { published: 10, conversionRate: 1 },
          cold: { published: 10, conversionRate: 0 },
        },
      );
      expect(ordered).toEqual(['cold', 'hot']);
      expect(rotationSortKey(4, DEFAULT_CONVERSION_CREDIT_CAP)).toBeGreaterThan(
        rotationSortKey(2, 0),
      );
    });
  });

  describe('formatConversionSummaryLine', () => {
    test('empty stats produce the stable none line', () => {
      expect(formatConversionSummaryLine([])).toBe(
        'Conversion rates: none (no published idea outcomes yet)',
      );
    });

    test('formats per-dimension rates and an overall total', () => {
      const line = formatConversionSummaryLine([
        {
          dimension: 'reliability',
          published: 4,
          merged: 2,
          closedUnimplemented: 0,
          openAged: 0,
          open: 2,
          conversionRate: 0.5,
        },
        {
          dimension: 'testing',
          published: 2,
          merged: 0,
          closedUnimplemented: 1,
          openAged: 1,
          open: 0,
          conversionRate: 0,
        },
      ]);
      expect(line).toBe(
        'Conversion rates: reliability 50% (2/4); testing 0% (0/2); overall 33% (2/6)',
      );
    });
  });

  describe('ledger schema guard', () => {
    test('empty ledger is valid', () => {
      expect(isValidIdeaOutcomeLedger(emptyIdeaOutcomeLedger())).toBe(true);
    });

    test('rejects missing ideas / run arrays and non-object idea rows', () => {
      expect(isValidIdeaOutcomeLedger(null)).toBe(false);
      expect(isValidIdeaOutcomeLedger({})).toBe(false);
      expect(
        isValidIdeaOutcomeLedger({ ideas: {}, recordedRuns: [], refreshedRuns: 'nope' }),
      ).toBe(false);
      expect(
        isValidIdeaOutcomeLedger({
          ideas: { '1': 'bad' },
          recordedRuns: [],
          refreshedRuns: [],
        }),
      ).toBe(false);
    });

    test('accepts a well-formed idea entry', () => {
      expect(
        isValidIdeaOutcomeLedger({
          ideas: {
            '42': {
              issueNumber: 42,
              dimension: 'reliability',
              authority: 'autonomous',
              publishedAt: '2026-08-01T00:00:00Z',
              outcome: 'open',
              outcomeAt: '2026-08-01T00:00:00Z',
              mergedPrNumber: null,
            },
          },
          recordedRuns: ['run-1'],
          refreshedRuns: ['run-1'],
          lastRefreshedAt: '2026-08-01T00:00:00Z',
        }),
      ).toBe(true);
    });
  });
});
