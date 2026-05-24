import { createHash } from 'node:crypto';
import type { AgentEvent, Anomaly } from './types.js';
import type {
  FindingEvidenceAuditRecord,
  FindingEvidenceObservation,
  FindingEvidenceObservationSource,
  FindingEvidenceVerdict,
} from '../shared/contracts/anomalies.js';

export type {
  FindingEvidenceAuditRecord,
  FindingEvidenceObservation,
  FindingEvidenceObservationSource,
  FindingEvidenceVerdict,
} from '../shared/contracts/anomalies.js';

/**
 * Reason a watchdog verdict was swallowed by the supervisor before reaching
 * the attention queue. M3/M4 review pipelines distinguish these from natural
 * "finding resolved" transitions when measuring detector quality.
 */
export type FindingSuppressionReason = 'subagent_running';

export interface FindingEvidenceAuditOptions {
  maxRecords?: number;
  maxObservationsPerRecord?: number;
  transientGraceMs?: number;
  supportAgeMs?: number;
  maxPaneExcerptChars?: number;
}

const DEFAULT_OPTIONS = {
  maxRecords: 200,
  maxObservationsPerRecord: 8,
  transientGraceMs: 3_000,
  supportAgeMs: 10_000,
  maxPaneExcerptChars: 1_200,
};

function anomalyFingerprint(anomaly: Anomaly): string {
  return `${anomaly.agentId}:${anomaly.type}:${anomaly.subType ?? ''}:${fingerprintExplanation(anomaly.type, anomaly.explanation)}`;
}

function fingerprintExplanation(type: Anomaly['type'], explanation: string): string {
  return type === 'stale_agent' || type === 'hook_disconnected' ? '' : explanation;
}

function recordId(anomaly: Anomaly, detectedAt: string): string {
  const hash = createHash('sha256')
    .update(`${anomalyFingerprint(anomaly)}:${detectedAt}`)
    .digest('hex')
    .slice(0, 16);
  return `finding-${hash}`;
}

function paneFingerprint(paneText: string): string {
  return createHash('sha256').update(paneText).digest('hex').slice(0, 16);
}

function excerptPane(paneText: string, maxChars: number): string | undefined {
  const normalized = paneText.replace(/\r/g, '').trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(Math.max(0, normalized.length - maxChars));
}

function isTrailingStateOverlay(event: AgentEvent): boolean {
  return event.type === 'notification' || event.type === 'subagent_stop';
}

function effectiveLastEvent(events: AgentEvent[]): AgentEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!isTrailingStateOverlay(event)) return event;
  }
  return undefined;
}

function lastEventLooksBlocking(anomaly: Anomaly, event: AgentEvent | undefined): boolean {
  if (!event) return false;
  if (anomaly.type === 'permission_blocked') return event.type === 'permission_request';
  if (anomaly.type === 'needs_input') {
    return event.type === 'stop'
      || (event.type === 'tool_use' && event.toolName === 'AskUserQuestion');
  }
  if (anomaly.type === 'api_error') return event.type === 'stop_failure';
  if (anomaly.type === 'repeated_error') return event.type === 'error';
  if (anomaly.type === 'merge_conflict') return event.type === 'tool_result';
  return true;
}

export class FindingEvidenceAuditor {
  private records = new Map<string, FindingEvidenceAuditRecord>();
  private activeByAgent = new Map<string, string>();
  private opts: Required<FindingEvidenceAuditOptions>;

  constructor(options: FindingEvidenceAuditOptions = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }

