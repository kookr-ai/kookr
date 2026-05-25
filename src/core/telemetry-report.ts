import { TELEMETRY_EVENT_TYPES, type TelemetryEvent } from './telemetry.js';

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

export function generateTelemetryReport(events: TelemetryEvent[]): TelemetryReport {
  const eventCounts: Record<string, number> = {};
  const inputMethods: Record<string, number> = {};
  const shortcuts: Record<string, number> = {};
  const platforms: Record<string, number> = {};
  const tabSwitches: Record<string, number> = {};

  let rapidRepeatClicks = 0;
  let healthyInspections = 0;
  let suggestionsAccepted = 0;
  let suggestionsIgnored = 0;
  let launchOpened = 0;
  let launchSubmitted = 0;
  let launchAbandoned = 0;
  const launchDwells: number[] = [];
  const cwdFieldMethodCounts: Record<string, number> = {};

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
  };
}
