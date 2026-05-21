import type { AnomalyType } from './types.js';
import type { InteractionEvent } from './interaction-log.js';

interface LiveCalibrationActiveFinding {
  agentId: string;
  anomalyType: AnomalyType;
}

type LiveCalibrationSignalKind =
  | 'skipped_finding'
  | 'snoozed_finding'
  | 'false_positive_feedback'
  | 'direct_intervention_without_finding';

interface LiveCalibrationSignal {
  kind: LiveCalibrationSignalKind;
  target: AnomalyType | 'unclassified_intervention';
  count: number;
  agentCount: number;
  evidence: string[];
}

type LiveCalibrationRecommendationDirection =
  | 'down_weight_candidate'
  | 'defer_candidate'
  | 'coverage_gap_candidate';

interface LiveCalibrationRecommendation {
  id: string;
  target: AnomalyType | 'unclassified_intervention';
  direction: LiveCalibrationRecommendationDirection;
  reason: string;
  evidence: string[];
  affectedActiveAgentIds: string[];
  wouldMutateQueue: false;
}

interface LiveFrictionCalibrationSnapshot {
  schemaVersion: 'live-friction-calibration.v1';
  mode: 'diagnostics_only';
  generatedAt: string;
  routingMutationAllowed: false;
  interactionCount: number;
  activeFindingCount: number;
  signalCount: number;
  signals: LiveCalibrationSignal[];
  recommendations: LiveCalibrationRecommendation[];
}

interface LiveFrictionCalibrationConfig {
  skippedRatioThreshold: number;
  skippedMinimumCount: number;
  snoozedMinimumCount: number;
  falsePositiveMinimumCount: number;
  directInterventionMinimumCount: number;
  maxEvidencePerSignal: number;
}

const DEFAULT_CONFIG: LiveFrictionCalibrationConfig = {
  skippedRatioThreshold: 0.5,
  skippedMinimumCount: 2,
  snoozedMinimumCount: 2,
  falsePositiveMinimumCount: 1,
  directInterventionMinimumCount: 2,
  maxEvidencePerSignal: 3,
};

interface AnomalyCounters {
  skips: Array<Extract<InteractionEvent, { type: 'finding_skipped' }>>;
  snoozes: Array<Extract<InteractionEvent, { type: 'finding_snoozed' }>>;
  falsePositiveFeedback: Array<Extract<InteractionEvent, { type: 'finding_feedback' }>>;
  falsePositiveResolutions: Array<Extract<InteractionEvent, { type: 'finding_resolved' }>>;
  resolutions: Array<Extract<InteractionEvent, { type: 'finding_resolved' }>>;
}

interface InterventionWithoutFinding {
  agentId: string;
  content: string;
}

export function buildLiveFrictionCalibrationSnapshot(
  events: InteractionEvent[],
  activeFindings: LiveCalibrationActiveFinding[] = [],
  config?: Partial<LiveFrictionCalibrationConfig>,
  now = new Date(),
): LiveFrictionCalibrationSnapshot {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const counters = collectAnomalyCounters(events);
  const interventionsWithoutFinding = collectInterventionsWithoutFinding(events);
  const signals = buildSignals(counters, interventionsWithoutFinding, cfg);
  const recommendations = buildRecommendations(counters, interventionsWithoutFinding, activeFindings, cfg);

  return {
    schemaVersion: 'live-friction-calibration.v1',
    mode: 'diagnostics_only',
    generatedAt: now.toISOString(),
    routingMutationAllowed: false,
    interactionCount: events.length,
    activeFindingCount: activeFindings.length,
    signalCount: signals.reduce((total, signal) => total + signal.count, 0),
    signals,
    recommendations,
  };
}

