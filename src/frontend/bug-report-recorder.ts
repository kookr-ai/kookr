import type { ClientMessage } from '../shared/protocol.js';

export interface BugReportWireObservation {
  direction: 'inbound' | 'outbound';
  receivedAt: string;
  sequence: number;
  type: string | null;
  parseOk: boolean;
  byteLength: number;
  fieldNames: string[];
  validationError?: string;
  shortPreview?: string;
  truncated: boolean;
}

export interface BugReportRecordedAlert {
  id: string;
  recordedAt: string;
  agentId: string;
  severity: 'critical' | 'warning' | 'info' | 'error';
  summary: string;
  summaryCategory: string;
  details?: string;
}

const MAX_WIRE_OBSERVATIONS = 10;
const MAX_WIRE_AGE_MS = 10 * 60 * 1000;
const MAX_ALERTS = 20;
const PREVIEW_LIMIT = 180;

let nextSequence = 1;
let wireObservations: BugReportWireObservation[] = [];
let recordedAlerts: BugReportRecordedAlert[] = [];

export function recordInbound(raw: string, parsed: unknown | null): void {
  const receivedAt = new Date().toISOString();
  const parseOk = parsed !== null && typeof parsed === 'object';
  const type = messageType(parsed);
  wireObservations.push({
    direction: 'inbound',
    receivedAt,
    sequence: nextSequence++,
    type,
    parseOk,
    byteLength: byteLength(raw),
    fieldNames: fieldNames(parsed),
    ...(parseOk ? {} : { validationError: 'json_parse_failed', shortPreview: safePreview(raw) }),
    truncated: raw.length > PREVIEW_LIMIT,
  });
  pruneWireObservations(Date.now());
}

export function recordOutbound(message: ClientMessage): void {
  const json = safeStringify(message);
  wireObservations.push({
    direction: 'outbound',
    receivedAt: new Date().toISOString(),
    sequence: nextSequence++,
    type: message.type,
    parseOk: true,
    byteLength: byteLength(json),
    fieldNames: Object.keys(message).sort(),
    truncated: false,
  });
  pruneWireObservations(Date.now());
}

export function recordReportableAlert(alert: Omit<BugReportRecordedAlert, 'id' | 'recordedAt'>): void {
  const recorded: BugReportRecordedAlert = {
    ...alert,
    summaryCategory: classifyAlert(alert.summary, alert.details),
    id: `alert-${Date.now()}-${recordedAlerts.length + 1}`,
    recordedAt: new Date().toISOString(),
  };
  recordedAlerts = [...recordedAlerts, recorded].slice(-MAX_ALERTS);
}

export function getBugReportWireObservations(): BugReportWireObservation[] {
  pruneWireObservations(Date.now());
  return wireObservations.map((event) => ({ ...event, fieldNames: [...event.fieldNames] }));
}

export function getBugReportAlerts(): BugReportRecordedAlert[] {
  return recordedAlerts.map((alert) => ({ ...alert }));
}

export function resetBugReportRecorderForTests(): void {
  nextSequence = 1;
  wireObservations = [];
  recordedAlerts = [];
}

function pruneWireObservations(nowMs: number): void {
  const minTime = nowMs - MAX_WIRE_AGE_MS;
  wireObservations = wireObservations
    .filter((event) => new Date(event.receivedAt).getTime() >= minTime)
    .slice(-MAX_WIRE_OBSERVATIONS);
}

function messageType(value: unknown): string | null {
  if (value && typeof value === 'object' && 'type' in value && typeof (value as { type?: unknown }).type === 'string') {
    return (value as { type: string }).type;
  }
  return null;
}

function fieldNames(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).sort();
}

function safePreview(value: string): string {
  return value.slice(0, PREVIEW_LIMIT).replace(/[\r\n\t]+/g, ' ');
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function classifyAlert(summary: string, details?: string): string {
  const text = `${summary} ${details ?? ''}`.toLowerCase();
  if (text.includes('malformed websocket')) return 'malformed_websocket';
  if (text.includes('websocket')) return 'websocket';
  if (text.includes('launch')) return 'launch';
  if (text.includes('github')) return 'github';
  if (text.includes('error')) return 'error';
  return 'general';
}