  observe(
    agentId: string,
    anomaly: Anomaly | null,
    events: AgentEvent[],
    options: {
      source: FindingEvidenceObservationSource;
      paneText?: string;
      now?: Date;
      /**
       * When `anomaly` is null, optionally tag the resolution with the reason
       * the supervisor swallowed the verdict. Used by M3/M4 detector-proposal
       * pipelines to distinguish natural resolution from suppression.
       */
      suppressionReason?: FindingSuppressionReason;
    } = { source: 'event' },
  ): boolean {
    const now = options.now ?? new Date();
    if (!anomaly) return this.resolve(agentId, events, now, options.suppressionReason);

    const existing = this.activeRecord(agentId);
    if (existing && anomalyFingerprintFromRecord(existing) !== anomalyFingerprint(anomaly)) {
      this.resolve(agentId, events, now);
    }

    const record = this.getOrCreateRecord(agentId, anomaly, now);
    const before = JSON.stringify(record);
    const observation = this.buildObservation(record, events, options.source, options.paneText, now);

    const previous = record.observations.at(-1);
    if (!previous || !sameObservation(previous, observation)) {
      record.observations.push(observation);
      if (record.observations.length > this.opts.maxObservationsPerRecord) {
        record.observations = record.observations.slice(-this.opts.maxObservationsPerRecord);
      }
    }

    record.updatedAt = now.toISOString();
    record.verdict = this.classify(record, anomaly, events);
    record.notes = this.buildNotes(record, anomaly, events);
    this.prune();
    return JSON.stringify(record) !== before;
  }

  resolve(
    agentId: string,
    events: AgentEvent[],
    now: Date = new Date(),
    suppressionReason?: FindingSuppressionReason,
  ): boolean {
    const activeId = this.activeByAgent.get(agentId);
    if (!activeId) return false;
    const record = this.records.get(activeId);
    this.activeByAgent.delete(agentId);
    if (!record || record.status === 'resolved') return false;

    const before = JSON.stringify(record);
    record.status = 'resolved';
    record.updatedAt = now.toISOString();
    const last = effectiveLastEvent(events);
    const ageMs = now.getTime() - Date.parse(record.detectedAt);
    record.observations.push({
      sampledAt: now.toISOString(),
      ageMs,
      source: 'event',
      anomalyStillPresent: false,
      lastEventType: last?.type ?? null,
      eventCount: events.length,
      ...(last?.eventSeq !== undefined ? { lastEventSeq: last.eventSeq } : {}),
    });
    if (record.observations.length > this.opts.maxObservationsPerRecord) {
      record.observations = record.observations.slice(-this.opts.maxObservationsPerRecord);
    }
    if (suppressionReason) {
      record.verdict = 'possible_false_positive';
      record.notes = [`Finding suppressed: ${suppressionReason}.`];
    } else {
      record.verdict = ageMs <= this.opts.transientGraceMs ? 'transient_too_fast' : 'resolved';
      record.notes = [
        ...(record.verdict === 'transient_too_fast'
          ? ['Finding resolved inside the timing grace window after more activity arrived.']
          : ['Finding resolved after subsequent state change.']),
      ];
    }
    return JSON.stringify(record) !== before;
  }

  getActiveRecord(agentId: string): FindingEvidenceAuditRecord | undefined {
    const id = this.activeByAgent.get(agentId);
    const record = id ? this.records.get(id) : undefined;
    return record ? cloneRecord(record) : undefined;
  }

  getRecords(): FindingEvidenceAuditRecord[] {
    return [...this.records.values()].map(cloneRecord);
  }

