import type { FrictionCategory, ReflectionReport } from './friction-analyzer.js';

export interface ReflectionRecommendationConfig {
  minimumInterventions: number;
  minimumFindings: number;
  minimumScore: number;
  highSignalMinimumFrequency: number;
}

export interface ReflectionRecommendation {
  shouldSuggest: boolean;
  score: number;
  summary: string;
  rationale: string[];
  totalFindings: number;
  sessionLabel: string;
}

const HIGH_SIGNAL_CATEGORIES = new Set<FrictionCategory>([
  'repeated_correction',
  'detection_gap',
]);

const DEFAULT_CONFIG: ReflectionRecommendationConfig = {
  minimumInterventions: 4,
  minimumFindings: 2,
  minimumScore: 8,
  highSignalMinimumFrequency: 2,
};

function formatSessionLabel(start: string, end: string): string {
  if (!start && !end) return 'recent supervision session';
  if (!start || !end) return start || end;

  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return 'recent supervision session';
  }

  const sameDay = startDate.toDateString() === endDate.toDateString();
  const startText = startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const endText = endDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `${startText}-${endText}`;

  const dateText = startDate.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${dateText} ${startText}-${endText}`;
}

export function getReflectionRecommendation(
  report: ReflectionReport,
  config?: Partial<ReflectionRecommendationConfig>,
): ReflectionRecommendation {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const rationale: string[] = [];
  const highSignalFindings = report.findings.filter(
    (finding) =>
      HIGH_SIGNAL_CATEGORIES.has(finding.category)
      && finding.frequency >= cfg.highSignalMinimumFrequency,
  );

  const score = report.totalInterventions
    + report.findings.length
    + highSignalFindings.length * 2;

  if (report.totalInterventions < cfg.minimumInterventions) {
    rationale.push(
      `Only ${report.totalInterventions} intervention(s); threshold is ${cfg.minimumInterventions}.`,
    );
  } else {
    rationale.push(`${report.totalInterventions} user intervention(s) crossed the conservative trigger.`);
  }

  if (report.findings.length < cfg.minimumFindings) {
    rationale.push(
      `Only ${report.findings.length} friction finding(s); threshold is ${cfg.minimumFindings}.`,
    );
  } else {
    rationale.push(`${report.findings.length} friction finding(s) were detected.`);
  }

  if (highSignalFindings.length > 0) {
    rationale.push(
      `${highSignalFindings.length} high-signal finding(s) point to repeated corrections or missed detection.`,
    );
  }

  if (score < cfg.minimumScore) {
    rationale.push(`Composite friction score ${score} is below the trigger score ${cfg.minimumScore}.`);
  } else {
    rationale.push(`Composite friction score ${score} met the trigger score ${cfg.minimumScore}.`);
  }

  const shouldSuggest = report.totalInterventions >= cfg.minimumInterventions
    && report.findings.length >= cfg.minimumFindings
    && score >= cfg.minimumScore;

  const summary = shouldSuggest
    ? `Session had ${report.totalInterventions} interventions and ${report.findings.length} friction signals.`
    : 'Session stayed below the reflection suggestion threshold.';

  return {
    shouldSuggest,
    score,
    summary,
    rationale,
    totalFindings: report.findings.length,
    sessionLabel: formatSessionLabel(report.sessionStart, report.sessionEnd),
  };
}
