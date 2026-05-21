const DISPLAY_LABEL: Record<string, string> = {
  failed_retryable: 'Retryable failure',
  failed_terminal: 'Terminal failure',
  false_positive: 'False positive',
  false_negative: 'False negative',
  in_progress: 'In progress',
  invalid_attempt: 'Invalid attempt',
  likely_false_positive: 'Likely false positive',
  model_review: 'Model review',
  persisted_review: 'Persisted review',
  queued: 'Queued',
  reviewed: 'Reviewed',
  sampler_disabled: 'Sampler disabled',
  supports_finding: 'Supports finding',
  timing_false_positive: 'Timing false positive',
  skipped_finding: 'Skipped finding',
  snoozed_finding: 'Snoozed finding',
  false_positive_feedback: 'False-positive feedback',
  direct_intervention_without_finding: 'Direct intervention without finding',
  down_weight_candidate: 'Down-weight candidate',
  defer_candidate: 'Defer candidate',
  coverage_gap_candidate: 'Coverage gap candidate',
  unclassified_intervention: 'Unclassified intervention',
  unclear: 'Unclear',
  unknown: 'Unknown',
};

export function formatDiagnosticIdentifier(value: string | null | undefined): string {
  if (!value) return 'Unknown';
  const label = DISPLAY_LABEL[value];
  if (label) return label;
  return value
    .split(/[_:-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Unknown';
}