  getReviewCandidates(limit = 20): FindingEvidenceAuditRecord[] {
    return this.getRecords()
      .filter((record) => record.verdict !== 'supports_finding' || record.status === 'active')
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, limit);
  }

  deleteAgent(agentId: string): void {
    const id = this.activeByAgent.get(agentId);
    if (id) this.records.delete(id);
    this.activeByAgent.delete(agentId);
  }

  private getOrCreateRecord(agentId: string, anomaly: Anomaly, now: Date): FindingEvidenceAuditRecord {
    const fingerprint = anomalyFingerprint(anomaly);
    const existingId = this.activeByAgent.get(agentId);
    const existing = existingId ? this.records.get(existingId) : undefined;
    if (existing && anomalyFingerprintFromRecord(existing) === fingerprint) return existing;

    const detectedAt = anomaly.detectedAt instanceof Date ? anomaly.detectedAt.toISOString() : now.toISOString();
    const record: FindingEvidenceAuditRecord = {
      id: recordId(anomaly, detectedAt),
      agentId,
      anomalyType: anomaly.type,
      ...(anomaly.subType ? { anomalySubType: anomaly.subType } : {}),
      explanation: anomaly.explanation,
      detectedAt,
      updatedAt: now.toISOString(),
      status: 'active',
      verdict: 'pending',
      observations: [],
      notes: [],
    };
    this.records.set(record.id, record);
    this.activeByAgent.set(agentId, record.id);
    return record;
  }

  private buildObservation(
    record: FindingEvidenceAuditRecord,
    events: AgentEvent[],
    source: FindingEvidenceObservationSource,
    paneText: string | undefined,
    now: Date,
  ): FindingEvidenceObservation {
    const last = effectiveLastEvent(events);
    const paneHash = paneText !== undefined ? paneFingerprint(paneText) : undefined;
    const previousPaneHash = [...record.observations].reverse().find((o) => o.paneHash)?.paneHash;
    return {
      sampledAt: now.toISOString(),
      ageMs: Math.max(0, now.getTime() - Date.parse(record.detectedAt)),
      source,
      anomalyStillPresent: true,
      lastEventType: last?.type ?? null,
      eventCount: events.length,
      ...(last?.eventSeq !== undefined ? { lastEventSeq: last.eventSeq } : {}),
      ...(paneHash ? { paneHash } : {}),
      ...(paneHash ? { paneChangedSincePrevious: previousPaneHash !== undefined && previousPaneHash !== paneHash } : {}),
      ...(paneText !== undefined ? { paneExcerpt: excerptPane(paneText, this.opts.maxPaneExcerptChars) } : {}),
    };
  }

  private classify(record: FindingEvidenceAuditRecord, anomaly: Anomaly, events: AgentEvent[]): FindingEvidenceVerdict {
    const newest = record.observations.at(-1);
    if (!newest) return 'pending';
    const last = effectiveLastEvent(events);
    const eventAdvanced = record.observations.some((o) => o.lastEventSeq !== undefined && o.lastEventSeq !== record.observations[0]?.lastEventSeq);
    const paneChanged = record.observations.some((o) => o.paneChangedSincePrevious);

    if (!lastEventLooksBlocking(anomaly, last) && (eventAdvanced || paneChanged)) {
      return 'possible_false_positive';
    }
    if (newest.ageMs < this.opts.supportAgeMs) return 'pending';
    return 'supports_finding';
  }

  private buildNotes(record: FindingEvidenceAuditRecord, anomaly: Anomaly, events: AgentEvent[]): string[] {
    const notes: string[] = [];
    const last = effectiveLastEvent(events);
    if (!lastEventLooksBlocking(anomaly, last)) {
      notes.push(`Latest event (${last?.type ?? 'none'}) no longer matches ${anomaly.type}.`);
    }
    if (record.observations.some((o) => o.paneChangedSincePrevious)) {
      notes.push('Terminal pane changed while the finding was active; review for timing-related false positives.');
    }
    if (record.verdict === 'supports_finding') {
      notes.push('Multiple observations still support the surfaced finding.');
    }
    return notes;
  }

  private prune(): void {
    while (this.records.size > this.opts.maxRecords) {
      const oldest = [...this.records.values()].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))[0];
      if (!oldest) return;
      this.records.delete(oldest.id);
      if (this.activeByAgent.get(oldest.agentId) === oldest.id) this.activeByAgent.delete(oldest.agentId);
    }
  }

  private activeRecord(agentId: string): FindingEvidenceAuditRecord | undefined {
    const existingId = this.activeByAgent.get(agentId);
    return existingId ? this.records.get(existingId) : undefined;
  }
}

function sameObservation(a: FindingEvidenceObservation, b: FindingEvidenceObservation): boolean {
  return a.source === b.source
    && a.lastEventType === b.lastEventType
    && a.eventCount === b.eventCount
    && a.lastEventSeq === b.lastEventSeq
    && a.ageMs === b.ageMs
    && a.paneHash === b.paneHash
    && a.anomalyStillPresent === b.anomalyStillPresent;
}

function anomalyFingerprintFromRecord(record: FindingEvidenceAuditRecord): string {
  return `${record.agentId}:${record.anomalyType}:${record.anomalySubType ?? ''}:${fingerprintExplanation(record.anomalyType, record.explanation)}`;
}

function cloneRecord(record: FindingEvidenceAuditRecord): FindingEvidenceAuditRecord {
  return {
    ...record,
    observations: record.observations.map((o) => ({ ...o })),
    notes: [...record.notes],
  };
}
