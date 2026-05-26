import type { InteractionEvent } from './interaction-log.js';
import type { FrictionFinding, ReflectionReport } from './friction-analyzer.js';
import {
  ATTENTION_MISS_SEED_SCHEMA_VERSION,
  stableSeedId,
  type AttentionMissConfidence,
  type AttentionMissPriorFindingState,
  type AttentionMissSeedV1,
} from './attention-miss-review-contracts.js';

export interface InteractionMissSeedOptions {
  lookbackMs: number;
  taskIdForAgent: (agentId: string) => string | null;
}

export interface FrictionMissSeedOptions {
  lookbackMs: number;
  target: { taskId: string | null; agentId: string };
}

const AMBIGUOUS_OPERATOR_MESSAGE = /^(ok|okay|yes|no|done|thanks|status|what|why|how|when|where|is|are|can|could|should|will)\b/i;

export function buildAttentionMissSeedsFromInteractionEvents(
  events: InteractionEvent[],
  options: InteractionMissSeedOptions,
): AttentionMissSeedV1[] {
  const sorted = [...events].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const seeds: AttentionMissSeedV1[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const event = sorted[index]!;
    if (event.type !== 'user_input') continue;

    const taskId = options.taskIdForAgent(event.agentId);
    const lookback = priorFindingState(sorted, event.agentId, event.timestamp, options.lookbackMs);
    const ambiguous = AMBIGUOUS_OPERATOR_MESSAGE.test(event.content.trim());
    const taskScoped = taskId !== null;
    const confidence: AttentionMissConfidence = !taskScoped || lookback.priorFindingState !== 'none'
      ? 'low'
      : ambiguous
        ? 'medium'
        : 'high';
    const reviewable = taskScoped && lookback.priorFindingState === 'none';
    seeds.push({
      schemaVersion: ATTENTION_MISS_SEED_SCHEMA_VERSION,
      seedId: stableSeedId('interaction', event.agentId, event.timestamp, String(index + 1)),
      target: { taskId, agentId: event.agentId },
      source: 'interaction_log',
      timestamp: event.timestamp,
      eventSeq: index + 1,
      reason: 'operator_intervention_without_finding',
      confidence,
      reviewable,
      lookback,
      correlation: { taskScoped, eventCount: sorted.length },
      notes: [
        ...(ambiguous ? ['operator message is ambiguous'] : []),
        ...(taskScoped ? [] : ['missing task correlation']),
      ],
    });
  }
  return seeds;
}

export function buildAttentionMissSeedsFromFrictionReport(
  report: ReflectionReport,
  options: FrictionMissSeedOptions,
): AttentionMissSeedV1[] {
  return report.findings
    .filter(isMissRelevantFrictionFinding)
    .map((finding, index) => {
      // Empty reports normally have no findings and never reach this branch.
      // Keep malformed reports deterministic instead of stamping "now".
      const endedAt = report.sessionEnd || new Date(0).toISOString();
      const startedAt = new Date(Math.max(0, Date.parse(endedAt) - options.lookbackMs)).toISOString();
      const taskScoped = options.target.taskId !== null;
      return {
        schemaVersion: ATTENTION_MISS_SEED_SCHEMA_VERSION,
        seedId: stableSeedId('friction', options.target.agentId, endedAt, finding.name, String(index)),
        target: options.target,
        source: 'friction_analyzer',
        timestamp: endedAt,
        reason: finding.category === 'detection_gap' ? 'friction_detection_gap' : 'friction_repeated_correction',
        confidence: taskScoped && finding.category === 'detection_gap' ? 'medium' : 'low',
        reviewable: taskScoped && finding.category === 'detection_gap',
        lookback: {
          durationMs: options.lookbackMs,
          startedAt,
          endedAt,
          priorFindingState: 'unknown',
        },
        correlation: { taskScoped, eventCount: finding.frequency },
        notes: finding.evidence.slice(0, 3),
      } satisfies AttentionMissSeedV1;
    });
}

function priorFindingState(
  events: InteractionEvent[],
  agentId: string,
  timestamp: string,
  lookbackMs: number,
): AttentionMissSeedV1['lookback'] {
  const endedAtMs = Date.parse(timestamp);
  const startedAtMs = Math.max(0, endedAtMs - lookbackMs);
  const relevant = events.filter((event) => {
    if (!('agentId' in event) || event.agentId !== agentId) return false;
    const eventMs = Date.parse(event.timestamp);
    return eventMs >= startedAtMs && eventMs < endedAtMs;
  });
  let priorFindingState: AttentionMissPriorFindingState = 'none';
  for (const event of relevant) {
    if (event.type === 'finding_snoozed' || event.type === 'finding_skipped') priorFindingState = 'active_in_lookback';
    if (event.type === 'finding_resolved' && priorFindingState === 'none') priorFindingState = 'resolved_in_lookback';
  }
  return {
    durationMs: lookbackMs,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    priorFindingState,
  };
}

function isMissRelevantFrictionFinding(finding: FrictionFinding): boolean {
  return finding.category === 'detection_gap' || finding.category === 'repeated_correction';
}