function collectAnomalyCounters(events: InteractionEvent[]): Map<AnomalyType, AnomalyCounters> {
  const counters = new Map<AnomalyType, AnomalyCounters>();
  const get = (anomalyType: AnomalyType): AnomalyCounters => {
    const existing = counters.get(anomalyType);
    if (existing) return existing;
    const created: AnomalyCounters = {
      skips: [],
      snoozes: [],
      falsePositiveFeedback: [],
      falsePositiveResolutions: [],
      resolutions: [],
    };
    counters.set(anomalyType, created);
    return created;
  };

  for (const event of events) {
    switch (event.type) {
      case 'finding_skipped':
        get(event.anomalyType).skips.push(event);
        break;
      case 'finding_snoozed':
        if (event.anomalyType) get(event.anomalyType).snoozes.push(event);
        break;
      case 'finding_feedback':
        get(event.anomalyType).falsePositiveFeedback.push(event);
        break;
      case 'finding_resolved': {
        const entry = get(event.anomalyType);
        entry.resolutions.push(event);
        if (event.method === 'false_positive') {
          entry.falsePositiveResolutions.push(event);
        }
        break;
      }
    }
  }

  return counters;
}

function collectInterventionsWithoutFinding(events: InteractionEvent[]): InterventionWithoutFinding[] {
  const interventions: InterventionWithoutFinding[] = [];
  const findingResponseKeys = new Set(
    events
      .filter((event): event is Extract<InteractionEvent, { type: 'finding_resolved' }> => (
        event.type === 'finding_resolved' && event.method === 'input'
      ))
      .map((event) => interactionKey(event.agentId, event.timestamp)),
  );

  for (const event of events) {
    if (event.type !== 'user_input') continue;

    // Responding to an active finding logs user_input before the matching
    // finding_resolved event. Treat same-timestamp input resolutions as
    // finding responses, not missed-detection interventions.
    if (findingResponseKeys.has(interactionKey(event.agentId, event.timestamp))) {
      continue;
    }
    interventions.push({
      agentId: event.agentId,
      content: event.content,
    });
  }

  return interventions;
}

function buildSignals(
  counters: Map<AnomalyType, AnomalyCounters>,
  interventionsWithoutFinding: InterventionWithoutFinding[],
  cfg: LiveFrictionCalibrationConfig,
): LiveCalibrationSignal[] {
  const signals: LiveCalibrationSignal[] = [];
  const sortedCounters = Array.from(counters.entries()).sort(([left], [right]) => left.localeCompare(right));

  for (const [anomalyType, entry] of sortedCounters) {
    if (entry.skips.length > 0) {
      signals.push({
        kind: 'skipped_finding',
        target: anomalyType,
        count: entry.skips.length,
        agentCount: uniqueAgentCount(entry.skips),
        evidence: entry.skips.slice(-cfg.maxEvidencePerSignal).map((event) => (
          `${event.anomalyType} skipped on ${event.agentId}`
        )),
      });
    }

    if (entry.snoozes.length > 0) {
      signals.push({
        kind: 'snoozed_finding',
        target: anomalyType,
        count: entry.snoozes.length,
        agentCount: uniqueAgentCount(entry.snoozes),
        evidence: entry.snoozes.slice(-cfg.maxEvidencePerSignal).map((event) => (
          `${event.anomalyType ?? anomalyType} snoozed on ${event.agentId} for ${Math.round(event.durationMs / 60_000)}min`
        )),
      });
    }

    const falsePositiveCount = Math.max(
      entry.falsePositiveFeedback.length,
      entry.falsePositiveResolutions.length,
    );
    if (falsePositiveCount > 0) {
      const source = entry.falsePositiveFeedback.length > 0
        ? entry.falsePositiveFeedback
        : entry.falsePositiveResolutions;
      signals.push({
        kind: 'false_positive_feedback',
        target: anomalyType,
        count: falsePositiveCount,
        agentCount: uniqueAgentCount(source),
        evidence: source.slice(-cfg.maxEvidencePerSignal).map((event) => (
          `${anomalyType} marked false positive on ${event.agentId}`
        )),
      });
    }
  }

  if (interventionsWithoutFinding.length > 0) {
    signals.push({
      kind: 'direct_intervention_without_finding',
      target: 'unclassified_intervention',
      count: interventionsWithoutFinding.length,
      agentCount: new Set(interventionsWithoutFinding.map((event) => event.agentId)).size,
      evidence: interventionsWithoutFinding.slice(-cfg.maxEvidencePerSignal).map((event) => (
        `Direct input to ${event.agentId}: "${truncate(event.content, 72)}"`
      )),
    });
  }

  return signals;
}

