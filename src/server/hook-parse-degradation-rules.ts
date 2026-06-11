import type { Anomaly, AnomalySeverity } from '../shared/contracts/anomalies.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import type { HookParseDegradationEvent } from './hook-ingestion.js';

export interface HookParseDegradationEvaluation {
  alert: Extract<ServerMessage, { type: 'alert' }>;
  anomaly: Anomaly;
}

export class HookParseDegradationEvaluator {
  private firingSessions = new Set<string>();

  evaluate(event: HookParseDegradationEvent): HookParseDegradationEvaluation | null {
    if (this.firingSessions.has(event.kookrSessionId)) return null;
    this.firingSessions.add(event.kookrSessionId);

    const severity: AnomalySeverity = 'warning';
    const summary = `Hook parse degraded for ${event.kookrSessionId}`;
    const details =
      `Malformed hook record from ${event.source}: ${event.error}. ` +
      `Excerpt: "${event.excerpt}" Event: ${event.eventId}`;
    const anomaly: Anomaly = {
      agentId: event.kookrSessionId,
      type: 'hook_parse_degraded',
      severity,
      explanation:
        `Hook events are failing to parse for this session. ` +
        `Malformed excerpt: "${event.excerpt}"`,
      detectedAt: new Date(event.observedAt),
      count: 1,
      eventId: event.eventId,
    };

    return {
      alert: {
        type: 'alert',
        agentId: event.kookrSessionId,
        summary,
        details,
        severity,
      },
      anomaly,
    };
  }
}

export function createHookParseDegradationEvaluator(): HookParseDegradationEvaluator {
  return new HookParseDegradationEvaluator();
}
