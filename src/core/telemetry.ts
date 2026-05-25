import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TelemetryEvent, TelemetryEventType } from '../shared/contracts/telemetry.js';

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

export async function readTelemetryLog(filePath: string): Promise<TelemetryEvent[]> {
  const { readFile } = await import('node:fs/promises');
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const events: TelemetryEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as TelemetryEvent);
    } catch {
      // Skip malformed lines
    }
  }
  return events;
}
