import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// --- Telemetry event types ---

export type TelemetryEventType =
  // Navigation & Selection
  | 'agent_clicked'
  | 'auto_advance_overridden'
  | 'tab_switched'
  // Response & Input
  | 'response_sent'
  | 'quick_action_clicked'
  | 'suggestion_accepted'
  | 'suggestion_ignored'
  // Agent Lifecycle
  | 'launch_dialog_opened'
  | 'launch_dialog_closed'
  | 'launch_dialog_draft_restored'
  | 'launch_dialog_draft_discarded'
  | 'launch_submitted'
  | 'task_completed'
  | 'task_cancelled'
  | 'task_relaunched'
  | 'task_renamed'
  // Finding Management
  | 'finding_skipped'
  | 'finding_snoozed'
  // Keyboard Shortcuts
  | 'shortcut_used'
  // Focus Tracking
  | 'focus_zone_changed'
  // Frustration & Confusion Signals
  | 'rapid_repeat_click'
  | 'healthy_agent_inspected'
  // Session-Level
  | 'session_started'
  | 'websocket_reconnect'
  // Suggestion Lifecycle (server-side)
  | 'suggestion_lifecycle';

export interface TelemetryEvent {
  type: TelemetryEventType;
  timestamp: string;
  sessionId: string;
  platform: 'linux' | 'darwin' | 'wsl2' | 'unknown';
  [key: string]: unknown;
}

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
