import type { Anomaly } from './types.js';

export function anomalyFingerprint(anomaly: Anomaly): string {
  return `${anomaly.type}:${anomaly.subType ?? ''}:${stableExplanation(anomaly)}`;
}

export function stableAnomalyExplanation(anomaly: Pick<Anomaly, 'type' | 'explanation'>): string {
  if (anomaly.type === 'stale_agent' || anomaly.type === 'hook_disconnected') return '';
  if (anomaly.type === 'repeated_error') {
    return anomaly.explanation.replace(/^Same error repeated \d+ times:/, 'Same error repeated:');
  }
  return anomaly.explanation;
}

function stableExplanation(anomaly: Anomaly): string {
  return stableAnomalyExplanation(anomaly);
}