function buildRecommendations(
  counters: Map<AnomalyType, AnomalyCounters>,
  interventionsWithoutFinding: InterventionWithoutFinding[],
  activeFindings: LiveCalibrationActiveFinding[],
  cfg: LiveFrictionCalibrationConfig,
): LiveCalibrationRecommendation[] {
  const recommendations: LiveCalibrationRecommendation[] = [];
  const sortedCounters = Array.from(counters.entries()).sort(([left], [right]) => left.localeCompare(right));

  for (const [anomalyType, entry] of sortedCounters) {
    const totalResolved = Math.max(entry.resolutions.length, entry.skips.length + entry.snoozes.length);
    const skipRatio = totalResolved > 0 ? entry.skips.length / totalResolved : 0;
    if (entry.skips.length >= cfg.skippedMinimumCount && skipRatio >= cfg.skippedRatioThreshold) {
      recommendations.push({
        id: `down-weight:${anomalyType}`,
        target: anomalyType,
        direction: 'down_weight_candidate',
        reason: `${formatAnomalyType(anomalyType)} is being skipped frequently in this session.`,
        evidence: [
          `${entry.skips.length}/${totalResolved} resolved ${anomalyType} finding(s) were skipped.`,
          ...entry.skips.slice(-2).map((event) => `Skipped on ${event.agentId} at ${event.timestamp}`),
        ],
        affectedActiveAgentIds: activeAgentIdsFor(anomalyType, activeFindings),
        wouldMutateQueue: false,
      });
    }

    if (entry.snoozes.length >= cfg.snoozedMinimumCount) {
      recommendations.push({
        id: `defer:${anomalyType}`,
        target: anomalyType,
        direction: 'defer_candidate',
        reason: `${formatAnomalyType(anomalyType)} is being deferred instead of acted on immediately.`,
        evidence: entry.snoozes.slice(-cfg.maxEvidencePerSignal).map((event) => (
          `Snoozed on ${event.agentId} for ${Math.round(event.durationMs / 60_000)}min`
        )),
        affectedActiveAgentIds: activeAgentIdsFor(anomalyType, activeFindings),
        wouldMutateQueue: false,
      });
    }

    const falsePositiveCount = Math.max(
      entry.falsePositiveFeedback.length,
      entry.falsePositiveResolutions.length,
    );
    if (falsePositiveCount >= cfg.falsePositiveMinimumCount) {
      recommendations.push({
        id: `false-positive:${anomalyType}`,
        target: anomalyType,
        direction: 'down_weight_candidate',
        reason: `${formatAnomalyType(anomalyType)} has live false-positive feedback.`,
        evidence: [`${falsePositiveCount} false-positive marker(s) recorded for ${anomalyType}.`],
        affectedActiveAgentIds: activeAgentIdsFor(anomalyType, activeFindings),
        wouldMutateQueue: false,
      });
    }
  }

  if (interventionsWithoutFinding.length >= cfg.directInterventionMinimumCount) {
    recommendations.push({
      id: 'coverage-gap:direct-intervention',
      target: 'unclassified_intervention',
      direction: 'coverage_gap_candidate',
      reason: 'The user repeatedly intervened before Kookr had an active finding for those agents.',
      evidence: interventionsWithoutFinding.slice(-cfg.maxEvidencePerSignal).map((event) => (
        `Direct input to ${event.agentId}: "${truncate(event.content, 72)}"`
      )),
      affectedActiveAgentIds: [],
      wouldMutateQueue: false,
    });
  }

  return recommendations;
}

function interactionKey(agentId: string, timestamp: string): string {
  return `${agentId}\0${timestamp}`;
}

function formatAnomalyType(anomalyType: AnomalyType): string {
  return anomalyType
    .replace(/[_:-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function uniqueAgentCount(events: Array<{ agentId: string }>): number {
  return new Set(events.map((event) => event.agentId)).size;
}

function activeAgentIdsFor(anomalyType: AnomalyType, activeFindings: LiveCalibrationActiveFinding[]): string[] {
  return activeFindings
    .filter((finding) => finding.anomalyType === anomalyType)
    .map((finding) => finding.agentId)
    .sort();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}...`;
}
