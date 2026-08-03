import { TELEMETRY_EVENT_TYPES, type TelemetryEvent } from './telemetry.js';

export interface TerminalLatencyPercentiles {
  sampleCount: number;
  p50FirstPaintMs: number | null;
  p95FirstPaintMs: number | null;
  maxFirstPaintMs: number | null;
  meanFirstPaintMs: number | null;
  subSecondRate: number | null;
}

/** One stratified attach-latency slice (warm|cold × agentType × strategy). */
export interface TerminalAttachLatencyStratum extends TerminalLatencyPercentiles {
  /** Join key for operators: warm|cold × agentType × strategy. */
  key: string;
  warm: 'warm' | 'cold';
  agentType: string;
  strategy: string;
}

export interface TelemetryReport {
  totalEvents: number;
  timeRange: { first: string; last: string } | null;
  eventCounts: Record<string, number>;
  inputMethodBreakdown: Record<string, number>;
  shortcutUsage: Record<string, number>;
  deadFeatures: string[];
  frustrationSignals: {
    rapidRepeatClicks: number;
    healthyAgentInspections: number;
  };
  suggestionMetrics: {
    accepted: number;
    ignored: number;
    acceptanceRate: number | null;
  };
  platformBreakdown: Record<string, number>;
  launchDialogMetrics: {
    opened: number;
    submitted: number;
    abandoned: number;
    avgDwellMs: number | null;
    cwdFieldMethodCounts: Record<string, number>;
    /**
     * Fraction of cwd-field interactions where the user did NOT pick from the
     * MRU dropdown — proxy for "users would benefit from path validation /
     * directory browsing." Null until at least one cwd-field interaction is
     * recorded. Computed as count(method ∈ {typed, paste}) / total.
     */
    nonMruRate: number | null;
  };
  tabSwitchCounts: Record<string, number>;
  selectionFlickerMetrics: {
    totalIncidents: number;
    topPairs: Array<{ pairKey: string; incidentCount: number }>;
    highestSwitchRate: number | null;
    sourceBreakdown: Record<string, number>;
  };
  /**
   * Terminal attach latency after task switch (client `terminal_switch_latency`).
   * Blended percentiles plus stratified p50/p95 by warm|cold × agentType ×
   * strategy so class SLOs are operable without log forensics (RFC Phase 0.0).
   */
  terminalSwitchLatencyMetrics: TerminalLatencyPercentiles & {
    /** Fraction of samples with recoveryUsed=true; null when no samples. */
    recoveryRate: number | null;
    /** Stratified slices for go/no-go (warm|cold × agentType × strategy). */
    byClass: TerminalAttachLatencyStratum[];
  };
}

const ALL_EVENT_TYPES = [...TELEMETRY_EVENT_TYPES];

function computeNonMruRate(counts: Record<string, number>): number | null {
  let nonMru = 0;
  let total = 0;
  for (const [method, count] of Object.entries(counts)) {
    total += count;
    if (method === 'typed' || method === 'paste') nonMru += count;
  }
  return total > 0 ? nonMru / total : null;
}

/** Resolve warm|cold from client event fields (seed hit or client warm). */
export function resolveAttachWarmLabel(event: {
  clientWarm?: unknown;
  seedCacheHit?: unknown;
  warmLabel?: unknown;
}): 'warm' | 'cold' {
  if (event.warmLabel === 'warm' || event.warmLabel === 'cold') {
    return event.warmLabel;
  }
  if (event.clientWarm === true || event.seedCacheHit === true) return 'warm';
  return 'cold';
}

