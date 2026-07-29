/**
 * Append-only JSONL audit log for the Telegram integration.
 *
 * Round-3 V19 fix: file-mode 0600 enforced on creation AND on every startup
 * via stat-and-rechmod. `fs.appendFile`'s `mode` arg only applies on file
 * creation, so we defend against drift explicitly.
 *
 * No HMAC chain, no rotation (V1 — see RFC §5).
 *
 * The pattern follows `src/core/interaction-log.ts` (existing JSONL append
 * utility) but is *not* a shared utility — round-3 boundary critic flagged
 * the v3 "reuses existing utility" claim as false; this is a 30-line file
 * scoped to the integration.
 */

import { appendFile, chmod, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentType } from '../../core/agent-types.js';
import { redactCredentials } from './redact.js';

export type AuditEvent =
  | { kind: 'start'; allowedUserCount: number; allowedProjectCount: number; dryRun: boolean }
  | { kind: 'message_received'; sender: number; text: string; len: number }
  | { kind: 'help_replied'; sender: number }
  | { kind: 'rate_limited'; sender: number }
  | { kind: 'agent_default_changed'; sender: number; agentType: AgentType }
  | { kind: 'agent_default_rejected'; sender: number; agentType: AgentType; reason: string }
  | { kind: 'agent_status_replied'; sender: number; agentType: AgentType }
  | { kind: 'agent_resolved'; sender: number; agentType: AgentType; source: 'default' | 'command' | 'rephrase' }
  | { kind: 'task_command'; sender: number; project: string; agentType: AgentType }
  | { kind: 'rephrased'; provider: string; model: string; specCwd: string; agentType: AgentType }
  | { kind: 'rephrase_failed'; reason: string }
  | { kind: 'rephrase_ambiguous'; reason: string }
  | { kind: 'confirmation_pending'; hash: string; chatId: number }
  | { kind: 'callback_received'; hash: string; action: string; sender: number }
  | { kind: 'callback_expired'; hash: string }
  | { kind: 'callback_invalid'; data: string }
  | { kind: 'spawn_reserved'; capUsage: { spawnsLast24h: number } }
  | { kind: 'cap_reached'; usage: { spawnsLast24h: number } }
  | { kind: 'spawned'; taskId: string; chatId: number; dryRun: boolean }
  | { kind: 'spawn_failed'; reason: string }
  | { kind: 'block_alert_sent'; taskId: string; chatId: number }
  | { kind: 'task_outcome_sent'; taskId: string; chatId: number; outcome: 'completion_ready' | 'completed' | 'failed' | 'cancelled' }
  | { kind: 'handle_failed'; updateId: number; err: string }
  | { kind: 'offset_persist_failed'; err: string }
  | { kind: 'loop_died'; err: string }
  | { kind: 'dropped_non_private' }
  | { kind: 'dropped_forwarded' }
  | { kind: 'dropped_non_text' }
  | { kind: 'dropped_unauthorized' }
  // Telegram audio-message handling — see issues #574, #585 and integrations/telegram/transcribe.ts.
  // Startup warmup — see issue #584 and integrations/telegram/warmup.ts.
  | { kind: 'voice_warmup'; okMs: number }
  | { kind: 'voice_warmup'; errMs: number; reason: string }
  | { kind: 'voice_warmup'; cancelledMs: number; cancelled: 'shutdown' }
  | { kind: 'audio_received'; source: 'voice' | 'audio' | 'video_note' | 'document'; sender: number; durationSec?: number; bytes: number; mimeType?: string }
  | { kind: 'transcribed'; source: 'voice' | 'audio' | 'video_note' | 'document'; durationSec?: number; len: number }
  | { kind: 'transcription_failed'; err: string }
  | { kind: 'dropped_audio_too_long'; source: 'voice' | 'audio' | 'video_note' | 'document'; durationSec?: number; bytes?: number; estimatedFromBytes?: boolean }
  | { kind: 'dropped_audio_too_large'; source: 'voice' | 'audio' | 'video_note' | 'document'; bytes: number; durationSec?: number }
  | { kind: 'dropped_audio_disabled'; source: 'voice' | 'audio' | 'video_note' | 'document' }
  // `/tasks` read-back command — see issue #1394 and integrations/telegram/tasks-command.ts.
  | { kind: 'tasks_replied'; sender: number; count: number }
  | { kind: 'tasks_query_failed'; sender: number; err: string };

export interface AuditWriter {
  /** Fire-and-forget append; never throws into the caller. */
  (event: AuditEvent): void;
  /** Wait for queued appends to settle; used by graceful shutdown and tests. */
  flush(): Promise<void>;
  /** Stop accepting new events, then wait for already queued appends. */
  close(): Promise<void>;
}

function redactAuditValue(_key: string, value: unknown): unknown {
  return typeof value === 'string' ? redactCredentials(value) : value;
}

export async function createAuditWriter(path: string): Promise<AuditWriter> {
  await mkdir(dirname(path), { recursive: true });

  // Enforce mode 0600 on startup. If file exists with looser mode (e.g., from
  // an older Kookr run with default umask), tighten it now.
  try {
    const s = await stat(path);
    if ((s.mode & 0o777) !== 0o600) {
      await chmod(path, 0o600);
    }
  } catch {
    // File does not exist yet; mode will be set on first write below.
  }

  let writeTail = Promise.resolve();
  let closed = false;
  const writer = ((event: AuditEvent) => {
    if (closed) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }, redactAuditValue) + '\n';
    // mode 0600 applied on file creation; existing file keeps its mode (already enforced above).
    writeTail = writeTail.then(() => appendFile(path, line, { mode: 0o600 })).catch((err) => {
      // Last-resort: write to stderr; never throw to caller.
      process.stderr.write(`[telegram-audit] append failed: ${String(err)}\n`);
    });
  }) as AuditWriter;
  writer.flush = () => writeTail;
  writer.close = () => {
    closed = true;
    return writeTail;
  };
  return writer;
}
