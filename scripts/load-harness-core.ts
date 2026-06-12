import type { HookEventName } from '../src/shared/contracts/hook-events.js';

export interface LoadHarnessOptions {
  sessions: number;
  eventsPerSession: number;
  seed: number;
  cwd: string;
  nowMs: number;
}

export interface SyntheticHookRecord {
  sessionId: string;
  event: Record<string, unknown>;
  json: string;
}

export interface BroadcastMetrics {
  messageCount: number;
  totalBytes: number;
  snapshotCount: number;
  snapshotBytes: number;
  largestSnapshotBytes: number;
}

export interface MemoryMetrics {
  startRssBytes: number;
  endRssBytes: number;
  deltaRssBytes: number;
}

export interface IngestionLagMetrics {
  sampleCount: number;
  meanMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export interface LoadHarnessReport {
  schemaVersion: 'kookr-load-harness-report.v1';
  generatedAt: string;
  target: {
    mode: 'in-process' | 'external';
    baseUrl: string;
  };
  config: {
    sessions: number;
    eventsPerSession: number;
    totalEvents: number;
    ratePerSecond: number | null;
    seed: number;
  };
  result: {
    attemptedEvents: number;
    dispatchedEvents: number;
    failedEvents: number;
    durationMs: number;
    throughputEventsPerSecond: number;
  };
  broadcast: BroadcastMetrics;
  snapshot: {
    finalAgentCount: number | null;
    finalSnapshotBytes: number | null;
  };
  ingestionLag: IngestionLagMetrics;
  memory: MemoryMetrics;
}

export const SYNTHETIC_REPLAY_SESSION_PREFIX = 'kookr-replay-load-';

const EVENT_CYCLE = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'PermissionRequest',
  'Notification',
  'Stop',
] as const satisfies readonly HookEventName[];

type SyntheticCycleHookName = (typeof EVENT_CYCLE)[number];

