import type { InteractionEvent } from './interaction-log.js';
import type { AnomalyType } from './types.js';

// --- Friction finding types ---

export type FrictionCategory =
  | 'reactive_user'
  | 'repeated_correction'
  | 'detection_gap'
  | 'workflow_inefficiency';

export interface FrictionFinding {
  name: string;
  category: FrictionCategory;
  evidence: string[];
  frequency: number;
  suggestedFix: string;
}

export interface ReflectionReport {
  sessionStart: string;
  sessionEnd: string;
  agentCount: number;
  totalInterventions: number;
  anomalyBreakdown: Record<string, number>;
  findings: FrictionFinding[];
}

// --- Configuration ---

export interface FrictionAnalyzerConfig {
  repeatedInputThreshold: number;       // min times same message must appear
  rapidSkipWindowMs: number;            // time window for rapid skip detection
  rapidSkipThreshold: number;           // min skips in window
  questionInputThreshold: number;       // min question-shaped inputs
  longResolutionMs: number;             // anomaly active too long before response
  skippedAnomalyRatioThreshold: number; // ratio above which an anomaly type is "always skipped"
}

const DEFAULT_CONFIG: FrictionAnalyzerConfig = {
  repeatedInputThreshold: 2,
  rapidSkipWindowMs: 30_000,
  rapidSkipThreshold: 3,
  questionInputThreshold: 2,
  longResolutionMs: 5 * 60_000,
  skippedAnomalyRatioThreshold: 0.5,
};

// --- Analyzer ---

export function analyzeSession(
  events: InteractionEvent[],
  config?: Partial<FrictionAnalyzerConfig>,
): ReflectionReport {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (events.length === 0) {
    return {
      sessionStart: '',
      sessionEnd: '',
      agentCount: 0,
      totalInterventions: 0,
      anomalyBreakdown: {},
      findings: [],
    };
  }

  const timestamps = events.map((e) => e.timestamp).filter(Boolean);
  const sessionStart = timestamps[0] ?? '';
  const sessionEnd = timestamps[timestamps.length - 1] ?? '';

  const agentIds = new Set<string>();
  const inputs = events.filter((e) => e.type === 'user_input') as Array<
    Extract<InteractionEvent, { type: 'user_input' }>
  >;
  const skips = events.filter((e) => e.type === 'finding_skipped') as Array<
    Extract<InteractionEvent, { type: 'finding_skipped' }>
  >;
  const resolutions = events.filter((e) => e.type === 'finding_resolved') as Array<
    Extract<InteractionEvent, { type: 'finding_resolved' }>
  >;

  for (const e of events) {
    if ('agentId' in e && e.agentId) agentIds.add(e.agentId);
  }

  // Anomaly breakdown from resolutions
  const anomalyBreakdown: Record<string, number> = {};
  for (const r of resolutions) {
    anomalyBreakdown[r.anomalyType] = (anomalyBreakdown[r.anomalyType] ?? 0) + 1;
  }

  const findings: FrictionFinding[] = [];

  // Rule 1: Repeated input
  findings.push(...detectRepeatedInput(inputs, cfg.repeatedInputThreshold));

  // Rule 2: Intervention without finding (detected via user_input to agent with no prior anomaly)
  findings.push(...detectInterventionWithoutFinding(events));

  // Rule 3: Rapid skip cycle
  findings.push(...detectRapidSkipCycle(skips, cfg.rapidSkipWindowMs, cfg.rapidSkipThreshold));

  // Rule 4: Question-shaped input
  findings.push(...detectQuestionInput(inputs, cfg.questionInputThreshold));

  // Rule 5: Long resolution time
  findings.push(...detectLongResolution(resolutions, cfg.longResolutionMs));

  // Rule 6: Always-skipped anomaly type
  findings.push(...detectAlwaysSkipped(skips, resolutions, cfg.skippedAnomalyRatioThreshold));

  return {
    sessionStart,
    sessionEnd,
    agentCount: agentIds.size,
    totalInterventions: inputs.length,
    anomalyBreakdown,
    findings,
  };
}

// --- Individual rules ---

const QUESTION_PATTERN = /^(did|does|is|are|have|has|can|could|should|will|what|why|how|where|when)\s/i;

function normalizeInput(s: string): string {
  return s.trim().toLowerCase().replace(/[?!.]+$/, '');
}

function detectRepeatedInput(
  inputs: Array<Extract<InteractionEvent, { type: 'user_input' }>>,
  threshold: number,
): FrictionFinding[] {
  // Count normalized messages across all agents
  const countsByMessage = new Map<string, { agents: Set<string>; count: number }>();
  for (const input of inputs) {
    const key = normalizeInput(input.content);
    if (!key) continue;
    const entry = countsByMessage.get(key) ?? { agents: new Set(), count: 0 };
    entry.agents.add(input.agentId);
    entry.count++;
    countsByMessage.set(key, entry);
  }

  const findings: FrictionFinding[] = [];
  for (const [message, { agents, count }] of countsByMessage) {
    if (count >= threshold || agents.size > 1) {
      findings.push({
        name: 'Repeated input',
        category: 'repeated_correction',
        evidence: [
          `"${message}" sent ${count} time(s) to ${agents.size} agent(s)`,
        ],
        frequency: count,
        suggestedFix:
          agents.size > 1
            ? `Add "${message}" to CLAUDE.md or a skill — it was sent to multiple agents`
            : `Add "${message}" to agent launch template — repeated ${count} times`,
      });
    }
  }
  return findings;
}

