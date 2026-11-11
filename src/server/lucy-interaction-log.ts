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
 *  - `ui`: a `lucy_*` telemetry event the browser sent over the websocket.
 *    The browser is not trusted, so only the documented fields survive
 *    (see {@link sanitizeLucyUiEvent}): enums are validated, strings clamped,
 *    numbers clamped to a day. Joins to `said` on `clipId`.
 *
 * Best-effort by design: recording never throws and never delays a request.
 * Writes go through a serial promise queue (so the stat/rotate/append sequence
 * cannot race) using the shared size-capped rotation helper. The queue is
 * bounded: when {@link MAX_PENDING_LUCY_LINES} lines are already waiting, new
 * lines are dropped (counted, warned once); browser `ui` lines stop earlier, at
 * {@link MAX_PENDING_LUCY_UI_LINES}, to leave room for `said` lines. A failure is swallowed and
 * reported once per failure kind via `console.warn`. The file is created
 * owner-only (0600, directory 0700) because it holds task names and spoken text.
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
/** New lines are dropped while this many are already waiting to be written. */
export const MAX_PENDING_LUCY_LINES = 500;
/**
 * Browser `ui` lines are dropped once this many are waiting, so a flood of
 * browser events cannot crowd out the server's own `said` lines, which may use
 * the remaining capacity up to {@link MAX_PENDING_LUCY_LINES}.
 */
export const MAX_PENDING_LUCY_UI_LINES = 400;
/** Most `lucy_*` events recorded from one telemetry message; the rest are ignored. */
export const MAX_LUCY_EVENTS_PER_TELEMETRY_MESSAGE = 20;
/** Longest string kept from a client event (clipId, sessionId, timestamp...). */
export const MAX_LUCY_STRING_CHARS = 64;
/** Client numbers are clamped to 0..one day in ms. */
export const MAX_LUCY_DURATION_MS = 86_400_000;

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
  /** Lines discarded because the write queue was full (`said` and `ui` together). */
  droppedLines?(): number;
  /** The part of {@link droppedLines} that were browser `ui` lines. */
  droppedUiLines?(): number;
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
    // The log holds task names and spoken text: keep it owner-only.
    fileMode: 0o600,
    dirMode: 0o700,
  };
  const appendLines = options.appendLines ?? appendJsonlWithRotation;
  const warnedKinds = new Set<string>();
  let queue: Promise<void> = Promise.resolve();
  let pending = 0;
  let dropped = 0;
  let droppedUi = 0;

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

  function enqueue(record: Record<string, unknown>, limit: number): void {
    if (!enabled()) return;
    let line: string;
    try {
      line = `${JSON.stringify({ v: LUCY_INTERACTION_LOG_VERSION, ts: now().toISOString(), ...record })}\n`;
    } catch (err) {
      warnOnce('serialize-failed', err);
      return;
    }
    if (pending >= limit) {
      dropped++;
      if (limit < MAX_PENDING_LUCY_LINES) droppedUi++;
      warnOnce(
        limit < MAX_PENDING_LUCY_LINES ? 'queue-full-ui' : 'queue-full',
        new Error(`more than ${limit} lines pending; dropping new lines`),
      );
      return;
    }
    pending++;
    queue = queue
      .then(() => appendLines(filePath, line, rotation))
      .catch((err: unknown) => {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        warnOnce(`write-failed:${typeof code === 'string' ? code : 'unknown'}`, err);
      })
      .finally(() => {
        pending--;
      });
  }

  return {
    recordSaid(input) {
      enqueue({ kind: 'said', ...pickSaidFields(input) }, MAX_PENDING_LUCY_LINES);
    },
    recordUi(sessionId, event) {
      const clean = sanitizeLucyUiEvent(event);
      if (!clean) return;
      enqueue({ kind: 'ui', sessionId: clampString(sessionId) ?? 'unknown', event: clean }, MAX_PENDING_LUCY_UI_LINES);
    },
    flush: () => queue.catch(() => {}),
    droppedLines: () => dropped,
    droppedUiLines: () => droppedUi,
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

const TRIGGERS = ['click', 'replay'] as const;
const PANEL_STATES = ['open', 'minimized', 'off'] as const;
const ENDED_BY = ['finished', 'user_stop', 'superseded'] as const;
const UNHEARD_REASONS = ['muted', 'dnd', 'audio_suspended', 'error'] as const;
const PANEL_ACTIONS = ['enable', 'disable', 'minimize', 'restore', 'move', 'replay'] as const;
const PLATFORMS = ['linux', 'darwin', 'wsl2', 'unknown'] as const;

/** Documented enum values per field; mirrors the comment in shared/contracts/telemetry.ts. */
export const LUCY_EVENT_ENUMS = {
  trigger: TRIGGERS,
  panelState: PANEL_STATES,
  endedBy: ENDED_BY,
  reason: UNHEARD_REASONS,
  action: PANEL_ACTIONS,
} as const;

/** Bucket for a client enum value outside the documented set. */
export const LUCY_OTHER = 'other';

/** Which payload fields each event type may carry, and how each is validated. */
const EVENT_FIELDS: Record<string, readonly string[]> = {
  lucy_clip_started: ['clipId', 'trigger', 'panelState', 'tabVisible'],
  lucy_clip_ended: ['clipId', 'endedBy', 'playedMs', 'totalMs'],
  lucy_clip_unheard: ['clipId', 'reason'],
  lucy_panel_action: ['action', 'clipId'],
};

function clampString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  return value.length > MAX_LUCY_STRING_CHARS ? value.slice(0, MAX_LUCY_STRING_CHARS) : value;
}

function clampMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(MAX_LUCY_DURATION_MS, Math.max(0, value));
}

function enumOrOther(value: unknown, allowed: readonly string[]): string | undefined {
  if (typeof value !== 'string') return undefined;
  return allowed.includes(value) ? value : LUCY_OTHER;
}

/**
 * Reduce a client-sent `lucy_*` event to its documented, bounded shape.
 * Returns undefined for an unknown event type (dropped). Within a known type,
 * unknown fields are discarded, enum values outside the documented set become
 * `"other"`, strings are cut to 64 chars and numbers clamped to 0..24h.
 */
export function sanitizeLucyUiEvent(event: unknown): Record<string, unknown> | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const raw = event as Record<string, unknown>;
  const type = raw.type;
  if (typeof type !== 'string' || !Object.hasOwn(EVENT_FIELDS, type)) return undefined;

  const out: Record<string, unknown> = { type };
  const set = (key: string, value: unknown): void => {
    if (value !== undefined) out[key] = value;
  };
  set('timestamp', clampString(raw.timestamp));
  set('sessionId', clampString(raw.sessionId));
  set('platform', enumOrOther(raw.platform, PLATFORMS));
  for (const field of EVENT_FIELDS[type]) {
    const value = raw[field];
    switch (field) {
      case 'clipId': set(field, clampString(value)); break;
      case 'trigger': set(field, enumOrOther(value, TRIGGERS)); break;
      case 'panelState': set(field, enumOrOther(value, PANEL_STATES)); break;
      case 'endedBy': set(field, enumOrOther(value, ENDED_BY)); break;
      case 'reason': set(field, enumOrOther(value, UNHEARD_REASONS)); break;
      case 'action': set(field, enumOrOther(value, PANEL_ACTIONS)); break;
      case 'tabVisible': set(field, typeof value === 'boolean' ? value : undefined); break;
      case 'playedMs':
      case 'totalMs': set(field, clampMs(value)); break;
    }
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