export function validateLoadHarnessOptions(options: LoadHarnessOptions): void {
  assertPositiveInteger(options.sessions, 'sessions');
  assertPositiveInteger(options.eventsPerSession, 'eventsPerSession');
  if (!Number.isInteger(options.seed) || options.seed < 0) {
    throw new Error(`seed must be a non-negative integer (got ${JSON.stringify(options.seed)})`);
  }
  if (!Number.isFinite(options.nowMs) || options.nowMs < 0) {
    throw new Error(`nowMs must be a non-negative timestamp (got ${JSON.stringify(options.nowMs)})`);
  }
  if (!options.cwd) throw new Error('cwd must be non-empty');
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer (got ${JSON.stringify(value)})`);
  }
}

export function generateSyntheticHookStorm(options: LoadHarnessOptions): SyntheticHookRecord[] {
  validateLoadHarnessOptions(options);
  const records: SyntheticHookRecord[] = [];
  const sessionBases = Array.from({ length: options.sessions }, (_, sessionIndex) => {
    const sessionId = sessionIdFor(options.seed, sessionIndex);
    const rawSessionId = `claude-load-${options.seed}-${sessionIndex}`;
    const base = {
      session_id: rawSessionId,
      transcript_path: `/tmp/kookr-load-harness/${rawSessionId}.jsonl`,
      cwd: options.cwd,
      kookr_hook_written_at_ms: options.nowMs,
    };
    return { sessionId, base, sessionIndex };
  });

  for (const session of sessionBases) {
    records.push(toRecord(session.sessionId, {
      ...session.base,
      hook_event_name: 'SessionStart',
      model: 'synthetic-load',
      source: 'load-harness',
    }));
  }

  for (let eventIndex = 1; eventIndex < options.eventsPerSession; eventIndex += 1) {
    for (const session of sessionBases) {
      const hookName = EVENT_CYCLE[(eventIndex - 1) % EVENT_CYCLE.length];
      records.push(toRecord(session.sessionId, buildSyntheticEvent({
        base: session.base,
        hookName,
        sessionIndex: session.sessionIndex,
        eventIndex,
        seed: options.seed,
      })));
    }
  }
  return records;
}

function buildSyntheticEvent(args: {
  base: Record<string, unknown>;
  hookName: SyntheticCycleHookName;
  sessionIndex: number;
  eventIndex: number;
  seed: number;
}): Record<string, unknown> {
  const toolUseId = `load-${args.seed}-${args.sessionIndex}-${Math.floor((args.eventIndex - 1) / 2)}`;
  switch (args.hookName) {
    case 'PreToolUse':
      return {
        ...args.base,
        hook_event_name: args.hookName,
        tool_name: 'Bash',
        tool_use_id: toolUseId,
        tool_input: { command: `printf load-${args.sessionIndex}-${args.eventIndex}` },
      };
    case 'PostToolUse':
      return {
        ...args.base,
        hook_event_name: args.hookName,
        tool_name: 'Bash',
        tool_use_id: toolUseId,
        tool_response: `load-${args.sessionIndex}-${args.eventIndex}`,
      };
    case 'UserPromptSubmit':
      return {
        ...args.base,
        hook_event_name: args.hookName,
        prompt: `continue synthetic load ${args.sessionIndex}/${args.eventIndex}`,
      };
    case 'PermissionRequest':
      return {
        ...args.base,
        hook_event_name: args.hookName,
        tool_name: 'Bash',
        tool_input: { command: `cat /tmp/kookr-load-${args.sessionIndex}` },
        permission_suggestions: [{ action: 'allow', command: 'cat' }],
        permission_mode: 'default',
      };
    case 'Notification':
      return {
        ...args.base,
        hook_event_name: args.hookName,
        notification_type: 'info',
        message: `synthetic notification ${args.sessionIndex}/${args.eventIndex}`,
      };
    case 'Stop':
      return {
        ...args.base,
        hook_event_name: args.hookName,
        stop_hook_active: true,
        last_assistant_message: `synthetic stop ${args.sessionIndex}/${args.eventIndex}`,
      };
  }
}

function toRecord(
  sessionId: string,
  event: Record<string, unknown>,
): SyntheticHookRecord {
  return {
    sessionId,
    event,
    json: JSON.stringify(event),
  };
}

function sessionIdFor(seed: number, sessionIndex: number): string {
  return `${SYNTHETIC_REPLAY_SESSION_PREFIX}${seed}-${String(sessionIndex).padStart(4, '0')}`;
}

export function createEmptyBroadcastMetrics(): BroadcastMetrics {
  return {
    messageCount: 0,
    totalBytes: 0,
    snapshotCount: 0,
    snapshotBytes: 0,
    largestSnapshotBytes: 0,
  };
}

export function recordBroadcastMessage(metrics: BroadcastMetrics, rawMessage: string): void {
  const bytes = Buffer.byteLength(rawMessage, 'utf8');
  metrics.messageCount += 1;
  metrics.totalBytes += bytes;
  try {
    const parsed = JSON.parse(rawMessage) as { type?: unknown };
    if (parsed.type === 'snapshot') {
      metrics.snapshotCount += 1;
      metrics.snapshotBytes += bytes;
      metrics.largestSnapshotBytes = Math.max(metrics.largestSnapshotBytes, bytes);
    }
  } catch {
    // Count opaque bytes; ignore malformed messages for snapshot metrics.
  }
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return 'n/a';
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}

export function formatNumber(value: number | null | undefined, fractionDigits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  return value.toFixed(fractionDigits);
}

export function formatMarkdownReport(report: LoadHarnessReport): string {
  return [
    '# Kookr Event Pipeline Load Harness',
    '',
    `- Target: ${report.target.mode} (${report.target.baseUrl})`,
    `- Events: ${report.result.dispatchedEvents}/${report.result.attemptedEvents} dispatched (${report.result.failedEvents} failed)`,
    `- Duration: ${report.result.durationMs} ms`,
    `- Throughput: ${formatNumber(report.result.throughputEventsPerSecond, 2)} events/sec`,
    `- Broadcasts: ${report.broadcast.messageCount} messages, ${formatBytes(report.broadcast.totalBytes)} total`,
    `- Snapshots: ${report.broadcast.snapshotCount} messages, largest ${formatBytes(report.broadcast.largestSnapshotBytes)}, final ${formatBytes(report.snapshot.finalSnapshotBytes)}`,
    `- Ingestion lag: count ${report.ingestionLag.sampleCount}, mean ${formatNumber(report.ingestionLag.meanMs)} ms, p95 ${formatNumber(report.ingestionLag.p95Ms)} ms, max ${formatNumber(report.ingestionLag.maxMs)} ms`,
    `- Memory RSS: start ${formatBytes(report.memory.startRssBytes)}, end ${formatBytes(report.memory.endRssBytes)}, delta ${formatBytes(report.memory.deltaRssBytes)}`,
    '',
    '```json',
    JSON.stringify(report, null, 2),
    '```',
    '',
  ].join('\n');
}
