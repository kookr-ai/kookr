/**
 * Append-only JSONL log of how the avatar ("Lucy") talks to the operator and
 * how the operator reacts (issue #3605). Lives at `<kookrDir>/lucy-interactions.jsonl`
 * (normally `~/.kookr/`), stays on this machine, and exists so the wording,
 * length and proactivity of her summaries can be analysed after the fact.
 *
 * Two kinds of line, both carrying `v: 1` and an ISO `ts`:
 *  - `said`: the server produced a clip (task summary or agent speak). Carries
 *    the final text, the pre-"speakable" wording when it differs, and timings.
 *    Audio bytes are never recorded.
 *  - `ui`: a `lucy_*` telemetry event the browser sent over the websocket,
 *    stored as received. Joins to `said` on `clipId`.
 *
 * Best-effort by design: recording never throws and never delays a request.
 * Writes go through a serial promise queue (so the stat/rotate/append sequence
 * cannot race) using the shared size-capped rotation helper. A failure is
 * swallowed and reported once per failure kind via `console.warn`.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { appendJsonlWithRotation, type JsonlRotationOptions } from '../core/jsonl-rotation.js';

export const LUCY_INTERACTION_LOG_FILENAME = 'lucy-interactions.jsonl';
export const LUCY_INTERACTION_LOG_VERSION = 1;
/** Rotate before an append would exceed this size. */
export const DEFAULT_LUCY_LOG_MAX_BYTES = 10 * 1024 * 1024;
/** Rotated generations kept (`.1`, `.2`, `.3`). */
export const DEFAULT_LUCY_LOG_ROTATED_GENERATIONS = 3;

export type LucySaidSource = 'task_summary' | 'agent_speak';

export interface LucySaidRecordInput {
  clipId: string;
  source: LucySaidSource;
  taskId?: string;
  agentId?: string;
  taskName?: string;
  /** What was synthesised and shown as caption. */
  text: string;
  /** Wording before the speakable-text step, when it differs from `text`. */
  rawText?: string;
  usedFallback: boolean;
  cached: boolean;
  verbosity?: string;
  voice?: string;
  findingType?: string;
  llmMs: number;
  ttsMs: number;
  durationMs: number;
  words: number;
}

export interface LucyInteractionLog {
  /** Record a clip the server just delivered. Never throws. */
  recordSaid(input: LucySaidRecordInput): void;
  /** Record a client `lucy_*` telemetry event as received. Never throws. */
  recordUi(sessionId: string, event: Record<string, unknown>): void;
  /** Await queued writes (tests, orderly shutdown). Never rejects. */
  flush(): Promise<void>;
}

export interface LucyInteractionLogOptions {
  /** Full path of the log file. Default `~/.kookr/lucy-interactions.jsonl`. */
  filePath?: string;
  /**
   * Read at write time so the `lucyInteractionLog` setting takes effect without
   * a restart. When it returns false nothing is written. Default: always on.
   */
  isEnabled?: () => boolean;
  /** Clock seam for tests. */
  now?: () => Date;
  maxBytes?: number;
  rotatedGenerations?: number;
  /** Append seam for tests; production uses the shared rotation helper. */
  appendLines?: (filePath: string, lines: string, options: JsonlRotationOptions) => Promise<void>;
}

/** Log that records nothing. Used when the feature is unwired (tests, partial harnesses). */
export const DISABLED_LUCY_INTERACTION_LOG: LucyInteractionLog = {
  recordSaid: () => {},
  recordUi: () => {},
  flush: async () => {},
};

export function defaultLucyInteractionLogPath(kookrDir?: string): string {
  return join(kookrDir ?? join(homedir(), '.kookr'), LUCY_INTERACTION_LOG_FILENAME);
}

export function createLucyInteractionLog(options: LucyInteractionLogOptions = {}): LucyInteractionLog {
  const filePath = options.filePath ?? defaultLucyInteractionLogPath();
  const isEnabled = options.isEnabled ?? (() => true);
  const now = options.now ?? (() => new Date());
  const rotation: JsonlRotationOptions = {
    maxBytes: options.maxBytes ?? DEFAULT_LUCY_LOG_MAX_BYTES,
    rotatedGenerations: options.rotatedGenerations ?? DEFAULT_LUCY_LOG_ROTATED_GENERATIONS,
  };
  const appendLines = options.appendLines ?? appendJsonlWithRotation;
  const warnedKinds = new Set<string>();
  let queue: Promise<void> = Promise.resolve();

  function warnOnce(kind: string, err: unknown): void {
    if (warnedKinds.has(kind)) return;
    warnedKinds.add(kind);
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[lucy-log] ${kind} (further failures of this kind are not logged): ${reason}`);
  }

  function enabled(): boolean {
    try {
      return isEnabled();
    } catch (err) {
      warnOnce('settings-read-failed', err);
      return false;
    }
  }

  function enqueue(record: Record<string, unknown>): void {
    if (!enabled()) return;
    let line: string;
    try {
      line = `${JSON.stringify({ v: LUCY_INTERACTION_LOG_VERSION, ts: now().toISOString(), ...record })}\n`;
    } catch (err) {
      warnOnce('serialize-failed', err);
      return;
    }
    queue = queue
      .then(() => appendLines(filePath, line, rotation))
      .catch((err: unknown) => {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        warnOnce(`write-failed:${typeof code === 'string' ? code : 'unknown'}`, err);
      });
  }

  return {
    recordSaid(input) {
      enqueue({ kind: 'said', ...pickSaidFields(input) });
    },
    recordUi(sessionId, event) {
      enqueue({ kind: 'ui', sessionId, event });
    },
    flush: () => queue.catch(() => {}),
  };
}

const SAID_FIELDS = [
  'clipId', 'source', 'taskId', 'agentId', 'taskName', 'text', 'rawText',
  'usedFallback', 'cached', 'verbosity', 'voice', 'findingType',
  'llmMs', 'ttsMs', 'durationMs', 'words',
] as const;

/**
 * Copy only the documented fields. An allowlist (not a spread) so a caller that
 * passes a whole speak response can never leak `audioBase64` into the log.
 */
function pickSaidFields(input: LucySaidRecordInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SAID_FIELDS) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return out;
}

/** True for telemetry event types owned by the Lucy interaction log. */
export function isLucyTelemetryType(type: unknown): boolean {
  return typeof type === 'string' && type.startsWith('lucy_');
}

/** Whitespace-separated word count, shared by the log and the response writers. */
export function countSpokenWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