export function generateTelemetryReport(events: TelemetryEvent[]): TelemetryReport {
  const eventCounts: Record<string, number> = {};
  const inputMethods: Record<string, number> = {};
  const shortcuts: Record<string, number> = {};
  const platforms: Record<string, number> = {};
  const tabSwitches: Record<string, number> = {};
  const selectionFlickerPairs: Record<string, number> = {};
  const selectionFlickerSources: Record<string, number> = {};

  let rapidRepeatClicks = 0;
  let healthyInspections = 0;
  let suggestionsAccepted = 0;
  let suggestionsIgnored = 0;
  let launchOpened = 0;
  let launchSubmitted = 0;
  let launchAbandoned = 0;
  let selectionFlickerIncidents = 0;
  let highestSelectionSwitchRate: number | null = null;
  const launchDwells: number[] = [];
  const cwdFieldMethodCounts: Record<string, number> = {};
  const terminalFirstPaintMs: number[] = [];
  let terminalRecoveryUsed = 0;
  /** Samples bucketed for stratified p50/p95. */
  const terminalByClass = new Map<string, number[]>();

  for (const event of events) {
    // Count all event types
    eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;

    // Platform breakdown
    if (event.platform) {
      platforms[event.platform] = (platforms[event.platform] ?? 0) + 1;
    }

    switch (event.type) {
      case 'response_sent': {
        const method = String(event.method ?? 'unknown');
        inputMethods[method] = (inputMethods[method] ?? 0) + 1;
        break;
      }
      case 'shortcut_used': {
        const key = String(event.key ?? 'unknown');
        shortcuts[key] = (shortcuts[key] ?? 0) + 1;
        break;
      }
      case 'rapid_repeat_click':
        rapidRepeatClicks++;
        break;
      case 'healthy_agent_inspected':
        healthyInspections++;
        break;
      case 'suggestion_accepted':
        suggestionsAccepted++;
        break;
      case 'suggestion_ignored':
        suggestionsIgnored++;
        break;
      case 'launch_dialog_opened':
        launchOpened++;
        break;
      case 'launch_dialog_closed': {
        if (event.submitted) {
          launchSubmitted++;
        } else {
          launchAbandoned++;
        }
        if (typeof event.dwellMs === 'number') {
          launchDwells.push(event.dwellMs);
        }
        break;
      }
      case 'launch_dialog_cwd_field_used': {
        const method = String(event.method ?? 'unknown');
        cwdFieldMethodCounts[method] = (cwdFieldMethodCounts[method] ?? 0) + 1;
        break;
      }
      case 'tab_switched': {
        const to = String(event.to ?? 'unknown');
        tabSwitches[to] = (tabSwitches[to] ?? 0) + 1;
        break;
      }
      case 'selection_flicker_incident': {
        selectionFlickerIncidents++;
        const pairKey = String(event.pairKey ?? 'unknown');
        selectionFlickerPairs[pairKey] = (selectionFlickerPairs[pairKey] ?? 0) + 1;
        if (typeof event.switchesPerSecond === 'number') {
          highestSelectionSwitchRate = Math.max(highestSelectionSwitchRate ?? 0, event.switchesPerSecond);
        }
        if (event.sourceCounts && typeof event.sourceCounts === 'object' && !Array.isArray(event.sourceCounts)) {
          for (const [source, count] of Object.entries(event.sourceCounts as Record<string, unknown>)) {
            if (typeof count === 'number' && Number.isFinite(count)) {
              selectionFlickerSources[source] = (selectionFlickerSources[source] ?? 0) + count;
            }
          }
        }
        break;
      }
      case 'terminal_switch_latency': {
        if (
          typeof event.selectionToFirstPaintMs === 'number'
          && Number.isFinite(event.selectionToFirstPaintMs)
          && event.selectionToFirstPaintMs >= 0
        ) {
          const ms = event.selectionToFirstPaintMs;
          terminalFirstPaintMs.push(ms);
          if (event.recoveryUsed === true) terminalRecoveryUsed++;

          const warm = resolveAttachWarmLabel(event);
          const agentType = typeof event.agentType === 'string' && event.agentType.length > 0
            ? event.agentType
            : 'unknown';
          const strategy = typeof event.serverStrategy === 'string' && event.serverStrategy.length > 0
            ? event.serverStrategy
            : (typeof event.strategy === 'string' && event.strategy.length > 0
              ? event.strategy
              : 'unknown');
          const classKey = `${warm}|${agentType}|${strategy}`;
          const bucket = terminalByClass.get(classKey);
          if (bucket) bucket.push(ms);
          else terminalByClass.set(classKey, [ms]);
        }
        break;
      }
    }
  }

  // Detect dead features: event types that were never recorded
  const deadFeatures = ALL_EVENT_TYPES.filter((t) => !eventCounts[t]);

  // Time range
  const timestamps = events.map((e) => e.timestamp).filter(Boolean).sort();
  const timeRange = timestamps.length > 0
    ? { first: timestamps[0], last: timestamps[timestamps.length - 1] }
    : null;

  // Suggestion acceptance rate
  const totalSuggestionActions = suggestionsAccepted + suggestionsIgnored;
  const acceptanceRate = totalSuggestionActions > 0
    ? suggestionsAccepted / totalSuggestionActions
    : null;

  // Average launch dwell
  const avgDwellMs = launchDwells.length > 0
    ? launchDwells.reduce((a, b) => a + b, 0) / launchDwells.length
    : null;

  const blended = summarizeTerminalSwitchLatency(terminalFirstPaintMs);
  const recoveryRate = blended.sampleCount > 0
    ? terminalRecoveryUsed / blended.sampleCount
    : null;

  const byClass: TerminalAttachLatencyStratum[] = [...terminalByClass.entries()]
    .map(([key, samples]) => {
      const [warm, agentType, strategy] = key.split('|') as ['warm' | 'cold', string, string];
      return {
        key,
        warm,
        agentType,
        strategy,
        ...summarizeTerminalSwitchLatency(samples),
      };
    })
    .sort((a, b) => b.sampleCount - a.sampleCount || a.key.localeCompare(b.key));

  return {
    totalEvents: events.length,
    timeRange,
    eventCounts,
    inputMethodBreakdown: inputMethods,
    shortcutUsage: shortcuts,
    deadFeatures,
    frustrationSignals: {
      rapidRepeatClicks,
      healthyAgentInspections: healthyInspections,
    },
    suggestionMetrics: {
      accepted: suggestionsAccepted,
      ignored: suggestionsIgnored,
      acceptanceRate,
    },
    platformBreakdown: platforms,
    launchDialogMetrics: {
      opened: launchOpened,
      submitted: launchSubmitted,
      abandoned: launchAbandoned,
      avgDwellMs,
      cwdFieldMethodCounts,
      nonMruRate: computeNonMruRate(cwdFieldMethodCounts),
    },
    tabSwitchCounts: tabSwitches,
    selectionFlickerMetrics: {
      totalIncidents: selectionFlickerIncidents,
      topPairs: Object.entries(selectionFlickerPairs)
        .map(([pairKey, incidentCount]) => ({ pairKey, incidentCount }))
        .sort((left, right) => right.incidentCount - left.incidentCount || left.pairKey.localeCompare(right.pairKey))
        .slice(0, 5),
      highestSwitchRate: highestSelectionSwitchRate,
      sourceBreakdown: selectionFlickerSources,
    },
    terminalSwitchLatencyMetrics: {
      ...blended,
      recoveryRate,
      byClass,
    },
  };
}

function summarizeTerminalSwitchLatency(samples: number[]): TerminalLatencyPercentiles {
  if (samples.length === 0) {
    return {
      sampleCount: 0,
      p50FirstPaintMs: null,
      p95FirstPaintMs: null,
      maxFirstPaintMs: null,
      meanFirstPaintMs: null,
      subSecondRate: null,
    };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const subSecond = sorted.filter((v) => v < 1000).length;
  return {
    sampleCount: sorted.length,
    p50FirstPaintMs: percentileMs(sorted, 50),
    p95FirstPaintMs: percentileMs(sorted, 95),
    maxFirstPaintMs: sorted[sorted.length - 1],
    meanFirstPaintMs: Math.round((sum / sorted.length) * 100) / 100,
    subSecondRate: subSecond / sorted.length,
  };
}

function percentileMs(sortedAscending: number[], percentileRank: number): number {
  if (sortedAscending.length === 0) return 0;
  const index = Math.min(
    sortedAscending.length - 1,
    Math.max(0, Math.ceil((percentileRank / 100) * sortedAscending.length) - 1),
  );
  return sortedAscending[index];
}
