import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TelemetryEvent, TelemetryEventType } from '../shared/contracts/telemetry.js';
import { JSONL_LOG_READ_MAX_BYTES, readJsonlLogTail } from './jsonl-file-tail.js';

export { TELEMETRY_EVENT_TYPES } from '../shared/contracts/telemetry.js';
export type { TelemetryEvent, TelemetryEventType };

// --- Writer ---

export class TelemetryLogWriter {
  constructor(private filePath: string) {}

  async append(event: TelemetryEvent): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, JSON.stringify(event) + '\n', 'utf-8');
  }

  async appendBatch(events: TelemetryEvent[]): Promise<void> {
    if (events.length === 0) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await appendFile(this.filePath, lines, 'utf-8');
  }

  getFilePath(): string {
    return this.filePath;
  }
}

// --- Deferred Writer ---

/**
 * Wraps TelemetryLogWriter with lazy session creation.
 * Shares the same session lifecycle as DeferredInteractionLogWriter —
 * telemetry events are only written once the interaction log has materialized a session.
 */
export class DeferredTelemetryLogWriter {
  private writer: TelemetryLogWriter | null = null;
  private buffer: TelemetryEvent[] = [];

  constructor(
    private sessionsDir: string,
    private getSessionId: () => string | null,
  ) {}

  async append(event: TelemetryEvent): Promise<void> {
    const sessionId = this.getSessionId();
    if (sessionId && !this.writer) {
      this.writer = new TelemetryLogWriter(join(this.sessionsDir, sessionId, 'telemetry.jsonl'));
    }
    if (this.writer) {
      // Flush buffer first
      if (this.buffer.length > 0) {
        await this.writer.appendBatch(this.buffer);
        this.buffer = [];
      }
      await this.writer.append(event);
      return;
    }
    this.buffer.push(event);
  }

  async appendBatch(events: TelemetryEvent[]): Promise<void> {
    if (events.length === 0) return;
    const sessionId = this.getSessionId();
    if (sessionId && !this.writer) {
      this.writer = new TelemetryLogWriter(join(this.sessionsDir, sessionId, 'telemetry.jsonl'));
    }
    if (this.writer) {
      if (this.buffer.length > 0) {
        await this.writer.appendBatch(this.buffer);
        this.buffer = [];
      }
      await this.writer.appendBatch(events);
      return;
    }
    this.buffer.push(...events);
  }

  getFilePath(): string | null {
    return this.writer?.getFilePath() ?? null;
  }
}

// --- Reader ---

/**
 * Byte cap for telemetry-log reads (issue #3243). Same value as the shared
 * JSONL tail helper — kept as a named export so tests and callers can size
 * fixtures against the production cap.
 */
export const TELEMETRY_LOG_READ_MAX_BYTES = JSONL_LOG_READ_MAX_BYTES;

/**
 * Read a telemetry JSONL log, bounded to the last
 * {@link TELEMETRY_LOG_READ_MAX_BYTES} unless `options.maxBytes` overrides.
 *
 * Callers (telemetry report, health/diagnostics) must use this helper rather
 * than reimplementing a tail. The file is never deleted or rotated.
 */
export async function readTelemetryLog(
  filePath: string,
  options?: { maxBytes?: number },
): Promise<TelemetryEvent[]> {
  const rows = await readJsonlLogTail(
    filePath,
    options?.maxBytes ?? TELEMETRY_LOG_READ_MAX_BYTES,
  );
  return rows as TelemetryEvent[];
}