function detectInterventionWithoutFinding(events: InteractionEvent[]): FrictionFinding[] {
  // Track which agents have had findings (skipped, snoozed, or resolved)
  const agentsWithFindings = new Set<string>();
  const interventionsWithoutFinding: Array<{ agentId: string; content: string; timestamp: string }> = [];

  for (const e of events) {
    if (
      e.type === 'finding_skipped' ||
      e.type === 'finding_snoozed' ||
      e.type === 'finding_resolved'
    ) {
      agentsWithFindings.add(e.agentId);
    }
    if (e.type === 'user_input' && !agentsWithFindings.has(e.agentId)) {
      interventionsWithoutFinding.push({
        agentId: e.agentId,
        content: e.content,
        timestamp: e.timestamp,
      });
    }
  }

  if (interventionsWithoutFinding.length === 0) return [];

  return [
    {
      name: 'Intervention without finding',
      category: 'detection_gap',
      evidence: interventionsWithoutFinding.map(
        (i) => `User sent "${i.content.slice(0, 60)}" to ${i.agentId} (no active finding)`,
      ),
      frequency: interventionsWithoutFinding.length,
      suggestedFix:
        'Anomaly detector may be missing a pattern — the user intervened with agents that had no active finding',
    },
  ];
}

function detectRapidSkipCycle(
  skips: Array<Extract<InteractionEvent, { type: 'finding_skipped' }>>,
  windowMs: number,
  threshold: number,
): FrictionFinding[] {
  if (skips.length < threshold) return [];

  // Sliding window: find any consecutive group within windowMs
  for (let i = 0; i <= skips.length - threshold; i++) {
    const windowStart = new Date(skips[i].timestamp).getTime();
    const windowEnd = new Date(skips[i + threshold - 1].timestamp).getTime();
    if (windowEnd - windowStart <= windowMs) {
      return [
        {
          name: 'Rapid skip cycle',
          category: 'workflow_inefficiency',
          evidence: [
            `${threshold}+ findings skipped within ${Math.round(windowMs / 1000)}s`,
          ],
          frequency: threshold,
          suggestedFix:
            'Too many low-priority findings — consider raising anomaly detection thresholds',
        },
      ];
    }
  }
  return [];
}

function detectQuestionInput(
  inputs: Array<Extract<InteractionEvent, { type: 'user_input' }>>,
  threshold: number,
): FrictionFinding[] {
  const questions = inputs.filter((i) => QUESTION_PATTERN.test(i.content.trim()));
  if (questions.length < threshold) return [];

  return [
    {
      name: 'Question-shaped inputs',
      category: 'reactive_user',
      evidence: questions.map(
        (q) => `"${q.content.slice(0, 60)}" → ${q.agentId}`,
      ),
      frequency: questions.length,
      suggestedFix:
        'User is asking agents for status/confirmation — agents should proactively report progress. Consider creating or improving a skill for milestone reporting.',
    },
  ];
}

function detectLongResolution(
  resolutions: Array<Extract<InteractionEvent, { type: 'finding_resolved' }>>,
  thresholdMs: number,
): FrictionFinding[] {
  const slow = resolutions.filter((r) => r.durationMs > thresholdMs);
  if (slow.length === 0) return [];

  return [
    {
      name: 'Long resolution time',
      category: 'workflow_inefficiency',
      evidence: slow.map(
        (r) =>
          `${r.anomalyType} on ${r.agentId} took ${Math.round(r.durationMs / 60_000)}min to resolve`,
      ),
      frequency: slow.length,
      suggestedFix:
        'Some anomalies took a long time before the user responded — consider adding browser notifications or more prominent alerts',
    },
  ];
}

function detectAlwaysSkipped(
  skips: Array<Extract<InteractionEvent, { type: 'finding_skipped' }>>,
  resolutions: Array<Extract<InteractionEvent, { type: 'finding_resolved' }>>,
  ratioThreshold: number,
): FrictionFinding[] {
  // Count skips and total occurrences per anomaly type
  const skipCounts = new Map<AnomalyType, number>();
  const totalCounts = new Map<AnomalyType, number>();

  for (const s of skips) {
    skipCounts.set(s.anomalyType, (skipCounts.get(s.anomalyType) ?? 0) + 1);
    totalCounts.set(s.anomalyType, (totalCounts.get(s.anomalyType) ?? 0) + 1);
  }
  for (const r of resolutions) {
    totalCounts.set(r.anomalyType, (totalCounts.get(r.anomalyType) ?? 0) + 1);
  }

  const findings: FrictionFinding[] = [];
  for (const [anomalyType, skipCount] of skipCounts) {
    const total = totalCounts.get(anomalyType) ?? skipCount;
    const ratio = skipCount / total;
    if (ratio >= ratioThreshold && total >= 2) {
      findings.push({
        name: 'Always-skipped anomaly type',
        category: 'workflow_inefficiency',
        evidence: [
          `${anomalyType} was skipped ${skipCount}/${total} times (${Math.round(ratio * 100)}%)`,
        ],
        frequency: skipCount,
        suggestedFix:
          `The "${anomalyType}" anomaly type is frequently skipped — consider raising its threshold or adjusting detection rules`,
      });
    }
  }
  return findings;
}
