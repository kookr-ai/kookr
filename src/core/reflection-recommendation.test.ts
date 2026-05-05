import { describe, expect, test } from 'vitest';
import { getReflectionRecommendation } from './reflection-recommendation.js';
import type { ReflectionReport } from './friction-analyzer.js';

function makeReport(overrides: Partial<ReflectionReport> = {}): ReflectionReport {
  return {
    sessionStart: '2026-04-06T09:00:00.000Z',
    sessionEnd: '2026-04-06T09:45:00.000Z',
    agentCount: 2,
    totalInterventions: 5,
    anomalyBreakdown: { needs_input: 2 },
    findings: [
      {
        name: 'Repeated input',
        category: 'repeated_correction',
        evidence: ['"run tests" sent 3 time(s)'],
        frequency: 3,
        suggestedFix: 'Add a reusable reminder.',
      },
      {
        name: 'Intervention without finding',
        category: 'detection_gap',
        evidence: ['User sent input without an active finding'],
        frequency: 2,
        suggestedFix: 'Broaden detection.',
      },
    ],
    ...overrides,
  };
}

describe('getReflectionRecommendation', () => {
  test('suggests reflection for a high-friction session', () => {
    const recommendation = getReflectionRecommendation(makeReport());

    expect(recommendation.shouldSuggest).toBe(true);
    expect(recommendation.score).toBeGreaterThanOrEqual(8);
    expect(recommendation.summary).toContain('5 interventions');
    expect(recommendation.sessionLabel).toContain('-');
  });

  test('stays silent for low-intervention sessions', () => {
    const recommendation = getReflectionRecommendation(
      makeReport({
        totalInterventions: 2,
        findings: [
          {
            name: 'Repeated input',
            category: 'repeated_correction',
            evidence: ['"run tests" sent 2 time(s)'],
            frequency: 2,
            suggestedFix: 'Add a reusable reminder.',
          },
        ],
      }),
    );

    expect(recommendation.shouldSuggest).toBe(false);
    expect(recommendation.rationale.join(' ')).toContain('threshold is 4');
  });

  test('stays silent when there are not enough distinct findings', () => {
    const recommendation = getReflectionRecommendation(
      makeReport({
        findings: [
          {
            name: 'Repeated input',
            category: 'repeated_correction',
            evidence: ['"run tests" sent 4 time(s)'],
            frequency: 4,
            suggestedFix: 'Add a reusable reminder.',
          },
        ],
      }),
    );

    expect(recommendation.shouldSuggest).toBe(false);
    expect(recommendation.totalFindings).toBe(1);
  });
});
